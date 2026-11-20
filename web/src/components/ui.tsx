import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setToken, type User } from "../api";

// ---- Session (simulated single sign-on) ---------------------------------------------------

interface Session {
  user: User | null;
  signIn: (userId: string, mfaCode?: string) => Promise<void>;
  signOut: () => void;
  notify: (msg: string, err?: boolean) => void;
}
export const SessionCtx = createContext<Session>(null as any);
export const useSession = () => useContext(SessionCtx);

export function Toast({ msg, err, onDone }: { msg: string; err?: boolean; onDone: () => void }) {
  // depend only on the message, so background polling re-renders don't restart the timer
  useEffect(() => { const t = setTimeout(onDone, err ? 6000 : 3500); return () => clearTimeout(t); }, [msg, err]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className={`toast ${err ? "err" : ""}`}>{msg}</div>;
}

/** Shows children only for the allowed roles; otherwise offers a sign-in as a suitable demo user. */
export function RoleGate({ roles, children, title }: { roles: string[]; children: ReactNode; title: string }) {
  const { user, signIn, notify } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [mfaFor, setMfaFor] = useState<User | null>(null);
  const [code, setCode] = useState("");
  const [demoCode, setDemoCode] = useState("");
  useEffect(() => { api<{ users: User[]; demoMfaCode: string }>("/auth/users").then((d) => { setUsers(d.users); setDemoCode(d.demoMfaCode); }); }, []);
  if (user && roles.includes(user.role)) return <>{children}</>;
  const fit = users.filter((u) => roles.includes(u.role));
  const go = async (u: User, mfa?: string) => {
    try { await signIn(u.userId, mfa); setMfaFor(null); setCode(""); }
    catch (e) { notify((e as Error).message, true); }
  };
  return (
    <div className="card signin">
      <h2>{title}</h2>
      <p className="muted small">
        {user ? `You're signed in as ${user.displayName}, whose role can't open this screen. ` : ""}
        Sign in through the API gateway (simulated single sign-on). Each role only sees the data it needs (NFR-SEC-02).
      </p>
      {!mfaFor ? (
        <div className="userlist">
          {fit.map((u) => (
            <button key={u.userId} className="btn userbtn" onClick={() => (u.mfaRequired ? setMfaFor(u) : go(u))}>
              <span>{u.displayName}</span>
              {u.mfaRequired ? <span className="pill info">MFA required</span> : <span className="pill muted">{u.role.replace("_", " ").toLowerCase()}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="grid">
          <div className="banner info">
            <b>Multi-factor authentication.</b>&nbsp;{mfaFor.displayName} has elevated access, so a password alone isn't enough (NFR-SEC-04).
          </div>
          <div className="row">
            <input placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 160 }} />
            <button className="btn primary" onClick={() => go(mfaFor, code)}>Verify</button>
            <button className="btn" onClick={() => setCode(demoCode)}>Use demo code</button>
            <button className="btn" onClick={() => setMfaFor(null)}>Back</button>
          </div>
          <span className="muted small">Demo code: {demoCode}</span>
        </div>
      )}
    </div>
  );
}

export function useSessionState() {
  const [user, setUser] = useState<User | null>(null);
  const [toast, setToastState] = useState<{ msg: string; err?: boolean } | null>(null);
  const session: Session = {
    user,
    notify: (msg, err) => setToastState({ msg, err }),
    signIn: async (userId, mfaCode) => {
      const out = await api<{ token: string; user: User }>("/auth/login", { userId, mfaCode });
      setToken(out.token);
      setUser(out.user);
    },
    signOut: () => { setToken(null); setUser(null); },
  };
  return { session, toast, clearToast: () => setToastState(null) };
}

// ---- Small display helpers ------------------------------------------------------------------

export function FlightStatus({ status, delay, stale }: { status: string; delay?: number; stale?: boolean }) {
  const cls = status === "CANCELLED" ? "bad" : status === "DELAYED" ? "warn" : status === "ARRIVED" || status === "DEPARTED" ? "muted" : "ok";
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className={`pill ${cls}`}>{status === "DELAYED" && delay ? `Delayed +${delay}m` : status.toLowerCase()}</span>
      {stale && <span className="pill muted" title="ACARS feed unavailable: last known status">stale</span>}
    </span>
  );
}

export const Req = ({ ids }: { ids: string }) => <span className="req">{ids}</span>;

export function Kpi({ v, l, tone }: { v: ReactNode; l: string; tone?: string }) {
  return (
    <div className="card tight kpi">
      <span className="v" style={tone ? { color: `var(--${tone})` } : undefined}>{v}</span>
      <span className="l">{l}</span>
    </div>
  );
}
