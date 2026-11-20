import { createSystem } from "../server/system.js";
import { createSimClock } from "../server/core.js";

/** A fresh system with a frozen clock (12:30 on the pilot day) and near-instant simulators. */
export function makeSystem() {
  return createSystem({ clock: createSimClock(undefined, true), latencyMs: 1 });
}

/** Delay SC 1042 by two hours, the trigger used throughout the Failure Scenario. */
export async function delaySc1042(sys: ReturnType<typeof makeSystem>, minutes = 120) {
  sys.flightOps.applyStatusUpdate({ flightId: "f-sc1042", source: "DISRUPTION_MGMT", delayMinutes: minutes, cause: "WEATHER" });
  await sys.bus.drain();
}

export const count = (sys: ReturnType<typeof makeSystem>, sql: string, ...args: unknown[]) =>
  (sys.db.prepare(sql).get(...args) as { n: number }).n;
