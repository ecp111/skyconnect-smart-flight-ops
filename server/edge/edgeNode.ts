import { tx } from "../db/index.js";
import { addMinutes, AppError, id } from "../core.js";
import type { Ctx } from "../context.js";
import type { FlightOpsService } from "../services/flightOps.js";
import type { CrewSchedulingService } from "../services/crewScheduling.js";
import { evaluateCrew, loadCrewData, RULE_SET_VERSION, type CrewData } from "../services/compliance.js";

/**
 * Miami Hub Edge Node (NFR-REL-03, NFR-REL-04; ADR-05, Cloud Architecture 2.3 and 2.8).
 *
 * While the hub is online it keeps a recent snapshot of crew schedules, gate information,
 * Part 117 rules and the override console. When the hub loses its connection:
 *   - staff keep working against the local snapshot,
 *   - every change is saved to a local queue with a sequence number and the version it was based on,
 *   - crew changes can only be PROVISIONAL (checked locally against the cached Part 117 rules).
 * When the connection returns, queued changes are sent to the cloud in order. Version checks catch
 * conflicts, which are flagged for staff instead of silently overwriting. Provisional crew assignments
 * are re-verified by the cloud Compliance Engine before they are confirmed.
 */

interface Snapshot {
  takenAt: string;
  ruleSet: string;
  flights: { flight_id: string; flight_number: string; estimated_departure: string; estimated_arrival: string; aircraft_type: string; status: string }[];
  gates: { gate_code: string; status: string }[];
  gateAssignments: { flight_id: string; gate_code: string; version: number; start_time: string; end_time: string }[];
  crew: Record<string, CrewData>;
}

export class EdgeNode {
  online = true;
  constructor(private ctx: Ctx, private flightOps: FlightOpsService, private crew: CrewSchedulingService) {}

  /** Copy what the hub needs to keep working offline. Runs periodically while online. */
  refreshSnapshot() {
    const { db } = this.ctx;
    if (!this.online) return;
    const crewIds = (db.prepare(`SELECT crew_id FROM crew_member WHERE base = 'MIA'`).all() as any[]).map((c) => c.crew_id);
    const snap: Snapshot = {
      takenAt: this.ctx.now(),
      ruleSet: RULE_SET_VERSION,
      flights: db.prepare(`SELECT flight_id, flight_number, estimated_departure, estimated_arrival, aircraft_type, status FROM flight`).all() as any,
      gates: db.prepare(`SELECT gate_code, status FROM gate`).all() as any,
      gateAssignments: db.prepare(`SELECT ga.flight_id, g.gate_code, ga.version, ga.start_time, ga.end_time FROM gate_assignment ga
        JOIN gate g ON g.gate_id = ga.gate_id WHERE ga.active = 1`).all() as any,
      crew: Object.fromEntries(crewIds.map((cid) => [cid, loadCrewData(db, cid)])),
    };
    db.prepare(`DELETE FROM edge_snapshot`).run();
    db.prepare(`INSERT INTO edge_snapshot VALUES (?,?,?)`).run(id("snap"), snap.takenAt, JSON.stringify(snap));
  }

  private snapshot(): Snapshot {
    const row = this.ctx.db.prepare(`SELECT data FROM edge_snapshot LIMIT 1`).get() as any;
    if (!row) throw new AppError(503, "NO_SNAPSHOT", "Edge node has no local data yet");
    return JSON.parse(row.data);
  }

  private saveSnapshot(s: Snapshot) {
    this.ctx.db.prepare(`UPDATE edge_snapshot SET data = ?`).run(JSON.stringify(s));
  }

  goOffline(reason = "Hub uplink lost (Direct Connect and VPN down)") {
    if (!this.online) return;
    this.refreshSnapshot();
    this.online = false;
    this.ctx.bus.record({ entity_type: "AIRPORT", entity_id: "MIA", event_type: "HUB_CONNECTIVITY_LOST", source: "EDGE_NODE", details: { reason } });
  }

  async goOnline() {
    if (this.online) return this.status();
    this.online = true;
    this.ctx.bus.record({ entity_type: "AIRPORT", entity_id: "MIA", event_type: "HUB_CONNECTIVITY_RESTORED", source: "EDGE_NODE", details: {} });
    const result = this.sync();
    this.refreshSnapshot();
    return result;
  }

