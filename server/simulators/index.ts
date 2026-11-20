import { id } from "../core.js";
import { SABRE_INVENTORY } from "../db/seed.js";

/**
 * SIMULATED external systems. SkyConnect does not own these (Integration Architecture,
 * "How external systems integrate"). Each one has switches so the Failure Scenario can be
 * acted out: slow responses, timeouts, outages and failed deliveries.
 */

export class SimError extends Error {
  constructor(public kind: "TIMEOUT" | "UNAVAILABLE" | "SOLD_OUT" | "REJECTED", message: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SabreMode = "normal" | "slow" | "timeout" | "down";

/** Sabre reservation system (SI-01). Master source for reservations and seat inventory. */
export class SabreSim {
  mode: SabreMode = "normal";
  /** Force the next booking call to time out (the booking still goes through; only the reply is lost). */
  timeoutNext = false;
  latencyMs = 250;
  slowMs = 2500;
  readonly supportsIdempotency = true;
  inventory: Record<string, number> = { ...SABRE_INVENTORY };
  private bookings = new Map<string, { bookingRef: string; flightId: string; bookingReference: string }>();
  calls = 0;

  seatsAvailable(flightId: string) {
    if (this.mode === "down") throw new SimError("UNAVAILABLE", "Sabre is unavailable");
    return this.inventory[flightId] ?? 0;
  }

  async book(req: { correlationId: string; bookingReference: string; newFlightId: string }) {
    this.calls++;
    if (this.mode === "down") throw new SimError("UNAVAILABLE", "Sabre is unavailable");
    await sleep(this.mode === "slow" ? this.slowMs : this.latencyMs);
    // Idempotency: the same correlation ID returns the original booking, never a second seat.
    let booking = this.bookings.get(req.correlationId);
    if (!booking) {
      if ((this.inventory[req.newFlightId] ?? 0) <= 0) throw new SimError("SOLD_OUT", "No seats left on that flight");
      this.inventory[req.newFlightId]--;
      booking = { bookingRef: `SBR-${id("pnr").slice(4).toUpperCase()}`, flightId: req.newFlightId, bookingReference: req.bookingReference };
      this.bookings.set(req.correlationId, booking);
    }
    if (this.mode === "timeout" || this.timeoutNext) {
      this.timeoutNext = false;
      throw new SimError("TIMEOUT", "Sabre did not respond in time");
    }
    return { bookingRef: booking.bookingRef };
  }

  /** Booking status lookup used after a timeout, before any retry. */
  async status(correlationId: string) {
    if (this.mode === "down") throw new SimError("UNAVAILABLE", "Sabre is unavailable");
    await sleep(this.latencyMs);
    const b = this.bookings.get(correlationId);
    return b ? { found: true as const, bookingRef: b.bookingRef } : { found: false as const };
  }

  /** Total seats sold through SkyConnect rebookings (used to prove no double booking). */
  bookingCount() {
    return this.bookings.size;
  }
}

/** Amadeus GDS (SI-02): receives schedule changes for distribution to travel agencies. */
export class AmadeusSim {
  up = true;
  received = new Map<string, { flightId: string; change: string }>();
  publish(eventId: string, flightId: string, change: string) {
    if (!this.up) throw new SimError("UNAVAILABLE", "Amadeus is unavailable");
    if (!this.received.has(eventId)) this.received.set(eventId, { flightId, change }); // de-duplicated
  }
}

/** ACARS aircraft messaging (SI-03). Up/down switch for the stale-data warning. */
export class AcarsSim {
  up = true;
  lastMessageAt: string | null = null;
}

/** Weather service. */
export class WeatherSim {
  up = true;
}

/** FAA compliance system (rule-set reference used as evidence for rest checks). */
export class FaaSim {
  up = true;
  ruleSetEvidence() {
    if (!this.up) throw new SimError("UNAVAILABLE", "FAA compliance feed unavailable");
    return `FAA-REF-${new Date().toISOString().slice(0, 10)}`;
  }
}

/** MRO maintenance system (SI-04). */
export class MroSim {
  up = true;
  status: Record<string, string> = {};
  aircraftStatus(aircraftId: string) {
    if (!this.up) throw new SimError("UNAVAILABLE", "MRO unavailable");
    return this.status[aircraftId] ?? "SERVICEABLE";
  }
}

/** SMS / push provider. Fails for devices that are unreachable, or at a configured rate. */
export class NotifyProviderSim {
  up = true;
  failureRate = 0;
  sent = 0;
  async deliver(to: { reachable: boolean }) {
    if (!this.up) throw new SimError("UNAVAILABLE", "Notification provider unavailable");
    if (!to.reachable || Math.random() < this.failureRate) throw new SimError("REJECTED", "Device unreachable");
    this.sent++;
  }
}

/** Payment processor: returns a token so SkyConnect never stores card numbers (NFR-SEC-01). */
export class PaymentSim {
  tokenize(cardNumber: string) {
    const last4 = cardNumber.replace(/\D/g, "").slice(-4);
    return { token: `tok_${id("pay").slice(4)}`, last4 };
  }
}

export interface Simulators {
  sabre: SabreSim; amadeus: AmadeusSim; acars: AcarsSim; weather: WeatherSim;
  faa: FaaSim; mro: MroSim; notify: NotifyProviderSim; payment: PaymentSim;
}

export function createSimulators(): Simulators {
  return {
    sabre: new SabreSim(), amadeus: new AmadeusSim(), acars: new AcarsSim(), weather: new WeatherSim(),
    faa: new FaaSim(), mro: new MroSim(), notify: new NotifyProviderSim(), payment: new PaymentSim(),
  };
}
