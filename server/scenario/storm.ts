import type { System } from "../system.js";
import { miamiLocal, SIM_DAY, localTime } from "../core.js";
import { AppError } from "../core.js";

/**
 * Storm scenario: plays out the Assignment 3 Failure Scenario on SC 1042, step by step.
 * Each step is labeled with the Failure Scenario heading it demonstrates.
 */

export interface ScenarioStep { n: number; heading: string; title: string; lines: string[]; at: string }

export class StormScenario {
  running = false;
  done = false;
  steps: ScenarioStep[] = [];
  error: string | null = null;

  constructor(private sys: System, private paceMs = 3500) {}

  private sleep() { return new Promise((r) => setTimeout(r, this.paceMs)); }

  private push(heading: string, title: string, lines: string[]) {
    this.steps.push({ n: this.steps.length + 1, heading, title, lines, at: this.sys.ctx.now() });
  }

  async run() {
    if (this.running) throw new AppError(409, "ALREADY_RUNNING", "The storm scenario is already running");
    this.running = true;
    try {
      await this.play();
      this.done = true;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.running = false;
    }
  }

  private async play() {
    const { db, bus, adapters, flightOps, override, edge, rebooking, sims, analytics } = this.sys;
    const q = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
    const all = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];

    // 1. Detect ---------------------------------------------------------------------------
    adapters.weather.ingest({ severity: "SEVERE", description: "Severe thunderstorms with lightning over MIA; ramp operations suspended",
      windowStart: miamiLocal(`${SIM_DAY}T13:30`), windowEnd: miamiLocal(`${SIM_DAY}T17:30`), delayMinutes: 120 });
    const sc1042 = q(`SELECT * FROM flight WHERE flight_id = 'f-sc1042'`);
    adapters.acars.ingest({ aircraftId: sc1042.aircraft_id, type: "GATE_HOLD", note: "Ramp closed, lightning within 5 miles" });
    await bus.drain();
    const delayed = all(`SELECT flight_number, delay_minutes FROM flight WHERE status = 'DELAYED' ORDER BY scheduled_departure`);
    const f = q(`SELECT * FROM flight WHERE flight_id = 'f-sc1042'`);
    this.push("How the system detects the problem", "Weather alert and ACARS gate hold arrive", [
      "The simulated weather service sends a severe-storm alert; ACARS reports SC 1042's aircraft held at the gate.",
      `Disruption Management delayed ${delayed.length} departures: ${delayed.map((d) => `${d.flight_number} (+${d.delay_minutes}m)`).join(", ")}.`,
      `SC 1042 now departs ${localTime(f.estimated_departure)} instead of ${localTime(f.scheduled_departure)} (DM-01). Each update was checked for source, version and freshness (FS-01).`,
      `Flights already in the air received a weather reroute recommendation (DM-03).`,
    ]);
    await this.sleep();

    // 2. Coordinate: gate change ------------------------------------------------------------
    flightOps.setGateStatus("D22", "CLOSED", "u-ctrl", "LIGHTNING_DAMAGE");
    await bus.drain();
    const gateRec = q(`SELECT * FROM recommendation WHERE type = 'GATE_REASSIGNMENT' AND flight_id = 'f-sc1042' AND status = 'OPEN'`);
    override.decide({ recommendationId: gateRec.recommendation_id, decision: "ACCEPT", actor: "u-ctrl", reason: "Gate D22 closed", gateCode: "D30" });
    await bus.drain();
    const conflict = q(`SELECT details FROM operations_event WHERE event_type = 'CREW_REST_CONFLICT' AND json_extract(details,'$.flightId') = 'f-sc1042'`);
    const cd = conflict ? JSON.parse(conflict.details) : null;
    const crewRec = q(`SELECT * FROM recommendation WHERE type = 'CREW_REPLACEMENT' AND flight_id = 'f-sc1042' AND status = 'OPEN'`);
    const cands = crewRec ? JSON.parse(crewRec.details).candidates : [];
    this.push("How services are coordinated", "One delay event, every service reacts", [
      "Gate D22 closed. Disruption Management recommended a new gate; the controller accepted and moved SC 1042 to D30 (GO-05). The dashboard, gate agents and passengers all got the change from one GATE_CHANGED event.",
      cd ? `Crew Scheduling rechecked every crew member (NFR-FAA-03) and caught Capt. Diaz before it happened (DM-02): ${cd.message}` : "No crew conflicts found.",
      `Replacement candidates, each fully checked: ${cands.map((c: any) => `${c.name} ${c.legal ? "LEGAL" : `NOT LEGAL (${c.violations[0]?.rule})`}`).join("; ")}.`,
    ]);
    await this.sleep();

