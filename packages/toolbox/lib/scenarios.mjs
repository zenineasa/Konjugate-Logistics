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
