import { tx } from "../db/index.js";
import { AppError, id } from "../core.js";
import type { Ctx } from "../context.js";
import type { OpsEvent } from "../bus/eventBus.js";
import { dutyWindow, evaluateCrew, loadCrewData, type ComplianceResult } from "./compliance.js";

/**
 * Crew Scheduling Service (CM-01, CM-03, DM-02; ADR-02, ADR-06).
 *
 * - Assignments are confirmed only after a SYNCHRONOUS Compliance Engine check passes
 *   (NFR-FAA-01, NFR-FAA-02). An illegal assignment is never saved as CONFIRMED.
 * - When a flight is delayed, every crew member on it is rechecked automatically
 *   (NFR-FAA-03). A violation is recorded as a REST_CHECK FAIL plus a CREW_REST_CONFLICT
 *   event, and a replacement recommendation is created for the scheduler.
 */

export class CrewSchedulingService {
  constructor(private ctx: Ctx) {
    ctx.bus.subscribe("crew-scheduling", ["FLIGHT_DELAYED", "FLIGHT_STATUS_UPDATED"], (e) => this.onFlightChanged(e));
  }

  /** Synchronous call to the Compliance Engine, recorded as REST_CHECK evidence. */
  private recordCheck(assignmentId: string, res: ComplianceResult, source: "CLOUD" | "EDGE") {
    let evidence: string;
    try { evidence = this.ctx.sims.faa.ruleSetEvidence(); } catch { evidence = `CACHED_RULES:${res.ruleSet}`; }
    const checkId = id("chk");
    this.ctx.db.prepare(`INSERT INTO rest_check VALUES (?,?,?,?,?,?,?,?)`).run(
      checkId, assignmentId, res.result, res.violations[0]?.rule ?? res.regulation,
      JSON.stringify({ violations: res.violations, period: res.checkedPeriod }), this.ctx.now(), source, evidence);
    return checkId;
  }

  private onFlightChanged(e: OpsEvent) {
    const { db, bus } = this.ctx;
    const flight = db.prepare(`SELECT * FROM flight WHERE flight_id = ?`).get(e.entity_id) as any;
    if (!flight || flight.status === "CANCELLED") return;
    const window = dutyWindow(flight);
    const crew = db.prepare(`SELECT ca.*, cm.name, cm.role FROM crew_assignment ca JOIN crew_member cm ON cm.crew_id = ca.crew_id
      WHERE ca.flight_id = ? AND ca.status IN ('CONFIRMED','PROVISIONAL')`).all(flight.flight_id) as any[];
    tx(db, () => {
      for (const a of crew) {
        db.prepare(`UPDATE crew_assignment SET duty_start = ?, duty_end = ? WHERE assignment_id = ?`)
          .run(window.duty_start, window.duty_end, a.assignment_id);
        const res = evaluateCrew(loadCrewData(db, a.crew_id));
        const checkId = this.recordCheck(a.assignment_id, res, "CLOUD");
        if (res.result === "FAIL") {
          bus.record({
            entity_type: "CREW_ASSIGNMENT", entity_id: a.assignment_id, event_type: "CREW_REST_CONFLICT", source: "COMPLIANCE_ENGINE",
            details: { flightId: flight.flight_id, flightNumber: flight.flight_number, crewId: a.crew_id, role: a.assigned_role,
              rule: res.violations[0].rule, message: res.violations[0].message, checkId, triggeredBy: e.event_id },
          });
          this.createReplacementRecommendation(flight, a);
        }
      }
    });
  }

  /** Rank reserve crew for a conflicted assignment; every candidate gets a full compliance check. */
  candidatesFor(flightId: string, role: string, excludeAssignmentId?: string) {
    const { db } = this.ctx;
    const flight = db.prepare(`SELECT * FROM flight WHERE flight_id = ?`).get(flightId) as any;
    const window = dutyWindow(flight);
    const reserves = db.prepare(`SELECT * FROM crew_member WHERE role = ? AND availability = 'RESERVE' ORDER BY name`).all(role) as any[];
    return reserves.map((c) => {
      const res = evaluateCrew(loadCrewData(db, c.crew_id), { flight_id: flightId, ...window, aircraft_type: flight.aircraft_type });
      return { crewId: c.crew_id, name: c.name, legal: res.result === "PASS", violations: res.violations, period: res.checkedPeriod };
    }).sort((a, b) => Number(b.legal) - Number(a.legal));
  }

