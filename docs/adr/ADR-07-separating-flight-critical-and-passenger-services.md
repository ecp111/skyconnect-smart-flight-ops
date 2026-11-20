# ADR-07: Separating flight-critical and passenger services

**Owner:** Elle Price · **Status:** Accepted (Assignment 3 Architecture Decision Log)

## Decision / problem
Prevent a problem with passenger features from affecting flight and crew operations.

## Alternatives considered
All services in one shared environment; separate flight-critical and passenger zones.

## Selected approach
Two zones: flight-critical (Flight Operations, Disruption Management, Crew Scheduling, Compliance Engine, Override Console) and passenger (Rebooking, Voucher/Eligibility, Notification).

## Requirement IDs
NFR-SAFE-02, NFR-REL-02, PP-01, PP-02

## Rationale
A heavy rebooking surge or a crash in the passenger app during a storm can't slow down or stop crew scheduling and flight monitoring.

## Trade-offs / limitations
More infrastructure to manage. The zones still have to share data through the Event Bus.

## Risks and mitigation
An Event Bus outage cuts both zones off. Mitigation: the Event Bus runs in more than one data center with automatic failover.

## Where it lives in this prototype
- Passenger services never write flight or crew tables; they react to events
- `tests/security-and-scenario.test.ts` — crew scheduling keeps working with the notification provider down
