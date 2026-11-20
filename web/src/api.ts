import { useCallback, useEffect, useRef, useState } from "react";

export interface User { userId: string; displayName: string; role: string; passengerId?: string; crewId?: string; mfaRequired?: boolean }

let token: string | null = null;
export const setToken = (t: string | null) => { token = t; };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "ERROR", data.message ?? res.statusText);
  return data as T;
}

/** Poll an endpoint every `ms` milliseconds while the component is mounted. */
export function usePoll<T>(path: string | null, ms = 2000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!path) return;
    try { const d = await api<T>(path); if (alive.current) { setData(d); setError(null); } }
    catch (e) { if (alive.current) setError((e as Error).message); }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    void load();
    const t = setInterval(load, ms);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, ms]);
  return { data, error, reload: load };
}

const TZ = "America/New_York";
export const fmtTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }) : "—";
export const fmtClock = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: TZ }) : "—";
