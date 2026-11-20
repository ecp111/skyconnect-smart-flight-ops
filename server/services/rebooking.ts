import { tx } from "../db/index.js";
import { AppError, id } from "../core.js";
import type { Ctx } from "../context.js";
import type { SabreAdapter } from "../integration/adapters.js";
import { SimError } from "../simulators/index.js";

/**
 * Rebooking Service (PP-02, DM-04, SI-01; ADR-04, ADR-07).
 *
 * Process (Database Architecture 3.2):
 *   commit a unique PENDING request -> recheck inventory -> submit to Sabre
 *   -> receive or look up the verified result -> CONFIRMED or FAILED -> queue notification.
 * After a timeout the request stays PENDING. The service asks Sabre for the booking status
 * before any retry, and escalates to staff if it still cannot tell. A passenger is never
 * told "booked" until Sabre has returned a booking reference.
 */

const DISRUPTED = ["DELAYED", "CANCELLED"];
const MAX_ATTEMPTS = 3;

export class RebookingService {
  constructor(private ctx: Ctx, private sabre: SabreAdapter) {}

  /** Passenger trip view: current flight, rebooking options, requests and notifications. */
  passengerView(passengerId: string) {
    const { db } = this.ctx;
    const pax = db.prepare(`SELECT passenger_id, name, preferred_language FROM passenger WHERE passenger_id = ?`).get(passengerId) as any;
    if (!pax) throw new AppError(404, "UNKNOWN_PASSENGER", "Unknown passenger");
    const res = db.prepare(`SELECT r.*, rf.flight_id FROM reservation r JOIN reservation_flight rf ON rf.reservation_id = r.reservation_id
      WHERE r.passenger_id = ? AND r.status = 'ACTIVE'`).get(passengerId) as any;
    const flight = res ? db.prepare(`SELECT f.*, g.gate_code AS gate FROM flight f
      LEFT JOIN gate_assignment ga ON ga.flight_id = f.flight_id AND ga.active = 1 LEFT JOIN gate g ON g.gate_id = ga.gate_id
      WHERE f.flight_id = ?`).get(res.flight_id) : null;
    const requests = res ? db.prepare(`SELECT rb.*, f.flight_number AS new_flight_number FROM rebooking rb
      JOIN flight f ON f.flight_id = rb.new_flight_id WHERE reservation_id = ? ORDER BY created_at DESC`).all(res.reservation_id) : [];
    const notifications = db.prepare(`SELECT * FROM notification WHERE passenger_id = ? ORDER BY created_at DESC`).all(passengerId);
    return { passenger: pax, reservation: res ?? null, flight, options: res ? this.options(res.flight_id) : [], requests, notifications };
  }

  /** Later flights on the same route with seats in Sabre (DM-04). */
  options(currentFlightId: string) {
    const { db } = this.ctx;
    const f = db.prepare(`SELECT * FROM flight WHERE flight_id = ?`).get(currentFlightId) as any;
    if (!f || !DISRUPTED.includes(f.status)) return [];
    const alts = db.prepare(`SELECT * FROM flight WHERE origin = ? AND destination = ? AND flight_id <> ?
      AND status IN ('SCHEDULED','DELAYED') AND estimated_departure > ? ORDER BY estimated_departure`)
      .all(f.origin, f.destination, f.flight_id, this.ctx.now()) as any[];
    return alts.map((a) => ({
      flightId: a.flight_id, flightNumber: a.flight_number, estimatedDeparture: a.estimated_departure,
      estimatedArrival: a.estimated_arrival, status: a.status, seatsAvailable: this.sabre.seatsAvailable(a.flight_id),
    }));
  }

