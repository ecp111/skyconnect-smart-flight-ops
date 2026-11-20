-- SkyConnect transactional schema (Assignment 3, Database Architecture, section 3.7)
-- The report specifies managed PostgreSQL (Amazon RDS). This prototype uses SQLite so it
-- runs with one command; the tables, keys and CHECK rules follow the report.

PRAGMA foreign_keys = ON;

-- Flight and gate operations ----------------------------------------------------------
CREATE TABLE flight (
  flight_id            TEXT PRIMARY KEY,
  flight_number        TEXT NOT NULL,
  origin               TEXT NOT NULL,
  destination          TEXT NOT NULL,
  aircraft_id          TEXT NOT NULL,
  aircraft_type        TEXT NOT NULL,
  seat_capacity        INTEGER NOT NULL,
  scheduled_departure  TEXT NOT NULL,
  scheduled_arrival    TEXT NOT NULL,
  estimated_departure  TEXT NOT NULL,
  estimated_arrival    TEXT NOT NULL,
  actual_departure     TEXT,
  actual_arrival       TEXT,
  status               TEXT NOT NULL CHECK (status IN ('SCHEDULED','DELAYED','CANCELLED','BOARDING','DEPARTED','ARRIVED')),
  delay_minutes        INTEGER NOT NULL DEFAULT 0,
  delay_cause          TEXT,
  version              INTEGER NOT NULL DEFAULT 1,
  last_updated_at      TEXT NOT NULL,
  source               TEXT NOT NULL
);

CREATE TABLE gate (
  gate_id       TEXT PRIMARY KEY,
  airport_code  TEXT NOT NULL,
  terminal      TEXT NOT NULL,
  gate_code     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED'))
);

CREATE TABLE gate_assignment (
  gate_assignment_id  TEXT PRIMARY KEY,
  flight_id           TEXT NOT NULL REFERENCES flight(flight_id),
  gate_id             TEXT NOT NULL REFERENCES gate(gate_id),
  start_time          TEXT NOT NULL,
  end_time            TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  version             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_gate_assignment_flight ON gate_assignment(flight_id, active);

-- Crew management and compliance ------------------------------------------------------
CREATE TABLE crew_member (
  crew_id         TEXT PRIMARY KEY,
  employee_id     TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('CAPTAIN','FIRST_OFFICER','FLIGHT_ATTENDANT')),
  base            TEXT NOT NULL,
  qualifications  TEXT NOT NULL,            -- comma-separated aircraft types
  availability    TEXT NOT NULL CHECK (availability IN ('ON_DUTY','RESERVE','OFF')),
  phone_reachable INTEGER NOT NULL DEFAULT 1 -- used by the notification simulator
);

-- Earlier duty periods (yesterday and the past week) used for rest and cumulative checks.
CREATE TABLE duty_history (
  duty_id       TEXT PRIMARY KEY,
  crew_id       TEXT NOT NULL REFERENCES crew_member(crew_id),
  report_time   TEXT NOT NULL,
  release_time  TEXT NOT NULL,
  segments      INTEGER NOT NULL
);

CREATE TABLE crew_assignment (
  assignment_id       TEXT PRIMARY KEY,
  crew_id             TEXT NOT NULL REFERENCES crew_member(crew_id),
  flight_id           TEXT NOT NULL REFERENCES flight(flight_id),
  assigned_role       TEXT NOT NULL,
  duty_start          TEXT NOT NULL,
  duty_end            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('PROVISIONAL','CONFIRMED','REJECTED','REMOVED')),
  override_reference  TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_crew_assignment_crew ON crew_assignment(crew_id, status);
CREATE INDEX idx_crew_assignment_flight ON crew_assignment(flight_id, status);

CREATE TABLE rest_check (
  check_id            TEXT PRIMARY KEY,
  assignment_id       TEXT NOT NULL REFERENCES crew_assignment(assignment_id),
  result              TEXT NOT NULL CHECK (result IN ('PASS','FAIL')),
  rule                TEXT NOT NULL,
  details             TEXT NOT NULL,
  checked_at          TEXT NOT NULL,
  source_system       TEXT NOT NULL CHECK (source_system IN ('CLOUD','EDGE')),
  evidence_reference  TEXT NOT NULL
);

-- Passenger information and reservations ----------------------------------------------
CREATE TABLE passenger (
  passenger_id              TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  email                     TEXT NOT NULL,
  phone                     TEXT NOT NULL,
  preferred_language        TEXT NOT NULL CHECK (preferred_language IN ('en','es','pt','ht')),
  notification_preferences  TEXT NOT NULL DEFAULT 'push,sms'
);

CREATE TABLE reservation (
  reservation_id     TEXT PRIMARY KEY,
  passenger_id       TEXT NOT NULL REFERENCES passenger(passenger_id),
  booking_reference  TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL CHECK (status IN ('ACTIVE','CANCELLED'))
);

CREATE TABLE reservation_flight (
  reservation_id    TEXT NOT NULL REFERENCES reservation(reservation_id),
  flight_id         TEXT NOT NULL REFERENCES flight(flight_id),
  segment_sequence  INTEGER NOT NULL,
  PRIMARY KEY (reservation_id, segment_sequence)
);