    // 3. Integrity --------------------------------------------------------------------------
    const diazAsg = q(`SELECT assignment_id FROM crew_assignment WHERE crew_id = 'c-diaz' AND flight_id = 'f-sc1042' AND status = 'CONFIRMED'`);
    let blocked = "";
    try {
      override.forceCrewAssignment({ flightId: "f-sc1042", crewId: "c-okafor", role: "CAPTAIN", actor: "u-ctrl", reason: "Fastest available", replaceAssignmentId: diazAsg.assignment_id });
    } catch (e) { blocked = (e as Error).message; }
    await bus.drain();
    this.push("How transaction integrity is protected", "Illegal assignments are never saved", [
      "A controller tried to force Capt. Okafor onto SC 1042 through the override console.",
      `Result: ${blocked || "accepted"} The attempt is in the audit log (NFR-FAA-02).`,
      "Capt. Diaz's record stays as-is until the scheduler confirms a legal replacement; any assignment that overlaps another duty is rejected by the overlap check.",
    ]);
    await this.sleep();

    // 4. Communicate ------------------------------------------------------------------------
    const paxAlerts = q(`SELECT COUNT(*) n FROM notification WHERE passenger_id IS NOT NULL`).n;
    const maria = q(`SELECT message FROM notification WHERE passenger_id = 'p-maria' ORDER BY created_at LIMIT 1`);
    const dead = q(`SELECT COUNT(*) n FROM notification WHERE delivery_status = 'DEAD_LETTER' AND crew_id = 'c-brooks'`).n;
    const a = analytics.get(true).notifications;
    this.push("How passengers and staff are informed", "Alerts in each passenger's language", [
      `${paxAlerts} passenger alerts sent; ${a.delayAlertsWithin90s} of ${a.delayAlerts} delay alerts arrived within 90 seconds (PP-01).`,
      `Maria Gonzalez (Spanish) received: "${maria?.message}" (PP-05).`,
      `Flight attendant Marcus Brooks's phone is off: ${dead} message(s) failed after 3 retries and were flagged so a scheduler calls him directly (CM-03).`,
    ]);
    await this.sleep();

    // 5. Limited connectivity ---------------------------------------------------------------
    edge.goOffline("Lightning strike knocked out the hub uplink (Direct Connect and VPN)");
    await bus.drain();
    const prov = edge.queueProvisionalCrew({ flightId: "f-sc1042", crewId: "c-patel", role: "CAPTAIN", actor: "u-sched", replaceAssignmentId: diazAsg.assignment_id });
    edge.queueGateChange({ flightId: "f-sc455", gateCode: "D25", actor: "u-gate" });
    // Meanwhile the remote operations center (still on the cloud) gives D25 to SC 77
    flightOps.changeGate({ flightId: "f-sc77", gateCode: "D25", actor: "u-ctrl", source: "CONTROLLER" });
    await bus.drain();
    this.push("How the system handles limited connectivity", "Miami hub goes offline; the edge node takes over", [
      "The hub lost its connection. The edge node kept crew schedules, gates, Part 117 rules and the override console available (NFR-REL-03).",
      `The scheduler replaced Capt. Diaz with Capt. Patel on the edge node: checked locally (${prov.localCheck.result}) and saved as PROVISIONAL.`,
      "A gate agent moved SC 455 to D25 on the edge node. At the same time, the remote operations center (still on the cloud) gave D25 to SC 77.",
      "Passenger alerts kept flowing because they are sent from the cloud, not the hub.",
    ]);
    await this.sleep();