  private createReplacementRecommendation(flight: any, a: any) {
    const { db } = this.ctx;
    const open = db.prepare(`SELECT 1 FROM recommendation WHERE type = 'CREW_REPLACEMENT' AND status = 'OPEN'
      AND json_extract(details, '$.assignmentId') = ?`).get(a.assignment_id);
    if (open) return;
    const candidates = this.candidatesFor(flight.flight_id, a.assigned_role, a.assignment_id);
    db.prepare(`INSERT INTO recommendation VALUES (?, 'CREW_REPLACEMENT', ?, ?, 'OPEN', ?, NULL, NULL, NULL)`).run(
      id("rec"), flight.flight_id, JSON.stringify({
        assignmentId: a.assignment_id, crewId: a.crew_id, crewName: a.name, role: a.assigned_role,
        flightNumber: flight.flight_number, suggestedCrewId: candidates.find((c) => c.legal)?.crewId ?? null, candidates,
      }), this.ctx.now());
  }

  /**
   * Assign crew to a flight. Runs the compliance check first and refuses illegal assignments.
   * `replaceAssignmentId` removes the conflicted crew member in the same transaction.
   * PROVISIONAL is used by a supervisor when the full check cannot be completed (edge/outage);
   * a provisional assignment cannot release a flight until it is re-verified.
   */
  assign(p: { flightId: string; crewId: string; role: string; actor: string; replaceAssignmentId?: string;
    status?: "CONFIRMED" | "PROVISIONAL"; source?: "CLOUD" | "EDGE"; overrideReference?: string }) {
    const { db, bus } = this.ctx;
    return tx(db, () => {
      const flight = db.prepare(`SELECT * FROM flight WHERE flight_id = ?`).get(p.flightId) as any;
      if (!flight) throw new AppError(404, "UNKNOWN_FLIGHT", "Unknown flight");
      const crew = db.prepare(`SELECT * FROM crew_member WHERE crew_id = ?`).get(p.crewId) as any;
      if (!crew) throw new AppError(404, "UNKNOWN_CREW", "Unknown crew member");
      if (crew.role !== p.role) throw new AppError(400, "ROLE_MISMATCH", `${crew.name} is not a ${p.role}`);
      const window = dutyWindow(flight);
      const res = evaluateCrew(loadCrewData(db, p.crewId), { flight_id: p.flightId, ...window, aircraft_type: flight.aircraft_type });
      const assignmentId = id("asg");
      const status = res.result === "PASS" ? (p.status ?? "CONFIRMED") : "REJECTED";
      db.prepare(`INSERT INTO crew_assignment VALUES (?,?,?,?,?,?,?,?,?,?)`).run(assignmentId, p.crewId, p.flightId, p.role,
        window.duty_start, window.duty_end, status, p.overrideReference ?? null, p.actor, this.ctx.now());
      const checkId = this.recordCheck(assignmentId, res, p.source ?? "CLOUD");
      this.ctx.audit({ actor_id: p.actor, action: "CREW_ASSIGN", entity_type: "CREW_ASSIGNMENT", entity_id: assignmentId,
        new_value: status, source_system: p.source ?? "CLOUD", override_reason_code: p.overrideReference ? "OVERRIDE" : null });
      if (res.result === "FAIL") {
        bus.record({ entity_type: "CREW_ASSIGNMENT", entity_id: assignmentId, event_type: "CREW_ASSIGNMENT_BLOCKED", source: "COMPLIANCE_ENGINE",
          details: { flightId: p.flightId, crewId: p.crewId, rule: res.violations[0].rule, message: res.violations[0].message, checkId } });
        return { assignmentId, status, compliance: res };
      }
      if (p.replaceAssignmentId) this.remove(p.replaceAssignmentId, p.actor, "REPLACED", false);
      bus.record({ entity_type: "CREW_ASSIGNMENT", entity_id: assignmentId, event_type: status === "CONFIRMED" ? "CREW_ASSIGNED" : "CREW_ASSIGNED_PROVISIONAL",
        source: p.source === "EDGE" ? "EDGE_NODE" : "CREW_SCHEDULING",
        details: { flightId: p.flightId, flightNumber: flight.flight_number, crewId: p.crewId, role: p.role, replaced: p.replaceAssignmentId ?? null, checkId } });
      return { assignmentId, status, compliance: res };
    });
  }