CREATE TABLE rebooking (
  request_id         TEXT PRIMARY KEY,
  reservation_id     TEXT NOT NULL REFERENCES reservation(reservation_id),
  old_flight_id      TEXT NOT NULL REFERENCES flight(flight_id),
  new_flight_id      TEXT NOT NULL REFERENCES flight(flight_id),
  correlation_id     TEXT NOT NULL UNIQUE,
  sabre_booking_ref  TEXT,
  status             TEXT NOT NULL CHECK (status IN ('PENDING','CONFIRMED','FAILED')),
  needs_review       INTEGER NOT NULL DEFAULT 0,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         TEXT NOT NULL,
  resolved_at        TEXT
);
-- One open rebooking request per reservation at a time (prevents double-clicks / duplicates).
CREATE UNIQUE INDEX idx_rebooking_one_pending ON rebooking(reservation_id) WHERE status = 'PENDING';

-- Operational events and notifications -------------------------------------------------
CREATE TABLE operations_event (
  event_id     TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  source       TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  version      INTEGER NOT NULL,
  details      TEXT NOT NULL DEFAULT '{}',  -- JSON, no PII
  published    INTEGER NOT NULL DEFAULT 0   -- transactional outbox flag
);
CREATE INDEX idx_event_unpublished ON operations_event(published, recorded_at);

-- Idempotent consumers: each service records which events it has already handled.
CREATE TABLE processed_event (
  consumer  TEXT NOT NULL,
  event_id  TEXT NOT NULL REFERENCES operations_event(event_id),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE notification (
  notification_id         TEXT PRIMARY KEY,
  passenger_id            TEXT REFERENCES passenger(passenger_id),
  crew_id                 TEXT REFERENCES crew_member(crew_id),
  flight_id               TEXT REFERENCES flight(flight_id),
  channel                 TEXT NOT NULL,
  language                TEXT NOT NULL,
  message                 TEXT NOT NULL,
  delivery_status         TEXT NOT NULL CHECK (delivery_status IN ('QUEUED','SENT','FAILED','DEAD_LETTER')),
  retry_count             INTEGER NOT NULL DEFAULT 0,
  triggered_by_event_id   TEXT REFERENCES operations_event(event_id),
  event_occurred_at       TEXT,
  created_at              TEXT NOT NULL,
  sent_at                 TEXT,
  CHECK ((passenger_id IS NULL) <> (crew_id IS NULL))
);

CREATE TABLE dead_letter (
  dead_letter_id  TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  reference_id    TEXT NOT NULL,
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  resolved        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE baggage_event (
  baggage_event_id  TEXT PRIMARY KEY,
  flight_id         TEXT NOT NULL REFERENCES flight(flight_id),
  event_type        TEXT NOT NULL,
  occurred_at       TEXT NOT NULL
);

-- Decision support and manual override -------------------------------------------------
CREATE TABLE recommendation (
  recommendation_id  TEXT PRIMARY KEY,
  type               TEXT NOT NULL CHECK (type IN ('REROUTE','CREW_REPLACEMENT')),
  flight_id          TEXT NOT NULL REFERENCES flight(flight_id),
  details            TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('OPEN','ACCEPTED','REJECTED')),
  created_at         TEXT NOT NULL,
  decided_by         TEXT,
  decided_at         TEXT,
  decision_reason    TEXT
);

-- Audit records (codes only, never names or contact details) ---------------------------
CREATE TABLE audit_log (
  audit_id              TEXT PRIMARY KEY,
  actor_id              TEXT NOT NULL,
  action                TEXT NOT NULL,
  entity_type           TEXT NOT NULL,
  entity_id             TEXT NOT NULL,
  old_value             TEXT,
  new_value             TEXT,
  override_reason_code  TEXT,
  source_system         TEXT NOT NULL DEFAULT 'CLOUD',
  occurred_at           TEXT NOT NULL
);

-- Reporting sources (AR-02 to AR-04) ---------------------------------------------------
CREATE TABLE passenger_feedback (
  feedback_id     TEXT PRIMARY KEY,
  reservation_id  TEXT NOT NULL REFERENCES reservation(reservation_id),
  survey_sent_at  TEXT NOT NULL,
  score           REAL,
  submitted_at    TEXT,
  source          TEXT NOT NULL
);

CREATE TABLE boarding_outcome (
  outcome_id    TEXT PRIMARY KEY,
  flight_id     TEXT NOT NULL REFERENCES flight(flight_id),
  passenger_id  TEXT NOT NULL REFERENCES passenger(passenger_id),
  outcome_type  TEXT NOT NULL CHECK (outcome_type IN ('BOARDED','DENIED_INVOLUNTARY','DENIED_VOLUNTARY')),
  cause         TEXT,
  occurred_at   TEXT NOT NULL
);

CREATE TABLE disruption_cost (
  cost_id            TEXT PRIMARY KEY,
  flight_id          TEXT NOT NULL REFERENCES flight(flight_id),
  amount             REAL NOT NULL,
  currency           TEXT NOT NULL,
  category           TEXT NOT NULL,
  recorded_at        TEXT NOT NULL,
  finance_reference  TEXT NOT NULL
);

-- Miami hub edge node (local store) ----------------------------------------------------
-- In production this lives on the on-site edge server. Here it is a separate set of
-- tables that the cloud services cannot write to directly.
CREATE TABLE edge_snapshot (
  snapshot_id  TEXT PRIMARY KEY,
  taken_at     TEXT NOT NULL,
  data         TEXT NOT NULL
);

CREATE TABLE edge_queue (
  queue_id      TEXT PRIMARY KEY,
  sequence      INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('GATE_CHANGE','PROVISIONAL_CREW_ASSIGNMENT','OVERRIDE')),
  payload       TEXT NOT NULL,
  base_version  INTEGER,
  actor_id      TEXT NOT NULL,
  queued_at     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('QUEUED','APPLIED','CONFLICT','REJECTED')),
  result        TEXT
);