  private nextSequence() {
    return ((this.ctx.db.prepare(`SELECT MAX(sequence) m FROM edge_queue`).get() as any).m ?? 0) + 1;
  }

  /** Offline gate change, validated against the local snapshot. */
  queueGateChange(p: { flightId: string; gateCode: string; actor: string }) {
    if (this.online) throw new AppError(409, "HUB_ONLINE", "Hub is online; use the normal gate change");
    const s = this.snapshot();
    const f = s.flights.find((x) => x.flight_id === p.flightId);
    if (!f) throw new AppError(404, "UNKNOWN_FLIGHT", "Flight not in local data");
    const gate = s.gates.find((g) => g.gate_code === p.gateCode);
    if (!gate || gate.status !== "OPEN") throw new AppError(409, "GATE_CLOSED", `Gate ${p.gateCode} is not open (local data)`);
    const start = addMinutes(f.estimated_departure, -60), end = addMinutes(f.estimated_departure, 20);
    const clash = s.gateAssignments.find((a) => a.gate_code === p.gateCode && a.flight_id !== p.flightId && a.start_time < end && start < a.end_time);
    if (clash) throw new AppError(409, "GATE_OCCUPIED", `Gate ${p.gateCode} is in use (local data)`);
    const current = s.gateAssignments.find((a) => a.flight_id === p.flightId);
    const queueId = id("edq");
    this.ctx.db.prepare(`INSERT INTO edge_queue VALUES (?,?, 'GATE_CHANGE', ?, ?, ?, ?, 'QUEUED', NULL)`).run(queueId, this.nextSequence(),
      JSON.stringify({ flightId: p.flightId, flightNumber: f.flight_number, fromGate: current?.gate_code ?? null, toGate: p.gateCode }),
      current?.version ?? null, p.actor, this.ctx.now());
    // update the local view so hub staff see their own change
    s.gateAssignments = s.gateAssignments.filter((a) => a.flight_id !== p.flightId)
      .concat({ flight_id: p.flightId, gate_code: p.gateCode, version: (current?.version ?? 0) + 1, start_time: start, end_time: end });
    this.saveSnapshot(s);
    this.ctx.audit({ actor_id: p.actor, action: "GATE_CHANGE_QUEUED", entity_type: "FLIGHT", entity_id: p.flightId, old_value: current?.gate_code ?? null,
      new_value: p.gateCode, source_system: "EDGE" });
    return { queueId, status: "QUEUED" };
  }

  /** Offline crew change: checked locally with cached Part 117 rules, saved as PROVISIONAL. */
  queueProvisionalCrew(p: { flightId: string; crewId: string; role: string; actor: string; replaceAssignmentId?: string }) {
    if (this.online) throw new AppError(409, "HUB_ONLINE", "Hub is online; use the normal crew assignment");
    const s = this.snapshot();
    const f = s.flights.find((x) => x.flight_id === p.flightId);
    const data = s.crew[p.crewId];
    if (!f || !data) throw new AppError(404, "NOT_IN_LOCAL_DATA", "Flight or crew member not in local data");
    const res = evaluateCrew(data, { flight_id: p.flightId, duty_start: addMinutes(f.estimated_departure, -60), duty_end: f.estimated_arrival,
      aircraft_type: f.aircraft_type }, []);
    if (res.result === "FAIL")
      throw new AppError(403, "PART117_NO_OVERRIDE", `Blocked locally: ${res.violations[0].message} Part 117 checks cannot be overridden.`);
    const queueId = id("edq");
    this.ctx.db.prepare(`INSERT INTO edge_queue VALUES (?,?, 'PROVISIONAL_CREW_ASSIGNMENT', ?, NULL, ?, ?, 'QUEUED', NULL)`).run(queueId, this.nextSequence(),
      JSON.stringify({ ...p, flightNumber: f.flight_number, localCheck: "PASS", ruleSet: s.ruleSet }), p.actor, this.ctx.now());
    this.ctx.audit({ actor_id: p.actor, action: "PROVISIONAL_CREW_QUEUED", entity_type: "FLIGHT", entity_id: p.flightId, new_value: "PROVISIONAL", source_system: "EDGE" });
    return { queueId, status: "QUEUED", localCheck: res };
  }

