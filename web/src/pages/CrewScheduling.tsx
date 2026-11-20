import { useState } from "react";
import { api, usePoll, fmtTime } from "../api";
import { FlightStatus, Req, RoleGate, useSession } from "../components/ui";

/** Crew scheduling (CM-01, CM-02, NFR-FAA-01 to 03). Assignments only save after a passing compliance check. */
export function CrewScheduling() {
  return <RoleGate roles={["CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"]} title="Crew scheduling: scheduler sign-in"><Scheduling /></RoleGate>;
}

function Scheduling() {
  const { user, notify } = useSession();
  const { data: flights } = usePoll<any>("/flights", 2500);
  const { data: crewList } = usePoll<any>("/crew", 10000);
  const [crewId, setCrewId] = useState("c-diaz");
  const { data: view, reload } = usePoll<any>(`/crew/${crewId}`, 2500);
  const [pick, setPick] = useState<{ flightId: string; role: string; replace?: string } | null>(null);
  const { data: cands } = usePoll<any>(pick ? `/crew-candidates?flightId=${pick.flightId}&role=${pick.role}` : null, 4000);
  const canAssign = ["CREW_SCHEDULER", "ADMIN"].includes(user!.role);
  const offline = flights && !flights.hub.online;

  const assign = async (candidate: string) => {
    try {
      const out = await api<any>("/crew/assign", { flightId: pick!.flightId, crewId: candidate, role: pick!.role, replaceAssignmentId: pick!.replace });
      notify(out.status === "QUEUED" ? "Saved on the edge node as PROVISIONAL. The cloud re-verifies it when the hub reconnects." : `Assigned: ${out.status}`);
      setPick(null); void reload();
    } catch (e) { notify((e as Error).message, true); }
  };

  return (
    <>
      <div className="row between"><h1>Crew scheduling</h1><Req ids="CM-01 · CM-02 · NFR-FAA-01/02/03" /></div>
      <p className="sub">Replaces spreadsheets and phone calls. Every assignment waits for a pass from the Compliance Engine (Part 117 for pilots, 14 CFR 121.467 for flight attendants) before it's saved.</p>
      {offline && <div className="banner bad"><b>Hub offline.</b> Assignments are checked locally against the cached Part 117 rules and saved as PROVISIONAL until the cloud re-verifies them.</div>}
      <div className="grid cols-2">
        <div className="card">
          <div className="row between">
            <h2>Crew member</h2>
            <select value={crewId} onChange={(e) => setCrewId(e.target.value)}>
              {crewList?.crew.map((c: any) => <option key={c.crew_id} value={c.crew_id}>{c.name} · {c.role.toLowerCase().replace("_", " ")}{c.availability === "RESERVE" ? " (reserve)" : ""}</option>)}
            </select>
          </div>
          {view && (
            <>
              <div className="row" style={{ margin: "8px 0 12px" }}>
                <span className={`pill ${view.compliance.result === "PASS" ? "ok" : "bad"}`}>{view.compliance.result === "PASS" ? "legal" : "not legal"}</span>
                <span className="small muted">{view.compliance.regulation}{view.compliance.checkedPeriod ? ` · duty ${view.compliance.checkedPeriod.fdpHours} h of ${view.compliance.checkedPeriod.limitHours} h allowed` : ""}</span>
              </div>
              {view.compliance.violations.map((v: any, i: number) => <div key={i} className="banner bad small"><b>{v.rule}</b>&nbsp;{v.message}</div>)}
              <table><thead><tr><th>Flight</th><th>Duty</th><th>Status</th><th>Check</th><th /></tr></thead><tbody>
                {view.assignments.map((a: any) => (
                  <tr key={a.assignment_id}>
                    <td><b>{a.flight_number}</b> <span className="small muted">{a.origin}→{a.destination}</span><div><FlightStatus status={a.flight_status} delay={a.delay_minutes} /></div></td>
                    <td>{fmtTime(a.duty_start)}–{fmtTime(a.duty_end)}</td>
                    <td><span className={`pill ${a.status === "CONFIRMED" ? "ok" : a.status === "PROVISIONAL" ? "warn" : "muted"}`}>{a.status.toLowerCase()}</span></td>
                    <td>{a.last_check && <span className={`pill ${a.last_check === "PASS" ? "ok" : "bad"}`}>{a.last_check.toLowerCase()}</span>}</td>
                    <td>{canAssign && a.status === "CONFIRMED" && a.last_check === "FAIL" && (
                      <button className="btn sm primary" onClick={() => setPick({ flightId: flightIdOf(flights, a.flight_number), role: a.assigned_role, replace: a.assignment_id })}>Find replacement</button>)}</td>
                  </tr>
                ))}
              </tbody></table>
            </>
          )}
        </div>
        <div className="card" style={{ alignSelf: "start" }}>
          <h2>Replacement candidates</h2>
          {!pick ? <p className="empty">Pick a crew member with a rest conflict (try Capt. Luis Diaz after the storm) and click <b>Find replacement</b>.</p> : (
            <>
              <p className="small muted">Each reserve is run through the full compliance check for this flight.</p>
              <table><tbody>
                {cands?.candidates.map((c: any) => (
                  <tr key={c.crewId}>
                    <td><b>{c.name}</b><div className="small muted">{c.legal ? `Rest ${c.period?.restBeforeHours ?? "—"} h · FDP ${c.period?.fdpHours} of ${c.period?.limitHours} h` : c.violations[0]?.message}</div></td>
                    <td>{c.legal ? <span className="pill ok">legal</span> : <span className="pill bad">{c.violations[0]?.rule}</span>}</td>
                    <td><button className={`btn sm ${c.legal ? "primary" : "danger"}`} onClick={() => assign(c.crewId)}>{c.legal ? "Assign" : "Try anyway"}</button></td>
                  </tr>
                ))}
              </tbody></table>
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setPick(null)}>Cancel</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const flightIdOf = (flights: any, number: string) => flights?.flights.find((f: any) => f.flight_number === number)?.flight_id;
