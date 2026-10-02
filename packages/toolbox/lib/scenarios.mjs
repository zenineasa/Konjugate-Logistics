/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The paths a scenario's fork follows, beside the chokepoint disruption's (chokepoints.mjs): a road closed for a while,
// the fleet changed, demand stepped up. Each returns the data the window supplies to the host, per parameter
// ({ [parameter key]: { entities, samples: { [entity]: [[seconds from the fork, value], ...] } } }), and the run
// counts its paths from the fork, which is the day the change starts.
//
// Every path holds a value between its breaks: the host follows the samples linearly, so a step is two samples a
// second apart.

const day = 86400;

// A held path from `forkAt` to `runTime`, valued `inside` from `start` for `duration` (to the end of the run when
// `duration` is not given) and `outside` otherwise.
export function heldPath({ outside, inside, start, duration = null, forkAt, runTime }) {
    if (!(forkAt <= start && start < runTime)) throw new Error('A change must start at or after the fork and before the end of the run.');
    if (duration !== null && !(duration > 0)) throw new Error('A change must last a while.');
    const end = duration === null ? runTime : Math.min(start + duration, runTime);
    const breaks = [...new Set([forkAt, start, end, runTime])].sort((a, b) => a - b);
    const path = [];
    for (let index = 0; index + 1 < breaks.length; index += 1) {
        const from = breaks[index];
        const to = breaks[index + 1];
        const value = from >= start && from < end ? inside : outside;
        if (path.length && path.at(-1)[1] === value) {
            path[path.length - 1] = [to - forkAt - Math.min(1, (to - from) / 2), value];
            continue;
        }
        path.push([from - forkAt, value], [to - forkAt - Math.min(1, (to - from) / 2), value]);
    }
    return path;
}

// A road closed (`open` 0) or restricted (between 0 and 1) for a while, and what its trucks do meanwhile:
//   'wait'      the lane loads only its open share; the warehouse's orders queue on it until it reopens.
//   'detour'    the lane stays open, but every trip takes `detourHours` longer (each way), over proportionally more
//               kilometres, so more of its trucks are on the road and its cost per trip rises.
//   'otherPorts' the warehouse orders what the lane can't take over its other lanes, from other ports, in proportion to
//               what they carry. Those ports ship only what their own yards hold, and orders left with them stay there
//               after the road reopens: the closed lane's cargo waits at its own port.
// `lanes` are the build's lanes ({ name, to, rate, leadTime, kilometres }).
export const closureModes = ['wait', 'detour', 'otherPorts'];
// The plan always holds the lane's four parameters (open, its warehouse's order shares, travel time, distance), the
// ones the mode leaves alone at their values.
export function closurePlan({ lanes, closed, mode = 'wait', open = 0, detourHours = 0, start, duration, forkAt, runTime }) {
    const lane = lanes.find((item) => item.name === closed);
    if (!lane) throw new Error(`There is no lane "${closed}" in the model.`);
    if (!closureModes.includes(mode)) throw new Error(`A closed road's trucks wait, take a detour or order from other ports, not "${mode}".`);
    if (mode === 'detour' && !(detourHours > 0)) throw new Error('A detour takes more than 0 hours longer.');
    if (mode !== 'detour' && !(open >= 0 && open < 1)) throw new Error('A closed road is open 0% of the way, a restricted one more but less than 100%.');
    const hold = (outside, inside) => heldPath({ outside, inside, start, duration, forkAt, runTime });
    const one = (value) => ({ entities: [lane.name], samples: { [lane.name]: value } });
    const siblings = lanes.filter((item) => item.to === lane.to);
    const total = siblings.reduce((sum, item) => sum + item.rate, 0);
    const others = siblings.filter((item) => item !== lane);
    const othersTotal = others.reduce((sum, item) => sum + item.rate, 0);
    const moved = mode === 'otherPorts' && othersTotal > 0 ? (1 - open) * lane.rate / total : 0;
    const samples = {};
    for (const item of siblings) {
        const share = item.rate / total;
        samples[item.name] = hold(share, item === lane ? share - moved : share + moved * item.rate / othersTotal);
    }
    const detour = mode === 'detour' ? lane.leadTime + detourHours / 24 : lane.leadTime;
    const kilometres = lane.kilometres * detour / lane.leadTime;
    return {
        supplied: {
            laneOpen: one(hold(1, mode === 'detour' ? 1 : open)),
            orderShare: { entities: siblings.map((item) => item.name), samples },
            leadTime: one(hold(lane.leadTime, detour)),
            distance: one(hold(lane.kilometres, kilometres))
        },
        warehouse: lane.to,
        // Where the orders the lane can't take go: the other lanes, or nowhere (they wait).
        reroutedTo: moved > 0 ? others.map((item) => item.name) : [],
        // Containers a day the lane stops carrying while it is closed; the detour's extra length.
        teuPerDay: mode === 'detour' ? 0 : (1 - open) * lane.rate,
        detour: mode === 'detour' ? { hours: detourHours, kilometres: kilometres - lane.kilometres } : null
    };
}

