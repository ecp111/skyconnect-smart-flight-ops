import type { DB } from "../db/index.js";
import { id, type Clock } from "../core.js";

/**
 * Event Bus (stands in for Amazon EventBridge; ADR-01, ADR-02).
 *
 * - Transactional outbox: services call `record()` inside the same transaction as their data
 *   change, so a change can never be saved without its event (NFR-PERF-03, Database 3.5).
 * - `drain()` publishes unpublished events in order to every subscriber.
 * - Idempotent consumers: each consumer's handled event IDs are stored in processed_event,
 *   so a replayed or duplicate event is ignored.
 * - Every event stays in operations_event, which is the append-only Event Log.
 */

export interface OpsEvent {
  event_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  source: string;
  occurred_at: string;
  recorded_at: string;
  version: number;
  details: Record<string, unknown>;
}

type Handler = (e: OpsEvent) => void | Promise<void>;

interface Subscription {
  consumer: string;
  types: string[] | "*";
  handler: Handler;
}

export class EventBus {
  private subs: Subscription[] = [];
  private draining: Promise<void> | null = null;
  private scheduled = false;

  constructor(private db: DB, private clock: Clock) {}

  subscribe(consumer: string, types: string[] | "*", handler: Handler) {
    this.subs.push({ consumer, types, handler });
  }

  /** Write an event to the outbox. Call inside the same transaction as the data change. */
  record(e: {
    entity_type: string; entity_id: string; event_type: string; source: string;
    details?: Record<string, unknown>; occurred_at?: string; version?: number;
  }): OpsEvent {
    const now = this.clock.now().toISOString();
    const event: OpsEvent = {
      event_id: id("evt"),
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      event_type: e.event_type,
      source: e.source,
      occurred_at: e.occurred_at ?? now,
      recorded_at: now,
      version: e.version ?? 1,
      details: e.details ?? {},
    };
    this.db.prepare(`INSERT INTO operations_event (event_id, entity_type, entity_id, event_type, source,
      occurred_at, recorded_at, version, details, published) VALUES (?,?,?,?,?,?,?,?,?,0)`)
      .run(event.event_id, event.entity_type, event.entity_id, event.event_type, event.source,
        event.occurred_at, event.recorded_at, event.version, JSON.stringify(event.details));
    this.schedule();
    return event;
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  /** Publish every unpublished event (and any events those handlers create). */
  drain(): Promise<void> {
    if (this.draining) return this.draining.then(() => this.drainIfPending());
    this.draining = this.run().finally(() => { this.draining = null; });
    return this.draining;
  }

  private async drainIfPending() {
    const pending = this.db.prepare(`SELECT COUNT(*) n FROM operations_event WHERE published = 0`).get() as { n: number };
    if (pending.n > 0) await this.drain();
  }

  private async run() {
    for (;;) {
      const row = this.db.prepare(`SELECT * FROM operations_event WHERE published = 0
        ORDER BY recorded_at, rowid LIMIT 1`).get() as any;
      if (!row) return;
      this.db.prepare(`UPDATE operations_event SET published = 1 WHERE event_id = ?`).run(row.event_id);
      await this.dispatch(rowToEvent(row));
    }
  }

  /** Deliver one event to its subscribers, skipping consumers that already handled it. */
  async dispatch(e: OpsEvent) {
    for (const s of this.subs) {
      if (s.types !== "*" && !s.types.includes(e.event_type)) continue;
      const fresh = this.db.prepare(`INSERT OR IGNORE INTO processed_event (consumer, event_id) VALUES (?, ?)`)
        .run(s.consumer, e.event_id).changes === 1;
      if (!fresh) continue; // duplicate delivery -> ignored (idempotent consumer)
      try {
        await s.handler(e);
      } catch (err) {
        this.db.prepare(`INSERT INTO dead_letter VALUES (?, 'EVENT_HANDLER', ?, ?, ?, 0)`)
          .run(id("dl"), e.event_id, `${s.consumer}: ${(err as Error).message}`, this.clock.now().toISOString());
      }
    }
  }

  /** Re-deliver an already published event (used to prove duplicates are ignored). */
  async replay(eventId: string) {
    const row = this.db.prepare(`SELECT * FROM operations_event WHERE event_id = ?`).get(eventId);
    if (row) await this.dispatch(rowToEvent(row));
  }

  list(limit = 200): OpsEvent[] {
    return (this.db.prepare(`SELECT * FROM operations_event ORDER BY recorded_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as any[]).map(rowToEvent);
  }
}

export function rowToEvent(row: any): OpsEvent {
  return { ...row, details: JSON.parse(row.details), published: undefined } as OpsEvent;
}
