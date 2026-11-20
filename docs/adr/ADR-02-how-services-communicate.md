# ADR-02: How services communicate

**Owner:** Margaret Haddad · **Status:** Accepted (Assignment 3 Architecture Decision Log)

## Decision / problem
Decide when a service should wait for an answer and when it should send an update and move on.

## Alternatives considered
All synchronous calls; all asynchronous messages; a mix based on the task.

## Selected approach
Mix: synchronous calls for safety checks such as the Part 117 compliance check; asynchronous messages for notifications, rebooking, and logging.

## Requirement IDs
CM-02, NFR-FAA-02, PP-01, CM-03

## Rationale
An illegal crew assignment must be blocked before it is saved, so that check has to wait for an answer. Notifications don't need a reply, so they can be retried without holding up the rest of the system.

## Trade-offs / limitations
Synchronous calls can slow scheduling if the Compliance Engine is busy. Asynchronous messages may be briefly delayed.

## Risks and mitigation
Compliance Engine unavailable. Mitigation: the edge node keeps Part 117 rules locally, and assignments are saved only as provisional until verified.

## Where it lives in this prototype
- `server/services/crewScheduling.ts` — `assign()` calls the Compliance Engine and waits
- `server/services/notification.ts` — subscribes to events, retries, dead-letters
