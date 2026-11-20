import type { DB } from "../db/index.js";
import { addMinutes, hoursBetween, localHour, MIAMI_UTC_OFFSET_HOURS } from "../core.js";

/**
 * Compliance Engine (CM-02, DM-02, NFR-FAA-01 to 03; ADR-02, ADR-06).
 *
 * Pilots (captain, first officer) are checked against a simplified version of
 * 14 CFR Part 117. Flight attendants are checked against 14 CFR 121.467 (domestic).
 * These rules are simplified for the prototype and are NOT a certified compliance tool.
 *
 * The rule functions are pure, so the Miami edge node can run the same checks offline
 * using its local snapshot (ADR-05).
 */

export const RULE_SET_VERSION = "P117-SIMPLIFIED-2026.1";

// Table B to Part 117: max flight duty period (hours), unaugmented, acclimated.
// Rows: report-time window (local). Columns: number of flight segments (1..7+).
const TABLE_B: { from: number; to: number; limits: number[] }[] = [
  { from: 0, to: 4, limits: [9, 9, 9, 9, 9, 9, 9] },
  { from: 4, to: 5, limits: [10, 10, 10, 10, 9, 9, 9] },
  { from: 5, to: 6, limits: [12, 12, 12, 12, 11.5, 11, 10.5] },
  { from: 6, to: 7, limits: [13, 13, 12, 12, 11.5, 11, 10.5] },
  { from: 7, to: 12, limits: [14, 14, 13, 13, 12.5, 12, 11.5] },
  { from: 12, to: 13, limits: [13, 13, 13, 13, 12.5, 12, 11.5] },
  { from: 13, to: 17, limits: [12, 12, 12, 12, 11.5, 11, 10.5] },
  { from: 17, to: 22, limits: [12, 12, 11, 11, 10, 9, 9] },
  { from: 22, to: 23, limits: [11, 11, 10, 10, 9, 9, 9] },
  { from: 23, to: 24, limits: [10, 10, 10, 9, 9, 9, 9] },
];

export function maxFlightDutyPeriod(reportIso: string, segments: number): number {
  const h = localHour(reportIso);
  const row = TABLE_B.find((r) => h >= r.from && h < r.to)!;
  return row.limits[Math.min(Math.max(segments, 1), 7) - 1];
}

export interface DutyPeriod {
  report: string;   // ISO
  release: string;  // ISO
  segments: number;
  label: string;
}

export interface Violation { rule: string; message: string }

export interface ComplianceResult {
  result: "PASS" | "FAIL";
  ruleSet: string;
  regulation: "14 CFR Part 117" | "14 CFR 121.467";
  violations: Violation[];
  checkedPeriod?: { report: string; release: string; segments: number; fdpHours: number; limitHours: number; restBeforeHours: number | null };
}

export type CrewRole = "CAPTAIN" | "FIRST_OFFICER" | "FLIGHT_ATTENDANT";

/** Pure rule check over a crew member's duty periods. `focus` is the period being decided. */
export function evaluateDutyPeriods(role: CrewRole, periods: DutyPeriod[], focus: DutyPeriod): ComplianceResult {
  const sorted = [...periods].sort((a, b) => a.report.localeCompare(b.report));
  const idx = sorted.findIndex((p) => p === focus);
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const restBefore = prev ? hoursBetween(prev.release, focus.report) : null;
  const dutyHours = hoursBetween(focus.report, focus.release);
  const violations: Violation[] = [];

  if (role === "FLIGHT_ATTENDANT") {
    if (restBefore !== null && restBefore < 9)
      violations.push({ rule: "121.467 REST_9H", message: `Only ${restBefore.toFixed(1)} h rest before duty; at least 9 h required.` });
    if (dutyHours > 14)
      violations.push({ rule: "121.467 DUTY_14H", message: `Duty period of ${dutyHours.toFixed(1)} h exceeds the 14 h limit.` });
    return {
      result: violations.length ? "FAIL" : "PASS", ruleSet: RULE_SET_VERSION, regulation: "14 CFR 121.467", violations,
      checkedPeriod: { report: focus.report, release: focus.release, segments: focus.segments, fdpHours: round(dutyHours), limitHours: 14, restBeforeHours: restBefore === null ? null : round(restBefore) },
    };
  }

  // Pilots: Part 117
  const limit = maxFlightDutyPeriod(focus.report, focus.segments);
  if (restBefore !== null && restBefore < 10)
    violations.push({ rule: "117.25(e) REST_10H", message: `Only ${restBefore.toFixed(1)} h rest before duty; at least 10 consecutive hours required.` });
  if (dutyHours > limit)
    violations.push({ rule: "117.13 FDP_TABLE_B", message: `Flight duty period of ${dutyHours.toFixed(1)} h exceeds the ${limit} h limit for a ${fmtLocal(focus.report)} report with ${focus.segments} segment(s).` });
  // 117.23(c)(1): no more than 60 FDP hours in any 168 consecutive hours
  const windowStart = addMinutes(focus.release, -168 * 60);
  const cumulative = sorted
    .filter((p) => p.release > windowStart && p.report <= focus.release)
    .reduce((sum, p) => sum + hoursBetween(p.report > windowStart ? p.report : windowStart, p.release), 0);
  if (cumulative > 60)
    violations.push({ rule: "117.23(c) FDP_60H_168H", message: `${cumulative.toFixed(1)} FDP hours in the last 168 h exceeds 60 h.` });
  // 117.25(b): 30 consecutive hours free from duty within the past 168 hours
  const longestRest = longestGap(sorted.filter((p) => p.release > windowStart), windowStart, focus.report);
  if (longestRest < 30)
    violations.push({ rule: "117.25(b) REST_30H_168H", message: `Longest rest in the past 168 h is ${longestRest.toFixed(1)} h; 30 h required.` });

  return {
    result: violations.length ? "FAIL" : "PASS", ruleSet: RULE_SET_VERSION, regulation: "14 CFR Part 117", violations,
    checkedPeriod: { report: focus.report, release: focus.release, segments: focus.segments, fdpHours: round(dutyHours), limitHours: limit, restBeforeHours: restBefore === null ? null : round(restBefore) },
  };
}