  /** Step 1: validate and commit a PENDING request with a unique correlation ID, then submit. */
  async request(p: { passengerId: string; newFlightId: string; actor: string }) {
    const { db, bus } = this.ctx;
    const created = tx(db, () => {
      const res = db.prepare(`SELECT r.*, rf.flight_id FROM reservation r JOIN reservation_flight rf ON rf.reservation_id = r.reservation_id
        WHERE r.passenger_id = ? AND r.status = 'ACTIVE'`).get(p.passengerId) as any;
      if (!res) throw new AppError(404, "NO_RESERVATION", "No active reservation");
      const current = db.prepare(`SELECT * FROM flight WHERE flight_id = ?`).get(res.flight_id) as any;
      if (!DISRUPTED.includes(current.status)) throw new AppError(409, "NOT_ELIGIBLE", "Self-service rebooking is only offered for disrupted flights");
      const target = db.prepare(`SELECT * FROM flight WHERE flight_id = ?`).get(p.newFlightId) as any;
      if (!target || target.origin !== current.origin || target.destination !== current.destination || target.flight_id === current.flight_id)
        throw new AppError(400, "INVALID_OPTION", "That flight is not a valid option for this trip");
      const pending = db.prepare(`SELECT request_id FROM rebooking WHERE reservation_id = ? AND status = 'PENDING'`).get(res.reservation_id) as any;
      if (pending) throw new AppError(409, "REQUEST_IN_PROGRESS", "A rebooking request is already being processed");
      const requestId = id("rbk");
      const correlationId = id("corr");
      db.prepare(`INSERT INTO rebooking (request_id, reservation_id, old_flight_id, new_flight_id, correlation_id, status, created_at)
        VALUES (?,?,?,?,?, 'PENDING', ?)`).run(requestId, res.reservation_id, current.flight_id, p.newFlightId, correlationId, this.ctx.now());
      bus.record({ entity_type: "REBOOKING", entity_id: requestId, event_type: "REBOOKING_REQUESTED", source: "PASSENGER_PORTAL",
        details: { oldFlightId: current.flight_id, newFlightId: p.newFlightId, correlationId } });
      this.ctx.audit({ actor_id: p.actor, action: "REBOOKING_REQUEST", entity_type: "REBOOKING", entity_id: requestId, new_value: "PENDING" });
      return { requestId, correlationId, bookingReference: res.booking_reference };
    });
    await this.submit(created.requestId);
    return this.get(created.requestId);
  }

  get(requestId: string) {
    return this.ctx.db.prepare(`SELECT * FROM rebooking WHERE request_id = ?`).get(requestId) as any;
  }

  /** Step 2: recheck inventory and submit to Sabre. */
  async submit(requestId: string) {
    const { db } = this.ctx;
    const rb = this.get(requestId);
    if (!rb || rb.status !== "PENDING") return;
    const seats = this.sabre.seatsAvailable(rb.new_flight_id);
    if (seats === 0) return this.fail(rb, "SOLD_OUT");
    const res = db.prepare(`SELECT booking_reference FROM reservation WHERE reservation_id = ?`).get(rb.reservation_id) as any;
    db.prepare(`UPDATE rebooking SET attempts = attempts + 1 WHERE request_id = ?`).run(requestId);
    try {
      const out = await this.sabre.book({ correlationId: rb.correlation_id, bookingReference: res.booking_reference, newFlightId: rb.new_flight_id });
      this.confirm(rb, out.bookingRef, "SABRE_RESPONSE");
    } catch (err) {
      const e = err as SimError;
      if (e.kind === "SOLD_OUT") return this.fail(rb, "SOLD_OUT");
      // TIMEOUT or UNAVAILABLE: do NOT claim confirmation and do NOT blindly resubmit.
      db.prepare(`UPDATE rebooking SET last_error = ? WHERE request_id = ?`).run(e.kind ?? "ERROR", requestId);
      this.ctx.bus.record({ entity_type: "REBOOKING", entity_id: requestId, event_type: "REBOOKING_UNCONFIRMED", source: "SABRE_ADAPTER",
        details: { reason: e.kind ?? "ERROR", message: e.message, action: "Will look up booking status in Sabre before any retry" } });
    }
  }

  /** Step 3 (after a timeout or outage): look up the outcome in Sabre before retrying. */
  async reconcile(requestId: string) {
    const { db } = this.ctx;
    const rb = this.get(requestId);
    if (!rb || rb.status !== "PENDING" || rb.needs_review) return rb;
    try {
      const s = await this.sabre.status(rb.correlation_id);
      if (s.found) {
        this.confirm(rb, s.bookingRef, "SABRE_STATUS_LOOKUP");
      } else if (rb.attempts < MAX_ATTEMPTS) {
        await this.submit(requestId); // safe: Sabre honors the correlation ID, so no duplicate seat
      } else {
        this.escalate(rb, "No booking found in Sabre after retries");
      }
    } catch (err) {
      if (rb.attempts >= MAX_ATTEMPTS) this.escalate(rb, (err as Error).message);
      else db.prepare(`UPDATE rebooking SET attempts = attempts + 1, last_error = ? WHERE request_id = ?`)
        .run((err as SimError).kind ?? "ERROR", requestId);
    }
    return this.get(requestId);
  }

