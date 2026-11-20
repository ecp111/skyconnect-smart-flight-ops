import { id, localTime } from "../core.js";
import type { Ctx } from "../context.js";
import type { OpsEvent } from "../bus/eventBus.js";

/**
 * Notification Service (PP-01, PP-04, PP-05, CM-03).
 * Reacts to events asynchronously. Passengers get alerts in their preferred language.
 * Failed deliveries are retried; after the last retry the message goes to the dead-letter
 * list and, for crew, is flagged so a scheduler can call the person directly.
 * Runs in the cloud, so passengers still receive alerts when the Miami hub is offline.
 */

const MAX_RETRIES = 3;
type Lang = "en" | "es" | "pt" | "ht";

// Sample templates. Spanish, Portuguese and Haitian Creole wording should be reviewed by native speakers.
const T: Record<string, Record<Lang, (d: any) => string>> = {
  delay: {
    en: (d) => `SkyConnect: Flight ${d.fn} is delayed. New departure ${d.time}. You can choose another flight in the app.`,
    es: (d) => `SkyConnect: El vuelo ${d.fn} está retrasado. Nueva salida ${d.time}. Puede elegir otro vuelo en la app.`,
    pt: (d) => `SkyConnect: O voo ${d.fn} está atrasado. Nova partida ${d.time}. Você pode escolher outro voo no app.`,
    ht: (d) => `SkyConnect: Vòl ${d.fn} an reta. Nouvo lè depa ${d.time}. Ou ka chwazi yon lòt vòl nan aplikasyon an.`,
  },
  cancel: {
    en: (d) => `SkyConnect: Flight ${d.fn} is cancelled. Please choose a new flight in the app.`,
    es: (d) => `SkyConnect: El vuelo ${d.fn} fue cancelado. Elija un nuevo vuelo en la app.`,
    pt: (d) => `SkyConnect: O voo ${d.fn} foi cancelado. Escolha um novo voo no app.`,
    ht: (d) => `SkyConnect: Vòl ${d.fn} anile. Tanpri chwazi yon nouvo vòl nan aplikasyon an.`,
  },
  gate: {
    en: (d) => `SkyConnect: Gate change for ${d.fn}. Now departing from gate ${d.gate}.`,
    es: (d) => `SkyConnect: Cambio de puerta para ${d.fn}. Ahora sale por la puerta ${d.gate}.`,
    pt: (d) => `SkyConnect: Mudança de portão para ${d.fn}. Agora embarca no portão ${d.gate}.`,
    ht: (d) => `SkyConnect: Chanjman pòtay pou ${d.fn}. Kounye a se pòtay ${d.gate}.`,
  },
  rebooked: {
    en: (d) => `SkyConnect: You're confirmed on ${d.fn}, departing ${d.time}. Booking ref ${d.ref}.`,
    es: (d) => `SkyConnect: Está confirmado en ${d.fn}, sale a las ${d.time}. Referencia ${d.ref}.`,
    pt: (d) => `SkyConnect: Você está confirmado no ${d.fn}, partida ${d.time}. Referência ${d.ref}.`,
    ht: (d) => `SkyConnect: Ou konfime sou ${d.fn}, depa ${d.time}. Referans ${d.ref}.`,
  },
};

export class NotificationService {
  constructor(private ctx: Ctx) {
    ctx.bus.subscribe("notification", ["FLIGHT_DELAYED", "FLIGHT_CANCELLED", "GATE_CHANGED", "REBOOKING_CONFIRMED",
      "CREW_REST_CONFLICT", "CREW_ASSIGNED", "CREW_ASSIGNMENT_REMOVED"], (e) => this.onEvent(e));
  }

  private passengersOn(flightId: string) {
    return this.ctx.db.prepare(`SELECT p.passenger_id, p.preferred_language FROM passenger p
      JOIN reservation r ON r.passenger_id = p.passenger_id AND r.status = 'ACTIVE'
      JOIN reservation_flight rf ON rf.reservation_id = r.reservation_id WHERE rf.flight_id = ?`).all(flightId) as any[];
  }

