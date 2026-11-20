import { describe, it, expect } from "vitest";
import { makeSystem, delaySc1042, count } from "./helpers.js";
import { maxFlightDutyPeriod, evaluateCrew, loadCrewData, dutyWindow } from "../server/services/compliance.js";
import { miamiLocal } from "../server/core.js";

// RTM rows: CM-02, DM-02, NFR-FAA-01, NFR-FAA-03

describe("Compliance Engine (NFR-FAA-01): Part 117 test suite with legal and illegal assignments", () => {
  it("uses Table B flight duty limits by report time and segments", () => {
    expect(maxFlightDutyPeriod(miamiLocal("2026-11-20T06:00"), 3)).toBe(12);
    expect(maxFlightDutyPeriod(miamiLocal("2026-11-20T07:30"), 2)).toBe(14);
    expect(maxFlightDutyPeriod(miamiLocal("2026-11-20T15:30"), 1)).toBe(12);
    expect(maxFlightDutyPeriod(miamiLocal("2026-11-20T02:00"), 1)).toBe(9);
  });

  it("finds Capt. Diaz legal before the storm", () => {
    const sys = makeSystem();
    expect(evaluateCrew(loadCrewData(sys.db, "c-diaz")).result).toBe("PASS");
  });

  it("matches the compliance team's expected result for each reserve captain", () => {
    const sys = makeSystem();
    const flight = sys.flightOps.getFlight("f-sc1042");
    const check = (crewId: string) => evaluateCrew(loadCrewData(sys.db, crewId),
      { flight_id: flight.flight_id, ...dutyWindow(flight), aircraft_type: flight.aircraft_type });
    expect(check("c-patel").result).toBe("PASS");
    expect(check("c-okafor").violations[0].rule).toBe("117.25(e) REST_10H");      // released 06:30 after a red-eye
    expect(check("c-nguyen").violations[0].rule).toBe("QUALIFICATION");          // B737 only
  });

  it("checks flight attendants under 14 CFR 121.467, not Part 117", () => {
    const sys = makeSystem();
    expect(evaluateCrew(loadCrewData(sys.db, "c-lopez")).regulation).toBe("14 CFR 121.467");
  });
});

describe("Automatic recheck after a delay (NFR-FAA-03, DM-02)", () => {
  it("flags Capt. Diaz before the extra two hours put him over his limit", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const conflict = sys.db.prepare(`SELECT details FROM operations_event WHERE event_type = 'CREW_REST_CONFLICT'`).get() as any;
    expect(conflict).toBeTruthy();
    const d = JSON.parse(conflict.details);
    expect(d.crewId).toBe("c-diaz");
    expect(d.rule).toBe("117.13 FDP_TABLE_B");
    // The rest of the SC 1042 crew is still legal
    expect(count(sys, `SELECT COUNT(*) n FROM operations_event WHERE event_type = 'CREW_REST_CONFLICT'`)).toBe(1);
  });

  it("creates a replacement recommendation that ranks only legal crew first", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    const rec = sys.override.listRecommendations("OPEN").find((r) => r.type === "CREW_REPLACEMENT")!;
    expect(rec.details.suggestedCrewId).toBe("c-patel");
    expect(rec.details.candidates[0].legal).toBe(true);
  });

  it("stores REST_CHECK evidence for every check", async () => {
    const sys = makeSystem();
    await delaySc1042(sys);
    expect(count(sys, `SELECT COUNT(*) n FROM rest_check WHERE result = 'FAIL' AND evidence_reference IS NOT NULL`)).toBe(1);
  });
});