function longestGap(periods: DutyPeriod[], from: string, to: string) {
  let cursor = from, best = 0;
  for (const p of [...periods].sort((a, b) => a.report.localeCompare(b.report))) {
    if (p.report > cursor) best = Math.max(best, hoursBetween(cursor, p.report));
    if (p.release > cursor) cursor = p.release;
  }
  if (to > cursor) best = Math.max(best, hoursBetween(cursor, to));
  return best;
}

const round = (n: number) => Math.round(n * 10) / 10;
const fmtLocal = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + MIAMI_UTC_OFFSET_HOURS * 3_600_000);
  return d.toISOString().slice(11, 16);
};
const localDate = (iso: string) =>
  new Date(new Date(iso).getTime() + MIAMI_UTC_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------
// Data gathering: build duty periods from the database (cloud) or a snapshot (edge).

export interface CrewData {
  crew: { crew_id: string; role: CrewRole; qualifications: string; availability: string };
  history: { report_time: string; release_time: string; segments: number }[];
  assignments: { assignment_id: string; flight_id: string; duty_start: string; duty_end: string; status: string }[];
}

export interface ProposedAssignment { flight_id: string; duty_start: string; duty_end: string; aircraft_type: string }

/** Check a crew member's schedule, optionally with a proposed new assignment and without some existing ones. */
export function evaluateCrew(data: CrewData, proposed?: ProposedAssignment, excludeAssignmentIds: string[] = []): ComplianceResult & { qualified: boolean } {
  const qualified = proposed ? data.crew.qualifications.split(",").includes(proposed.aircraft_type) : true;
  const active = data.assignments.filter((a) =>
    (a.status === "CONFIRMED" || a.status === "PROVISIONAL") && !excludeAssignmentIds.includes(a.assignment_id));
  const legs = [...active.map((a) => ({ start: a.duty_start, end: a.duty_end, proposed: false })),
    ...(proposed ? [{ start: proposed.duty_start, end: proposed.duty_end, proposed: true }] : [])];

  // Group today's legs into duty periods by local report date
  const byDay = new Map<string, typeof legs>();
  for (const l of legs) {
    const k = localDate(l.start);
    byDay.set(k, [...(byDay.get(k) ?? []), l]);
  }
  const periods: (DutyPeriod & { hasProposed: boolean })[] = [
    ...data.history.map((h) => ({ report: h.report_time, release: h.release_time, segments: h.segments, label: "history", hasProposed: false })),
    ...[...byDay.values()].map((ls) => ({
      report: ls.map((l) => l.start).sort()[0],
      release: ls.map((l) => l.end).sort().at(-1)!,
      segments: ls.length,
      label: "scheduled",
      hasProposed: ls.some((l) => l.proposed),
    })),
  ];
  const scheduled = periods.filter((p) => p.label === "scheduled");
  if (!scheduled.length) return { result: "PASS", ruleSet: RULE_SET_VERSION, regulation: "14 CFR Part 117", violations: [], qualified };
  const focus = scheduled.find((p) => p.hasProposed) ?? scheduled.sort((a, b) => b.release.localeCompare(a.release))[0];
  const res = evaluateDutyPeriods(data.crew.role, periods, focus);
  if (!qualified) res.violations.unshift({ rule: "QUALIFICATION", message: `Not qualified on the ${proposed!.aircraft_type}.` });
  // Overlap: the same person cannot be on two duties at once
  if (proposed) {
    const clash = active.find((a) => a.duty_start < proposed.duty_end && proposed.duty_start < a.duty_end);
    if (clash) res.violations.unshift({ rule: "OVERLAP", message: `Overlaps an existing assignment (${clash.flight_id}).` });
  }
  return { ...res, result: res.violations.length ? "FAIL" : "PASS", qualified };
}

export function loadCrewData(db: DB, crewId: string): CrewData {
  const crew = db.prepare(`SELECT crew_id, role, qualifications, availability FROM crew_member WHERE crew_id = ?`).get(crewId) as CrewData["crew"];
  const history = db.prepare(`SELECT report_time, release_time, segments FROM duty_history WHERE crew_id = ?`).all(crewId) as CrewData["history"];
  const assignments = db.prepare(`SELECT assignment_id, flight_id, duty_start, duty_end, status FROM crew_assignment WHERE crew_id = ?`).all(crewId) as CrewData["assignments"];
  return { crew, history, assignments };
}

/** Duty window for a flight: report 60 minutes before departure, release at arrival. */
export function dutyWindow(flight: { estimated_departure: string; estimated_arrival: string }) {
  return { duty_start: addMinutes(flight.estimated_departure, -60), duty_end: flight.estimated_arrival };
}
