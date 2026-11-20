# ADR-01: Overall architecture style

**Owner:** Margaret Haddad · **Status:** Accepted (Assignment 3 Architecture Decision Log)

## Decision / problem
Choose an architecture that can manage many different airline operations, keep them connected, stay reliable, and grow beyond Miami.

## Alternatives considered
Client-server architecture; blackboard architecture; hybrid of microservices, event-driven, and API-based integration.

## Selected approach
Hybrid: microservices, event-driven architecture through an Event Bus, and API-based integration through an API Gateway and integration adapters.

## Requirement IDs
NFR-SCAL-02, NFR-SAFE-02, PP-01, DM-01, SI-01 to SI-04

## Rationale
Separate services keep one failure from stopping everything. The Event Bus shares delays with every affected service at once, which supports the 90-second notification target. Adapters let SkyConnect keep Sabre, Amadeus, ACARS, and MRO instead of replacing them.

## Trade-offs / limitations
More services to build, monitor, and maintain than a single system. Events can arrive late or out of order.

## Risks and mitigation
Services falling out of sync. Mitigation: every event gets a unique ID and timestamp, and services ignore duplicates.

## Where it lives in this prototype
- `server/services/` — one module per service
- `server/bus/eventBus.ts` — outbox, ordered delivery, idempotent consumers
- `server/integration/adapters.ts` — one adapter per outside system
- `server/app.ts` — API gateway
