import type { DB } from "./index.js";
import { miamiLocal, addMinutes, SIM_DAY } from "../core.js";

/**
 * Seed data for the Miami pilot day. All people are fictional.
 * The star of the demo is SC 1042 (Miami -> Atlanta, 14:30), flown by Capt. Luis Diaz,
 * who already flew MIA-TPA-MIA this morning. A two-hour delay pushes him past his
 * Part 117 flight duty limit, exactly as described in the Failure Scenario.
 */

const T = (hhmm: string, day = SIM_DAY) => miamiLocal(`${day}T${hhmm}`);
const YESTERDAY = "2026-11-19";

interface FlightSeed {
  id: string; num: string; from: string; to: string; dep: string; arr: string;
  type?: string; seats?: number; status?: string; actualDep?: string; actualArr?: string; gate?: string;
}

export const FLIGHTS: FlightSeed[] = [
  // Earlier today (history for on-time reporting and Capt. Diaz's duty day)
  { id: "f-sc101", num: "SC 101", from: "MIA", to: "TPA", dep: "07:00", arr: "08:15", status: "ARRIVED", actualDep: "07:02", actualArr: "08:14" },
  { id: "f-sc102", num: "SC 102", from: "TPA", to: "MIA", dep: "09:15", arr: "10:30", status: "ARRIVED", actualDep: "09:16", actualArr: "10:33" },
  { id: "f-sc330", num: "SC 330", from: "MIA", to: "LGA", dep: "08:00", arr: "10:55", status: "ARRIVED", actualDep: "08:31", actualArr: "11:22" },
  { id: "f-sc611", num: "SC 611", from: "MIA", to: "MCO", dep: "10:00", arr: "11:05", status: "ARRIVED", actualDep: "10:04", actualArr: "11:03" },
  { id: "f-sc520", num: "SC 520", from: "MIA", to: "SJU", dep: "12:00", arr: "14:40", status: "DEPARTED", actualDep: "12:08" },
  // Afternoon departures (the storm hits these)
  { id: "f-sc210", num: "SC 210", from: "MIA", to: "DFW", dep: "13:45", arr: "16:15", gate: "D20" },
  { id: "f-sc1042", num: "SC 1042", from: "MIA", to: "ATL", dep: "14:30", arr: "16:30", gate: "D22" },
  { id: "f-sc318", num: "SC 318", from: "MIA", to: "JFK", dep: "15:00", arr: "17:50", gate: "D28" },
  { id: "f-sc455", num: "SC 455", from: "MIA", to: "ORD", dep: "16:10", arr: "19:10", gate: "D32" },
  { id: "f-sc77", num: "SC 77", from: "MIA", to: "BOS", dep: "17:30", arr: "20:40", gate: "D21" },
  { id: "f-sc1046", num: "SC 1046", from: "MIA", to: "ATL", dep: "18:15", arr: "20:15", gate: "D24" },
  { id: "f-sc902", num: "SC 902", from: "MIA", to: "LAX", dep: "19:00", arr: "21:55", gate: "D23", type: "B737", seats: 172 },
  { id: "f-sc1050", num: "SC 1050", from: "MIA", to: "ATL", dep: "20:45", arr: "22:45", gate: "D26" },
];

export const GATES = ["D20", "D21", "D22", "D23", "D24", "D25", "D26", "D27", "D28", "D29", "D30", "D31", "D32"];

/** Seats still for sale in Sabre (Sabre is the master source for seat inventory). */
export const SABRE_INVENTORY: Record<string, number> = {
  "f-sc1046": 6, "f-sc1050": 20, "f-sc210": 4, "f-sc318": 8, "f-sc455": 10,
  "f-sc77": 12, "f-sc902": 15, "f-sc1042": 0,
};

const FIRST = ["Maria", "Jean-Baptiste", "Ana", "David", "Keisha", "Carlos", "Emily", "Rafael", "Nadia", "Tyler",
  "Lucia", "Marc", "Priya", "Owen", "Camila", "Andre", "Grace", "Mateo", "Sofia", "Wesley", "Isabela", "Jamal",
  "Hannah", "Diego", "Claire", "Roberto", "Fabiola", "Kevin", "Paula", "Henry", "Leticia", "Samuel"];
const LAST = ["Gonzalez", "Pierre", "Souza", "Chen", "Johnson", "Ramirez", "Walsh", "Torres", "Haddad", "Brooks",
  "Fernandez", "Joseph", "Shah", "Miller", "Rojas", "Baptiste", "Lee", "Vargas", "Costa", "Hughes", "Lima", "Carter",
  "Klein", "Mendez", "Dubois", "Silva", "Jean", "OBrien", "Santos", "Wright", "Alves", "Thompson"];