// The fleet on some lanes changed by `change` (-0.3 for 30% fewer trucks, 0.2 for a fifth more) from `start`, for
// `duration` or for the rest of the run. Each size changes on its own, rounded to whole trucks. Trucks are hired or
// released over the lane's hiring time, and only idle ones are released. `lanes` are the build's lanes
// ({ name, fleet, fleet2 }).
export function fleetPlan({ lanes, change, start, duration = null, forkAt, runTime }) {
    if (!lanes.length) throw new Error('Choose at least one lane whose fleet changes.');
    if (!(change >= -1 && change !== 0)) throw new Error('Change the fleet by more than -100% and other than 0%.');
    const scaled = (count) => Math.max(0, Math.round(count * (1 + change)));
    const sizes = { fleetSize: 'fleet', fleetSize2: 'fleet2' };
    const supplied = {};
    for (const [key, field] of Object.entries(sizes)) {
        supplied[key] = { entities: lanes.map((lane) => lane.name), samples: {} };
        for (const lane of lanes) {
            const count = lane[field] ?? 0;
            supplied[key].samples[lane.name] = heldPath({ outside: count, inside: scaled(count), start, duration, forkAt, runTime });
        }
    }
    const before = lanes.reduce((sum, lane) => sum + (lane.fleet ?? 0) + (lane.fleet2 ?? 0), 0);
    const after = lanes.reduce((sum, lane) => sum + scaled(lane.fleet ?? 0) + scaled(lane.fleet2 ?? 0), 0);
    return { supplied, trucks: { before, after } };
}

// Demand in some towns stepped up (or down) by `change` from `start`, for `duration` or for the rest of the run.
// `towns` are the build's towns ({ name, demand }).
export function demandPlan({ towns, change, start, duration = null, forkAt, runTime }) {
    if (!towns.length) throw new Error('Choose at least one town whose demand changes.');
    if (!(change > -1 && change !== 0)) throw new Error('Change demand by more than -100% and other than 0%.');
    const samples = Object.fromEntries(towns.map((town) => [town.name, heldPath({ outside: town.demand, inside: town.demand * (1 + change), start, duration, forkAt, runTime })]));
    const end = duration === null ? runTime : Math.min(start + duration, runTime);
    const extra = towns.reduce((sum, town) => sum + town.demand * change, 0) * (end - start) / day;
    return { supplied: { baseDemand: { entities: towns.map((town) => town.name), samples } }, extraTeu: extra };
}

// A held path through `breaks` (seconds), valued `valueAt(time)` from each break to the next, counted from `forkAt`.
function pathThrough(valueAt, breaks, forkAt, runTime) {
    const times = [...new Set(breaks.filter((time) => time >= forkAt && time <= runTime))].sort((a, b) => a - b);
    const path = [];
    for (let index = 0; index + 1 < times.length; index += 1) {
        const from = times[index];
        const to = times[index + 1];
        const value = valueAt(from);
        if (path.length && path.at(-1)[1] === value) {
            path[path.length - 1] = [to - forkAt - Math.min(1, (to - from) / 2), value];
            continue;
        }
        path.push([from - forkAt, value], [to - forkAt - Math.min(1, (to - from) / 2), value]);
    }
    return path;
}

// A held schedule's value at a time: [[seconds, value], ...], or a constant.
const valueOf = (base) => {
    const schedule = Array.isArray(base) ? base : [[0, base]];
    return (time) => {
        let value = schedule[0][1];
        for (const [sampleTime, sampleValue] of schedule) {
            if (sampleTime > time) break;
            value = sampleValue;
        }
        return value;
    };
};

