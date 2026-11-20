import { tx } from "../db/index.js";
import { AppError } from "../core.js";
import type { Ctx } from "../context.js";
import type { FlightOpsService } from "./flightOps.js";
import type { CrewSchedulingService } from "./crewScheduling.js";

/**
 * Manual Override Console (DM-05, NFR-SAFE-01, NFR-REL-04; ADR-06).
 * Authorized staff can accept, reject or override automated decisions. Every decision is
 * logged with who, when and why. The one firm limit: no one can confirm a crew assignment
 * that the Compliance Engine flags as illegal under Part 117 (NFR-FAA-02).
 */
export class OverrideService {
  constructor(private ctx: Ctx, private flightOps: FlightOpsService, private crew: CrewSchedulingService) {}

  listRecommendations(status = "OPEN") {
    return (this.ctx.db.prepare(`SELECT r.*, f.flight_number FROM recommendation r JOIN flight f ON f.flight_id = r.flight_id
      WHERE (? = 'ALL' OR r.status = ?) ORDER BY r.created_at DESC`).all(status, status) as any[])
      .map((r) => ({ ...r, details: JSON.parse(r.details) }));
  }

  /** Accept or reject a recommendation. Accepting a crew replacement still runs the full compliance check. */
  decide(p: { recommendationId: string; decision: "ACCEPT" | "REJECT"; actor: string; reason: string; chosenCrewId?: string; gateCode?: string }) {
    const { db, bus } = this.ctx;
    const rec = db.prepare(`SELECT * FROM recommendation WHERE recommendation_id = ?`).get(p.recommendationId) as any;
    if (!rec) throw new AppError(404, "UNKNOWN_RECOMMENDATION", "Unknown recommendation");
    if (rec.status !== "OPEN") throw new AppError(409, "ALREADY_DECIDED", `Already ${rec.status.toLowerCase()}`);
    if (!p.reason?.trim()) throw new AppError(400, "REASON_REQUIRED", "A reason is required for every override decision");
    const details = JSON.parse(rec.details);
    let outcome: unknown = null;

    if (p.decision === "ACCEPT") {
      if (rec.type === "CREW_REPLACEMENT") {
        const crewId = p.chosenCrewId ?? details.suggestedCrewId;
        if (!crewId) throw new AppError(409, "NO_LEGAL_CANDIDATE", "No legal replacement is available; escalate to crew scheduling");
        outcome = this.crew.assign({ flightId: rec.flight_id, crewId, role: details.role, actor: p.actor, replaceAssignmentId: details.assignmentId,
          overrideReference: p.recommendationId });
        if ((outcome as any).status === "REJECTED") {
          const v = (outcome as any).compliance.violations[0];
          this.ctx.audit({ actor_id: p.actor, action: "OVERRIDE_BLOCKED_PART117", entity_type: "RECOMMENDATION", entity_id: rec.recommendation_id,
            new_value: crewId, override_reason_code: v.rule });
          throw new AppError(403, "PART117_NO_OVERRIDE", `Blocked: ${v.message} Part 117 checks cannot be overridden.`);
        }
      } else if (rec.type === "GATE_REASSIGNMENT") {
        outcome = this.flightOps.changeGate({ flightId: rec.flight_id, gateCode: p.gateCode ?? details.toGate, actor: p.actor, source: "CONTROLLER" });
      } else if (rec.type === "REROUTE") {
        outcome = { reroute: "Filed with dispatch", addedMinutes: details.addedMinutes };
      }
    }

    tx(db, () => {
      db.prepare(`UPDATE recommendation SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ? WHERE recommendation_id = ?`)
        .run(p.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED", p.actor, this.ctx.now(), p.reason, rec.recommendation_id);
      bus.record({ entity_type: "RECOMMENDATION", entity_id: rec.recommendation_id, event_type: "MANUAL_OVERRIDE", source: "OVERRIDE_CONSOLE",
        details: { type: rec.type, decision: p.decision, flightId: rec.flight_id, actor: p.actor } });
      this.ctx.audit({ actor_id: p.actor, action: `RECOMMENDATION_${p.decision}`, entity_type: "RECOMMENDATION", entity_id: rec.recommendation_id,
        old_value: "OPEN", new_value: p.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED", override_reason_code: reasonCode(p.reason) });
    });
    return { recommendationId: rec.recommendation_id, decision: p.decision, outcome };
  }

  /** Direct manual actions when automation is unavailable or staff disagree with it. */
  manualFlightStatus(p: { flightId: string; status?: string; delayMinutes?: number; actor: string; reason: string }) {
    if (!p.reason?.trim()) throw new AppError(400, "REASON_REQUIRED", "A reason is required");
    const out = this.flightOps.applyStatusUpdate({ flightId: p.flightId, source: "MANUAL_OVERRIDE", status: p.status,
      delayMinutes: p.delayMinutes, cause: "MANUAL", actor: p.actor });
    this.ctx.bus.record({ entity_type: "FLIGHT", entity_id: p.flightId, event_type: "MANUAL_OVERRIDE", source: "OVERRIDE_CONSOLE",
      details: { type: "FLIGHT_STATUS", status: p.status ?? null, delayMinutes: p.delayMinutes ?? null, actor: p.actor } });
    return out;
  }

  /** A forced crew assignment still goes through the compliance check; illegal ones are refused. */
  forceCrewAssignment(p: { flightId: string; crewId: string; role: string; actor: string; reason: string; replaceAssignmentId?: string }) {
    if (!p.reason?.trim()) throw new AppError(400, "REASON_REQUIRED", "A reason is required");
    const out = this.crew.assign({ ...p, overrideReference: "MANUAL" });
    if (out.status === "REJECTED") {
      const v = out.compliance.violations[0];
      this.ctx.audit({ actor_id: p.actor, action: "OVERRIDE_BLOCKED_PART117", entity_type: "CREW_ASSIGNMENT", entity_id: out.assignmentId,
        override_reason_code: v.rule });
      throw new AppError(403, "PART117_NO_OVERRIDE", `Blocked: ${v.message} Part 117 checks cannot be overridden.`);
    }
    return out;
  }

  auditLog(limit = 100) {
    return this.ctx.db.prepare(`SELECT * FROM audit_log ORDER BY occurred_at DESC, rowid DESC LIMIT ?`).all(limit);
  }
}

const reasonCode = (reason: string) => reason.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 40);
