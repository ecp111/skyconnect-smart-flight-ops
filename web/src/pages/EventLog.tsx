import { useState } from "react";
import { usePoll, fmtClock } from "../api";
import { Req, RoleGate } from "../components/ui";

const TONE: Record<string, string> = {
  CREW_REST_CONFLICT: "bad", CREW_ASSIGNMENT_BLOCKED: "bad", NOTIFICATION_FAILED: "bad", SYNC_CONFLICT: "bad", HUB_CONNECTIVITY_LOST: "bad",
  FLIGHT_DELAYED: "warn", GATE_CLOSED: "warn", REBOOKING_UNCONFIRMED: "warn", WEATHER_ALERT: "warn", ACARS_GATE_HOLD: "warn",
  REBOOKING_CONFIRMED: "ok", CREW_ASSIGNED: "ok", HUB_CONNECTIVITY_RESTORED: "ok", EDGE_SYNC_COMPLETED: "ok",
};

/** The append-only Event Log (OPERATIONS_EVENT): every event with timestamp, source, version and ID. */
export function EventLog() {
  return <RoleGate roles={["GATE_AGENT", "CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"]} title="Event log: staff sign-in"><Log /></RoleGate>;
}

function Log() {
  const { data } = usePoll<any>("/events", 1500);
  const { data: dl } = usePoll<any>("/dead-letters", 3000);
  const [filter, setFilter] = useState("");
  const events = (data?.events ?? []).filter((e: any) => !filter || e.event_type.includes(filter.toUpperCase()) || JSON.stringify(e.details).toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <div className="row between"><h1>Event log</h1><Req ids="AR-01 · NFR-PERF-03 · NFR-SEC-03" /></div>
      <p className="sub">Every change is saved together with its event (transactional outbox), then sent over the event bus. Each event has a unique ID, timestamps and a version, so services can ignore duplicates and keep things in order. Details hold IDs and codes, no personal data.</p>
      <div className="grid cols-2" style={{ gridTemplateColumns: "minmax(480px, 2fr) minmax(280px, 1fr)" }}>
        <div className="card" style={{ overflowX: "auto" }}>
          <div className="row between" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>{data?.events.length ?? 0} events</h2>
            <input placeholder="Filter (e.g. crew, SC 1042)" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <table><thead><tr><th>Time</th><th>Event</th><th>Source</th><th>Details</th></tr></thead><tbody>
            {events.map((e: any) => (
              <tr key={e.event_id}>
                <td className="mono">{fmtClock(e.recorded_at)}</td>
                <td><span className={`pill ${TONE[e.event_type] ?? "muted"}`}>{e.event_type}</span><div className="mono muted" style={{ fontSize: 10.5, marginTop: 3 }}>{e.event_id} · v{e.version}</div></td>
                <td className="small">{e.source}</td>
                <td className="small">{describe(e)}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
        <div className="card" style={{ alignSelf: "start" }}>
          <h2>Dead-letter list</h2>
          <p className="muted small">Messages that failed after every retry. Each one is flagged for a person to follow up.</p>
          {!dl?.deadLetters.length ? <p className="empty">Empty.</p> : dl.deadLetters.map((d: any) => (
            <div key={d.dead_letter_id} className="banner warn small"><b>{d.kind.replace(/_/g, " ").toLowerCase()}</b>&nbsp;{d.reason}</div>
          ))}
        </div>
      </div>
    </>
  );
}

function describe(e: any): string {
  const d = e.details;
  switch (e.event_type) {
    case "FLIGHT_DELAYED": return `${d.flightNumber}: +${d.delayMinutes} min (${d.cause ?? "—"})`;
    case "GATE_CHANGED": return `${d.flightNumber}: ${d.fromGate ?? "—"} → ${d.toGate}`;
    case "GATE_CLOSED": return `Gate ${d.gate} closed (${d.reason})`;
    case "WEATHER_ALERT": return d.description;
    case "CREW_REST_CONFLICT": case "CREW_ASSIGNMENT_BLOCKED": return `${d.flightNumber ?? d.flightId}: ${d.rule}. ${d.message ?? ""}`;
    case "CREW_ASSIGNED": case "CREW_ASSIGNED_PROVISIONAL": return `${d.flightNumber}: ${d.crewId} as ${d.role}${d.verifiedFrom ? " (verified after sync)" : ""}`;
    case "CREW_ASSIGNMENT_REMOVED": return `${d.flightNumber}: ${d.crewId} released (${d.reason})`;
    case "REBOOKING_CONFIRMED": return `${d.newFlightNumber} · ${d.sabreBookingRef} · via ${d.confirmedVia}`;
    case "REBOOKING_UNCONFIRMED": return `${d.reason}: ${d.action}`;
    case "SYNC_CONFLICT": return `${d.flightNumber}: ${d.reason}`;
    case "EDGE_SYNC_COMPLETED": return `${d.applied} applied, ${d.conflicts} conflict(s), ${d.rejected} rejected`;
    case "MANUAL_OVERRIDE": return `${d.type} ${d.decision ?? ""} by ${d.actor}`;
    case "NOTIFICATION_FAILED": return `After ${d.retries} retries → ${d.action}`;
    default: return Object.entries(d).filter(([, v]) => typeof v !== "object").slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(" · ");
  }
}
