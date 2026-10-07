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
//   'wait'      the lane loads only its open share, and the warehouse orders over it only that share until it reopens:
//               the cargo waits at the port, and the warehouse lives on its stock and its other lanes. (Orders placed
//               on a closed lane would count as on their way, and the warehouse's order rule would then cut its orders
//               on every lane, the open ones included, while its stock ran out.)
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
        // The closed lane takes only its open share of the orders (all of them on a detour); with other ports, what it
        // can't take moves to the other lanes, otherwise it is not ordered while the road is closed.
        samples[item.name] = hold(share, item === lane ? (mode === 'detour' ? share : share * open) : share + moved * item.rate / othersTotal);
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
// `duration` or for the rest of the run. Each size changes on its own, rounded to whole trucks (a category's share of a
// link's vehicles, which is not a whole number, is scaled as it is). Trucks are hired or
// released over the lane's hiring time, and only idle ones are released. `lanes` are the build's lanes
// ({ name, fleet, fleet2 }).
export function fleetPlan({ lanes, change, start, duration = null, forkAt, runTime }) {
    if (!lanes.length) throw new Error('Choose at least one lane whose fleet changes.');
    if (!(change >= -1 && change !== 0)) throw new Error('Change the fleet by more than -100% and other than 0%.');
    const scaled = (count) => Math.max(0, Number.isInteger(count) ? Math.round(count * (1 + change)) : count * (1 + change));
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

// A supplier short, late or both for a while. Short: it makes only (1 - `short`) of what is ordered from it in the
// baseline (its capacity is held there; cutting its capacity by a share would do nothing while it has headroom). Late:
// every order takes `lateDays` longer, those already in production too, since a supplier's lead time is one figure for
// all it is making. Nothing ordered is dropped: orders wait and arrive late, and come ready close together once it ends.
// Meanwhile its warehouses
//   'wait'           order from it as before, counting what is late as on its way;
//   'otherSuppliers' order the share it cannot make from their other lanes of the same goods, in proportion to what
//                    those carry (their sources make or hold only so much); a warehouse with no other lane waits.
// `suppliers` are the build's suppliers ({ name, arrivals, berths: the most it can make, leadDays }), `chosen` the names
// of those in trouble (a supplier's copy for each category it is short of), `lanes` the build's lanes.
// The plan always holds the three parameters, those it leaves alone at their values.
export const supplierModes = ['wait', 'otherSuppliers'];
export const mostLateDays = 14;
export function supplierPlan({ lanes, suppliers, chosen, short = 0, lateDays = 0, mode = 'wait', start, duration, forkAt, runTime }) {
    const troubled = suppliers.filter((supplier) => chosen.includes(supplier.name));
    if (!troubled.length) throw new Error('Choose a supplier that is short or late.');
    if (!(short >= 0 && short <= 1)) throw new Error('A supplier makes from 0% to 100% less than is ordered from it.');
    if (!(lateDays >= 0 && lateDays <= mostLateDays)) throw new Error(`A supplier's orders take from 0 to ${mostLateDays} days longer.`);
    if (!(short > 0) && !(lateDays > 0)) throw new Error('Make the supplier short, late or both: it is neither.');
    if (!supplierModes.includes(mode)) throw new Error(`A short supplier's warehouses wait or order from their other suppliers, not "${mode}".`);
    const hold = (outside, inside) => heldPath({ outside, inside, start, duration, forkAt, runTime });
    const names = troubled.map((supplier) => supplier.name);
    const supplierCapacity = { entities: names, samples: Object.fromEntries(troubled.map((supplier) => [supplier.name, hold(supplier.berths, short > 0 ? Math.min(supplier.berths, (1 - short) * supplier.arrivals) : supplier.berths)])) };
    const supplierLeadTime = { entities: names, samples: Object.fromEntries(troubled.map((supplier) => [supplier.name, hold(supplier.leadDays, supplier.leadDays + lateDays)])) };
    const orderShare = { entities: [], samples: {} };
    const reroutedTo = new Set();
    const waiting = new Set();
    const its = lanes.filter((lane) => names.includes(lane.from) && lane.rate > 0);
    for (const warehouse of new Set(its.map((lane) => lane.to))) {
        const siblings = lanes.filter((lane) => lane.to === warehouse);
        const total = siblings.reduce((sum, lane) => sum + lane.rate, 0);
        const others = siblings.filter((lane) => !names.includes(lane.from) && lane.rate > 0);
        const othersTotal = others.reduce((sum, lane) => sum + lane.rate, 0);
        const moving = mode === 'otherSuppliers' && short > 0 && othersTotal > 0;
        const moved = moving ? short * siblings.filter((lane) => names.includes(lane.from)).reduce((sum, lane) => sum + lane.rate, 0) / total : 0;
        if (mode === 'otherSuppliers' && short > 0 && !moving) waiting.add(warehouse);
        for (const lane of siblings) {
            const share = lane.rate / total;
            const during = !moving ? share : names.includes(lane.from) ? share * (1 - short) : others.includes(lane) ? share + moved * lane.rate / othersTotal : share;
            orderShare.entities.push(lane.name);
            orderShare.samples[lane.name] = hold(share, during);
            if (moving && others.includes(lane)) reroutedTo.add(lane.name);
        }
    }
    // A supplier with no lanes (it supplies nothing) still names a lane, at its usual share, so the scenario has the
    // data it declares.
    if (!orderShare.entities.length && lanes.length) {
        const lane = lanes[0];
        const share = lane.rate / Math.max(1e-9, lanes.filter((item) => item.to === lane.to).reduce((sum, item) => sum + item.rate, 0));
        orderShare.entities.push(lane.name);
        orderShare.samples[lane.name] = hold(share, share);
    }
    return {
        supplied: { supplierCapacity, supplierLeadTime, orderShare },
        // What it does not make a day while it is short; the lanes from it; where the orders it cannot fill go, and the
        // warehouses that were to order elsewhere and have no one else to order from.
        shortPerDay: troubled.reduce((sum, supplier) => sum + Math.max(0, supplier.arrivals - Math.min(supplier.berths, (1 - short) * supplier.arrivals)) * (short > 0 ? 1 : 0), 0),
        lanes: its.map((lane) => lane.name), warehouses: [...new Set(its.map((lane) => lane.to))], reroutedTo: [...reroutedTo], waiting: [...waiting]
    };
}

// A site down for a while (a warehouse out of action, a store closed): nothing goes into it or out of it by road, and
// nothing is sold or delivered from it. `nodes` are the site's nodes in the model that hold its stock (one for each
// category), `lanes` the build's lanes and `deliveries` its deliveries ({ name, from, share }).
//   - Every lane into it and out of it is closed, and no order is placed over one: an order on a closed lane would
//     count as on its way and hold back its site's other orders (see closurePlan). Goods bound for it wait where they
//     are, and come when it reopens.
//   - Every delivery from its stock stops: a closed store's shoppers are lost or wait as when its shelves are empty.
//   - The sites it restocks 'wait', or with 'otherWarehouses' order what it sent them over their other lanes, in
//     proportion to what those carry; one with no other lane waits, and is named.
// The plan always holds the three parameters: with no delivery from the site, a delivery is named at its usual share.
export const siteDownModes = ['wait', 'otherWarehouses'];
export function siteDownPlan({ lanes, deliveries, nodes, mode = 'wait', start, duration, forkAt, runTime }) {
    if (!nodes?.length) throw new Error('Choose a site that is down.');
    if (!siteDownModes.includes(mode)) throw new Error(`The sites a site that is down restocks wait or order from their other warehouses, not "${mode}".`);
    const hold = (outside, inside) => heldPath({ outside, inside, start, duration, forkAt, runTime });
    const down = new Set(nodes);
    const into = lanes.filter((lane) => down.has(lane.to));
    const outOf = lanes.filter((lane) => down.has(lane.from));
    if (!into.length && !outOf.length) throw new Error('The site has no lane in the model: nothing goes into it or out of it.');
    const laneOpen = { entities: [], samples: {} };
    const orderShare = { entities: [], samples: {} };
    const set = (group, name, path) => { if (!group.samples[name]) group.entities.push(name); group.samples[name] = path; };
    for (const lane of [...into, ...outOf]) set(laneOpen, lane.name, hold(1, 0));
    const shareOf = (lane) => { const total = lanes.filter((item) => item.to === lane.to).reduce((sum, item) => sum + item.rate, 0); return total > 0 ? lane.rate / total : 0; };
    // It orders nothing while it is down.
    for (const lane of into) set(orderShare, lane.name, hold(shareOf(lane), 0));
    // And nothing is ordered from it: by each site it restocks, from its other lanes or not at all.
    const reroutedTo = new Set();
    const waiting = new Set();
    for (const destination of new Set(outOf.map((lane) => lane.to))) {
        const siblings = lanes.filter((lane) => lane.to === destination);
        const others = siblings.filter((lane) => !down.has(lane.from) && lane.rate > 0);
        const othersTotal = others.reduce((sum, lane) => sum + lane.rate, 0);
        const moving = mode === 'otherWarehouses' && othersTotal > 0;
        const moved = siblings.filter((lane) => down.has(lane.from)).reduce((sum, lane) => sum + shareOf(lane), 0);
        if (!moving) waiting.add(destination);
        for (const lane of siblings) {
            const share = shareOf(lane);
            if (down.has(lane.from)) set(orderShare, lane.name, hold(share, 0));
            else if (moving && others.includes(lane)) { set(orderShare, lane.name, hold(share, share + moved * lane.rate / othersTotal)); reroutedTo.add(lane.name); }
        }
    }
    const stopped = deliveries.filter((delivery) => down.has(delivery.from));
    const share = { entities: [], samples: {} };
    for (const delivery of stopped) set(share, delivery.name, hold(delivery.share, 0));
    if (!stopped.length && deliveries.length) set(share, deliveries[0].name, hold(deliveries[0].share, deliveries[0].share));
    return {
        supplied: { laneOpen, orderShare, share },
        // What it sent out a day, the lanes closed, the deliveries stopped, where orders went and who waits.
        perDay: outOf.reduce((sum, lane) => sum + lane.rate, 0),
        lanes: [...into, ...outOf].map((lane) => lane.name), deliveries: stopped.map((delivery) => delivery.name),
        reroutedTo: [...reroutedTo], waiting: [...waiting]
    };
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

// The orders of every warehouse that orders from a port a chokepoint cut reaches, while the cut lasts: a lane from an
// affected port keeps only the share its port can still supply (`dependence` of its ships through the chokepoint,
// `cut` of them kept out), a lane from a port cargo is diverted to takes the diverted cargo (`moved`: warehouse ->
// port -> TEU a day), and the cargo lost is not ordered at all, so the shares add up to less than 1. An order for cargo
// that will not come would sit on its lane as on order and hold back the warehouse's orders from everywhere else.
function chokepointOrders({ lanes, affected, cut, moved = new Map(), hold }) {
    const dependence = new Map(affected.map((item) => [item.port, item.share]));
    const warehouses = [...new Set(lanes.filter((lane) => dependence.has(lane.from) && lane.rate > 0).map((lane) => lane.to)), ...moved.keys()];
    const orderShare = { entities: [], samples: {} };
    for (const warehouse of new Set(warehouses)) {
        const own = lanes.filter((lane) => lane.to === warehouse);
        const total = own.reduce((sum, lane) => sum + lane.rate, 0);
        if (!(total > 0)) continue;
        for (const lane of own) {
            const share = lane.rate / total;
            const gained = moved.get(warehouse)?.get(lane.from) ?? 0;
            const during = gained > 0 ? share + gained / total : share * (1 - (dependence.get(lane.from) ?? 0) * cut);
            orderShare.entities.push(lane.name);
            orderShare.samples[lane.name] = hold(share, during);
        }
    }
    return orderShare;
}

// A chokepoint disruption with the cargo kept out lost (or arriving later): its warehouses stop ordering what will not
// come, while the cut lasts. `lanes` are the build's lanes, `affected` the ports the cut reaches ([{ port, share }]).
export function keptOutPlan({ lanes, affected, cut, start, duration, forkAt, runTime }) {
    const hold = (outside, during) => heldPath({ outside, inside: during, start, duration, forkAt, runTime });
    const orderShare = chokepointOrders({ lanes, affected, cut, hold });
    // A cut that reaches no warehouse (a port with no lanes) still names a lane, at its usual share, so the scenario
    // has the data it declares.
    if (!orderShare.entities.length && lanes.length) {
        const lane = lanes[0];
        const share = lane.rate / lanes.filter((item) => item.to === lane.to).reduce((sum, item) => sum + item.rate, 0);
        orderShare.entities.push(lane.name);
        orderShare.samples[lane.name] = hold(share, share);
    }
    return { supplied: { orderShare } };
}

// A chokepoint disruption's cargo diverted to ports outside it, and trucked inland from there: of what the cut keeps
// out of each affected port, each target's `diverted` share arrives at that port instead, for the days of the
// disruption (`targets`: [{ to, diverted, berths }], or one port as `to`, `diverted` and `berths`). Each warehouse
// that ordered from an affected port moves the matching shares of its orders to its lanes from those ports (standby
// lanes, or ones it already has), and those lanes hire trucks towards what their new flow needs (`trucksFound` of them:
// 1 for all, less when trucks are short), over the lane's hiring time, and keep them to the end of the run. Only cargo
// bound for a warehouse with a lane from a target can go there; the rest of that share stays kept out, and the
// warehouses without a lane are listed. `lanes` are the build's lanes ({ name, from, to, rate, leadTime, fleet }),
// `ports` its ports ({ name, arrivals, berths, schedule }), `affected` the ports the cut reaches ([{ port, share }]).
// A target's berths keep their own capacity, sized for its usual traffic, unless its `berths` (TEU a day) are given,
// from the disruption's first day to the end of the run: a port that hands little inland may have far more berths than
// that, and may not.
export function diversionPlan({ lanes, ports, affected, to = null, cut, diverted, trucksFound = 1, berths = null, targets = null, start, duration, forkAt, runTime, truckCapacity, loadDays, idleReserve = 2 }) {
    targets = (targets ?? [{ to, diverted, berths }]).map((target) => ({ berths: null, ...target }));
    if (!targets.length) throw new Error('Choose a port to divert the cargo to.');
    if (new Set(targets.map((target) => target.to)).size !== targets.length) throw new Error('Divert to each port once.');
    for (const target of targets) {
        if (!ports.some((port) => port.name === target.to)) throw new Error(`There is no port "${target.to}" in the model.`);
        if (affected.some((item) => item.port === target.to)) throw new Error(`${target.to} is reached by the disruption itself: divert to a port outside it.`);
        if (!(target.diverted > 0 && target.diverted <= 1)) throw new Error('Divert more than 0% and at most 100% of the cargo kept out.');
        if (target.berths !== null && !(target.berths > 0)) throw new Error(`The berths at ${target.to} handle more than 0 TEU a day.`);
    }
    if (targets.reduce((sum, target) => sum + target.diverted, 0) > 1 + 1e-9) throw new Error('The cargo diverted adds up to at most 100% of what is kept out.');
    if (!(trucksFound >= 0 && trucksFound <= 1)) throw new Error('The trucks found for the diversion are from 0% to 100% of what it needs.');
    const end = Math.min(start + duration, runTime);
    const inside = (time) => time >= start && time < end;
    const moved = new Map(); // warehouse -> target port -> TEU a day of orders moved to its lane from that port
    const unreachable = new Map(targets.map((target) => [target.to, new Set()]));
    const reach = new Map(); // `${affected port}|${target}` -> share of its flow bound for warehouses with a lane from the target
    for (const { port, share } of affected) {
        const outbound = lanes.filter((lane) => lane.from === port && lane.rate > 0);
        const total = outbound.reduce((sum, lane) => sum + lane.rate, 0);
        for (const target of targets) {
            let reachable = 0;
            for (const lane of outbound) {
                if (!lanes.some((item) => item.from === target.to && item.to === lane.to)) { unreachable.get(target.to).add(lane.to); continue; }
                reachable += lane.rate;
                if (!moved.has(lane.to)) moved.set(lane.to, new Map());
                moved.get(lane.to).set(target.to, (moved.get(lane.to).get(target.to) ?? 0) + lane.rate * share * cut * target.diverted);
            }
            reach.set(`${port}|${target.to}`, total > 0 ? reachable / total : 0);
        }
    }
    // Arrivals at each target: its own, and from the first day of the disruption the cargo diverted to it, following
    // each affected port's own arrivals.
    const bases = new Map(ports.map((port) => [port.name, valueOf(port.schedule ?? port.arrivals)]));
    const extra = (target) => (time) => (inside(time) ? affected.reduce((sum, { port, share }) => sum + bases.get(port)(time) * share * cut * target.diverted * reach.get(`${port}|${target.to}`), 0) : 0);
    const portByName = new Map(ports.map((port) => [port.name, port]));
    const scheduleTimes = [...targets.map((target) => portByName.get(target.to)), ...ports.filter((port) => affected.some((item) => item.port === port.name))].flatMap((port) => (port.schedule ?? []).map(([time]) => time));
    const breaks = [forkAt, start, end, runTime, ...scheduleTimes];
    const times = [...new Set(breaks)].sort((a, b) => a - b);
    const hold = (outside, during) => heldPath({ outside, inside: during, start, duration, forkAt, runTime });
    const orderShare = chokepointOrders({ lanes, affected, cut, moved, hold });
    const fleetSize = { entities: [], samples: {} };
    const vesselArrivals = { entities: [], samples: {} };
    const berthCapacity = { entities: [], samples: {} };
    const byTarget = [];
    for (const target of targets) {
        const more = extra(target);
        vesselArrivals.entities.push(target.to);
        vesselArrivals.samples[target.to] = pathThrough((time) => bases.get(target.to)(time) + more(time), breaks, forkAt, runTime);
        // TEU diverted to it in all: the extra arrivals, held between breaks.
        const teu = times.slice(0, -1).reduce((sum, time, index) => sum + more(time) * (times[index + 1] - time), 0) / 86400;
        let trucks = 0;
        const itsLanes = [];
        for (const [warehouse, byPort] of moved) {
            const teuPerDay = byPort.get(target.to) ?? 0;
            if (!(teuPerDay > 0)) continue;
            const lane = lanes.find((item) => item.from === target.to && item.to === warehouse);
            // Trucks for the new flow, as the toolbox sizes a lane: loaded and returning, and a reserve of loads, of the
            // lane's own first size when it has vehicle types.
            const rate = lane.rate + teuPerDay;
            const needed = Math.ceil((2 * rate * lane.leadTime + idleReserve * rate * (lane.loadDays ?? loadDays)) / (lane.truckCapacity ?? truckCapacity));
            const fleet = lane.fleet + Math.max(0, Math.round((needed - lane.fleet) * trucksFound));
            fleetSize.entities.push(lane.name);
            // Hired from the disruption's first day to the end of the run: the trucks stay while the cargo diverted to
            // the port still waits in its yard, as the berths opened for it do.
            fleetSize.samples[lane.name] = heldPath({ outside: lane.fleet, inside: fleet, start, forkAt, runTime });
            trucks += fleet;
            itsLanes.push(lane.name);
        }
        if (!itsLanes.length) throw new Error(`No warehouse that orders from ${affected.map((item) => item.port).join(' or ')} has a lane from ${target.to}: build the model with standby lanes from ${target.to}.`);
        // Its berths, in and out of the template's outage window alike, from the first day of the disruption to the end
        // of the run: berths opened for the diverted cargo stay open while the ships it brought still wait.
        const own = portByName.get(target.to).berths;
        berthCapacity.entities.push(target.to);
        berthCapacity.samples[target.to] = heldPath({ outside: own, inside: target.berths ?? own, start, forkAt, runTime });
        byTarget.push({ to: target.to, diverted: target.diverted, berths: target.berths ?? own, teu, lanes: itsLanes, trucks, unreachable: [...unreachable.get(target.to)] });
    }
    return {
        supplied: { vesselArrivals, orderShare, fleetSize, berthCapacity, outageCapacity: berthCapacity },
        // Per target: the TEU diverted to it, its lanes that take the diverted orders and the trucks they have for it.
        targets: byTarget,
        divertedTeu: byTarget.reduce((sum, item) => sum + item.teu, 0),
        unreachable: [...new Set(byTarget.flatMap((item) => item.unreachable))],
        lanes: byTarget.flatMap((item) => item.lanes),
        trucks: byTarget.reduce((sum, item) => sum + item.trucks, 0)
    };
}