    // 6. Failed integrations ----------------------------------------------------------------
    sims.sabre.mode = "slow";
    sims.sabre.timeoutNext = true;
    const mariaReq = await rebooking.request({ passengerId: "p-maria", newFlightId: "f-sc1046", actor: "u-maria" });
    const others = ["p-003", "p-005", "p-007"];
    for (const [i, pid] of others.entries())
      await rebooking.request({ passengerId: pid, newFlightId: i === 0 ? "f-sc1046" : "f-sc1050", actor: pid });
    const before = mariaReq; // status right after the timeout, before any reconciliation
    sims.acars.up = false;
    await rebooking.reconcileAll();
    sims.sabre.mode = "normal";
    await bus.drain();
    const after = rebooking.get(mariaReq.request_id);
    const confirmed = q(`SELECT COUNT(*) n FROM rebooking WHERE status = 'CONFIRMED'`).n;
    this.push("How failed integrations are handled", "Sabre times out; the system checks before retrying", [
      `Sabre slowed under the rebooking surge and Maria's request timed out (${before.last_error}). It stayed ${before.status}; she was not told she was booked and nothing was resent.`,
      `The adapter looked up the booking in Sabre by its correlation ID and found it: now ${after.status} (${after.sabre_booking_ref}).`,
      `Sabre holds ${sims.sabre.bookingCount()} bookings for ${confirmed} confirmed requests, so no one was double-booked (PP-02, SI-01).`,
      "The ACARS feed dropped too; the dashboard now shows last known status with a stale-data warning.",
    ]);
    sims.acars.up = true;
    await this.sleep();

    // 7. Manual fallback --------------------------------------------------------------------
    const reroute = q(`SELECT * FROM recommendation WHERE type = 'REROUTE' AND status = 'OPEN'`);
    if (reroute) override.decide({ recommendationId: reroute.recommendation_id, decision: "ACCEPT", actor: "u-ctrl", reason: "Avoid convective cell" });
    await bus.drain();
    const audits = q(`SELECT COUNT(*) n FROM audit_log`).n;
    this.push("How manual fallback is supported", "Staff stay in control", [
      "The controller reviewed the weather reroute for SC 520 and accepted it with a reason (DM-03, NFR-SAFE-01).",
      "Every automated workflow has a written manual procedure (NFR-REL-04); the override console runs in the cloud and on the edge node.",
      `${audits} audit entries so far record who did what, when and why. The only thing nobody can override is an illegal Part 117 assignment.`,
    ]);
    await this.sleep();

    // 8. Sync -------------------------------------------------------------------------------
    const sync = await edge.goOnline();
    await bus.drain();
    const patel = q(`SELECT status FROM crew_assignment WHERE crew_id = 'c-patel' AND flight_id = 'f-sc1042' ORDER BY created_at DESC LIMIT 1`);
    this.push("How information synchronizes after connectivity returns", "Queued changes sent in order", [
      `The hub reconnected and the edge node sent its queue in order: ${(sync as any).applied} applied, ${(sync as any).conflicts} conflict(s), ${(sync as any).rejected} rejected.`,
      `Capt. Patel's provisional assignment was rechecked by the cloud Compliance Engine: ${patel?.status}. Capt. Diaz was released and notified.`,
      "SC 455's move to D25 clashed with SC 77, which the operations center had already put there. It was flagged for staff instead of overwriting.",
      "The Event Log holds a complete timestamped record of the storm, and analytics picked up every delay (AR-01, AR-02).",
    ]);
  }
}
