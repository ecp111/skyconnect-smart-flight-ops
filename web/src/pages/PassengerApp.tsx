import { api, usePoll, fmtTime } from "../api";
import { FlightStatus, Req, RoleGate, useSession } from "../components/ui";

/** Passenger app (PP-01, PP-02, PP-04, PP-05). A passenger sees only their own booking. */
export function PassengerApp() {
  return (
    <>
      <div className="row between"><h1>Passenger app</h1><Req ids="PP-01 · PP-02 · PP-04 · PP-05 · NFR-USE-02" /></div>
      <p className="sub">Delay alerts in the passenger's language within 90 seconds, and self-service rebooking that only says "confirmed" once Sabre confirms.</p>
      <RoleGate roles={["PASSENGER"]} title="Sign in as a passenger"><Phone /></RoleGate>
    </>
  );
}

function Phone() {
  const { notify } = useSession();
  const { data, reload } = usePoll<any>("/passenger/me", 1500);
  if (!data) return <p className="empty">Loading…</p>;
  const f = data.flight;
  const pending = data.requests.find((r: any) => r.status === "PENDING");
  const rebook = async (flightId: string) => {
    try {
      const out = await api<any>("/passenger/me/rebook", { newFlightId: flightId });
      notify(out.status === "CONFIRMED" ? "You're confirmed" : "Request received. We're confirming your seat with the reservation system.");
      void reload();
    } catch (e) { notify((e as Error).message, true); }
  };
  return (
    <div className="phone" role="application" aria-label="SkyConnect passenger app">
      <div className="ph-top">
        <div className="small" style={{ opacity: .75 }}>Hi {data.passenger.name.split(" ")[0]} · language: {data.passenger.preferred_language}</div>
        {f && <>
          <div style={{ fontSize: 22, fontWeight: 650, marginTop: 6 }}>{f.flight_number}</div>
          <div>{f.origin} → {f.destination} · gate {f.gate ?? "TBA"}</div>
          <div className="small" style={{ marginTop: 6, opacity: .85 }}>Departs {fmtTime(f.estimated_departure)}{f.delay_minutes ? ` (was ${fmtTime(f.scheduled_departure)})` : ""}</div>
        </>}
      </div>
      <div className="ph-body">
        {f && <FlightStatus status={f.status} delay={f.delay_minutes} />}
        {pending && (
          <div className="banner warn small" role="status">
            Confirming your seat on {pending.new_flight_number}… {pending.last_error ? "The reservation system is slow; we're checking your booking status. We won't book you twice." : ""}
          </div>
        )}
        {data.requests.filter((r: any) => r.status === "CONFIRMED").slice(0, 1).map((r: any) => (
          <div key={r.request_id} className="banner ok small">Confirmed on {r.new_flight_number} · ref <span className="mono">{r.sabre_booking_ref}</span></div>
        ))}
        {data.options.length > 0 && !pending && (
          <div>
            <h3>Choose another flight</h3>
            <div className="grid" style={{ gap: 8 }}>
              {data.options.map((o: any) => (
                <div key={o.flightId} className="option">
                  <div><b>{o.flightNumber}</b><div className="small muted">Departs {fmtTime(o.estimatedDeparture)} · {o.seatsAvailable === null ? "seats unknown" : `${o.seatsAvailable} seats`}</div></div>
                  <button className="btn sm primary" disabled={o.seatsAvailable === 0} onClick={() => rebook(o.flightId)}>Select</button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div>
          <h3>Messages</h3>
          {!data.notifications.length && <p className="empty">No messages yet.</p>}
          {data.notifications.map((n: any) => (
            <div key={n.notification_id} className="msg" lang={n.language}>
              <div className="t">{fmtTime(n.sent_at ?? n.created_at)} · push</div>{n.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
