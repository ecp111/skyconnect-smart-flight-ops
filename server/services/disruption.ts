import { tx } from "../db/index.js";
import { id } from "../core.js";
import type { Ctx } from "../context.js";
import type { OpsEvent } from "../bus/eventBus.js";
import type { FlightOpsService } from "./flightOps.js";

/**
 * Disruption Management Service (DM-01, DM-03, DM-04 trigger).
 * Detects disruptions from outside data (weather, ACARS, gate closures), publishes one event
 * per affected flight, and creates recommendations that staff accept or reject (NFR-SAFE-01).
 */
export class DisruptionService {
  constructor(private ctx: Ctx, private flightOps: FlightOpsService) {
    ctx.bus.subscribe("disruption-mgmt", ["WEATHER_ALERT"], (e) => this.onWeather(e));
    ctx.bus.subscribe("disruption-mgmt", ["GATE_CLOSED"], (e) => this.onGateClosed(e));
  }

  private onWeather(e: OpsEvent) {
    const { db } = this.ctx;
    const d = e.details as { windowStart: string; windowEnd: string; delayMinutes: number; description: string };
    // Departures from Miami inside the storm window get delayed (DM-01)
    const affected = db.prepare(`SELECT * FROM flight WHERE origin = 'MIA' AND status IN ('SCHEDULED','DELAYED')
      AND estimated_departure >= ? AND estimated_departure < ? ORDER BY estimated_departure`).all(d.windowStart, d.windowEnd) as any[];
    for (const f of affected) {
      this.flightOps.applyStatusUpdate({ flightId: f.flight_id, source: "DISRUPTION_MGMT",
        delayMinutes: Math.max(f.delay_minutes, d.delayMinutes), cause: "WEATHER" });
    }
    // Flights already in the air get a weather reroute recommendation (DM-03)
    const airborne = db.prepare(`SELECT * FROM flight WHERE status = 'DEPARTED'`).all() as any[];
    for (const f of airborne) {
      this.recommend("REROUTE", f.flight_id, {
        flightNumber: f.flight_number,
        summary: `Deviate around the convective cell east of Miami; adds about 12 minutes to the ${f.origin}-${f.destination} route.`,
        addedMinutes: 12, triggeredBy: e.event_id,
      });
    }
  }

  private onGateClosed(e: OpsEvent) {
    const affected = (e.details.affectedFlights as string[]) ?? [];
    for (const flightId of affected) {
      const f = this.flightOps.getFlight(flightId);
      const suggested = this.flightOps.suggestGate(flightId);
      this.recommend("GATE_REASSIGNMENT", flightId, {
        flightNumber: f.flight_number, fromGate: e.details.gate, toGate: suggested,
        summary: suggested ? `Move ${f.flight_number} from ${e.details.gate} to ${suggested}.` : `No free gate found for ${f.flight_number}.`,
        triggeredBy: e.event_id,
      });
    }
  }

  recommend(type: "REROUTE" | "GATE_REASSIGNMENT", flightId: string, details: Record<string, unknown>) {
    const exists = this.ctx.db.prepare(`SELECT 1 FROM recommendation WHERE type = ? AND flight_id = ? AND status = 'OPEN'`).get(type, flightId);
    if (exists) return;
    tx(this.ctx.db, () => {
      const recId = id("rec");
      this.ctx.db.prepare(`INSERT INTO recommendation VALUES (?,?,?,?, 'OPEN', ?, NULL, NULL, NULL)`)
        .run(recId, type, flightId, JSON.stringify(details), this.ctx.now());
      this.ctx.bus.record({ entity_type: "RECOMMENDATION", entity_id: recId, event_type: `${type}_RECOMMENDED`, source: "DISRUPTION_MGMT",
        details: { flightId, ...details } });
    });
  }

  /** Disruptions currently open, for the dashboard. */
  summary() {
    const { db } = this.ctx;
    return {
      delayed: db.prepare(`SELECT COUNT(*) n FROM flight WHERE status = 'DELAYED'`).get(),
      cancelled: db.prepare(`SELECT COUNT(*) n FROM flight WHERE status = 'CANCELLED'`).get(),
      openRecommendations: db.prepare(`SELECT COUNT(*) n FROM recommendation WHERE status = 'OPEN'`).get(),
      latestWeather: db.prepare(`SELECT details, occurred_at FROM operations_event WHERE event_type = 'WEATHER_ALERT'
        ORDER BY recorded_at DESC LIMIT 1`).get(),
    };
  }
}
