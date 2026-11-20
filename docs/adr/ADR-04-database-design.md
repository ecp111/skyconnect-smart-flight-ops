# ADR-04: Database design

**Owner:** Amanie Bhakta · **Status:** Accepted (Assignment 3 Architecture Decision Log)

## Decision / problem
Choose storage for transaction integrity and analytics.

## Alternatives considered
Pure NoSQL; relational-only; hybrid design.

## Selected approach
Managed PostgreSQL, event queue, and separate data warehouse.

## Requirement IDs
CM-01, CM-02, PP-02, FS-01, AR-01 to AR-04, NFR-PERF-03

## Rationale
ACID consistency, auditable events, and isolated reporting.

## Trade-offs / limitations
Added cloud and ETL costs; possible warehouse refresh lag.

## Risks and mitigation
Outbox and unique IDs prevent lost or duplicate events; validate Sabre support.

## Where it lives in this prototype
- `server/db/schema.sql` — the tables from Database Architecture 3.7
- `operations_event` + `processed_event` — outbox and idempotent consumers
- `server/services/analytics.ts` — warehouse snapshot vs live view
