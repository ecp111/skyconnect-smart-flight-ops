# ADR-05: Keeping the hub running offline

**Owner:** Elle Price (with Olivia Janse Van Rensburg) · **Status:** Accepted (Assignment 3 Architecture Decision Log)

## Decision / problem
Keep essential hub operations running if Miami loses its internet connection, for example during a storm.

## Alternatives considered
Cloud only, with paper procedures during outages; a full on-site data center at each hub; a small edge node at each hub.

## Selected approach
An edge node at each hub that stores crew schedules, gate information, Part 117 rules, and the override console locally, then syncs to the cloud when the connection returns.

## Requirement IDs
NFR-REL-03, NFR-REL-04, NFR-SCAL-02, CM-02

## Rationale
Staff can keep working, and crew legality can still be checked, without a connection. It costs far less than a full data center, and each new hub (Atlanta, Dallas) gets the same setup.

## Trade-offs / limitations
Extra hardware to maintain at each hub. Local and cloud data can briefly differ during an outage.

## Risks and mitigation
Conflicting changes when the connection returns. Mitigation: queued changes carry unique IDs and timestamps, and conflicts are flagged for staff to resolve.

## Where it lives in this prototype
- `server/edge/edgeNode.ts` — snapshot, offline queue, provisional crew, ordered sync with conflict detection
