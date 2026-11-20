import { useState } from "react";
import { api, usePoll, fmtTime } from "../api";
import { Req, RoleGate, useSession } from "../components/ui";

/** Manual override console (DM-03, DM-05, NFR-SAFE-01, NFR-FAA-02). */
export function OverrideConsole() {
  return <RoleGate roles={["OPS_CONTROLLER", "CREW_SCHEDULER", "ADMIN"]} title="Override console: controller or scheduler sign-in"><Console /></RoleGate>;
}

function Console() {
  const { user, notify } = useSession();
  const { data, reload } = usePoll<any>("/recommendations?status=ALL", 2000);
  const isCtrl = ["OPS_CONTROLLER", "ADMIN"].includes(user!.role);
  const { data: audit } = usePoll<any>(isCtrl ? "/audit" : null, 3000);
  const [reason, setReason] = useState<Record<string, string>>({});

  const decide = async (rec: any, decision: "ACCEPT" | "REJECT", chosenCrewId?: string) => {
    try {
      await api(`/recommendations/${rec.recommendation_id}/decision`, { decision, reason: reason[rec.recommendation_id] ?? "", chosenCrewId });
      notify(decision === "ACCEPT" ? "Accepted and logged" : "Rejected and logged");
      void reload();
    } catch (e) { notify((e as Error).message, true); }
  };
  const open = data?.recommendations.filter((r: any) => r.status === "OPEN") ?? [];
  const decided = data?.recommendations.filter((r: any) => r.status !== "OPEN") ?? [];

  return (
    <>
      <div className="row between"><h1>Override console</h1><Req ids="DM-05 · NFR-SAFE-01 · NFR-REL-04" /></div>
      <p className="sub">Automation recommends; people decide. Every decision needs a reason and is logged. The only firm limit is that nobody can confirm a crew assignment that breaks Part 117.</p>
      <div className="grid cols-2">
        <div className="grid" style={{ alignContent: "start" }}>
          <h2 style={{ margin: 0 }}>Open recommendations ({open.length})</h2>
          {!open.length && <div className="card"><p className="empty" style={{ margin: 0 }}>Nothing waiting. Run the storm scenario or close a gate to create some.</p></div>}
          {open.map((r: any) => (
            <div key={r.recommendation_id} className="card">
              <div className="row between">
                <b>{r.flight_number}: {r.type.replace("_", " ").toLowerCase()}</b>
                <span className="pill warn">open</span>
              </div>
              {r.type === "CREW_REPLACEMENT" ? (
                <>
                  <p className="small">{r.details.crewName} ({r.details.role.toLowerCase().replace("_", " ")}) is no longer legal for this flight. Candidates, each checked by the Compliance Engine:</p>
                  <table><tbody>
                    {r.details.candidates.map((c: any) => (
                      <tr key={c.crewId}>
                        <td><b>{c.name}</b><div className="small muted">{c.legal ? `FDP ${c.period?.fdpHours} h of ${c.period?.limitHours} h · rest ${c.period?.restBeforeHours ?? "—"} h` : c.violations[0]?.message}</div></td>
                        <td>{c.legal ? <span className="pill ok">legal</span> : <span className="pill bad">{c.violations[0]?.rule}</span>}</td>
                        <td><button className={`btn sm ${c.legal ? "primary" : "danger"}`} onClick={() => decide(r, "ACCEPT", c.crewId)}>{c.legal ? "Assign" : "Try to force"}</button></td>
                      </tr>
                    ))}
                  </tbody></table>
                </>
              ) : <p className="small">{r.details.summary}</p>}
              <div className="row" style={{ marginTop: 8 }}>
                <input placeholder="Reason (required)" value={reason[r.recommendation_id] ?? ""} onChange={(e) => setReason({ ...reason, [r.recommendation_id]: e.target.value })} style={{ flex: 1 }} />
                {r.type !== "CREW_REPLACEMENT" && <button className="btn primary sm" onClick={() => decide(r, "ACCEPT")}>Accept</button>}
                <button className="btn sm" onClick={() => decide(r, "REJECT")}>Reject</button>
              </div>
            </div>
          ))}
          {decided.length > 0 && (
            <div className="card">
              <h3>Decided</h3>
              <table><tbody>{decided.map((r: any) => (
                <tr key={r.recommendation_id}><td>{r.flight_number}</td><td>{r.type.replace("_", " ").toLowerCase()}</td>
                  <td><span className={`pill ${r.status === "ACCEPTED" ? "ok" : "muted"}`}>{r.status.toLowerCase()}</span></td>
                  <td className="small muted">{r.decided_by} · {fmtTime(r.decided_at)} · “{r.decision_reason}”</td></tr>
              ))}</tbody></table>
            </div>
          )}
        </div>
        <div className="card" style={{ alignSelf: "start" }}>
          <div className="row between"><h2>Audit log</h2><Req ids="NFR-SEC-03" /></div>
          {!isCtrl ? <p className="empty">Only controllers and administrators can read the audit log.</p> : (
            <>
              <p className="muted small">Codes and IDs only, never names or contact details.</p>
              <table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Change</th><th>Where</th></tr></thead><tbody>
                {audit?.audit.slice(0, 40).map((a: any) => (
                  <tr key={a.audit_id} className={a.action === "OVERRIDE_BLOCKED_PART117" ? "hl" : ""}>
                    <td>{fmtTime(a.occurred_at)}</td><td className="mono">{a.actor_id}</td><td className="mono">{a.action}</td>
                    <td className="small">{a.old_value ?? ""}{a.old_value || a.new_value ? " → " : ""}{a.new_value ?? ""}{a.override_reason_code ? <div className="muted mono">{a.override_reason_code}</div> : null}</td>
                    <td><span className={`pill ${a.source_system === "EDGE" ? "warn" : "muted"}`}>{a.source_system.toLowerCase()}</span></td>
                  </tr>
                ))}
              </tbody></table>
            </>
          )}
        </div>
      </div>
    </>
  );
}