  /** Send queued changes to the cloud in order. Duplicates are skipped, conflicts are flagged. */
  sync() {
    const { db, bus } = this.ctx;
    const items = db.prepare(`SELECT * FROM edge_queue WHERE status = 'QUEUED' ORDER BY sequence`).all() as any[];
    const summary = { applied: 0, conflicts: 0, rejected: 0, items: [] as any[] };
    for (const item of items) {
      const payload = JSON.parse(item.payload);
      let status: "APPLIED" | "CONFLICT" | "REJECTED" = "APPLIED";
      let result: any = null;
      try {
        if (item.kind === "GATE_CHANGE") {
          result = this.flightOps.changeGate({ flightId: payload.flightId, gateCode: payload.toGate, actor: item.actor_id, source: "EDGE_SYNC",
            baseVersion: item.base_version ?? undefined, sourceSystem: "EDGE" });
        } else if (item.kind === "PROVISIONAL_CREW_ASSIGNMENT") {
          const created = this.crew.assign({ flightId: payload.flightId, crewId: payload.crewId, role: payload.role, actor: item.actor_id,
            replaceAssignmentId: payload.replaceAssignmentId, status: "PROVISIONAL", source: "EDGE" });
          result = created.status === "PROVISIONAL" ? this.crew.verifyProvisional(created.assignmentId, "edge-sync") : created;
          if (result?.status !== "CONFIRMED") status = "REJECTED";
        }
      } catch (err) {
        const e = err as AppError;
        status = ["VERSION_CONFLICT", "GATE_OCCUPIED", "GATE_CLOSED"].includes(e.code) ? "CONFLICT" : "REJECTED";
        result = { code: e.code, message: e.message };
      }
      tx(db, () => {
        db.prepare(`UPDATE edge_queue SET status = ?, result = ? WHERE queue_id = ? AND status = 'QUEUED'`)
          .run(status, JSON.stringify(result), item.queue_id);
        if (status !== "APPLIED")
          bus.record({ entity_type: "EDGE_QUEUE", entity_id: item.queue_id, event_type: "SYNC_CONFLICT", source: "EDGE_SYNC",
            details: { kind: item.kind, ...payload, outcome: status, reason: result?.message ?? result?.compliance?.violations?.[0]?.message ?? "Rejected" } });
      });
      summary[status === "APPLIED" ? "applied" : status === "CONFLICT" ? "conflicts" : "rejected"]++;
      summary.items.push({ queueId: item.queue_id, kind: item.kind, status, payload, result });
    }
    bus.record({ entity_type: "AIRPORT", entity_id: "MIA", event_type: "EDGE_SYNC_COMPLETED", source: "EDGE_SYNC",
      details: { applied: summary.applied, conflicts: summary.conflicts, rejected: summary.rejected } });
    return summary;
  }

  /** Staff fix a sync conflict by choosing another gate. */
  resolveGateConflict(queueId: string, gateCode: string, actor: string) {
    const item = this.ctx.db.prepare(`SELECT * FROM edge_queue WHERE queue_id = ? AND status = 'CONFLICT'`).get(queueId) as any;
    if (!item) throw new AppError(404, "NO_CONFLICT", "No open conflict with that ID");
    const payload = JSON.parse(item.payload);
    const out = this.flightOps.changeGate({ flightId: payload.flightId, gateCode, actor, source: "CONTROLLER" });
    this.ctx.db.prepare(`UPDATE edge_queue SET status = 'APPLIED', result = ? WHERE queue_id = ?`)
      .run(JSON.stringify({ resolvedBy: actor, gate: gateCode }), queueId);
    return out;
  }

  status() {
    const { db } = this.ctx;
    const snap = db.prepare(`SELECT taken_at FROM edge_snapshot LIMIT 1`).get() as any;
    return {
      online: this.online,
      snapshotTakenAt: snap?.taken_at ?? null,
      ruleSet: RULE_SET_VERSION,
      queue: (db.prepare(`SELECT * FROM edge_queue ORDER BY sequence`).all() as any[]).map((q) => ({ ...q, payload: JSON.parse(q.payload), result: q.result ? JSON.parse(q.result) : null })),
      localView: this.online ? null : this.snapshot(),
    };
  }
}
