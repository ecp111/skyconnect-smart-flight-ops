import { openDatabase } from "./db/index.js";
import { seed } from "./db/seed.js";
import { createSimClock, type Clock } from "./core.js";
import { EventBus } from "./bus/eventBus.js";
import { createCtx } from "./context.js";
import { createSimulators } from "./simulators/index.js";
import { SabreAdapter, WeatherAdapter, AcarsAdapter, AmadeusAdapter } from "./integration/adapters.js";
import { FlightOpsService } from "./services/flightOps.js";
import { DisruptionService } from "./services/disruption.js";
import { CrewSchedulingService } from "./services/crewScheduling.js";
import { RebookingService } from "./services/rebooking.js";
import { NotificationService } from "./services/notification.js";
import { OverrideService } from "./services/override.js";
import { AnalyticsService } from "./services/analytics.js";
import { EdgeNode } from "./edge/edgeNode.js";

/** Builds one complete SkyConnect system (used by the server and by every test). */
export function createSystem(opts: { clock?: Clock; latencyMs?: number } = {}) {
  const db = openDatabase();
  seed(db);
  const clock = opts.clock ?? createSimClock();
  const sims = createSimulators();
  if (opts.latencyMs !== undefined) { sims.sabre.latencyMs = opts.latencyMs; sims.sabre.slowMs = opts.latencyMs * 4; }
  const bus = new EventBus(db, clock);
  const ctx = createCtx(db, clock, bus, sims);

  const flightOps = new FlightOpsService(ctx);
  const sabre = new SabreAdapter(ctx);
  const adapters = {
    sabre,
    weather: new WeatherAdapter(ctx),
    acars: new AcarsAdapter(ctx, (u) => flightOps.applyStatusUpdate(u)),
    amadeus: new AmadeusAdapter(ctx),
  };
  const disruption = new DisruptionService(ctx, flightOps);
  const crew = new CrewSchedulingService(ctx);
  const notification = new NotificationService(ctx);
  const rebooking = new RebookingService(ctx, sabre);
  const override = new OverrideService(ctx, flightOps, crew);
  const analytics = new AnalyticsService(ctx);
  const edge = new EdgeNode(ctx, flightOps, crew);
  edge.refreshSnapshot();

  return { db, clock, sims, bus, ctx, adapters, flightOps, disruption, crew, notification, rebooking, override, analytics, edge };
}

export type System = ReturnType<typeof createSystem>;
