import { useState } from "react";
import { api, usePoll, fmtTime } from "../api";
import { FlightStatus, Req, RoleGate, useSession } from "../components/ui";

const STAFF = ["GATE_AGENT", "CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"];

/** Real-time operations dashboard (FS-01, GO-05). Gate agents and controllers work here. */
export function Operations() {
  return <RoleGate roles={STAFF} title="Operations dashboard: staff sign-in"><Dashboard /></RoleGate>;
}

function Dashboard() {
  const { user, notify } = useSession();
  const { data, reload } = usePoll<any>("/flights", 2000);
  const { data: edge, reload: reloadEdge } = usePoll<any>("/edge", 2500);
  const { data: rb } = usePoll<any>("/rebookings", 3000);
  const [gateFor, setGateFor] = useState<string | null>(null);
  const [gate, setGate] = useState("");
  const canGate = ["GATE_AGENT", "OPS_CONTROLLER", "ADMIN"].includes(user!.role);
  const isCtrl = ["OPS_CONTROLLER", "ADMIN"].includes(user!.role);
  if (!data) return <p className="empty">Loading…</p>;

  const offline = !data.hub.online;
  const localGate = (flightId: string) => edge?.localView?.gateAssignments.find((g: any) => g.flight_id === flightId)?.gate_code;
  const changeGate = async (flightId: string) => {
    try {
      const out = await api<any>(`/flights/${flightId}/gate`, { gateCode: gate });
      notify(out.status === "QUEUED" ? `Saved on the edge node. It will sync when the hub reconnects.` : `Moved to ${out.toGate}`);
      setGateFor(null); setGate(""); void reload(); void reloadEdge();
    } catch (e) { notify((e as Error).message, true); }
  };
  const delay = async (flightId: string) => {
    const m = prompt("Total delay in minutes?");
    if (!m) return;
    try { await api(`/flights/${flightId}/delay`, { delayMinutes: Number(m), cause: "OPERATIONAL" }); void reload(); }
    catch (e) { notify((e as Error).message, true); }
  };
  const toggleGate = async (code: string, status: string) => {
    try { await api(`/gates/${code}/status`, { status: status === "OPEN" ? "CLOSED" : "OPEN", reason: "CONTROLLER" }); void reload(); }
    catch (e) { notify((e as Error).message, true); }
  };
  const resolve = async (queueId: string) => {
    const g = prompt("Conflict: choose another gate for this flight (e.g. D27)");
    if (!g) return;
    try { await api(`/edge/conflicts/${queueId}/resolve`, { gateCode: g }); notify("Conflict resolved"); void reloadEdge(); void reload(); }
    catch (e) { notify((e as Error).message, true); }
  };
  const conflicts = edge?.queue.filter((q: any) => q.status === "CONFLICT") ?? [];
  const queued = edge?.queue.filter((q: any) => q.status === "QUEUED") ?? [];

  return (
    <>
      <div className="row between"><h1>Miami hub operations</h1><Req ids="FS-01 · GO-05 · NFR-USE-01" /></div>
      <p className="sub">One dashboard for flight status, gates and crew conflicts, so departments don't have to call each other.</p>
      {offline && <div className="banner bad"><b>Hub offline.</b> You're working on the Miami edge node. Gate changes are saved locally ({queued.length} queued) and sync when the connection returns.</div>}
      {!data.acarsUp && <div className="banner warn"><b>ACARS feed unavailable.</b> Aircraft status shows the last known data and is marked stale.</div>}
      {conflicts.map((c: any) => (
        <div key={c.queue_id} className="banner warn">
          <b>Sync conflict:</b>&nbsp;{c.payload.flightNumber} → {c.payload.toGate} was changed offline, but {c.result?.message}.
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => resolve(c.queue_id)}>Resolve</button>
        </div>
      ))}

      <div className="card" style={{ marginBottom: 16, overflowX: "auto" }}>
        <table>
          <thead><tr><th>Flight</th><th>Route</th><th>Sched</th><th>Est</th><th>Status</th><th>Gate</th><th>Crew</th><th /></tr></thead>
          <tbody>
            {data.flights.map((f: any) => {
              const lg = offline ? localGate(f.flight_id) : null;
              return (
                <tr key={f.flight_id} className={f.flight_id === "f-sc1042" ? "hl" : ""}>
                  <td><b>{f.flight_number}</b><div className="muted small">{f.aircraft_type} · v{f.version}</div></td>
                  <td>{f.origin} → {f.destination}</td>
                  <td>{fmtTime(f.scheduled_departure)}</td>
                  <td>{fmtTime(f.estimated_departure)}</td>
                  <td><FlightStatus status={f.status} delay={f.delay_minutes} stale={f.stale} /></td>
                  <td>{lg && lg !== f.gate ? <><s className="muted">{f.gate}</s> <b>{lg}</b> <span className="pill warn">queued</span></> : f.gate ?? "—"}</td>
                  <td>
                    {f.open_crew_conflicts > 0 && <span className="pill bad">rest conflict</span>}
                    {f.provisional_crew > 0 && <span className="pill warn">provisional</span>}
                    {!f.open_crew_conflicts && !f.provisional_crew && ["SCHEDULED", "DELAYED"].includes(f.status) && <span className="pill ok">legal</span>}
                  </td>
                  <td><div className="row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "nowrap" }}>
                    {canGate && ["SCHEDULED", "DELAYED"].includes(f.status) && (gateFor === f.flight_id ? (
                      <><input value={gate} onChange={(e) => setGate(e.target.value.toUpperCase())} placeholder="D27" style={{ width: 70 }} />
                        <button className="btn sm primary" onClick={() => changeGate(f.flight_id)}>Move</button>
                        <button className="btn sm" onClick={() => setGateFor(null)}>×</button></>
                    ) : <button className="btn sm" onClick={() => setGateFor(f.flight_id)}>Change gate</button>)}
                    {isCtrl && !offline && ["SCHEDULED", "DELAYED"].includes(f.status) && <button className="btn sm" onClick={() => delay(f.flight_id)}>Set delay</button>}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="row between"><h2>Concourse D gates</h2><Req ids="GO-05" /></div>
          <div className="row" style={{ gap: 6 }}>
            {data.gates.map((g: any) => (
              <button key={g.gate_code} className="btn sm" disabled={!isCtrl || offline} onClick={() => toggleGate(g.gate_code, g.status)}
                title={isCtrl ? "Click to open/close" : ""}
                style={{ borderColor: g.status === "CLOSED" ? "var(--bad)" : g.flight ? "var(--teal)" : undefined, background: g.status === "CLOSED" ? "var(--bad-soft)" : g.flight ? "var(--teal-soft)" : undefined }}>
                <b>{g.gate_code}</b> <span className="small muted">{g.status === "CLOSED" ? "closed" : g.flight ?? "free"}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="row between"><h2>Rebooking requests</h2><Req ids="PP-02 · DM-04" /></div>
          {!rb?.rebookings.length ? <p className="empty">No rebooking requests yet.</p> : (
            <table><thead><tr><th>Booking</th><th>From → to</th><th>Status</th><th>Sabre ref</th></tr></thead><tbody>
              {rb.rebookings.slice(0, 8).map((r: any) => (
                <tr key={r.request_id}>
                  <td className="mono">{r.booking_reference}</td>
                  <td>{r.old_flight} → {r.new_flight}</td>
                  <td><span className={`pill ${r.status === "CONFIRMED" ? "ok" : r.status === "FAILED" ? "bad" : "warn"}`}>{r.needs_review ? "needs review" : r.status.toLowerCase()}</span>
                    {r.last_error && r.status === "PENDING" && <div className="small muted">{r.last_error.toLowerCase()}; checking Sabre</div>}</td>
                  <td className="mono">{r.sabre_booking_ref ?? "—"}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>
    </>
  );
}