  async reconcileAll() {
    const pending = this.ctx.db.prepare(`SELECT request_id FROM rebooking WHERE status = 'PENDING' AND needs_review = 0 AND last_error IS NOT NULL`).all() as any[];
    for (const p of pending) await this.reconcile(p.request_id);
    return pending.length;
  }

  private confirm(rb: any, bookingRef: string, via: string) {
    const { db, bus } = this.ctx;
    tx(db, () => {
      const changed = db.prepare(`UPDATE rebooking SET status = 'CONFIRMED', sabre_booking_ref = ?, resolved_at = ?, last_error = NULL
        WHERE request_id = ? AND status = 'PENDING'`).run(bookingRef, this.ctx.now(), rb.request_id).changes;
      if (!changed) return;
      db.prepare(`UPDATE reservation_flight SET flight_id = ? WHERE reservation_id = ? AND flight_id = ?`).run(rb.new_flight_id, rb.reservation_id, rb.old_flight_id);
      const nf = db.prepare(`SELECT flight_number, estimated_departure FROM flight WHERE flight_id = ?`).get(rb.new_flight_id) as any;
      bus.record({ entity_type: "REBOOKING", entity_id: rb.request_id, event_type: "REBOOKING_CONFIRMED", source: "SABRE_ADAPTER",
        details: { reservationId: rb.reservation_id, newFlightId: rb.new_flight_id, newFlightNumber: nf.flight_number,
          newDeparture: nf.estimated_departure, sabreBookingRef: bookingRef, confirmedVia: via } });
      this.ctx.audit({ actor_id: "system", action: "REBOOKING_STATUS", entity_type: "REBOOKING", entity_id: rb.request_id, old_value: "PENDING", new_value: "CONFIRMED" });
    });
  }

  private fail(rb: any, reason: string) {
    tx(this.ctx.db, () => {
      this.ctx.db.prepare(`UPDATE rebooking SET status = 'FAILED', last_error = ?, resolved_at = ? WHERE request_id = ?`).run(reason, this.ctx.now(), rb.request_id);
      this.ctx.bus.record({ entity_type: "REBOOKING", entity_id: rb.request_id, event_type: "REBOOKING_FAILED", source: "SABRE_ADAPTER",
        details: { reservationId: rb.reservation_id, reason } });
      this.ctx.audit({ actor_id: "system", action: "REBOOKING_STATUS", entity_type: "REBOOKING", entity_id: rb.request_id, old_value: "PENDING", new_value: "FAILED" });
    });
  }

  private escalate(rb: any, reason: string) {
    tx(this.ctx.db, () => {
      this.ctx.db.prepare(`UPDATE rebooking SET needs_review = 1, last_error = ? WHERE request_id = ?`).run(reason, rb.request_id);
      this.ctx.db.prepare(`INSERT INTO dead_letter VALUES (?, 'REBOOKING_RECONCILIATION', ?, ?, ?, 0)`).run(id("dl"), rb.request_id, reason, this.ctx.now());
      this.ctx.bus.record({ entity_type: "REBOOKING", entity_id: rb.request_id, event_type: "REBOOKING_NEEDS_REVIEW", source: "REBOOKING",
        details: { reason } });
    });
  }

  /** Staff view of every rebooking (gate agents, controllers). */
  list() {
    return this.ctx.db.prepare(`SELECT rb.request_id, rb.status, rb.needs_review, rb.attempts, rb.last_error, rb.sabre_booking_ref,
      rb.created_at, rb.resolved_at, r.booking_reference, fo.flight_number AS old_flight, fn.flight_number AS new_flight
      FROM rebooking rb JOIN reservation r ON r.reservation_id = rb.reservation_id
      JOIN flight fo ON fo.flight_id = rb.old_flight_id JOIN flight fn ON fn.flight_id = rb.new_flight_id
      ORDER BY rb.created_at DESC`).all();
  }
}
