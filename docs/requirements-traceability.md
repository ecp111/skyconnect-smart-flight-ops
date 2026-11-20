# Requirements traceability: report → code → test

Each row connects a requirement from Assignments 1 and 2 to the code that implements it in this prototype and the automated test that verifies it (`npm test`). The Decision IDs match the Assignment 3 Architecture Decision Log and `docs/adr/`.

| Req. ID | Summary | Where in the code | Decision | Verified by |
|---|---|---|---|---|
| PP-01 | Delay alerts within 90 seconds | `services/notification.ts` | ADR-01, ADR-02 | `events-and-flights.test.ts` › alerts every passenger within 90 seconds |
| PP-02 | Self-service rebooking | `services/rebooking.ts`, Passenger app | ADR-04, ADR-07 | `rebooking.test.ts` |
| PP-04 | Proactive status notifications | `services/notification.ts` | ADR-01 | `events-and-flights.test.ts` |
| PP-05 | Multilingual (es, pt, ht) | Notification templates | ADR-01 | `events-and-flights.test.ts` › in their language |
| FS-01 | Real-time status dashboard | `services/flightOps.ts`, Operations dashboard | ADR-01, ADR-04 | `events-and-flights.test.ts` › stale, untrusted, out-of-order |
| GO-05 | Real-time gate assignments | `flightOps.changeGate()` | ADR-04, ADR-05 | `events-and-flights.test.ts` › closed or occupied gates |
| CM-01 | Automated crew scheduling | `services/crewScheduling.ts` | ADR-02, ADR-04 | `crew-and-override.test.ts` |
| CM-02 | Part 117 rest tracking | `services/compliance.ts` | ADR-02, ADR-05, ADR-06 | `compliance.test.ts` |
| CM-03 | Crew schedule updates and rest alerts | `services/notification.ts`, Crew app | ADR-02 | `events-and-flights.test.ts` › dead-letters and flags a phone call |
| DM-01 | Detect disruptions, alert staff | `services/disruption.ts`, weather/ACARS adapters | ADR-01 | `events-and-flights.test.ts` › weather alert |
| DM-02 | Predict rest violations before they occur | `crewScheduling.onFlightChanged()` | ADR-02 | `compliance.test.ts` › before the extra two hours |
| DM-03 | Weather rerouting recommendations | `disruption.ts` → Override console | ADR-06 | `events-and-flights.test.ts` › reroute for airborne flights |
| DM-04 | Identify affected passengers, offer options | `rebooking.options()` | ADR-01, ADR-07 | `rebooking.test.ts` › lists later flights |
| DM-05 | Manual override | `services/override.ts` | ADR-06 | `crew-and-override.test.ts` |
| SI-01 | Sabre | `SabreAdapter` + Sabre simulator | ADR-01 | `rebooking.test.ts` › Sabre failures |
| SI-02 | Amadeus | `AmadeusAdapter` | ADR-01 | Storm demo (Amadeus switch) |
| SI-03 | ACARS | `AcarsAdapter` | ADR-01 | `events-and-flights.test.ts` › stale when ACARS is down |
| SI-04 | MRO | MRO simulator | ADR-01, ADR-03 | Not built beyond the simulator (Should Have) |
| AR-01–04 | On-time, satisfaction, denied boarding, cost | `services/analytics.ts` | ADR-04 | Analytics tab |
| NFR-PERF-03 | No duplicate data across systems | Outbox + `processed_event`, Sabre correlation IDs | ADR-01, ADR-04 | `events-and-flights.test.ts` › replayed event; `rebooking.test.ts` › no second booking |
| NFR-SEC-01 | Payment card protection | `PaymentSim.tokenize()` | ADR-03 | `security-and-scenario.test.ts` |
| NFR-SEC-02 | Role-based access | `gateway/auth.ts` | ADR-01, ADR-03 | `security-and-scenario.test.ts` |
| NFR-SEC-03 | Audit trail | `audit_log` | ADR-03 | `crew-and-override.test.ts` (audited) |
| NFR-SEC-04 | MFA for elevated access | `gateway/auth.ts` | ADR-03 | `security-and-scenario.test.ts` |
| NFR-REL-03 | Offline operation | `edge/edgeNode.ts` | ADR-05 | `edge-node.test.ts` |
| NFR-REL-04 | Documented manual fallback | Override console, manual flight status | ADR-06 | `crew-and-override.test.ts` › by hand |
| NFR-SAFE-01 | Human oversight | Recommendations need a decision and reason | ADR-06 | `crew-and-override.test.ts` |
| NFR-SAFE-02 | Passenger failures don't affect flight-critical work | Zone separation | ADR-07 | `security-and-scenario.test.ts` › zone separation |
| NFR-FAA-01 | Evaluate before confirming | `crewScheduling.assign()` | ADR-02 | `compliance.test.ts` |
| NFR-FAA-02 | Block violations | `assign()` + override limit | ADR-02, ADR-06 | `crew-and-override.test.ts` |
| NFR-FAA-03 | Recheck when operations change | Subscribes to `FLIGHT_DELAYED` | ADR-01, ADR-02 | `compliance.test.ts` |
| NFR-SCAL-02 | Expand beyond Miami | Edge node per hub, shared cloud services | ADR-01, ADR-03, ADR-05 | Design only (one hub seeded) |
| Failure Scenario | Severe weather at MIA | `scenario/storm.ts` | All | `security-and-scenario.test.ts` › all eight parts |
