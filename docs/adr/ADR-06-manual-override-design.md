# ADR-06: Manual override design

**Owner:** Elle Price · **Status:** Accepted (Assignment 3 Architecture Decision Log)

## Decision / problem
Decide how much control staff have over automated decisions.

## Alternatives considered
Fully automated with no overrides; staff can override everything, including the Part 117 check; staff can override everything except confirming an illegal crew assignment.

## Selected approach
Authorized staff can accept, reject, or override any automated recommendation from the cloud or the edge node, but cannot confirm an assignment the Compliance Engine has flagged as illegal.

## Requirement IDs
DM-05, NFR-SAFE-01, NFR-SAFE-03, NFR-REL-04, NFR-FAA-02

## Rationale
The board required human control over automation, but SkyConnect has already had two FAA rest violations, so the legal check cannot be bypassed. Every override records who made it, when, and why.

## Trade-offs / limitations
Staff lose flexibility in rare edge cases. Manual procedures must be kept up to date and staff must be trained on them.

## Risks and mitigation
An outage blocks urgent crew changes. Mitigation: a supervisor can save a provisional assignment, which cannot authorize flight release until compliance is verified.

## Where it lives in this prototype
- `server/services/override.ts` — decisions need a reason; forced crew assignments still run the compliance check
- `audit_log` table — who, when, why