  private async onEvent(e: OpsEvent) {
    const d = e.details as any;
    const sends: Promise<unknown>[] = [];
    if (e.event_type === "FLIGHT_DELAYED" || e.event_type === "FLIGHT_CANCELLED") {
      const tpl = e.event_type === "FLIGHT_DELAYED" ? T.delay : T.cancel;
      for (const p of this.passengersOn(e.entity_id))
        sends.push(this.send({ passengerId: p.passenger_id, flightId: e.entity_id, lang: p.preferred_language,
          message: tpl[p.preferred_language as Lang]({ fn: d.flightNumber, time: localTime(d.estimatedDeparture) }), event: e }));
    } else if (e.event_type === "GATE_CHANGED") {
      for (const p of this.passengersOn(e.entity_id))
        sends.push(this.send({ passengerId: p.passenger_id, flightId: e.entity_id, lang: p.preferred_language,
          message: T.gate[p.preferred_language as Lang]({ fn: d.flightNumber, gate: d.toGate }), event: e }));
      for (const c of this.crewOn(e.entity_id))
        sends.push(this.send({ crewId: c.crew_id, flightId: e.entity_id, lang: "en", message: `Gate change: ${d.flightNumber} now at ${d.toGate}.`, event: e }));
    } else if (e.event_type === "REBOOKING_CONFIRMED") {
      const p = this.ctx.db.prepare(`SELECT p.passenger_id, p.preferred_language FROM reservation r JOIN passenger p ON p.passenger_id = r.passenger_id
        WHERE r.reservation_id = ?`).get(d.reservationId) as any;
      sends.push(this.send({ passengerId: p.passenger_id, flightId: d.newFlightId, lang: p.preferred_language,
        message: T.rebooked[p.preferred_language as Lang]({ fn: d.newFlightNumber, time: localTime(d.newDeparture), ref: d.sabreBookingRef }), event: e }));
    } else if (e.event_type === "CREW_REST_CONFLICT") {
      sends.push(this.send({ crewId: d.crewId, flightId: d.flightId, lang: "en",
        message: `Rest alert: the delay to ${d.flightNumber} would put you over your legal limit (${d.rule}). Crew scheduling is arranging a replacement.`, event: e }));
    } else if (e.event_type === "CREW_ASSIGNED") {
      sends.push(this.send({ crewId: d.crewId, flightId: d.flightId, lang: "en", message: `Schedule update: you are assigned to ${d.flightNumber} as ${d.role}.`, event: e }));
    } else if (e.event_type === "CREW_ASSIGNMENT_REMOVED") {
      sends.push(this.send({ crewId: d.crewId, flightId: d.flightId, lang: "en", message: `Schedule update: you have been released from ${d.flightNumber} (${d.reason}).`, event: e }));
    }
    await Promise.all(sends);
  }

  private crewOn(flightId: string) {
    return this.ctx.db.prepare(`SELECT crew_id FROM crew_assignment WHERE flight_id = ? AND status = 'CONFIRMED'`).all(flightId) as any[];
  }

  async send(p: { passengerId?: string; crewId?: string; flightId?: string; lang: string; message: string; event: OpsEvent }) {
    const { db, sims } = this.ctx;
    const nid = id("ntf");
    db.prepare(`INSERT INTO notification (notification_id, passenger_id, crew_id, flight_id, channel, language, message, delivery_status,
      retry_count, triggered_by_event_id, event_occurred_at, created_at) VALUES (?,?,?,?, 'push', ?, ?, 'QUEUED', 0, ?, ?, ?)`)
      .run(nid, p.passengerId ?? null, p.crewId ?? null, p.flightId ?? null, p.lang, p.message, p.event.event_id, p.event.occurred_at, this.ctx.now());
    const reachable = p.crewId
      ? !!(db.prepare(`SELECT phone_reachable FROM crew_member WHERE crew_id = ?`).get(p.crewId) as any)?.phone_reachable
      : true;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await sims.notify.deliver({ reachable });
        db.prepare(`UPDATE notification SET delivery_status = 'SENT', sent_at = ?, retry_count = ? WHERE notification_id = ?`).run(this.ctx.now(), attempt, nid);
        return;
      } catch {
        db.prepare(`UPDATE notification SET delivery_status = 'FAILED', retry_count = ? WHERE notification_id = ?`).run(attempt, nid);
      }
    }
    db.prepare(`UPDATE notification SET delivery_status = 'DEAD_LETTER' WHERE notification_id = ?`).run(nid);
    db.prepare(`INSERT INTO dead_letter VALUES (?, 'NOTIFICATION', ?, ?, ?, 0)`).run(id("dl"), nid,
      p.crewId ? "Crew member unreachable after retries; scheduler must call directly" : "Passenger unreachable after retries", this.ctx.now());
    this.ctx.bus.record({ entity_type: "NOTIFICATION", entity_id: nid, event_type: "NOTIFICATION_FAILED", source: "NOTIFICATION",
      details: { crewId: p.crewId ?? null, passengerId: p.passengerId ? "redacted" : null, flightId: p.flightId ?? null, retries: MAX_RETRIES,
        action: p.crewId ? "CALL_CREW_MEMBER" : "SHOW_AT_GATE" } });
  }

  list(limit = 100) {
    return this.ctx.db.prepare(`SELECT n.*, COALESCE(p.name, c.name) AS recipient FROM notification n
      LEFT JOIN passenger p ON p.passenger_id = n.passenger_id LEFT JOIN crew_member c ON c.crew_id = n.crew_id
      ORDER BY n.created_at DESC LIMIT ?`).all(limit);
  }
}