// A chokepoint disruption's cargo diverted to a port outside it, and trucked inland from there: `diverted` of what the
// cut keeps out of each affected port arrives at port `to` instead, for the days of the disruption. Each warehouse
// that ordered from an affected port moves the matching share of its orders to its lane from `to` (a standby lane,
// or one it already has), and that lane hires trucks towards what its new flow needs (`trucksFound` of them: 1 for
// all, less when trucks are short), over the lane's hiring time. Only cargo bound for a warehouse with a lane from
// `to` can be diverted; the rest of the share stays kept out, and the warehouses without a lane are listed.
// `lanes` are the build's lanes ({ name, from, to, rate, leadTime, fleet }), `ports` its ports ({ name, arrivals,
// berths, schedule }), `affected` the ports the cut reaches ([{ port, share }]). The berths at `to` keep their own
// capacity, sized for its usual traffic, unless `berths` (TEU a day) is given, from the disruption's first day to the
// end of the run: a port that hands little inland may have far more berths than that, and may not.
export function diversionPlan({ lanes, ports, affected, to, cut, diverted, trucksFound = 1, berths = null, start, duration, forkAt, runTime, truckCapacity, loadDays, idleReserve = 2 }) {
    const target = ports.find((port) => port.name === to);
    if (!target) throw new Error(`There is no port "${to}" in the model.`);
    if (affected.some((item) => item.port === to)) throw new Error(`${to} is reached by the disruption itself: divert to a port outside it.`);
    if (!(diverted > 0 && diverted <= 1)) throw new Error('Divert more than 0% and at most 100% of the cargo kept out.');
    if (!(trucksFound >= 0 && trucksFound <= 1)) throw new Error('The trucks found for the diversion are from 0% to 100% of what it needs.');
    if (berths !== null && !(berths > 0)) throw new Error(`The berths at ${to} handle more than 0 TEU a day.`);
    const end = Math.min(start + duration, runTime);
    const inside = (time) => time >= start && time < end;
    const moved = new Map(); // warehouse -> TEU a day of orders moved to its lane from `to`
    const unreachable = new Set();
    const reach = new Map(); // affected port -> share of its flow bound for warehouses with a lane from `to`
    for (const { port, share } of affected) {
        const outbound = lanes.filter((lane) => lane.from === port && lane.rate > 0);
        const total = outbound.reduce((sum, lane) => sum + lane.rate, 0);
        let reachable = 0;
        for (const lane of outbound) {
            if (!lanes.some((item) => item.from === to && item.to === lane.to)) { unreachable.add(lane.to); continue; }
            reachable += lane.rate;
            moved.set(lane.to, (moved.get(lane.to) ?? 0) + lane.rate * share * cut * diverted);
        }
        reach.set(port, total > 0 ? reachable / total : 0);
    }
    // Arrivals at `to`: its own, and from the first day of the disruption the cargo diverted to it, following each
    // affected port's own arrivals.
    const bases = new Map(ports.map((port) => [port.name, valueOf(port.schedule ?? port.arrivals)]));
    const extra = (time) => (inside(time) ? affected.reduce((sum, { port, share }) => sum + bases.get(port)(time) * share * cut * diverted * reach.get(port), 0) : 0);
    const scheduleTimes = [target, ...ports.filter((port) => affected.some((item) => item.port === port.name))].flatMap((port) => (port.schedule ?? []).map(([time]) => time));
    const breaks = [forkAt, start, end, runTime, ...scheduleTimes];
    const arrivals = pathThrough((time) => bases.get(to)(time) + extra(time), breaks, forkAt, runTime);
    // TEU diverted in all: the extra arrivals, held between breaks.
    const times = [...new Set(breaks)].sort((a, b) => a - b);
    const divertedTeu = times.slice(0, -1).reduce((sum, time, index) => sum + extra(time) * (times[index + 1] - time), 0) / 86400;
    // Orders: each warehouse's lanes keep their shares, less what moves from the affected ports' lanes to `to`'s.
    const orderShare = { entities: [], samples: {} };
    const fleetSize = { entities: [], samples: {} };
    let trucks = 0;
    const hold = (outside, during) => heldPath({ outside, inside: during, start, duration, forkAt, runTime });
    for (const [warehouse, teuPerDay] of moved) {
        const own = lanes.filter((lane) => lane.to === warehouse);
        const total = own.reduce((sum, lane) => sum + lane.rate, 0);
        for (const lane of own) {
            const share = lane.rate / total;
            const dependence = affected.find((item) => item.port === lane.from)?.share ?? 0;
            const during = lane.from === to ? share + teuPerDay / total : share * (1 - dependence * cut * diverted);
            orderShare.entities.push(lane.name);
            orderShare.samples[lane.name] = hold(share, during);
            if (lane.from !== to) continue;
            // Trucks for the new flow, as the toolbox sizes a lane: loaded and returning, and a reserve of loads.
            const rate = lane.rate + teuPerDay;
            const needed = Math.ceil((2 * rate * lane.leadTime + idleReserve * rate * loadDays) / truckCapacity);
            const fleet = lane.fleet + Math.max(0, Math.round((needed - lane.fleet) * trucksFound));
            fleetSize.entities.push(lane.name);
            fleetSize.samples[lane.name] = hold(lane.fleet, fleet);
            trucks += fleet;
        }
    }
    if (!fleetSize.entities.length) throw new Error(`No warehouse that orders from ${affected.map((item) => item.port).join(' or ')} has a lane from ${to}: build the model with standby lanes from ${to}.`);
    // Its berths, in and out of the template's outage window alike, from the first day of the disruption to the end of
    // the run: berths opened for the diverted cargo stay open while the ships it brought still wait.
    const berthPath = heldPath({ outside: target.berths, inside: berths ?? target.berths, start, forkAt, runTime });
    return {
        supplied: {
            vesselArrivals: { entities: [to], samples: { [to]: arrivals } }, orderShare, fleetSize,
            berthCapacity: { entities: [to], samples: { [to]: berthPath } }, outageCapacity: { entities: [to], samples: { [to]: berthPath } }
        },
        // The lanes from `to` that take the diverted orders, and the trucks they have for it.
        divertedTeu, unreachable: [...unreachable], lanes: fleetSize.entities, trucks
    };
}
