import { AppError, id } from "../core.js";
import type { Ctx } from "../context.js";
import { SimError } from "../simulators/index.js";

/**
 * Integration Adapters (SI-01 to SI-04, NFR-PERF-03; ADR-01).
 * One adapter per outside system. Each translates between that system and SkyConnect and
 * contains its failures, so a problem with one system never spreads to the rest.
 */

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new SimError("TIMEOUT", `No response within ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Sabre adapter (SI-01). Never treats an unconfirmed booking as completed. */
export class SabreAdapter {
  timeoutMs = 4000;
  constructor(private ctx: Ctx) {}

  seatsAvailable(flightId: string): number | null {
    try { return this.ctx.sims.sabre.seatsAvailable(flightId); } catch { return null; }
  }

  async book(req: { correlationId: string; bookingReference: string; newFlightId: string }) {
    return withTimeout(this.ctx.sims.sabre.book(req), this.timeoutMs);
  }

  async status(correlationId: string) {
    return withTimeout(this.ctx.sims.sabre.status(correlationId), this.timeoutMs);
  }
}

/** Weather adapter: turns a weather-service alert into a WEATHER_ALERT event. */
export class WeatherAdapter {
  constructor(private ctx: Ctx) {}
  ingest(alert: { severity: string; description: string; windowStart: string; windowEnd: string; delayMinutes: number }) {
    if (!this.ctx.sims.weather.up) throw new AppError(503, "WEATHER_FEED_DOWN", "Weather feed unavailable; enter delays manually");
    return this.ctx.bus.record({ entity_type: "AIRPORT", entity_id: "MIA", event_type: "WEATHER_ALERT", source: "WEATHER_SERVICE",
      details: alert });
  }
}

/** ACARS adapter (SI-03): aircraft messages become flight status updates. */
export class AcarsAdapter {
  constructor(private ctx: Ctx, private applyStatus: (u: any) => unknown) {}
  ingest(msg: { aircraftId: string; type: "GATE_HOLD" | "OUT" | "IN"; observedAt?: string; note?: string }) {
    const { db, sims, bus } = this.ctx;
    if (!sims.acars.up) throw new AppError(503, "ACARS_DOWN", "ACARS feed unavailable; showing last known status");
    const f = db.prepare(`SELECT * FROM flight WHERE aircraft_id = ? AND status NOT IN ('ARRIVED','CANCELLED')
      ORDER BY scheduled_departure LIMIT 1`).get(msg.aircraftId) as any;
    if (!f) throw new AppError(404, "UNKNOWN_AIRCRAFT", `No active flight for ${msg.aircraftId}`);
    sims.acars.lastMessageAt = this.ctx.now();
    if (msg.type === "GATE_HOLD") {
      return bus.record({ entity_type: "FLIGHT", entity_id: f.flight_id, event_type: "ACARS_GATE_HOLD", source: "ACARS",
        details: { flightNumber: f.flight_number, aircraftId: msg.aircraftId, note: msg.note ?? "Held at gate" } });
    }
    return this.applyStatus({ flightId: f.flight_id, source: "ACARS", observedAt: msg.observedAt,
      status: msg.type === "OUT" ? "DEPARTED" : "ARRIVED" });
  }
}

/** Amadeus adapter (SI-02): forwards schedule changes; failures go to the dead-letter list. */
export class AmadeusAdapter {
  constructor(private ctx: Ctx) {
    ctx.bus.subscribe("amadeus-adapter", ["FLIGHT_DELAYED", "FLIGHT_CANCELLED"], (e) => {
      try {
        ctx.sims.amadeus.publish(e.event_id, e.entity_id, e.event_type);
      } catch (err) {
        ctx.db.prepare(`INSERT INTO dead_letter VALUES (?, 'AMADEUS_PUBLISH', ?, ?, ?, 0)`)
          .run(id("dl"), e.event_id, (err as Error).message, ctx.now());
      }
    });
  }
}
