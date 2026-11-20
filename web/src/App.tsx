import { useState } from "react";
import { SessionCtx, Toast, useSessionState } from "./components/ui";
import { usePoll, fmtClock } from "./api";
import { StormDemo } from "./pages/StormDemo";
import { Operations } from "./pages/Operations";
import { OverrideConsole } from "./pages/OverrideConsole";
import { CrewScheduling } from "./pages/CrewScheduling";
import { PassengerApp } from "./pages/PassengerApp";
import { CrewApp } from "./pages/CrewApp";
import { EventLog } from "./pages/EventLog";
import { Analytics } from "./pages/Analytics";
import { About } from "./pages/About";

const TABS = [
  { key: "storm", label: "Storm demo", el: <StormDemo /> },
  { key: "ops", label: "Operations dashboard", el: <Operations /> },
  { key: "override", label: "Override console", el: <OverrideConsole /> },
  { key: "crew", label: "Crew scheduling", el: <CrewScheduling /> },
  { key: "pax", label: "Passenger app", el: <PassengerApp /> },
  { key: "crewapp", label: "Crew app", el: <CrewApp /> },
  { key: "events", label: "Event log", el: <EventLog /> },
  { key: "analytics", label: "Analytics", el: <Analytics /> },
  { key: "about", label: "Architecture map", el: <About /> },
];

export function App() {
  const { session, toast, clearToast } = useSessionState();
  const [tab, setTab] = useState("storm");
  const { data: sim } = usePoll<any>("/sim", 1500);
  return (
    <SessionCtx.Provider value={session}>
      <header className="topbar">
        <div className="brand"><div className="logo">✈</div>SkyConnect <small>Smart Flight Operations · Miami pilot</small></div>
        <div className="spacer" />
        {sim && (
          <>
            <span className={`pill ${sim.hubOnline ? "ok" : "bad"}`}><span className="dot" />Miami hub {sim.hubOnline ? "online" : "offline (edge node)"}</span>
            <span className="pill dark">MIA {fmtClock(sim.clock)}</span>
          </>
        )}
        {session.user ? (
          <span className="row" style={{ gap: 8 }}>
            <span className="small">{session.user.displayName}</span>
            <button className="btn sm" onClick={session.signOut}>Sign out</button>
          </span>
        ) : <span className="small" style={{ opacity: .7 }}>Not signed in</span>}
      </header>
      <nav className="nav">
        {TABS.map((t) => <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </nav>
      <main>{TABS.find((t) => t.key === tab)!.el}</main>
      {toast && <Toast msg={toast.msg} err={toast.err} onDone={clearToast} />}
    </SessionCtx.Provider>
  );
}
