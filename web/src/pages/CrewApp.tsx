import { usePoll, fmtTime } from "../api";
import { Req, RoleGate } from "../components/ui";

/** Crew app (CM-03): schedule updates and rest alerts. Crew see only their own schedule. */
export function CrewApp() {
  return (
    <>
      <div className="row between"><h1>Crew app</h1><Req ids="CM-03 · CM-02" /></div>
      <p className="sub">Pilots and flight attendants get schedule changes and rest alerts directly, instead of by phone call.</p>
      <RoleGate roles={["CREW"]} title="Sign in as a crew member"><Phone /></RoleGate>
    </>
  );
}

function Phone() {
  const { data } = usePoll<any>("/crew/me", 1500);
  if (!data) return <p className="empty">Loading…</p>;
  const c = data.compliance;
  const upcoming = data.assignments.filter((a: any) => ["CONFIRMED", "PROVISIONAL"].includes(a.status) && !["ARRIVED"].includes(a.flight_status));
  return (
    <div className="phone">
      <div className="ph-top">
        <div className="small" style={{ opacity: .75 }}>{data.crew.role.toLowerCase().replace("_", " ")} · base {data.crew.base}</div>
        <div style={{ fontSize: 20, fontWeight: 650, marginTop: 4 }}>{data.crew.name}</div>
        <div className="small" style={{ marginTop: 6 }}>
          <span className={`pill ${c.result === "PASS" ? "ok" : "bad"}`}>{c.result === "PASS" ? "Within legal limits" : "Over legal limit"}</span>
        </div>
      </div>
      <div className="ph-body">
        {c.checkedPeriod && <div className="small muted">Today's duty: {c.checkedPeriod.fdpHours} h of {c.checkedPeriod.limitHours} h allowed ({c.regulation})</div>}
        <div>
          <h3>My trips</h3>
          {!upcoming.length && <p className="empty">No upcoming trips.</p>}
          {upcoming.map((a: any) => (
            <div key={a.assignment_id} className="option">
              <div><b>{a.flight_number}</b> {a.origin}→{a.destination}<div className="small muted">Report {fmtTime(a.duty_start)} · release {fmtTime(a.duty_end)}</div></div>
              <span className={`pill ${a.status === "PROVISIONAL" ? "warn" : a.last_check === "FAIL" ? "bad" : "ok"}`}>{a.status === "PROVISIONAL" ? "provisional" : a.last_check === "FAIL" ? "rest conflict" : "confirmed"}</span>
            </div>
          ))}
        </div>
        <div>
          <h3>Alerts</h3>
          {!data.notifications.length && <p className="empty">No alerts.</p>}
          {data.notifications.map((n: any) => (
            <div key={n.notification_id} className="msg">
              <div className="t">{fmtTime(n.created_at)} · {n.delivery_status === "DEAD_LETTER" ? "not delivered (phone unreachable); scheduler will call" : "delivered"}</div>{n.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
