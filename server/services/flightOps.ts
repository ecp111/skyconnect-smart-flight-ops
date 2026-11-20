import { tx } from "../db/index.js";
import { addMinutes, AppError, id } from "../core.js";
import type { Ctx } from "../context.js";

/**
 * Flight Operations Service (FS-01, GO-05, SI-03).
 * Owns FLIGHT, GATE and GATE_ASSIGNMENT. Validates every status update before saving it
 * (known flight, trusted source, allowed transition, not stale) and publishes the change
 * through the outbox in the same transaction.
 */

const TRUSTED_SOURCES = ["ACARS", "FLIGHT_DATA", "CONTROLLER", "DISRUPTION_MGMT", "EDGE_SYNC", "MANUAL_OVERRIDE"];
const TRANSITIONS: Record<string, string[]> = {
  SCHEDULED: ["SCHEDULED", "DELAYED", "CANCELLED", "BOARDING", "DEPARTED"],
  DELAYED: ["DELAYED", "SCHEDULED", "CANCELLED", "BOARDING", "DEPARTED"],
  BOARDING: ["BOARDING", "DELAYED", "DEPARTED", "CANCELLED"],
  DEPARTED: ["DEPARTED", "ARRIVED"],
  ARRIVED: ["ARRIVED"],
  CANCELLED: ["CANCELLED"],
};

export interface StatusUpdate {
  flightId: string;
  source: string;
  observedAt?: string;         // when the source observed it; older than our last update => stale
  delayMinutes?: number;       // total delay from schedule
  status?: string;
  cause?: string;
  actor?: string;
}

export class FlightOpsService {
  constructor(private ctx: Ctx) {}

  listFlights() {
    const { db, sims } = this.ctx;
    const rows = db.prepare(`
      SELECT f.*, g.gate_code AS gate, ga.version AS gate_version,
        (SELECT COUNT(*) FROM crew_assignment ca WHERE ca.flight_id = f.flight_id AND ca.status = 'CONFIRMED'
           AND (SELECT rc.result FROM rest_check rc WHERE rc.assignment_id = ca.assignment_id
                ORDER BY rc.checked_at DESC, rc.rowid DESC LIMIT 1) = 'FAIL') AS open_crew_conflicts,
        (SELECT COUNT(*) FROM crew_assignment ca WHERE ca.flight_id = f.flight_id AND ca.status = 'PROVISIONAL') AS provisional_crew
      FROM flight f
      LEFT JOIN gate_assignment ga ON ga.flight_id = f.flight_id AND ga.active = 1
      LEFT JOIN gate g ON g.gate_id = ga.gate_id
      ORDER BY f.scheduled_departure`).all() as any[];
    return rows.map((r) => ({
      ...r,
      stale: !sims.acars.up && ["SCHEDULED", "DELAYED", "BOARDING", "DEPARTED"].includes(r.status),
    }));
  }

  getFlight(flightId: string) {
    const f = this.ctx.db.prepare(`SELECT * FROM flight WHERE flight_id = ?`).get(flightId) as any;
    if (!f) throw new AppError(404, "UNKNOWN_FLIGHT", `Unknown flight ${flightId}`);
    return f;
  }

  /** Apply a validated status/delay update (FS-01 verification: source, transition, freshness). */
  applyStatusUpdate(u: StatusUpdate) {
    const { db, bus } = this.ctx;
    if (!TRUSTED_SOURCES.includes(u.source)) throw new AppError(400, "UNTRUSTED_SOURCE", `Source ${u.source} is not trusted`);
    return tx(db, () => {
      const f = this.getFlight(u.flightId);
      if (u.observedAt && u.observedAt < f.last_updated_at)
        throw new AppError(409, "STALE_UPDATE", `Update observed at ${u.observedAt} is older than current data`);
      const newStatus = u.status ?? (u.delayMinutes && u.delayMinutes > 0 ? "DELAYED" : f.status);
      if (!TRANSITIONS[f.status]?.includes(newStatus))
        throw new AppError(409, "INVALID_TRANSITION", `Cannot go from ${f.status} to ${newStatus}`);
      const delay = u.delayMinutes ?? f.delay_minutes;
      const estDep = addMinutes(f.scheduled_departure, delay);
      const estArr = addMinutes(f.scheduled_arrival, delay);
      const version = f.version + 1;
      db.prepare(`UPDATE flight SET status = ?, delay_minutes = ?, delay_cause = COALESCE(?, delay_cause),
        estimated_departure = ?, estimated_arrival = ?, version = ?, last_updated_at = ?, source = ? WHERE flight_id = ?`)
        .run(newStatus, delay, u.cause ?? null, estDep, estArr, version, u.observedAt ?? this.ctx.now(), u.source, f.flight_id);
      const eventType = newStatus === "CANCELLED" ? "FLIGHT_CANCELLED"
        : delay !== f.delay_minutes ? "FLIGHT_DELAYED" : "FLIGHT_STATUS_UPDATED";
      const evt = bus.record({
        entity_type: "FLIGHT", entity_id: f.flight_id, event_type: eventType, source: u.source, version,
        occurred_at: u.observedAt,
        details: { flightNumber: f.flight_number, oldStatus: f.status, newStatus, delayMinutes: delay,
          previousDelayMinutes: f.delay_minutes, estimatedDeparture: estDep, estimatedArrival: estArr, cause: u.cause ?? f.delay_cause },
      });
      if (u.actor) this.ctx.audit({ actor_id: u.actor, action: eventType, entity_type: "FLIGHT", entity_id: f.flight_id,
        old_value: `${f.status}/${f.delay_minutes}`, new_value: `${newStatus}/${delay}`, override_reason_code: u.source === "MANUAL_OVERRIDE" ? "MANUAL_STATUS" : null });
      return { flight: this.getFlight(f.flight_id), event: evt };
    });
  }