  remove(assignmentId: string, actor: string, reason: string, wrap = true) {
    const run = () => {
      const a = this.ctx.db.prepare(`SELECT ca.*, f.flight_number FROM crew_assignment ca JOIN flight f ON f.flight_id = ca.flight_id
        WHERE assignment_id = ?`).get(assignmentId) as any;
      if (!a) throw new AppError(404, "UNKNOWN_ASSIGNMENT", "Unknown assignment");
      this.ctx.db.prepare(`UPDATE crew_assignment SET status = 'REMOVED' WHERE assignment_id = ?`).run(assignmentId);
      this.ctx.bus.record({ entity_type: "CREW_ASSIGNMENT", entity_id: assignmentId, event_type: "CREW_ASSIGNMENT_REMOVED", source: "CREW_SCHEDULING",
        details: { flightId: a.flight_id, flightNumber: a.flight_number, crewId: a.crew_id, reason } });
      this.ctx.audit({ actor_id: actor, action: "CREW_REMOVE", entity_type: "CREW_ASSIGNMENT", entity_id: assignmentId, old_value: a.status, new_value: "REMOVED", override_reason_code: reason });
    };
    return wrap ? tx(this.ctx.db, run) : run();
  }

  /** Re-verify a PROVISIONAL assignment once the full check is possible (after edge sync). */
  verifyProvisional(assignmentId: string, actor: string) {
    const { db, bus } = this.ctx;
    return tx(db, () => {
      const a = db.prepare(`SELECT * FROM crew_assignment WHERE assignment_id = ?`).get(assignmentId) as any;
      if (!a || a.status !== "PROVISIONAL") return null;
      // Evaluate as if this assignment were being added now, so rest, FDP, overlap and qualification all run.
      const flight = db.prepare(`SELECT * FROM flight WHERE flight_id = ?`).get(a.flight_id) as any;
      const final = evaluateCrew(loadCrewData(db, a.crew_id), { flight_id: a.flight_id, ...dutyWindow(flight), aircraft_type: flight.aircraft_type }, [assignmentId]);
      const status = final.result === "PASS" ? "CONFIRMED" : "REJECTED";
      db.prepare(`UPDATE crew_assignment SET status = ? WHERE assignment_id = ?`).run(status, assignmentId);
      const checkId = this.recordCheck(assignmentId, final, "CLOUD");
      bus.record({ entity_type: "CREW_ASSIGNMENT", entity_id: assignmentId, event_type: status === "CONFIRMED" ? "CREW_ASSIGNED" : "CREW_ASSIGNMENT_BLOCKED",
        source: "COMPLIANCE_ENGINE", details: { flightId: a.flight_id, flightNumber: flight.flight_number, crewId: a.crew_id, role: a.assigned_role, verifiedFrom: "PROVISIONAL", checkId,
          rule: final.violations[0]?.rule ?? null, message: final.violations[0]?.message ?? null } });
      this.ctx.audit({ actor_id: actor, action: "PROVISIONAL_VERIFIED", entity_type: "CREW_ASSIGNMENT", entity_id: assignmentId, old_value: "PROVISIONAL", new_value: status });
      return { assignmentId, status, compliance: final };
    });
  }

  crewView(crewId: string) {
    const { db } = this.ctx;
    const crew = db.prepare(`SELECT crew_id, name, role, base, qualifications, availability FROM crew_member WHERE crew_id = ?`).get(crewId);
    if (!crew) throw new AppError(404, "UNKNOWN_CREW", "Unknown crew member");
    const assignments = db.prepare(`SELECT ca.assignment_id, ca.status, ca.assigned_role, ca.duty_start, ca.duty_end, f.flight_number, f.origin,
      f.destination, f.estimated_departure, f.status AS flight_status, f.delay_minutes,
      (SELECT result FROM rest_check rc WHERE rc.assignment_id = ca.assignment_id ORDER BY checked_at DESC, rc.rowid DESC LIMIT 1) AS last_check
      FROM crew_assignment ca JOIN flight f ON f.flight_id = ca.flight_id WHERE ca.crew_id = ? ORDER BY ca.duty_start`).all(crewId);
    const compliance = evaluateCrew(loadCrewData(db, crewId));
    const notifications = db.prepare(`SELECT * FROM notification WHERE crew_id = ? ORDER BY created_at DESC`).all(crewId);
    return { crew, assignments, compliance, notifications };
  }

  listCrew() {
    return this.ctx.db.prepare(`SELECT crew_id, name, role, availability, qualifications FROM crew_member ORDER BY role, name`).all();
  }
}
