import { describe, it, expect } from "vitest";
import { makeSystem, delaySc1042, count } from "./helpers.js";

// RTM rows: PP-02, DM-04, SI-01

describe("Self-service rebooking (PP-02, DM-04)", () => {
  it("is only offered for disrupted flights", async () => {
    const sys = makeSystem();
    await expect(sys.rebooking.request({ passengerId: "p-maria", newFlightId: "f-sc1046", actor: "u-maria" })).rejects.toThrow(/disrupted/);
  });

  it("lists later flights on the same route with seats from Sabre", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const opts = sys.rebooking.passengerView("p-maria").options;
    expect(opts.map((o) => o.flightNumber)).toEqual(["SC 1046", "SC 1050"]);
    expect(opts[0].seatsAvailable).toBe(6);
  });

  it("confirms only after Sabre returns a booking reference, then moves the reservation", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const rb = await sys.rebooking.request({ passengerId: "p-maria", newFlightId: "f-sc1046", actor: "u-maria" });
    expect(rb.status).toBe("CONFIRMED");
    expect(rb.sabre_booking_ref).toMatch(/^SBR-/);
    expect((sys.db.prepare(`SELECT flight_id FROM reservation_flight WHERE reservation_id = 'r-maria'`).get() as any).flight_id).toBe("f-sc1046");
  });
});

describe("Sabre failures (SI-01): PENDING-before-call, timeout lookup, no duplicates", () => {
  it("saves the request as PENDING before calling Sabre, and stays PENDING if Sabre is down", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    sys.sims.sabre.mode = "down";
    const rb = await sys.rebooking.request({ passengerId: "p-maria", newFlightId: "f-sc1046", actor: "u-maria" });
    await sys.bus.drain();
    expect(rb.status).toBe("PENDING");
    expect(rb.last_error).toBe("UNAVAILABLE");
    expect(count(sys, `SELECT COUNT(*) n FROM notification WHERE passenger_id = 'p-maria' AND message LIKE '%confirm%'`)).toBe(0);
  });

  it("after a timeout, looks up the booking in Sabre instead of resubmitting", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    sys.sims.sabre.timeoutNext = true;
    const rb = await sys.rebooking.request({ passengerId: "p-maria", newFlightId: "f-sc1046", actor: "u-maria" });
    expect(rb.status).toBe("PENDING");
    expect(sys.sims.sabre.calls).toBe(1);
    const after = await sys.rebooking.reconcile(rb.request_id);
    expect(after.status).toBe("CONFIRMED");
    expect(sys.sims.sabre.calls).toBe(1);          // no second booking call
    expect(sys.sims.sabre.bookingCount()).toBe(1); // exactly one seat in Sabre
    expect(sys.sims.sabre.inventory["f-sc1046"]).toBe(5);
  });

  it("refuses a second request while one is still pending (duplicate prevention)", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    sys.sims.sabre.mode = "down";
    await sys.rebooking.request({ passengerId: "p-maria", newFlightId: "f-sc1046", actor: "u-maria" });
    await expect(sys.rebooking.request({ passengerId: "p-maria", newFlightId: "f-sc1050", actor: "u-maria" })).rejects.toThrow(/already being processed/);
  });

  it("marks the request FAILED when the flight is sold out", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    sys.sims.sabre.inventory["f-sc1046"] = 0;
    const rb = await sys.rebooking.request({ passengerId: "p-maria", newFlightId: "f-sc1046", actor: "u-maria" });
    expect(rb.status).toBe("FAILED");
  });

  it("escalates to staff when Sabre still can't confirm after retries", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    sys.sims.sabre.mode = "down";
    const rb = await sys.rebooking.request({ passengerId: "p-maria", newFlightId: "f-sc1046", actor: "u-maria" });
    for (let i = 0; i < 4; i++) await sys.rebooking.reconcile(rb.request_id);
    expect(sys.rebooking.get(rb.request_id).needs_review).toBe(1);
    expect(count(sys, `SELECT COUNT(*) n FROM dead_letter WHERE kind = 'REBOOKING_RECONCILIATION'`)).toBe(1);
  });
});
