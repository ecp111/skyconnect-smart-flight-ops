import { randomUUID } from "node:crypto";

/** Shared helpers: simulated clock, IDs and time math. */

export interface Clock {
  now(): Date;
  advance(minutes: number): void;
}

/**
 * Simulation clock. The demo always starts at 12:30 local time in Miami on the pilot day,
 * then moves forward in real time. Tests use a frozen clock.
 */
export const SIM_DAY = "2026-11-20";
export const MIAMI_UTC_OFFSET_HOURS = -5; // EST (no DST in November)

export function miamiLocal(dateTime: string): string {
  // "2026-11-20T14:30" (Miami local) -> ISO UTC string
  const d = new Date(`${dateTime}:00Z`);
  d.setUTCHours(d.getUTCHours() - MIAMI_UTC_OFFSET_HOURS);
  return d.toISOString();
}

export function createSimClock(startLocal = `${SIM_DAY}T12:30`, frozen = false): Clock {
  let offsetMs = new Date(miamiLocal(startLocal)).getTime() - Date.now();
  let frozenAt = new Date(miamiLocal(startLocal)).getTime();
  return {
    now: () => new Date(frozen ? frozenAt : Date.now() + offsetMs),
    advance: (minutes: number) => {
      offsetMs += minutes * 60_000;
      frozenAt += minutes * 60_000;
    },
  };
}

export const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export const addMinutes = (iso: string, minutes: number) =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

export const hoursBetween = (a: string, b: string) =>
  (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;

/** Local Miami hour (0-23) of an ISO timestamp. */
export const localHour = (iso: string) => {
  const d = new Date(iso);
  return (d.getUTCHours() + MIAMI_UTC_OFFSET_HOURS + 24) % 24;
};

export const localTime = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + MIAMI_UTC_OFFSET_HOURS * 3_600_000);
  return d.toISOString().slice(11, 16);
};

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
