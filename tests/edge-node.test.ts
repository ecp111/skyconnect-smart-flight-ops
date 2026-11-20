import { describe, it, expect } from "vitest";
import { makeSystem, delaySc1042, count } from "./helpers.js";

// RTM rows: NFR-REL-03, NFR-REL-04, NFR-SCAL-02 (same edge setup per hub)

const gateOf = (sys: ReturnType<typeof makeSystem>, flightId: string) =>
  (sys.db.prepare(`SELECT g.gate_code FROM gate_assignment ga JOIN gate g ON g.gate_id = ga.gate_id WHERE ga.flight_id = ? AND ga.active = 1`).get(flightId) as any).gate_code;

describe("Miami edge node: offline work and sync (NFR-REL-03)", () => {
  it("queues an offline gate change locally and applies it centrally only after reconnecting", async () => {
    const sys = makeSystem();
    sys.edge.goOffline();
    sys.edge.queueGateChange({ flightId: "f-sc1042", gateCode: "D30", actor: "u-gate" });
    expect(gateOf(sys, "f-sc1042")).toBe("D22"); // cloud unchanged while offline
    const sync: any = await sys.edge.goOnline();
    expect(sync.applied).toBe(1);
    expect(gateOf(sys, "f-sc1042")).toBe("D30");
  });

  it("flags a conflict instead of overwriting when the cloud changed the same thing", async () => {
    const sys = makeSystem();
    await delaySc1042(sys); // SC 1042 now leaves 16:30
    sys.edge.goOffline();
    sys.edge.queueGateChange({ flightId: "f-sc455", gateCode: "D25", actor: "u-gate" });
    sys.flightOps.changeGate({ flightId: "f-sc318", gateCode: "D25", actor: "u-ctrl" }); // ops center, still on the cloud
    const sync: any = await sys.edge.goOnline();
    expect(sync.conflicts).toBe(1);
    expect(gateOf(sys, "f-sc318")).toBe("D25");
    expect(gateOf(sys, "f-sc455")).toBe("D32");
    expect(count(sys, `SELECT COUNT(*) n FROM operations_event WHERE event_type = 'SYNC_CONFLICT'`)).toBe(1);
  });

  it("blocks an illegal crew change locally, using the cached Part 117 rules", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    sys.edge.goOffline();
    expect(() => sys.edge.queueProvisionalCrew({ flightId: "f-sc1042", crewId: "c-okafor", role: "CAPTAIN", actor: "u-sched" }))
      .toThrow(/cannot be overridden/);
  });

  it("keeps a legal offline crew change PROVISIONAL until the cloud re-verifies it", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const diaz = sys.db.prepare(`SELECT assignment_id FROM crew_assignment WHERE crew_id = 'c-diaz' AND flight_id = 'f-sc1042'`).get() as any;
    sys.edge.goOffline();
    sys.edge.queueProvisionalCrew({ flightId: "f-sc1042", crewId: "c-patel", role: "CAPTAIN", actor: "u-sched", replaceAssignmentId: diaz.assignment_id });
    expect(count(sys, `SELECT COUNT(*) n FROM crew_assignment WHERE crew_id = 'c-patel'`)).toBe(0); // nothing central yet
    await sys.edge.goOnline();
    await sys.bus.drain();
    expect((sys.db.prepare(`SELECT status FROM crew_assignment WHERE crew_id = 'c-patel'`).get() as any).status).toBe("CONFIRMED");
    expect((sys.db.prepare(`SELECT status FROM crew_assignment WHERE assignment_id = ?`).get(diaz.assignment_id) as any).status).toBe("REMOVED");
  });

  it("applies each queued change exactly once, even if sync runs twice", async () => {
    const sys = makeSystem();
    sys.edge.goOffline();
    sys.edge.queueGateChange({ flightId: "f-sc1042", gateCode: "D30", actor: "u-gate" });
    await sys.edge.goOnline();
    const second = sys.edge.sync();
    expect(second.applied).toBe(0);
    expect(count(sys, `SELECT COUNT(*) n FROM operations_event WHERE event_type = 'GATE_CHANGED' AND entity_id = 'f-sc1042'`)).toBe(1);
  });

  it("keeps sending passenger alerts while the hub is offline (they come from the cloud)", async () => {
    const sys = makeSystem();
    sys.edge.goOffline();
    await delaySc1042(sys);
    expect(count(sys, `SELECT COUNT(*) n FROM notification WHERE flight_id = 'f-sc1042' AND passenger_id IS NOT NULL AND delivery_status = 'SENT'`)).toBe(14);
  });
});
