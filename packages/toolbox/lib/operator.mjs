/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A fleet operator: the trucks a haulier runs, where they are based and which lanes it carries. A user's own
// operator is theirs; a generated one is invented, plausible and labelled synthetic everywhere it is used.
//
//   {
//     name, synthetic: true|false, currency: 'cost units',
//     trucks: [{ id, label, teu, costPerKm, costPerDay }],          // one or two sizes, the larger first
//     depots: [{ name, lat, lon, trucks: { [truck id]: count } }],
//     contracts: [{ from, to }]                                       // lanes by origin and destination name
//   }
//
// In the model, a contracted lane runs on the operator's trucks: each depot's trucks of each size are shared among
// the contracted lanes nearest to it (by their origin) in proportion to what each lane needs. The operator's truck
// sizes and costs become the region's, so lanes it does not carry use them too, with a fleet of the first size
// sized to their flow, as before.

import { distance } from './geo.mjs';

export function parseOperator(input) {
    const operator = typeof input === 'string' ? JSON.parse(input) : input;
    const fail = (message) => { throw new Error(`The operator: ${message}`); };
    if (!operator || typeof operator !== 'object') fail('it is not a JSON object.');
    if (!Array.isArray(operator.trucks) || operator.trucks.length < 1 || operator.trucks.length > 2) fail('it needs one or two truck sizes.');
    const trucks = operator.trucks.map((truck, index) => {
        for (const key of ['teu', 'costPerKm', 'costPerDay']) if (!(Number(truck[key]) >= 0)) fail(`truck size ${truck.label ?? index + 1} needs a ${key} of 0 or more.`);
        if (!(Number(truck.teu) > 0)) fail(`truck size ${truck.label ?? index + 1} must carry more than 0 TEU.`);
        return { id: String(truck.id ?? `size${index + 1}`), label: String(truck.label ?? truck.id ?? `Size ${index + 1}`), teu: Number(truck.teu), costPerKm: Number(truck.costPerKm), costPerDay: Number(truck.costPerDay) };
    }).sort((a, b) => b.teu - a.teu);
    const ids = new Set(trucks.map((truck) => truck.id));
    const depots = (operator.depots ?? []).map((depot, index) => {
        if (!Number.isFinite(Number(depot.lat)) || !Number.isFinite(Number(depot.lon))) fail(`depot ${depot.name ?? index + 1} needs a latitude and a longitude.`);
        const counts = {};
        for (const [id, count] of Object.entries(depot.trucks ?? {})) {
            if (!ids.has(id)) fail(`depot ${depot.name ?? index + 1} has trucks of an unknown size "${id}".`);
            if (!(Number(count) >= 0)) fail(`depot ${depot.name ?? index + 1} needs 0 or more trucks of ${id}.`);
            counts[id] = Math.round(Number(count));
        }
        return { name: String(depot.name ?? `Depot ${index + 1}`), lat: Number(depot.lat), lon: Number(depot.lon), trucks: counts };
    });
    if (!depots.length) fail('it needs at least one depot.');
    const contracts = (operator.contracts ?? []).map((contract) => {
        if (!contract?.from || !contract?.to) fail('every contract names a lane by its origin ("from") and destination ("to").');
        return { from: String(contract.from), to: String(contract.to) };
    });
    return { name: String(operator.name ?? 'Fleet operator'), synthetic: operator.synthetic !== false, currency: String(operator.currency ?? 'cost units'), trucks, depots, contracts };
}