  /** Move a flight to another gate (GO-05). Rejects closed or occupied gates. */
  changeGate(p: { flightId: string; gateCode: string; actor: string; source?: string; baseVersion?: number; sourceSystem?: "CLOUD" | "EDGE" }) {
    const { db, bus } = this.ctx;
    return tx(db, () => {
      const f = this.getFlight(p.flightId);
      const gate = db.prepare(`SELECT * FROM gate WHERE gate_code = ?`).get(p.gateCode) as any;
      if (!gate) throw new AppError(404, "UNKNOWN_GATE", `Unknown gate ${p.gateCode}`);
      if (gate.status !== "OPEN") throw new AppError(409, "GATE_CLOSED", `Gate ${p.gateCode} is closed`);
      const current = db.prepare(`SELECT ga.*, g.gate_code FROM gate_assignment ga JOIN gate g ON g.gate_id = ga.gate_id
        WHERE ga.flight_id = ? AND ga.active = 1`).get(f.flight_id) as any;
      if (p.baseVersion !== undefined && current && current.version !== p.baseVersion)
        throw new AppError(409, "VERSION_CONFLICT", `Gate assignment for ${f.flight_number} changed since it was read`);
      const start = addMinutes(f.estimated_departure, -60), end = addMinutes(f.estimated_departure, 20);
      const clash = db.prepare(`SELECT ga.*, fl.flight_number FROM gate_assignment ga JOIN flight fl ON fl.flight_id = ga.flight_id
        WHERE ga.gate_id = ? AND ga.active = 1 AND ga.flight_id <> ? AND ga.start_time < ? AND ? < COALESCE(ga.end_time, '9999')`)
        .get(gate.gate_id, f.flight_id, end, start) as any;
      if (clash) throw new AppError(409, "GATE_OCCUPIED", `Gate ${p.gateCode} is already assigned to ${clash.flight_number}`);
      const version = (current?.version ?? 0) + 1;
      if (current) db.prepare(`UPDATE gate_assignment SET active = 0, end_time = ? WHERE gate_assignment_id = ?`).run(this.ctx.now(), current.gate_assignment_id);
      db.prepare(`INSERT INTO gate_assignment VALUES (?,?,?,?,?,1,?)`).run(id("ga"), f.flight_id, gate.gate_id, start, end, version);
      bus.record({ entity_type: "FLIGHT", entity_id: f.flight_id, event_type: "GATE_CHANGED", source: p.source ?? "CONTROLLER", version,
        details: { flightNumber: f.flight_number, fromGate: current?.gate_code ?? null, toGate: p.gateCode } });
      this.ctx.audit({ actor_id: p.actor, action: "GATE_CHANGE", entity_type: "FLIGHT", entity_id: f.flight_id,
        old_value: current?.gate_code ?? null, new_value: p.gateCode, source_system: p.sourceSystem ?? "CLOUD" });
      return { flightId: f.flight_id, fromGate: current?.gate_code ?? null, toGate: p.gateCode, version };
    });
  }

  setGateStatus(gateCode: string, status: "OPEN" | "CLOSED", actor: string, reason: string) {
    const { db, bus } = this.ctx;
    return tx(db, () => {
      const gate = db.prepare(`SELECT * FROM gate WHERE gate_code = ?`).get(gateCode) as any;
      if (!gate) throw new AppError(404, "UNKNOWN_GATE", `Unknown gate ${gateCode}`);
      db.prepare(`UPDATE gate SET status = ? WHERE gate_id = ?`).run(status, gate.gate_id);
      const affected = db.prepare(`SELECT f.flight_id, f.flight_number FROM gate_assignment ga JOIN flight f ON f.flight_id = ga.flight_id
        WHERE ga.gate_id = ? AND ga.active = 1 AND f.status IN ('SCHEDULED','DELAYED','BOARDING')`).all(gate.gate_id) as any[];
      bus.record({ entity_type: "GATE", entity_id: gate.gate_id, event_type: status === "CLOSED" ? "GATE_CLOSED" : "GATE_REOPENED",
        source: "FLIGHT_DATA", details: { gate: gateCode, reason, affectedFlights: affected.map((a) => a.flight_id) } });
      this.ctx.audit({ actor_id: actor, action: `GATE_${status}`, entity_type: "GATE", entity_id: gate.gate_id, new_value: status });
      return { gate: gateCode, status, affected };
    });
  }

  listGates() {
    return this.ctx.db.prepare(`SELECT g.gate_code, g.status,
      (SELECT f.flight_number FROM gate_assignment ga JOIN flight f ON f.flight_id = ga.flight_id
        WHERE ga.gate_id = g.gate_id AND ga.active = 1 AND f.status IN ('SCHEDULED','DELAYED','BOARDING') LIMIT 1) AS flight
      FROM gate g ORDER BY g.gate_code`).all();
  }

  /** First open gate that is free for this flight's departure window. */
  suggestGate(flightId: string, exclude: string[] = []) {
    const f = this.getFlight(flightId);
    const start = addMinutes(f.estimated_departure, -60), end = addMinutes(f.estimated_departure, 20);
    const gates = this.ctx.db.prepare(`SELECT * FROM gate WHERE status = 'OPEN' ORDER BY gate_code DESC`).all() as any[];
    return gates.find((g) => !exclude.includes(g.gate_code) && !this.ctx.db.prepare(`SELECT 1 FROM gate_assignment
      WHERE gate_id = ? AND active = 1 AND flight_id <> ? AND start_time < ? AND ? < COALESCE(end_time, '9999')`)
      .get(g.gate_id, flightId, end, start))?.gate_code ?? null;
  }
}
