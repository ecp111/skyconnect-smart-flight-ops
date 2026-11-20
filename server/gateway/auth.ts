import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { AppError } from "../core.js";

/**
 * API Gateway identity (NFR-SEC-02, NFR-SEC-04; Integration Architecture "How users connect").
 * Simulated single sign-on with role-based access. Accounts with elevated access must pass
 * multi-factor authentication. The demo MFA code is shown on the sign-in screen.
 */

export type Role = "PASSENGER" | "CREW" | "GATE_AGENT" | "CREW_SCHEDULER" | "OPS_CONTROLLER" | "ADMIN";
export const DEMO_MFA_CODE = "246810";
const ELEVATED: Role[] = ["CREW_SCHEDULER", "OPS_CONTROLLER", "ADMIN"];

export interface DemoUser { userId: string; displayName: string; role: Role; passengerId?: string; crewId?: string }

export const DEMO_USERS: DemoUser[] = [
  { userId: "u-maria", displayName: "Maria Gonzalez (passenger, SC 1042)", role: "PASSENGER", passengerId: "p-maria" },
  { userId: "u-jb", displayName: "Jean-Baptiste Pierre (passenger, SC 1042)", role: "PASSENGER", passengerId: "p-002" },
  { userId: "u-diaz", displayName: "Capt. Luis Diaz (crew, SC 1042)", role: "CREW", crewId: "c-diaz" },
  { userId: "u-patel", displayName: "Capt. Arjun Patel (reserve crew)", role: "CREW", crewId: "c-patel" },
  { userId: "u-brooks", displayName: "Marcus Brooks (flight attendant, SC 1042)", role: "CREW", crewId: "c-brooks" },
  { userId: "u-gate", displayName: "Taylor Reed (gate agent, Concourse D)", role: "GATE_AGENT" },
  { userId: "u-sched", displayName: "Jordan Ellis (crew scheduler)", role: "CREW_SCHEDULER" },
  { userId: "u-ctrl", displayName: "Sam Rivera (operations controller)", role: "OPS_CONTROLLER" },
  { userId: "u-admin", displayName: "System administrator", role: "ADMIN" },
];

const sessions = new Map<string, DemoUser>();

export function login(userId: string, mfaCode?: string) {
  const user = DEMO_USERS.find((u) => u.userId === userId);
  if (!user) throw new AppError(401, "UNKNOWN_USER", "Unknown user");
  if (ELEVATED.includes(user.role) && mfaCode !== DEMO_MFA_CODE)
    throw new AppError(401, "MFA_REQUIRED", "This account has elevated access and requires multi-factor authentication");
  const token = randomUUID();
  sessions.set(token, user);
  return { token, user };
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const user = sessions.get(token);
  if (!user) return next(new AppError(401, "NOT_SIGNED_IN", "Sign in first"));
  (req as any).user = user;
  next();
}

export const requireRole = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) => {
  const user = (req as any).user as DemoUser;
  if (!user || !roles.includes(user.role)) return next(new AppError(403, "FORBIDDEN", `Your role (${user?.role}) cannot do this`));
  next();
};

export const userOf = (req: Request) => (req as any).user as DemoUser;