// Each contracted lane's trucks of each size: { [lane key 'from|to']: { depot, counts: [first size, second size] } }.
// `lanes` are [{ from, to, origin: { lat, lon }, need }], need being the lane's busy capacity in TEU (what its flow
// keeps on the road), by which a depot's trucks are shared.
export function allocateFleet(operator, lanes) {
    const contracted = lanes.filter((lane) => operator.contracts.some((contract) => contract.from === lane.from && contract.to === lane.to));
    const nearest = (lane) => operator.depots.reduce((best, depot) => (distance(depot, lane.origin) < distance(best, lane.origin) ? depot : best));
    const allocation = {};
    for (const depot of operator.depots) {
        const itsLanes = contracted.filter((lane) => nearest(lane) === depot);
        const totalNeed = itsLanes.reduce((total, lane) => total + lane.need, 0);
        // Largest remainder, so the depot's trucks add up exactly.
        const counts = itsLanes.map(() => operator.trucks.map(() => 0));
        operator.trucks.forEach((truck, size) => {
            const available = depot.trucks[truck.id] ?? 0;
            if (!totalNeed || !available) return;
            const exact = itsLanes.map((lane) => available * lane.need / totalNeed);
            const floors = exact.map(Math.floor);
            let left = available - floors.reduce((total, value) => total + value, 0);
            const order = exact.map((value, index) => [value - floors[index], index]).sort((a, b) => b[0] - a[0]);
            for (const [, index] of order) { if (left <= 0) break; floors[index] += 1; left -= 1; }
            floors.forEach((count, index) => { counts[index][size] = count; });
        });
        itsLanes.forEach((lane, index) => { allocation[`${lane.from}|${lane.to}`] = { depot: depot.name, counts: counts[index] }; });
    }
    return allocation;
}

// An invented operator for a built model: it carries the busiest port's largest lanes (about half that port's flow
// inland, at least two lanes), from one depot at the port, with 40-foot (2 TEU) and 20-foot (1 TEU) trucks. It has the
// trucks those lanes keep on the road, loaded and returning, and `reserve` loading periods of each lane's flow idle at
// the port: at least 1 for a lane to keep up, so the baseline holds still, and less than the 2 a lane the toolbox sizes
// itself has, so a closure or a surge makes its trucks the bottleneck first. The costs are invented and plausible.
// `built` is a build's data: { lanes: [{ name, from, to, rate, leadTime }], ports: [{ name }] }; `sites` gives positions.
export function generateOperator(built, sites, { reserve = 1.5, loadDays = 0.25, largeShare = 0.7 } = {}) {
    const flowFrom = new Map();
    for (const lane of built.lanes) flowFrom.set(lane.from, (flowFrom.get(lane.from) ?? 0) + lane.rate);
    const [port] = [...flowFrom].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!port) throw new Error('Build a model first: the operator is made for its lanes.');
    const position = sites.get(port);
    if (!position) throw new Error(`The position of ${port} is not known.`);
    const lanes = built.lanes.filter((lane) => lane.from === port).sort((a, b) => b.rate - a.rate);
    const total = lanes.reduce((sum, lane) => sum + lane.rate, 0);
    const carried = [];
    let sum = 0;
    for (const lane of lanes) {
        if (carried.length >= 2 && sum >= 0.5 * total) break;
        carried.push(lane);
        sum += lane.rate;
    }
    // TEU of trucks: loaded and returning, plus the loading reserve; whole trucks, rounded up.
    const need = carried.reduce((total, lane) => total + 2 * lane.rate * lane.leadTime + reserve * lane.rate * loadDays, 0);
    const large = Math.ceil(need * largeShare / 2);
    const small = Math.ceil(need * (1 - largeShare) / 1);
    return {
        name: 'Quayside Haulage (an invented operator)', synthetic: true, currency: 'cost units',
        trucks: [
            { id: 'forty', label: '40-foot (2 TEU)', teu: 2, costPerKm: 1.6, costPerDay: 240 },
            { id: 'twenty', label: '20-foot (1 TEU)', teu: 1, costPerKm: 1.2, costPerDay: 170 }
        ],
        // At the port: where its trucks start and end their trips. (An offset could put it at sea.)
        depots: [{ name: `${port} depot`, lat: position.lat, lon: position.lon, trucks: { forty: large, twenty: small } }],
        contracts: carried.map((lane) => ({ from: lane.from, to: lane.to }))
    };
}
