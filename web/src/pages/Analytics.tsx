import { useState } from "react";
import { usePoll, fmtClock } from "../api";
import { Kpi, Req, RoleGate, useSession } from "../components/ui";

/** Analytics (AR-01 to AR-04). Executive view reads the warehouse snapshot; controllers can switch to live. */
export function Analytics() {
  return <RoleGate roles={["GATE_AGENT", "CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"]} title="Analytics: staff sign-in"><Board /></RoleGate>;
}

function Board() {
  const { user } = useSession();
  const canLive = ["OPS_CONTROLLER", "ADMIN"].includes(user!.role);
  const [live, setLive] = useState(canLive);
  const { data: a } = usePoll<any>(`/analytics${live ? "?live=1" : ""}`, 3000);
  if (!a) return <p className="empty">Loading…</p>;
  return (
    <>
      <div className="row between">
        <h1>Operational analytics</h1>
        <span className="row">
          <span className={`pill ${a.mode === "LIVE" ? "ok" : "info"}`}>{a.mode === "LIVE" ? "live data" : `warehouse · refreshed ${fmtClock(a.refreshedAt)}`}</span>
          {canLive && <button className="btn sm" onClick={() => setLive(!live)}>{live ? "Show warehouse view" : "Show live"}</button>}
        </span>
      </div>
      <p className="sub">Tracks the board's success measures. Reporting runs separately from live operations, so heavy reports never slow down the dashboard.</p>

      <h2>Board success measures <Req ids="AR-01 · AR-02 · AR-03 · AR-04" /></h2>
      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <Kpi v={a.onTimePerformance.percent === null ? "—" : `${a.onTimePerformance.percent}%`} l={`On-time arrivals today (${a.onTimePerformance.onTime}/${a.onTimePerformance.arrived}) · baseline 67%, target 85%`} />
        <Kpi v={a.satisfaction.average ?? "—"} l={`Satisfaction · ${a.satisfaction.responses} of ${a.satisfaction.invited} surveys · target 8.5`} />
        <Kpi v={a.deniedBoarding.involuntary} l={`Involuntary denied boardings (of ${a.deniedBoarding.boarded} boarding records) · target −30%`} />
        <Kpi v={`$${Number(a.financialImpact.disruptionCostUsd).toLocaleString()}`} l="Disruption costs recorded (vouchers, compensation)" />
      </div>

      <h2>Today at the Miami hub</h2>
      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <Kpi v={a.departures.delayed} l={`Delayed departures of ${a.departures.total} · avg delay ${a.departures.avgDelayMinutes} min`} tone={a.departures.delayed ? "warn" : undefined} />
        <Kpi v={a.departures.cancelled} l="Cancellations" />
        <Kpi v={a.crew.coverageGaps} l="Crew coverage gaps right now · baseline ~8 per week" tone={a.crew.coverageGaps ? "bad" : "ok"} />
        <Kpi v={a.crew.restViolationsPrevented} l="Rest violations caught before they happened" tone="ok" />
      </div>
      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <Kpi v={a.notifications.within90Percent === null ? "—" : `${a.notifications.within90Percent}%`} l={`Delay alerts within 90 s (${a.notifications.delayAlertsWithin90s}/${a.notifications.delayAlerts}) · PP-01`} tone="ok" />
        <Kpi v={`${a.notifications.sent}/${a.notifications.total}`} l={`Notifications delivered · ${a.notifications.retries} retries · ${a.notifications.deadLettered} dead-lettered`} />
        <Kpi v={`${a.rebooking.confirmed}/${a.rebooking.total}`} l={`Self-service rebookings confirmed · avg ${a.rebooking.avgCompletionSeconds ?? "—"} s · ${a.rebooking.needsReview} need review`} />
        <Kpi v={`${a.gates.inUse}/${a.gates.open}`} l="Gates in use / open" />
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h3>Delays by cause</h3>
          {!a.departures.byCause.length ? <p className="empty">No delays.</p> : (
            <table><tbody>{a.departures.byCause.map((c: any) => <tr key={c.cause}><td>{c.cause.toLowerCase()}</td><td style={{ width: "60%" }}>
              <div style={{ height: 10, borderRadius: 5, background: "var(--teal)", width: `${Math.min(100, c.n * 20)}%` }} /></td><td>{c.n}</td></tr>)}</tbody></table>
          )}
        </div>
        <div className="card">
          <h3>Operational controls</h3>
          <table><tbody>
            <tr><td>Manual overrides logged</td><td><b>{a.overrides}</b></td></tr>
            <tr><td>Unresolved dead letters</td><td><b>{a.deadLetters}</b></td></tr>
          </tbody></table>
        </div>
      </div>
    </>
  );
}
