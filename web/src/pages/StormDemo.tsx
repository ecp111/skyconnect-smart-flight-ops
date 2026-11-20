import { api, usePoll } from "../api";
import { useSession } from "../components/ui";

/** Plays the Assignment 3 Failure Scenario and exposes switches for every simulated outside system. */
export function StormDemo() {
  const { notify } = useSession();
  const { data: sim, reload } = usePoll<any>("/sim", 1200);
  const set = async (patch: Record<string, unknown>) => {
    try {
      const out = await api<any>("/sim", patch);
      if (out.sync) notify(`Hub back online. Sync: ${out.sync.applied} applied, ${out.sync.conflicts} conflict(s), ${out.sync.rejected} rejected.`);
      void reload();
    } catch (e) { notify((e as Error).message, true); }
  };
  const run = async () => { try { await api("/scenario/storm", {}); void reload(); } catch (e) { notify((e as Error).message, true); } };
  const reset = async () => { try { await api("/sim/reset", {}); notify("Demo reset to 12:30 on the pilot day."); void reload(); } catch (e) { notify((e as Error).message, true); } };
  const sc = sim?.scenario;

  return (
    <>
      <h1>Severe weather at Miami: the Failure Scenario, live</h1>
      <p className="sub">
        Runs the Failure Scenario from Assignment 3 on flight SC 1042 (Miami → Atlanta). Each step is labeled with the section heading it
        demonstrates. While it runs, open the other tabs to watch the dashboard, apps and event log update.
      </p>
      <div className="grid cols-2" style={{ gridTemplateColumns: "minmax(420px, 2fr) minmax(300px, 1fr)" }}>
        <div className="card">
          <div className="row between" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Storm scenario</h2>
            <div className="row">
              <button className="btn primary" onClick={run} disabled={sc?.running || sc?.done}>{sc?.running ? "Running…" : "Run storm scenario"}</button>
              <button className="btn" onClick={reset} disabled={sc?.running}>Reset demo</button>
            </div>
          </div>
          {!sc && <p className="empty">Press <b>Run storm scenario</b>. It takes about 30 seconds and walks through all eight parts of the Failure Scenario.</p>}
          {sc?.error && <div className="banner bad">Scenario stopped: {sc.error}</div>}
          <div className="steps">
            {sc?.steps.map((s: any) => (
              <div key={s.n} className="step">
                <div className="h">{s.n}. {s.heading}</div>
                <b>{s.title}</b>
                <ul>{s.lines.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
              </div>
            ))}
            {sc?.running && <div className="muted small">Next step coming…</div>}
            {sc?.done && <div className="banner ok">Scenario complete. Check the Event log, Analytics, Passenger app (Maria) and Crew app (Capt. Diaz, Capt. Patel).</div>}
          </div>
        </div>

        <div className="grid" style={{ alignContent: "start" }}>
          <div className="card">
            <h2>Simulated outside systems</h2>
            <p className="muted small">SkyConnect doesn't own these, so they're simulated. Flip a switch to see how each adapter contains the failure.</p>
            {sim && (
              <>
                <div className="switch"><span>Miami hub connection <span className="req">NFR-REL-03</span></span>
                  <button className={`btn sm ${sim.hubOnline ? "danger" : "primary"}`} onClick={() => set({ hubOnline: !sim.hubOnline })}>
                    {sim.hubOnline ? "Disconnect hub" : "Reconnect and sync"}</button></div>
                <div className="switch"><span>Sabre reservations <span className="req">SI-01</span></span>
                  <select value={sim.sabreMode} onChange={(e) => set({ sabreMode: e.target.value })}>
                    <option value="normal">normal</option><option value="slow">slow</option><option value="timeout">timing out</option><option value="down">down</option>
                  </select></div>
                <Toggle label="ACARS aircraft messages" req="SI-03" on={sim.acarsUp} set={(v) => set({ acarsUp: v })} />
                <Toggle label="Amadeus GDS" req="SI-02" on={sim.amadeusUp} set={(v) => set({ amadeusUp: v })} />
                <Toggle label="Weather service" req="DM-01" on={sim.weatherUp} set={(v) => set({ weatherUp: v })} />
                <Toggle label="FAA compliance feed" req="CM-02" on={sim.faaUp} set={(v) => set({ faaUp: v })} />
                <Toggle label="SMS / push provider" req="PP-01" on={sim.notifyUp} set={(v) => set({ notifyUp: v })} />
              </>
            )}
          </div>
          <div className="card">
            <h3>What to watch</h3>
            <ul className="small" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.6 }}>
              <li><b>Operations dashboard</b>: delays, gate D22 closing, the crew conflict on SC 1042</li>
              <li><b>Passenger app</b> as Maria: Spanish alert, then rebooking</li>
              <li><b>Crew app</b> as Capt. Diaz: rest alert and release</li>
              <li><b>Event log</b>: every event in order, including the sync conflict</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}

function Toggle({ label, req, on, set }: { label: string; req: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="switch">
      <span>{label} <span className="req">{req}</span></span>
      <span className="row" style={{ gap: 8 }}>
        <span className={`pill ${on ? "ok" : "bad"}`}>{on ? "up" : "down"}</span>
        <button className="btn sm" onClick={() => set(!on)}>{on ? "Take down" : "Bring up"}</button>
      </span>
    </div>
  );
}
