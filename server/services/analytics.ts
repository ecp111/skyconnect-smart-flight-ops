import type { Ctx } from "../context.js";
import { hoursBetween } from "../core.js";

/**
 * Analytics Service (AR-01 to AR-04; Database Architecture 3.6).
 * Simulates the separate data warehouse: executive figures are refreshed on a schedule and
 * show when they were last updated. Controllers can request live figures.
 */
export class AnalyticsService {
  private snapshot: any = null;
  constructor(private ctx: Ctx, private refreshEveryMs = 30_000) {}

  get(live = false) {
    const stale = !this.snapshot || Date.now() - this.snapshot.refreshedAtMs > this.refreshEveryMs;
    if (live || stale) this.snapshot = { ...this.compute(), refreshedAtMs: Date.now() };
    return { ...this.snapshot, mode: live ? "LIVE" : "WAREHOUSE" };
  }

  private compute() {
    const { db } = this.ctx;
    const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;

    // AR-01 on-time performance: arrived within 15 minutes of schedule
    const arrived = db.prepare(`SELECT scheduled_arrival, actual_arrival FROM flight WHERE status = 'ARRIVED'`).all() as any[];
    const onTime = arrived.filter((f) => hoursBetween(f.scheduled_arrival, f.actual_arrival) * 60 <= 15).length;
    const departures = one(`SELECT COUNT(*) n, SUM(delay_minutes > 15) delayed, ROUND(AVG(delay_minutes), 0) avgDelay,
      SUM(status = 'CANCELLED') cancelled FROM flight WHERE origin = 'MIA'`);
    const byCause = db.prepare(`SELECT COALESCE(delay_cause, 'NONE') cause, COUNT(*) n FROM flight WHERE delay_minutes > 15 GROUP BY cause`).all();

    // Crew coverage gaps: flights missing a confirmed captain or first officer, or with an open rest conflict
    const crewGaps = one(`SELECT COUNT(*) n FROM flight f WHERE f.status IN ('SCHEDULED','DELAYED','BOARDING') AND (
      NOT EXISTS (SELECT 1 FROM crew_assignment WHERE flight_id = f.flight_id AND assigned_role = 'CAPTAIN' AND status = 'CONFIRMED')
      OR NOT EXISTS (SELECT 1 FROM crew_assignment WHERE flight_id = f.flight_id AND assigned_role = 'FIRST_OFFICER' AND status = 'CONFIRMED')
      OR EXISTS (SELECT 1 FROM crew_assignment ca WHERE ca.flight_id = f.flight_id AND ca.status = 'CONFIRMED'
        AND (SELECT result FROM rest_check WHERE assignment_id = ca.assignment_id ORDER BY checked_at DESC, rowid DESC LIMIT 1) = 'FAIL'))`).n;
    const restViolationsPrevented = one(`SELECT COUNT(*) n FROM operations_event WHERE event_type IN ('CREW_REST_CONFLICT','CREW_ASSIGNMENT_BLOCKED')`).n;

    // Rebooking and notifications
    const rb = one(`SELECT COUNT(*) total, SUM(status = 'CONFIRMED') confirmed, SUM(status = 'FAILED') failed, SUM(status = 'PENDING') pending,
      SUM(needs_review) review FROM rebooking`);
    const rbTimes = db.prepare(`SELECT created_at, resolved_at FROM rebooking WHERE status = 'CONFIRMED'`).all() as any[];
    const avgRebookSeconds = rbTimes.length ? Math.round(rbTimes.reduce((s, r) => s + hoursBetween(r.created_at, r.resolved_at) * 3600, 0) / rbTimes.length) : null;
    const nt = one(`SELECT COUNT(*) total, SUM(delivery_status = 'SENT') sent, SUM(delivery_status = 'DEAD_LETTER') dead, SUM(retry_count) retries FROM notification`);
    const paxDelay = db.prepare(`SELECT event_occurred_at, sent_at FROM notification n JOIN operations_event e ON e.event_id = n.triggered_by_event_id
      WHERE n.passenger_id IS NOT NULL AND e.event_type = 'FLIGHT_DELAYED'`).all() as any[];
    const within90 = paxDelay.filter((n) => n.sent_at && hoursBetween(n.event_occurred_at, n.sent_at) * 3600 <= 90).length;

    // Gates, baggage, AR-02..04
    const gateUse = one(`SELECT COUNT(DISTINCT gate_id) used, (SELECT COUNT(*) FROM gate WHERE status = 'OPEN') open FROM gate_assignment WHERE active = 1`);
    const sat = one(`SELECT ROUND(AVG(score), 1) avg, COUNT(score) responses, COUNT(*) invited FROM passenger_feedback`);
    const db_ = one(`SELECT SUM(outcome_type = 'DENIED_INVOLUNTARY') denied, COUNT(*) total FROM boarding_outcome`);
    const cost = one(`SELECT ROUND(SUM(amount), 0) total FROM disruption_cost`);
    const overrides = one(`SELECT COUNT(*) n FROM operations_event WHERE event_type = 'MANUAL_OVERRIDE'`).n;
    const deadLetters = one(`SELECT COUNT(*) n FROM dead_letter WHERE resolved = 0`).n;

    return {
      refreshedAt: this.ctx.now(),
      onTimePerformance: { arrived: arrived.length, onTime, percent: arrived.length ? Math.round((onTime / arrived.length) * 100) : null, baselinePercent: 67, targetPercent: 85 },
      departures: { total: departures.n, delayed: departures.delayed ?? 0, cancelled: departures.cancelled ?? 0, avgDelayMinutes: departures.avgDelay ?? 0, byCause },
      crew: { coverageGaps: crewGaps, baselineGapsPerWeek: 8, restViolationsPrevented },
      rebooking: { total: rb.total, confirmed: rb.confirmed ?? 0, failed: rb.failed ?? 0, pending: rb.pending ?? 0, needsReview: rb.review ?? 0, avgCompletionSeconds: avgRebookSeconds },
      notifications: { total: nt.total, sent: nt.sent ?? 0, deadLettered: nt.dead ?? 0, retries: nt.retries ?? 0,
        delayAlerts: paxDelay.length, delayAlertsWithin90s: within90, within90Percent: paxDelay.length ? Math.round((within90 / paxDelay.length) * 100) : null },
      gates: { inUse: gateUse.used, open: gateUse.open },
      satisfaction: { average: sat.avg, responses: sat.responses, invited: sat.invited, target: 8.5 },
      deniedBoarding: { involuntary: db_.denied ?? 0, boarded: db_.total },
      financialImpact: { disruptionCostUsd: cost.total ?? 0 },
      overrides, deadLetters,
    };
  }
}
