import type { DB } from "./db/index.js";
import type { EventBus } from "./bus/eventBus.js";
import type { Simulators } from "./simulators/index.js";
import { id, type Clock } from "./core.js";

/** Everything a service needs. Services only talk to each other through the bus or this context. */
export interface Ctx {
  db: DB;
  clock: Clock;
  bus: EventBus;
  sims: Simulators;
  now(): string;
  audit(entry: {
    actor_id: string; action: string; entity_type: string; entity_id: string;
    old_value?: string | null; new_value?: string | null; override_reason_code?: string | null;
    source_system?: "CLOUD" | "EDGE";
  }): void;
}

export function createCtx(db: DB, clock: Clock, bus: EventBus, sims: Simulators): Ctx {
  return {
    db, clock, bus, sims,
    now: () => clock.now().toISOString(),
    audit(e) {
      // Audit values hold codes and IDs only, never names or contact details (Database 3.5).
      db.prepare(`INSERT INTO audit_log VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id("aud"), e.actor_id, e.action, e.entity_type, e.entity_id, e.old_value ?? null, e.new_value ?? null,
        e.override_reason_code ?? null, e.source_system ?? "CLOUD", clock.now().toISOString());
    },
  };
}