const LANG = ["es", "ht", "pt", "en", "en", "es", "en", "es", "en", "en", "es", "ht", "en", "en", "es", "ht",
  "en", "es", "pt", "en", "pt", "en", "en", "es", "en", "pt", "ht", "en", "pt", "en", "pt", "en"] as const;

export function seed(db: DB) {
  const now = T("12:30");

  const insFlight = db.prepare(`INSERT INTO flight (flight_id, flight_number, origin, destination, aircraft_id, aircraft_type,
    seat_capacity, scheduled_departure, scheduled_arrival, estimated_departure, estimated_arrival, actual_departure,
    actual_arrival, status, delay_minutes, delay_cause, version, last_updated_at, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`);
  FLIGHTS.forEach((f, i) => {
    const dep = T(f.dep), arr = T(f.arr);
    const aDep = f.actualDep ? T(f.actualDep) : null, aArr = f.actualArr ? T(f.actualArr) : null;
    const delay = aDep ? Math.max(0, Math.round((new Date(aDep).getTime() - new Date(dep).getTime()) / 60000)) : 0;
    insFlight.run(f.id, f.num, f.from, f.to, `N${310 + i}SC`, f.type ?? "A320", f.seats ?? 150, dep, arr,
      aDep ?? dep, aArr ?? arr, aDep, aArr, f.status ?? "SCHEDULED", delay, delay > 15 ? "ATC" : null, now, "SEED");
  });

  const insGate = db.prepare(`INSERT INTO gate VALUES (?, 'MIA', 'D', ?, 'OPEN')`);
  GATES.forEach((g) => insGate.run(`g-${g}`, g));
  const insGA = db.prepare(`INSERT INTO gate_assignment VALUES (?,?,?,?,?,1,1)`);
  FLIGHTS.filter((f) => f.gate).forEach((f) =>
    insGA.run(`ga-${f.id}`, f.id, `g-${f.gate}`, addMinutes(T(f.dep), -60), addMinutes(T(f.dep), 20)));

  // Crew ------------------------------------------------------------------------------
  const insCrew = db.prepare(`INSERT INTO crew_member VALUES (?,?,?,?,'MIA',?,?,?)`);
  const insDuty = db.prepare(`INSERT INTO duty_history VALUES (?,?,?,?,?)`);
  const insAsg = db.prepare(`INSERT INTO crew_assignment VALUES (?,?,?,?,?,?, 'CONFIRMED', NULL, 'seed', ?)`);
  const flight = (fid: string) => FLIGHTS.find((f) => f.id === fid)!;
  const assign = (crewId: string, fid: string, role: string, reportMinutes = 60) => {
    const f = flight(fid);
    insAsg.run(`a-${crewId}-${fid}`, crewId, fid, role, addMinutes(T(f.dep), -reportMinutes), T(f.arr), now);
  };

  // SC 1042 crew (the demo flight)
  insCrew.run("c-diaz", "E10421", "Capt. Luis Diaz", "CAPTAIN", "A320", "ON_DUTY", 1);
  insCrew.run("c-kim", "E10422", "F/O Hana Kim", "FIRST_OFFICER", "A320", "ON_DUTY", 1);
  insCrew.run("c-lopez", "E10423", "Sofia Lopez", "FLIGHT_ATTENDANT", "A320", "ON_DUTY", 1);
  insCrew.run("c-brooks", "E10424", "Marcus Brooks", "FLIGHT_ATTENDANT", "A320", "ON_DUTY", 0); // phone off -> delivery fails
  insDuty.run("d-diaz-1", "c-diaz", T("07:00", YESTERDAY), T("17:30", YESTERDAY), 3);
  insDuty.run("d-kim-1", "c-kim", T("09:00", YESTERDAY), T("20:00", YESTERDAY), 2);
  insDuty.run("d-lopez-1", "c-lopez", T("06:00", YESTERDAY), T("15:00", YESTERDAY), 3);
  insDuty.run("d-brooks-1", "c-brooks", T("08:00", YESTERDAY), T("16:00", YESTERDAY), 2);
  assign("c-diaz", "f-sc101", "CAPTAIN");
  assign("c-diaz", "f-sc102", "CAPTAIN");
  assign("c-diaz", "f-sc1042", "CAPTAIN");
  assign("c-kim", "f-sc1042", "FIRST_OFFICER");
  assign("c-lopez", "f-sc1042", "FLIGHT_ATTENDANT");
  assign("c-brooks", "f-sc1042", "FLIGHT_ATTENDANT");

  // Reserve captains: one legal, one short on rest, one not qualified on the A320
  insCrew.run("c-patel", "E20001", "Capt. Arjun Patel", "CAPTAIN", "A320", "RESERVE", 1);
  insCrew.run("c-okafor", "E20002", "Capt. Grace Okafor", "CAPTAIN", "A320", "RESERVE", 1);
  insCrew.run("c-nguyen", "E20003", "Capt. Tom Nguyen", "CAPTAIN", "B737", "RESERVE", 1);
  insCrew.run("c-reyes", "E20004", "F/O Daniel Reyes", "FIRST_OFFICER", "A320,B737", "RESERVE", 1);
  insDuty.run("d-patel-1", "c-patel", T("08:00", YESTERDAY), T("19:00", YESTERDAY), 2);
  insDuty.run("d-okafor-1", "c-okafor", T("22:00", YESTERDAY), T("06:30"), 2); // red-eye, released 06:30 today
  insDuty.run("d-nguyen-1", "c-nguyen", T("07:00", YESTERDAY), T("15:00", YESTERDAY), 2);
  insDuty.run("d-reyes-1", "c-reyes", T("07:00", YESTERDAY), T("14:00", YESTERDAY), 2);

  // Line crew for the other afternoon flights (captain, first officer, one flight attendant)
  const others = ["f-sc210", "f-sc318", "f-sc455", "f-sc77", "f-sc1046", "f-sc902", "f-sc1050"];
  const crewNames = [
    ["Capt. Elena Rivera", "F/O James Park", "Ines Moreau"],
    ["Capt. Victor Hale", "F/O Aisha Bello", "Paolo Ricci"],
    ["Capt. Monica Shaw", "F/O Ben Ortiz", "Lena Fischer"],
    ["Capt. Raj Mehta", "F/O Chloe Grant", "Tariq Aziz"],
    ["Capt. Sam Doyle", "F/O Mia Laurent", "Nora Quinn"],
    ["Capt. Felix Wade", "F/O Zoe Tran", "Omar Haddad"],
    ["Capt. Rosa Ibarra", "F/O Liam Cole", "Eva Novak"],
  ];
  others.forEach((fid, i) => {
    const type = flight(fid).type ?? "A320";
    (["CAPTAIN", "FIRST_OFFICER", "FLIGHT_ATTENDANT"] as const).forEach((role, j) => {
      const cid = `c-${fid.slice(2)}-${j}`;
      insCrew.run(cid, `E3${i}${j}00`, crewNames[i][j], role, type, "ON_DUTY", 1);
      insDuty.run(`d-${cid}`, cid, T("08:00", YESTERDAY), T("17:00", YESTERDAY), 2);
      assign(cid, fid, role);
    });
  });

  // Passengers ------------------------------------------------------------------------
  const insPax = db.prepare(`INSERT INTO passenger VALUES (?,?,?,?,?, 'push,sms')`);
  const insRes = db.prepare(`INSERT INTO reservation VALUES (?,?,?, 'ACTIVE')`);
  const insRF = db.prepare(`INSERT INTO reservation_flight VALUES (?,?,1)`);
  const paxFlights = [
    ...Array(14).fill("f-sc1042"), ...Array(3).fill("f-sc210"), ...Array(3).fill("f-sc318"),
    ...Array(3).fill("f-sc455"), ...Array(3).fill("f-sc77"), ...Array(2).fill("f-sc1046"),
    ...Array(2).fill("f-sc902"), ...Array(2).fill("f-sc330"),
  ];
  paxFlights.forEach((fid, i) => {
    const pid = i === 0 ? "p-maria" : `p-${String(i + 1).padStart(3, "0")}`;
    const name = `${FIRST[i]} ${LAST[i]}`;
    insPax.run(pid, name, `${FIRST[i].toLowerCase()}.${LAST[i].toLowerCase()}@example.com`,
      `+1-305-555-${String(1000 + i)}`, LANG[i]);
    const rid = `r-${pid.slice(2)}`;
    insRes.run(rid, pid, `SKY${String(4200 + i)}`);
    insRF.run(rid, fid);
  });

  // Reporting history (AR-02 to AR-04) ------------------------------------------------
  const insFb = db.prepare(`INSERT INTO passenger_feedback VALUES (?,?,?,?,?, 'POST_TRIP_SURVEY')`);
  [7.0, 6.5, null, 8.0].forEach((score, i) =>
    insFb.run(`fb-${i}`, i < 2 ? "r-031" : "r-032", T("12:00"), score, score ? T("12:20") : null));
  const insBo = db.prepare(`INSERT INTO boarding_outcome VALUES (?,?,?,?,?,?)`);
  insBo.run("bo-1", "f-sc330", "p-031", "BOARDED", null, T("07:45"));
  insBo.run("bo-2", "f-sc330", "p-032", "DENIED_INVOLUNTARY", "OVERSOLD", T("07:45"));
  const insCost = db.prepare(`INSERT INTO disruption_cost VALUES (?,?,?, 'USD', ?, ?, ?)`);
  insCost.run("cost-1", "f-sc330", 775, "DENIED_BOARDING_COMPENSATION", T("08:10"), "FIN-88231");
  insCost.run("cost-2", "f-sc330", 240, "MEAL_VOUCHERS", T("08:10"), "FIN-88232");
}
