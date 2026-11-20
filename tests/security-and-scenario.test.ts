import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.js";
import { makeSystem, count } from "./helpers.js";
import { StormScenario } from "../server/scenario/storm.js";

// RTM rows: NFR-SEC-01, NFR-SEC-02, NFR-SEC-04, NFR-SAFE-02 and the full Failure Scenario

const { app, stop } = createApp({ paceMs: 0, latencyMs: 1 });
afterAll(() => stop());

const signIn = async (userId: string, mfaCode?: string) =>
  (await request(app).post("/api/auth/login").send({ userId, mfaCode })).body.token as string;

describe("API gateway security (NFR-SEC-02, NFR-SEC-04)", () => {
  it("refuses requests that aren't signed in", async () => {
    expect((await request(app).get("/api/flights")).status).toBe(401);
  });

  it("requires MFA for accounts with elevated access", async () => {
    const res = await request(app).post("/api/auth/login").send({ userId: "u-ctrl" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("MFA_REQUIRED");
    expect(await signIn("u-ctrl", "246810")).toBeTruthy();
  });

  it("only shows each role the data it needs", async () => {
    const pax = await signIn("u-maria");
    expect((await request(app).get("/api/flights").set("Authorization", `Bearer ${pax}`)).status).toBe(403);
    const mine = await request(app).get("/api/passenger/me").set("Authorization", `Bearer ${pax}`);
    expect(mine.body.passenger.passenger_id).toBe("p-maria");
    const crew = await signIn("u-diaz");
    expect((await request(app).get("/api/audit").set("Authorization", `Bearer ${crew}`)).status).toBe(403);
    const gate = await signIn("u-gate");
    expect((await request(app).post("/api/crew/assign").set("Authorization", `Bearer ${gate}`).send({})).status).toBe(403);
  });
});

describe("Payment data (NFR-SEC-01)", () => {
  it("stores a token, never the card number", () => {
    const sys = makeSystem();
    const out = sys.sims.payment.tokenize("4111 1111 1111 1111");
    expect(out.token).toMatch(/^tok_/);
    expect(JSON.stringify(out)).not.toContain("4111111111111111");
  });
});

describe("Zone separation (NFR-SAFE-02)", () => {
  it("keeps crew scheduling working when the passenger notification provider is down", async () => {
    const sys = makeSystem();
    sys.sims.notify.up = false;
    sys.flightOps.applyStatusUpdate({ flightId: "f-sc1042", source: "DISRUPTION_MGMT", delayMinutes: 120 });
    await sys.bus.drain();
    expect(count(sys, `SELECT COUNT(*) n FROM operations_event WHERE event_type = 'CREW_REST_CONFLICT'`)).toBe(1);
    expect(sys.crew.assign({ flightId: "f-sc1046", crewId: "c-reyes", role: "FIRST_OFFICER", actor: "u-sched" }).status).toBe("CONFIRMED");
  });
});

describe("Failure Scenario: severe weather at Miami, end to end", () => {
  it("covers all eight parts of the scenario with the expected outcomes", async () => {
    const sys = makeSystem();
    const scenario = new StormScenario(sys, 0);
    await scenario.run();
    expect(scenario.error).toBeNull();
    expect(scenario.steps.map((s) => s.heading)).toEqual([
      "How the system detects the problem",
      "How services are coordinated",
      "How transaction integrity is protected",
      "How passengers and staff are informed",
      "How the system handles limited connectivity",
      "How failed integrations are handled",
      "How manual fallback is supported",
      "How information synchronizes after connectivity returns",
    ]);
    const q = (sql: string) => sys.db.prepare(sql).get() as any;
    expect(q(`SELECT g.gate_code FROM gate_assignment ga JOIN gate g ON g.gate_id = ga.gate_id WHERE ga.flight_id = 'f-sc1042' AND ga.active = 1`).gate_code).toBe("D30");
    expect(q(`SELECT status FROM crew_assignment WHERE crew_id = 'c-patel' AND flight_id = 'f-sc1042'`).status).toBe("CONFIRMED");
    expect(q(`SELECT status FROM crew_assignment WHERE crew_id = 'c-diaz' AND flight_id = 'f-sc1042'`).status).toBe("REMOVED");
    expect(q(`SELECT COUNT(*) n FROM rebooking WHERE status = 'CONFIRMED'`).n).toBe(sys.sims.sabre.bookingCount());
    expect(q(`SELECT COUNT(*) n FROM edge_queue WHERE status = 'CONFLICT'`).n).toBe(1);
    expect(q(`SELECT COUNT(*) n FROM crew_assignment WHERE crew_id = 'c-okafor' AND status = 'CONFIRMED'`).n).toBe(0);
  });
});
