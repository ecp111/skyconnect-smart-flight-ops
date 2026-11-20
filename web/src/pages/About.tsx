import { Req } from "../components/ui";

const ADRS = [
  ["ADR-01", "Hybrid of microservices, event-driven and API-based integration", "server/services/*, server/bus/eventBus.ts, server/integration/adapters.ts"],
  ["ADR-02", "Synchronous compliance check, asynchronous notifications", "crewScheduling.ts → compliance.ts (waits); notification.ts (subscribes to events)"],
  ["ADR-03", "Hybrid cloud (AWS) plus an edge node at each hub", "Prototype runs in one process; see the mapping table below"],
  ["ADR-04", "Relational database, event log and separate analytics", "server/db/schema.sql, operations_event, analytics.ts"],
  ["ADR-05", "Miami edge node for offline operation", "server/edge/edgeNode.ts"],
  ["ADR-06", "Manual override design, with no override of Part 117", "server/services/override.ts"],
  ["ADR-07", "Separate flight-critical and passenger services", "Flight-critical and passenger services share no tables they write to directly; they meet only on the event bus"],
];

const MAP = [
  ["Amazon EventBridge", "In-process event bus with a transactional outbox and idempotent consumers"],
  ["Amazon RDS (PostgreSQL)", "SQLite with the same tables, keys, CHECK rules and ACID transactions"],
  ["AWS containers per service", "One Node.js process; each service is its own module and talks to the others through the bus"],
  ["Data warehouse", "Analytics snapshot refreshed every 30 seconds, with a live view for controllers"],
  ["Edge server at the hub", "Separate edge tables and a local copy of the Part 117 rules; switch it offline from the Storm demo tab"],
  ["Sabre, Amadeus, ACARS, weather, FAA, MRO, SMS/push, payments", "Simulators with switches for slow, timeout and down"],
  ["SSO and MFA identity provider", "Demo sign-in with roles; elevated roles need a 6-digit code"],
];

/** How the prototype maps to the Assignment 3 architecture. */
export function About() {
  return (
    <>
      <h1>Architecture map</h1>
      <p className="sub">How this prototype follows the Assignment 3 design: what's built, what's simulated, and where to find each decision in the code.</p>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Layers</h2>
        <div className="grid" style={{ gap: 8 }}>
          <Layer label="Users" items={["Passenger app", "Crew app", "Staff dashboard"]} />
          <Layer label="Entry" items={["API gateway · SSO · roles · MFA"]} />
          <div className="grid cols-2" style={{ gap: 8 }}>
            <Layer label="Flight-critical zone" tone="#efeafd" items={["Flight Operations", "Disruption Mgmt", "Crew Scheduling", "Compliance Engine", "Override Console"]} />
            <Layer label="Passenger zone" tone="#e3f4f1" items={["Rebooking", "Voucher / Eligibility*", "Notification"]} />
          </div>
          <Layer label="Event bus" items={["Outbox → ordered delivery → idempotent consumers"]} />
          <Layer label="Data" items={["Relational DB", "Event log", "Analytics warehouse"]} />
          <Layer label="Integration adapters" items={["Sabre", "Amadeus", "ACARS", "Weather", "FAA", "MRO", "SMS/push", "Payments"]} />
          <Layer label="Miami hub edge node" tone="#fff3dc" items={["Crew schedules", "Gate info", "Part 117 rules", "Override console", "Offline queue"]} />
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>*Voucher/eligibility (PP-03) is a Should Have and isn't built in this prototype; the payment tokenization simulator is in place for it.</p>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Architecture decisions <Req ids="Decision Log" /></h2>
          <table><tbody>{ADRS.map(([id, d, where]) => <tr key={id}><td className="mono"><b>{id}</b></td><td>{d}<div className="small muted mono">{where}</div></td></tr>)}</tbody></table>
        </div>
        <div className="card">
          <h2>Production design → prototype</h2>
          <table><thead><tr><th>In the report</th><th>In this prototype</th></tr></thead><tbody>
            {MAP.map(([a, b]) => <tr key={a}><td><b>{a}</b></td><td className="small">{b}</td></tr>)}
          </tbody></table>
          <p className="small muted">Compliance rules are a simplified, educational version of 14 CFR Part 117 and 121.467, not a certified tool. All people, bookings and data are fictional.</p>
        </div>
      </div>
    </>
  );
}

function Layer({ label, items, tone }: { label: string; items: string[]; tone?: string }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px", background: tone ?? "#fafbfd" }}>
      <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div className="row" style={{ gap: 6 }}>{items.map((i) => <span key={i} className="pill muted" style={{ background: "#fff", border: "1px solid var(--line)" }}>{i}</span>)}</div>
    </div>
  );
}
