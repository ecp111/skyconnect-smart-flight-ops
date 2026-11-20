import { describe, it, expect } from "vitest";
import { makeSystem, delaySc1042, count } from "./helpers.js";

// RTM rows: CM-01, NFR-FAA-02, DM-05, NFR-SAFE-01, NFR-REL-04

describe("Crew assignment (CM-01, NFR-FAA-02)", () => {
  it("confirms a legal assignment only after the compliance check passes", () => {
    const sys = makeSystem();
    const out = sys.crew.assign({ flightId: "f-sc1042", crewId: "c-patel", role: "CAPTAIN", actor: "u-sched" });
    expect(out.status).toBe("CONFIRMED");
    expect(count(sys, `SELECT COUNT(*) n FROM rest_check WHERE assignment_id = ? AND result = 'PASS'`, out.assignmentId)).toBe(1);
  });

  it("never saves an illegal assignment as confirmed and names the rule it broke", () => {
    const sys = makeSystem();
    const out = sys.crew.assign({ flightId: "f-sc1042", crewId: "c-okafor", role: "CAPTAIN", actor: "u-sched" });
    expect(out.status).toBe("REJECTED");
    expect(out.compliance.violations[0].rule).toBe("117.25(e) REST_10H");
    expect(count(sys, `SELECT COUNT(*) n FROM crew_assignment WHERE crew_id = 'c-okafor' AND status = 'CONFIRMED'`)).toBe(0);
  });

  it("rejects overlapping duties for the same person", () => {
    const sys = makeSystem();
    sys.crew.assign({ flightId: "f-sc1042", crewId: "c-patel", role: "CAPTAIN", actor: "u-sched" });
    const second = sys.crew.assign({ flightId: "f-sc318", crewId: "c-patel", role: "CAPTAIN", actor: "u-sched" });
    expect(second.status).toBe("REJECTED");
    expect(second.compliance.violations[0].rule).toBe("OVERLAP");
  });

  it("replacing a conflicted crew member removes the old assignment and notifies both", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const diaz = sys.db.prepare(`SELECT assignment_id FROM crew_assignment WHERE crew_id = 'c-diaz' AND flight_id = 'f-sc1042'`).get() as any;
    sys.crew.assign({ flightId: "f-sc1042", crewId: "c-patel", role: "CAPTAIN", actor: "u-sched", replaceAssignmentId: diaz.assignment_id });
    await sys.bus.drain();
    expect((sys.db.prepare(`SELECT status FROM crew_assignment WHERE assignment_id = ?`).get(diaz.assignment_id) as any).status).toBe("REMOVED");
    expect(count(sys, `SELECT COUNT(*) n FROM notification WHERE crew_id = 'c-patel'`)).toBeGreaterThan(0);
    expect(count(sys, `SELECT COUNT(*) n FROM notification WHERE crew_id = 'c-diaz' AND message LIKE '%released%'`)).toBe(1);
  });
});

describe("Override console (DM-05, NFR-SAFE-01)", () => {
  it("lets authorized staff accept a recommendation, with a logged reason", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const rec = sys.override.listRecommendations("OPEN").find((r) => r.type === "CREW_REPLACEMENT")!;
    sys.override.decide({ recommendationId: rec.recommendation_id, decision: "ACCEPT", actor: "u-ctrl", reason: "Legal reserve available" });
    expect(count(sys, `SELECT COUNT(*) n FROM audit_log WHERE action = 'RECOMMENDATION_ACCEPT' AND actor_id = 'u-ctrl'`)).toBe(1);
  });

  it("requires a reason for every override", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const rec = sys.override.listRecommendations("OPEN")[0];
    expect(() => sys.override.decide({ recommendationId: rec.recommendation_id, decision: "REJECT", actor: "u-ctrl", reason: " " })).toThrow(/reason/i);
  });

  it("cannot be used to force an illegal Part 117 assignment, and the attempt is audited (NFR-FAA-02)", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    expect(() => sys.override.forceCrewAssignment({ flightId: "f-sc1042", crewId: "c-okafor", role: "CAPTAIN", actor: "u-ctrl", reason: "Fastest" }))
      .toThrow(/cannot be overridden/);
    expect(count(sys, `SELECT COUNT(*) n FROM audit_log WHERE action = 'OVERRIDE_BLOCKED_PART117'`)).toBe(1);
  });

  it("lets a controller set a flight status by hand when automation is unavailable (NFR-REL-04)", () => {
    const sys = makeSystem();
    sys.override.manualFlightStatus({ flightId: "f-sc318", delayMinutes: 45, actor: "u-ctrl", reason: "Weather feed down" });
    expect(sys.flightOps.getFlight("f-sc318").delay_minutes).toBe(45);
    expect(count(sys, `SELECT COUNT(*) n FROM audit_log WHERE override_reason_code = 'MANUAL_STATUS'`)).toBe(1);
  });
});
