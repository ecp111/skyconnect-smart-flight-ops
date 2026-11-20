import { describe, it, expect } from "vitest";
import { makeSystem, delaySc1042, count } from "./helpers.js";
import { addMinutes } from "../server/core.js";

// RTM rows: FS-01, GO-05, PP-01, PP-05, CM-03, DM-01, DM-03, NFR-PERF-03

describe("Flight status updates (FS-01)", () => {
  it("saves the change and its event together, with a new version", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const f = sys.flightOps.getFlight("f-sc1042");
    expect(f.version).toBe(2);
    expect(f.estimated_departure).toBe(addMinutes(f.scheduled_departure, 120));
    expect(count(sys, `SELECT COUNT(*) n FROM operations_event WHERE event_type = 'FLIGHT_DELAYED' AND entity_id = 'f-sc1042' AND version = 2`)).toBe(1);
  });

  it("rejects stale, untrusted and out-of-order updates", () => {
    const sys = makeSystem();
    expect(() => sys.flightOps.applyStatusUpdate({ flightId: "f-sc1042", source: "ACARS", observedAt: "2026-01-01T00:00:00.000Z", delayMinutes: 30 })).toThrow(/older/);
    expect(() => sys.flightOps.applyStatusUpdate({ flightId: "f-sc1042", source: "RANDOM_FEED", delayMinutes: 30 })).toThrow(/not trusted/);
    expect(() => sys.flightOps.applyStatusUpdate({ flightId: "f-sc101", source: "CONTROLLER", status: "DELAYED" })).toThrow(/Cannot go from ARRIVED/);
  });

  it("marks flight status as stale when the ACARS feed is down", () => {
    const sys = makeSystem();
    sys.sims.acars.up = false;
    expect(sys.flightOps.listFlights().find((f) => f.flight_id === "f-sc1042")!.stale).toBe(true);
  });
});

describe("Disruption detection (DM-01, DM-03) and gates (GO-05)", () => {
  it("turns a weather alert into delays for flights in the storm window and a reroute for airborne flights", async () => {
    const sys = makeSystem();
    sys.adapters.weather.ingest({ severity: "SEVERE", description: "test", windowStart: "2026-11-20T18:30:00.000Z", windowEnd: "2026-11-20T22:30:00.000Z", delayMinutes: 90 });
    await sys.bus.drain();
    expect(count(sys, `SELECT COUNT(*) n FROM flight WHERE status = 'DELAYED'`)).toBe(4);
    expect(count(sys, `SELECT COUNT(*) n FROM recommendation WHERE type = 'REROUTE' AND flight_id = 'f-sc520'`)).toBe(1);
  });

  it("refuses closed or occupied gates", () => {
    const sys = makeSystem();
    sys.flightOps.setGateStatus("D27", "CLOSED", "u-ctrl", "TEST");
    expect(() => sys.flightOps.changeGate({ flightId: "f-sc1042", gateCode: "D27", actor: "u-ctrl" })).toThrow(/closed/);
    expect(() => sys.flightOps.changeGate({ flightId: "f-sc1042", gateCode: "D28", actor: "u-ctrl" })).toThrow(/already assigned/);
  });
});

describe("Event bus (NFR-PERF-03)", () => {
  it("ignores a replayed event, so nothing is processed twice", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const before = count(sys, `SELECT COUNT(*) n FROM notification`);
    const evt = sys.db.prepare(`SELECT event_id FROM operations_event WHERE event_type = 'FLIGHT_DELAYED'`).get() as any;
    await sys.bus.replay(evt.event_id);
    await sys.bus.replay(evt.event_id);
    expect(count(sys, `SELECT COUNT(*) n FROM notification`)).toBe(before);
    expect(count(sys, `SELECT COUNT(*) n FROM operations_event WHERE event_type = 'CREW_REST_CONFLICT'`)).toBe(1);
  });

  it("keeps personal data out of event details", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const all = (sys.db.prepare(`SELECT details FROM operations_event`).all() as any[]).map((e) => e.details).join(" ");
    expect(all).not.toMatch(/Gonzalez|@example\.com|305-555/);
  });
});

describe("Notifications (PP-01, PP-05, CM-03)", () => {
  it("alerts every passenger on the flight within 90 seconds, in their language", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const rows = sys.db.prepare(`SELECT n.*, p.preferred_language FROM notification n JOIN passenger p ON p.passenger_id = n.passenger_id
      WHERE n.flight_id = 'f-sc1042'`).all() as any[];
    expect(rows).toHaveLength(14);
    for (const n of rows) {
      expect(n.delivery_status).toBe("SENT");
      expect((new Date(n.sent_at).getTime() - new Date(n.event_occurred_at).getTime()) / 1000).toBeLessThanOrEqual(90);
      expect(n.language).toBe(n.preferred_language);
    }
    expect(rows.find((n) => n.passenger_id === "p-maria").message).toMatch(/retrasado/);
    expect(rows.find((n) => n.passenger_id === "p-002").message).toMatch(/an reta/);
  });

  it("retries a failed crew message, then dead-letters it and flags a phone call", async () => {
    const sys = makeSystem();
    sys.flightOps.changeGate({ flightId: "f-sc1042", gateCode: "D30", actor: "u-ctrl" });
    await sys.bus.drain();
    const n = sys.db.prepare(`SELECT * FROM notification WHERE crew_id = 'c-brooks'`).get() as any;
    expect(n.delivery_status).toBe("DEAD_LETTER");
    expect(n.retry_count).toBe(3);
    const evt = sys.db.prepare(`SELECT details FROM operations_event WHERE event_type = 'NOTIFICATION_FAILED'`).get() as any;
    expect(JSON.parse(evt.details).action).toBe("CALL_CREW_MEMBER");
  });
});
