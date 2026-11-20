# ADR-03: Cloud deployment model

**Owner:** Olivia Janse Van Rensburg · **Status:** Accepted (Assignment 3 Architecture Decision Log)

## Decision / problem
Select a cloud architecture that supports daily operations, reliability, and future expansion.

## Alternatives considered
Fully public cloud; fully on-premises; hybrid cloud.

## Selected approach
Hybrid AWS architecture with a local edge node at the Miami hub.

## Requirement IDs
NFR-REL-01, NFR-REL-02, NFR-SCAL-02, NFR-SEC-01 to NFR-SEC-04, SI-04

## Rationale
AWS supports centralized services and scalable processing; the Miami edge node maintains local access to crew schedules, gate information, Part 117 rules, and manual overrides during outages.

## Trade-offs / limitations
Two environments increase hardware, maintenance, operational complexity, and synchronization work.

## Risks and mitigation
Cloud/edge divergence during outages. Mitigation: queue changes as provisional, authenticate and audit actions, then reconcile versions and validate crew-rest and booking constraints before finalizing.

## Where it lives in this prototype
- The prototype runs in one process; see the *Production design → prototype* table in the README
- `server/edge/edgeNode.ts` — the hub side of the hybrid design
