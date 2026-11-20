import express, { type Request, type Response, type NextFunction } from "express";
import { createSystem, type System } from "./system.js";
import { AppError } from "./core.js";
import { authenticate, requireRole, login, userOf, DEMO_USERS, DEMO_MFA_CODE } from "./gateway/auth.js";
import { StormScenario } from "./scenario/storm.js";

/**
 * API Gateway: the single front door for the passenger app, crew app and staff dashboard.
 * Every request is authenticated and checked against the caller's role (NFR-SEC-02).
 */

const STAFF = ["GATE_AGENT", "CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"] as const;

export function createApp(opts: { paceMs?: number; latencyMs?: number } = {}) {
  let sys: System = createSystem({ latencyMs: opts.latencyMs });
  let scenario: StormScenario | null = null;
  const app = express();
  app.use(express.json());

  const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req, res);
      await sys.bus.drain();
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) { next(e); }
  };

  // ---- Identity ------------------------------------------------------------------------
  app.get("/api/auth/users", (_req, res) => res.json({
    users: DEMO_USERS.map((u) => ({ ...u, mfaRequired: ["CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"].includes(u.role) })),
    demoMfaCode: DEMO_MFA_CODE,
  }));
  app.post("/api/auth/login", wrap((req) => {
    const out = login(req.body.userId, req.body.mfaCode);
    sys.ctx.audit({ actor_id: out.user.userId, action: "LOGIN", entity_type: "USER", entity_id: out.user.userId, new_value: out.user.role });
    return out;
  }));

  // ---- Simulation controls (demo only, not part of the real system) --------------------
  const simState = () => ({
    sabreMode: sys.sims.sabre.mode, acarsUp: sys.sims.acars.up, weatherUp: sys.sims.weather.up, faaUp: sys.sims.faa.up,
    amadeusUp: sys.sims.amadeus.up, notifyUp: sys.sims.notify.up, notifyFailureRate: sys.sims.notify.failureRate,
    hubOnline: sys.edge.online, clock: sys.ctx.now(),
    scenario: scenario ? { running: scenario.running, done: scenario.done, error: scenario.error, steps: scenario.steps } : null,
  });
  app.get("/api/sim", (_req, res) => res.json(simState()));
  app.post("/api/sim", wrap(async (req) => {
    const b = req.body;
    if (b.sabreMode) sys.sims.sabre.mode = b.sabreMode;
    if (typeof b.acarsUp === "boolean") sys.sims.acars.up = b.acarsUp;
    if (typeof b.weatherUp === "boolean") sys.sims.weather.up = b.weatherUp;
    if (typeof b.faaUp === "boolean") sys.sims.faa.up = b.faaUp;
    if (typeof b.amadeusUp === "boolean") sys.sims.amadeus.up = b.amadeusUp;
    if (typeof b.notifyUp === "boolean") sys.sims.notify.up = b.notifyUp;
    if (typeof b.notifyFailureRate === "number") sys.sims.notify.failureRate = b.notifyFailureRate;
    if (b.hubOnline === false) sys.edge.goOffline();
    let sync = null;
    if (b.hubOnline === true) sync = await sys.edge.goOnline();
    return { ...simState(), sync };
  }));
  app.post("/api/sim/reset", wrap(() => {
    if (scenario?.running) throw new AppError(409, "SCENARIO_RUNNING", "Wait for the scenario to finish");
    sys = createSystem({ latencyMs: opts.latencyMs });
    scenario = null;
    return simState();
  }));
  app.post("/api/sim/weather-alert", wrap((req) => sys.adapters.weather.ingest(req.body)));
  app.post("/api/sim/acars", wrap((req) => sys.adapters.acars.ingest(req.body)));
  app.post("/api/scenario/storm", wrap(() => {
    if (scenario?.running) throw new AppError(409, "ALREADY_RUNNING", "The storm scenario is already running");
    if (scenario?.done) throw new AppError(409, "RESET_FIRST", "Reset the demo before running the storm again");
    scenario = new StormScenario(sys, opts.paceMs);
    void scenario.run();
    return { started: true };
  }));

  // Everything below requires sign-in ------------------------------------------------------
  app.use("/api", authenticate);

  // ---- Flights and gates (FS-01, GO-05) -------------------------------------------------
  app.get("/api/flights", requireRole(...STAFF), wrap(() => ({ flights: sys.flightOps.listFlights(), gates: sys.flightOps.listGates(),
    hub: { online: sys.edge.online }, acarsUp: sys.sims.acars.up })));
  app.post("/api/flights/:id/gate", requireRole("GATE_AGENT", "OPS_CONTROLLER", "ADMIN"), wrap((req) => {
    const actor = userOf(req).userId;
    if (!sys.edge.online) return sys.edge.queueGateChange({ flightId: String(req.params.id), gateCode: req.body.gateCode, actor });
    return sys.flightOps.changeGate({ flightId: String(req.params.id), gateCode: req.body.gateCode, actor });
  }));
  app.post("/api/flights/:id/delay", requireRole("OPS_CONTROLLER", "ADMIN"), wrap((req) =>
    sys.flightOps.applyStatusUpdate({ flightId: String(req.params.id), source: "CONTROLLER", delayMinutes: Number(req.body.delayMinutes),
      cause: req.body.cause ?? "OPERATIONAL", actor: userOf(req).userId })));
  app.post("/api/gates/:code/status", requireRole("OPS_CONTROLLER", "ADMIN"), wrap((req) =>
    sys.flightOps.setGateStatus(String(req.params.code), req.body.status, userOf(req).userId, req.body.reason ?? "OPERATIONAL")));

  // ---- Crew (CM-01, CM-02, CM-03) -------------------------------------------------------
  app.get("/api/crew", requireRole("CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"), wrap(() => ({ crew: sys.crew.listCrew() })));
  app.get("/api/crew/me", requireRole("CREW"), wrap((req) => sys.crew.crewView(userOf(req).crewId!)));
  app.get("/api/crew/:id", requireRole("CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"), wrap((req) => sys.crew.crewView(String(req.params.id))));
  app.get("/api/crew-candidates", requireRole("CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"), wrap((req) =>
    ({ candidates: sys.crew.candidatesFor(String(req.query.flightId), String(req.query.role)) })));
  app.post("/api/crew/assign", requireRole("CREW_SCHEDULER", "ADMIN"), wrap((req) => {
    const actor = userOf(req).userId;
    const b = req.body;
    if (!sys.edge.online) return sys.edge.queueProvisionalCrew({ flightId: b.flightId, crewId: b.crewId, role: b.role, actor, replaceAssignmentId: b.replaceAssignmentId });
    const out = sys.crew.assign({ flightId: b.flightId, crewId: b.crewId, role: b.role, actor, replaceAssignmentId: b.replaceAssignmentId });
    if (out.status === "REJECTED") throw new AppError(403, "PART117_NO_OVERRIDE", `Blocked: ${out.compliance.violations[0].message}`);
    return out;
  }));

  // ---- Override console (DM-03, DM-05, NFR-SAFE-01) -------------------------------------
  app.get("/api/recommendations", requireRole("CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"), wrap((req) =>
    ({ recommendations: sys.override.listRecommendations(String(req.query.status ?? "ALL")) })));
  app.post("/api/recommendations/:id/decision", requireRole("CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"), wrap((req) =>
    sys.override.decide({ recommendationId: String(req.params.id), decision: req.body.decision, actor: userOf(req).userId, reason: req.body.reason,
      chosenCrewId: req.body.chosenCrewId, gateCode: req.body.gateCode })));
  app.post("/api/override/flight-status", requireRole("OPS_CONTROLLER", "ADMIN"), wrap((req) =>
    sys.override.manualFlightStatus({ ...req.body, actor: userOf(req).userId })));
  app.post("/api/override/crew", requireRole("OPS_CONTROLLER", "ADMIN"), wrap((req) =>
    sys.override.forceCrewAssignment({ ...req.body, actor: userOf(req).userId })));
  app.get("/api/audit", requireRole("OPS_CONTROLLER", "ADMIN"), wrap(() => ({ audit: sys.override.auditLog(200) })));

  // ---- Passengers (PP-01, PP-02, PP-05) -------------------------------------------------
  app.get("/api/passenger/me", requireRole("PASSENGER"), wrap((req) => sys.rebooking.passengerView(userOf(req).passengerId!)));
  app.post("/api/passenger/me/rebook", requireRole("PASSENGER"), wrap((req) =>
    sys.rebooking.request({ passengerId: userOf(req).passengerId!, newFlightId: req.body.newFlightId, actor: userOf(req).userId })));
  app.get("/api/rebookings", requireRole(...STAFF), wrap(() => ({ rebookings: sys.rebooking.list() })));
  app.post("/api/rebookings/reconcile", requireRole("GATE_AGENT", "OPS_CONTROLLER", "ADMIN"), wrap(async () => ({ checked: await sys.rebooking.reconcileAll() })));

  // ---- Events, notifications, analytics, edge -------------------------------------------
  app.get("/api/events", requireRole(...STAFF), wrap(() => ({ events: sys.bus.list(300) })));
  app.get("/api/notifications", requireRole(...STAFF), wrap(() => ({ notifications: sys.notification.list(200) })));
  app.get("/api/dead-letters", requireRole(...STAFF), wrap(() => ({ deadLetters: sys.db.prepare(`SELECT * FROM dead_letter ORDER BY created_at DESC`).all() })));
  app.get("/api/analytics", requireRole(...STAFF), wrap((req) => sys.analytics.get(req.query.live === "1" && ["OPS_CONTROLLER", "ADMIN"].includes(userOf(req).role))));
  app.get("/api/edge", requireRole(...STAFF), wrap(() => sys.edge.status()));
  app.post("/api/edge/conflicts/:id/resolve", requireRole("GATE_AGENT", "OPS_CONTROLLER", "ADMIN"), wrap((req) =>
    sys.edge.resolveGateConflict(String(req.params.id), req.body.gateCode, userOf(req).userId)));

  // ---- Errors ---------------------------------------------------------------------------
  app.use("/api", (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.code, message: err.message });
    console.error(err);
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  });

  // Background jobs: reconcile unconfirmed rebookings, refresh the edge snapshot
  const timers = [
    setInterval(() => { void sys.rebooking.reconcileAll(); }, 5000),
    setInterval(() => sys.edge.refreshSnapshot(), 15000),
  ];
  const stop = () => timers.forEach(clearInterval);

  return { app, system: () => sys, stop };
}
