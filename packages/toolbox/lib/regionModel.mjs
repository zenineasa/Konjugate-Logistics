/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Builds a runnable model from a curated region: each kept port, logistics zone and town becomes a
// node from the component templates, each town draws on the nearby zones, each zone is supplied
// by nearby ports over road lanes whose travel times and distances come from routing, and every
// initial value is the steady state, so the baseline holds still. Every value records where it came
// from: sourced, routed, assumed or the user's own.

import { toLocal } from './geo.mjs';
import { historyWindow, tonnesPerTeu } from './portwatch.mjs';

export const regionModelDefaults = {
    // Containers a day a port hands inland on average, until port activity is matched: an assumption to replace.
    // It is shared among the ports in proportion to their port land, so a large container port takes more than
    // a small harbour.
    portTeuPerDay: 100,
    // For a port with IMF PortWatch activity: the average weight of an imported TEU, and the share of its
    // container imports handed inland (the rest only change ships there). Both assumptions to adjust.
    tonnesPerTeu,
    inlandShare: 1,
    // A port with IMF PortWatch history: 'average' keeps its arrivals at a steady average, so the
    // baseline holds still; 'history' has them follow its daily container imports over the latest
    // `days` days of the history (model day 0 is the first of them), held for each day, through a
    // stored parameter schedule. The average is then taken over the same days, so arrivals and
    // demand balance over the run.
    arrivals: 'average',
    // The period of the history both use: `days` days from this date (YYYY-MM-DD). Not given: arrivals that follow
    // the history replay the latest days, and a steady average is taken over the whole history fetched.
    historyFrom: null,
    // Berth capacity as a multiple of the port's arrivals.
    berthHeadroom: 1.5,
    // Hours added to every road trip for gate and yard handling.
    gateHours: 2,
    // A zone orders from at most this many ports, preferring nearer ones.
    portsPerZone: 2,
    // A lane carrying less than this share of its zone's supply, or less than this many TEU a day, is dropped
    // where the rest can still balance: a lane of a fraction of a truck a day is noise, not a route.
    minimumShare: 0.1,
    minimumLaneTeuPerDay: 2,
    // A town draws on up to this many logistics zones, in proportion to their significance (floor area and
    // road access) and nearness; a zone this many hours further away gets 1/e the weight.
    zonesPerTown: 4,
    townGravityHours: 0.5,
    // How quickly preference falls with travel time: a port this many hours further away gets 1/e the weight.
    gravityHours: 3,
    // Idle trucks kept per lane, in multiples of what one loading period needs.
    idleReserve: 2,
    // Weight of a town or customer with neither a population nor a demand of its own: a small town.
    assumedPopulation: 20000,
    days: 90, stepMinutes: 15, outputMinutes: 60
};

// 1, 2 or 5 times a power of ten, at or above `value`: a round slider limit.
function niceCeiling(value) {
    if (!(value > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    return [1, 2, 5, 10].map((step) => step * power).find((candidate) => candidate >= value);
}

function templateValue(templates, templateId, key) {
    const declared = templates.get(templateId)?.sharedParameters?.find((item) => item.key === key);
    if (!declared) throw new Error(`The ${templateId} template has no shared parameter "${key}".`);
    return declared.value;
}

// Balances a flow table so each zone receives its demand and each port ships its arrivals, keeping
// the gravity weights' shape (iterative proportional fitting). Returns null if it does not settle.
function balanceFlows(pairs, zoneDemand, portSupply) {
    const flows = new Map(pairs.map((pair) => [pair.key, pair.weight]));
    for (let iteration = 0; iteration < 5000; iteration += 1) {
        const zoneTotals = new Map();
        for (const pair of pairs) zoneTotals.set(pair.zone, (zoneTotals.get(pair.zone) ?? 0) + flows.get(pair.key));
        for (const pair of pairs) flows.set(pair.key, flows.get(pair.key) * zoneDemand.get(pair.zone) / zoneTotals.get(pair.zone));
        const portTotals = new Map();
        for (const pair of pairs) portTotals.set(pair.port, (portTotals.get(pair.port) ?? 0) + flows.get(pair.key));
        let error = 0;
        for (const [port, supply] of portSupply) error = Math.max(error, Math.abs((portTotals.get(port) ?? 0) - supply) / supply);
        if (error < 1e-10) return flows;
        for (const pair of pairs) flows.set(pair.key, flows.get(pair.key) * portSupply.get(pair.port) / portTotals.get(pair.port));
    }
    return null;
}

// A road lane carrying `rate` TEU/day over `leadTime` days with `fleet` trucks, in steady state:
// loaded trucks on the road, empty ones returning, the rest idle at the origin.
export function roadLaneState(rate, leadTime, fleet, { truckCapacity, loadDays, responseDays }) {
    const loaded = rate * leadTime / 3;
    const loadedTrucks = rate * leadTime / truckCapacity;
    const returning = Math.max(0, Math.min(rate / truckCapacity * leadTime, fleet - loadedTrucks));
    const idle = Math.max(0, fleet - loadedTrucks - returning);
    const busy = loadedTrucks + returning;
    return {
        loaded1: loaded, loaded2: loaded, loaded3: loaded, idleTrucks: idle, returning, requested: rate * responseDays,
        arriving: rate, canLoad: idle * truckCapacity / loadDays, utilisation: busy + idle > 0 ? busy / (busy + idle) : 0
    };
}

// `builder` is a ModelBuilder over the component templates. `selection` holds the curated
// { ports, zones, towns } (each with lat, lon, name, and optionally teuPerDay for a port or a
// customer's fixed demand, and population for a town). `route(a, b)` returns { hours, kilometres, basis }.
export function buildRegionModel({ builder, selection, route, options = {} }) {
    const settings = { ...regionModelDefaults, ...options };
    const templates = builder.templates;
    const truckCapacity = templateValue(templates, 'roadLane', 'truckCapacity');
    const loadDays = templateValue(templates, 'roadLane', 'loadDays');
    const responseDays = templateValue(templates, 'roadShipment', 'responseDays');
    const coverDays = templateValue(templates, 'warehouse', 'coverDays');
    const berthingDays = templateValue(templates, 'port', 'berthingDays');

    const provenance = [];
    const warnings = [];
    const note = (entity, parameter, value, unit, basis, detail) => provenance.push({ entity, parameter, value, unit, basis, detail });
    const ports = selection.ports ?? [];
    const zones = selection.zones ?? [];
    const towns = selection.towns ?? [];
    if (!ports.length) throw new Error('Keep at least one port: it is where containers enter the region.');
    if (!zones.length) throw new Error('Keep at least one logistics zone: towns are served from zones.');
    if (!towns.length) throw new Error('Keep at least one town or customer: it is where the demand is.');

    // ---- supply: the user's figures; then IMF PortWatch activity; otherwise an assumed volume shared by port land
    const supply = new Map();
    const histories = new Map(); // port id -> { samples: [[seconds, TEU/day]], from, to } when arrivals follow history
    // A port's usual arrivals, in TEU a day, when its history has a break: the level before a fall (or after a rise),
    // so a scenario can tell when the period modelled is already far below it.
    const normals = new Map();
    const normalOf = (activity) => (activity.shift ? Math.max(activity.shift.before, activity.shift.after) / settings.tonnesPerTeu * settings.inlandShare : null);
    const secondsPerDay = templateValue(templates, 'port', 'secondsPerDay');
    const sourced = (port) => !(Number(port.teuPerDay) > 0) && port.activity?.importTonnesPerDay > 0;
    const assumedPorts = ports.filter((port) => !(Number(port.teuPerDay) > 0) && !sourced(port));
    const landOf = (port) => Number(port.areaSquareKilometres) || 0;
    const largestLand = Math.max(0, ...assumedPorts.map(landOf));
    // A harbour mapped as a point, or one of the user's own, still takes a tenth of the largest port's share.
    const portWeight = (port) => (largestLand > 0 ? Math.max(landOf(port), 0.1 * largestLand) : 1);
    const assumedWeight = assumedPorts.reduce((total, port) => total + portWeight(port), 0);
    for (const port of ports) {
        if (sourced(port)) {
            const activity = port.activity;
            const teu = (tonnes) => tonnes / settings.tonnesPerTeu * settings.inlandShare;
            const conversion = `at an assumed ${settings.tonnesPerTeu} t a TEU${settings.inlandShare === 1 ? ', counting containers that only change ships there' : `, ${Math.round(settings.inlandShare * 100)}% of them handed inland (assumed)`}`;
            const period = activity.daily?.length ? historyWindow(activity.daily, { from: settings.historyFrom, days: settings.days }) : [];
            if (settings.historyFrom && !period.length) {
                warnings.push(`${port.name}'s PortWatch history has no days from ${settings.historyFrom}; its latest ${settings.days} days are used instead.`);
            }
            const chosen = period.length ? period : activity.daily?.slice(-settings.days) ?? [];
            const replay = settings.arrivals === 'history' && chosen.length ? chosen : null;
            const shiftNote = activity.shift
                ? ` Its history ${activity.shift.change < 0 ? 'fell' : 'rose'} ${Math.round(Math.abs(activity.shift.change) * 100)}% from ${activity.shift.month}, so this depends on the period chosen.`
                : '';
            if (replay) {
                const start = Date.parse(`${replay[0][0]}T00:00:00Z`);
                const samples = replay.map(([date, tonnes]) => [Math.round((Date.parse(`${date}T00:00:00Z`) - start) / 86400000) * secondsPerDay, teu(tonnes)]);
                const value = samples.reduce((total, sample) => total + sample[1], 0) / samples.length;
                const from = replay[0][0];
                const to = replay.at(-1)[0];
                supply.set(port.id, value);
                histories.set(port.id, { samples, from, to });
                normals.set(port.id, normalOf(activity));
                note(port.name, 'Containers handed inland', value, 'TEU/day', 'sourced',
                    `IMF PortWatch (Source: International Monetary Fund), ${activity.name}: the arrivals follow each day's container imports from ${from} (model day 0) to ${to} (${samples.length} days), averaging ${Math.round(value * settings.tonnesPerTeu / settings.inlandShare).toLocaleString('en')} t a day, ${conversion}.${shiftNote}`);
                continue;
            }
            // A steady average: over the chosen period when one is given, otherwise over the whole history fetched.
            const averaged = settings.historyFrom && period.length
                ? { tonnes: period.reduce((total, row) => total + row[1], 0) / period.length, from: period[0][0], to: period.at(-1)[0], days: period.length }
                : { tonnes: activity.importTonnesPerDay, from: activity.from, to: activity.to, days: activity.days };
            const value = teu(averaged.tonnes);
            supply.set(port.id, value);
            normals.set(port.id, normalOf(activity));
            note(port.name, 'Containers handed inland', value, 'TEU/day', 'sourced',
                `IMF PortWatch (Source: International Monetary Fund), ${activity.name}: container imports averaging ${Math.round(averaged.tonnes).toLocaleString('en')} t a day over ${averaged.from} to ${averaged.to} (${averaged.days} days), ${conversion}.${shiftNote}`);
            continue;
        }
        const user = Number(port.teuPerDay) > 0;
        const value = user ? Number(port.teuPerDay) : settings.portTeuPerDay * assumedPorts.length * portWeight(port) / assumedWeight;
        supply.set(port.id, value);
        const assumption = largestLand > 0 && assumedPorts.length > 1
            ? `Assumed, with no port activity matched: ${settings.portTeuPerDay} TEU/day a port on average, shared by port land (${landOf(port).toFixed(1)} km²${landOf(port) < 0.1 * largestLand ? ', counted as a tenth of the largest' : ''}).`
            : 'Assumed, with no port activity matched.';
        note(port.name, 'Containers handed inland', value, 'TEU/day', user ? (port.teuPerDayBasis ?? 'user') : 'assumed', user ? port.teuPerDaySource : assumption);
    }
    const totalSupply = [...supply.values()].reduce((total, value) => total + value, 0);

    // ---- demand: fixed where given, the rest split by population
    const fixed = towns.filter((town) => Number(town.teuPerDay) > 0);
    const fixedTotal = fixed.reduce((total, town) => total + Number(town.teuPerDay), 0);
    const weighted = towns.filter((town) => !(Number(town.teuPerDay) > 0));
    let remainder = totalSupply - fixedTotal;
    let fixedScale = 1;
    if (remainder < 0 || (remainder > 0 && !weighted.length)) {
        fixedScale = totalSupply / fixedTotal;
        remainder = 0;
        warnings.push(`The customers' own demand (${fixedTotal.toFixed(0)} TEU/day) differs from what the ports hand inland (${totalSupply.toFixed(0)} TEU/day); it was scaled to match so the baseline holds still.`);
    }
    const weightOf = (town) => Number(town.population) || settings.assumedPopulation;
    const weightTotal = weighted.reduce((total, town) => total + weightOf(town), 0);
    const demand = new Map();
    for (const town of fixed) {
        demand.set(town.id, Number(town.teuPerDay) * fixedScale);
        note(town.name, 'Demand', demand.get(town.id), 'TEU/day', fixedScale === 1 ? 'user' : 'assumed', fixedScale === 1 ? 'Your figure.' : 'Your figure, scaled to match port volumes.');
    }
    for (const town of weighted) {
        demand.set(town.id, remainder * weightOf(town) / weightTotal);
        note(town.name, 'Demand', demand.get(town.id), 'TEU/day', 'assumed',
            `Share of the ports' inland volume by population (${{
                OpenStreetMap: 'population from OpenStreetMap',
                user: 'your population figure',
                shared: `an even share of ${town.city ?? 'the city'}'s population among its suburbs, an assumption`
            }[town.populationBasis] ?? 'assumed size'}).`);
    }

    // ---- towns to zones: each town draws on up to zonesPerTown nearby zones, by significance and nearness
    const zoneWeight = (zone) => Number(zone.significance) > 0 && Number.isFinite(Number(zone.significance)) ? Number(zone.significance)
        : Number(zone.floorAreaSquareMetres) > 0 ? Number(zone.floorAreaSquareMetres) : null;
    const knownWeights = zones.map(zoneWeight).filter((value) => value !== null).sort((a, b) => a - b);
    // A zone of the user's own, with no floor area given, counts as a typical one of the region.
    const typicalWeight = knownWeights.length ? knownWeights[Math.floor(knownWeights.length / 2)] : 1;
    const allocations = []; // { town, zone, share, leg }
    for (const town of towns) {
        const options = zones.map((zone) => {
            const leg = route(zone, town);
            return { zone, leg, weight: (zoneWeight(zone) ?? typicalWeight) * Math.exp(-leg.hours / settings.townGravityHours) };
        }).sort((a, b) => b.weight - a.weight);
        const nearby = options.slice(0, settings.zonesPerTown).filter((option) => option.weight >= settings.minimumShare * options[0].weight);
        // A share of less than half a lane's minimum is not worth its own deliveries: it goes to the town's main zone.
        const nearbyWeight = nearby.reduce((sum, option) => sum + option.weight, 0);
        const kept = nearby.filter((option, index) => index === 0 || demand.get(town.id) * option.weight / nearbyWeight >= settings.minimumLaneTeuPerDay / 2);
        const total = kept.reduce((sum, option) => sum + option.weight, 0);
        for (const option of kept) allocations.push({ town, zone: option.zone, share: option.weight / total, leg: option.leg });
    }
    const zoneDemand = new Map();
    for (const allocation of allocations) zoneDemand.set(allocation.zone.id, (zoneDemand.get(allocation.zone.id) ?? 0) + allocation.share * demand.get(allocation.town.id));
    const usedZones = zones.filter((zone) => zoneDemand.get(zone.id) > 0);
    const unusedZones = zones.filter((zone) => !(zoneDemand.get(zone.id) > 0));
    if (unusedZones.length) warnings.push(`${unusedZones.map((zone) => zone.name).join(', ')} ${unusedZones.length === 1 ? 'serves' : 'serve'} none of the kept towns (${unusedZones.length === 1 ? 'it is' : 'they are'} not among the nearest few to any), so ${unusedZones.length === 1 ? 'it was' : 'they were'} left out of the model. Keep a town nearby, or add a customer of your own, to use ${unusedZones.length === 1 ? 'it' : 'them'}.`);

    // ---- zones to ports: nearest ports, balanced so every port ships what arrives and every zone gets what it needs
    const legs = new Map();
    for (const zone of usedZones) for (const port of ports) legs.set(`${zone.id}|${port.id}`, route(port, zone));
    const pairFor = (zone, port) => {
        const key = `${zone.id}|${port.id}`;
        return { key, zone: zone.id, port: port.id, weight: supply.get(port.id) * Math.exp(-legs.get(key).hours / settings.gravityHours) };
    };
    const nearestPorts = (zone) => [...ports].sort((a, b) => legs.get(`${zone.id}|${a.id}`).hours - legs.get(`${zone.id}|${b.id}`).hours);
    const pairsOf = (keys) => usedZones.flatMap((zone) => ports.filter((port) => keys.has(`${zone.id}|${port.id}`)).map((port) => pairFor(zone, port)));
    // Each zone draws on its nearest few ports, one more at a time until every port ships what arrives and every zone gets what it needs.
    let support = null;
    let flows = null;
    let portsPerZone = Math.min(settings.portsPerZone, ports.length);
    for (; portsPerZone <= ports.length && !flows; portsPerZone += 1) {
        support = new Set();
        for (const zone of usedZones) nearestPorts(zone).slice(0, portsPerZone).forEach((port) => support.add(`${zone.id}|${port.id}`));
        for (const port of ports) {
            if ([...support].some((key) => key.endsWith(`|${port.id}`))) continue;
            const nearest = [...usedZones].sort((a, b) => legs.get(`${a.id}|${port.id}`).hours - legs.get(`${b.id}|${port.id}`).hours)[0];
            support.add(`${nearest.id}|${port.id}`);
        }
        flows = balanceFlows(pairsOf(support), zoneDemand, supply);
    }
    if (!flows) throw new Error('The flows between ports and zones could not be balanced.');
    if (portsPerZone - 1 > settings.portsPerZone) warnings.push(`The nearest ${settings.portsPerZone} ports could not supply every zone in balance, so zones draw on up to ${portsPerZone - 1}.`);
    // Then drop the smallest lanes, one at a time, while the rest still balances.
    for (;;) {
        const small = [...support].filter((key) => {
            const [zoneId, portId] = key.split('|');
            const onlyForPort = [...support].filter((other) => other.endsWith(`|${portId}`)).length === 1;
            const onlyForZone = [...support].filter((other) => other.startsWith(`${zoneId}|`)).length === 1;
            return !onlyForPort && !onlyForZone && flows.get(key) < Math.max(settings.minimumShare * zoneDemand.get(zoneId), settings.minimumLaneTeuPerDay);
        }).sort((a, b) => flows.get(a) - flows.get(b));
        let dropped = false;
        for (const key of small) {
            const trial = new Set(support);
            trial.delete(key);
            const balanced = balanceFlows(pairsOf(trial), zoneDemand, supply);
            if (balanced) { support = trial; flows = balanced; dropped = true; break; }
        }
        if (!dropped) break;
    }

    // ---- layout: north up, the region spread over about 80 units so names on the canvas stay apart
    const everything = [...ports, ...usedZones, ...towns];
    const origin = { lat: everything.reduce((total, item) => total + item.lat, 0) / everything.length, lon: everything.reduce((total, item) => total + item.lon, 0) / everything.length };
    const local = everything.map((item) => toLocal(item, origin));
    const extent = Math.max(1, ...local.map((point) => Math.max(Math.abs(point.x), Math.abs(point.y))));
    const scale = 40 / extent;
    const position = (item) => {
        const point = toLocal(item, origin);
        return [Number((point.x * scale).toFixed(3)), Number((point.y * scale).toFixed(3)), 0];
    };
    const between = (a, b, offset = 0) => {
        const p = position(a);
        const q = position(b);
        return [Number(((p[0] + q[0]) / 2).toFixed(3)), Number(((p[1] + q[1]) / 2 + offset).toFixed(3)), 0];
    };

    // Shared parameters a placement created, by template key, so scenarios can find them by entity.
    const parameterIndex = [];
    const indexPlacement = (templateId, entity, before) => {
        const created = builder.sharedParameters.slice(before);
        for (const declared of templates.get(templateId).sharedParameters ?? []) {
            if (declared.scope === 'project') continue;
            const shared = created.find((item) => item.symbol === declared.symbol || item.symbol.replace(/\d+$/, '') === declared.symbol);
            if (shared) {
                created.splice(created.indexOf(shared), 1);
                parameterIndex.push({
                    key: declared.key, entity, name: `${declared.name} (${entity})`, symbol: shared.symbol, sharedParameterId: shared.id,
                    scope: 'instance', value: shared.value, unit: shared.unit, live: shared.mode === 'live'
                });
            }
        }
    };
    const place = (templateId, entity, options) => {
        const before = builder.sharedParameters.length;
        const node = builder.placeNode(templateId, options);
        indexPlacement(templateId, entity, before);
        return node;
    };
    const bundle = (templateId, entity, endpoints, options) => {
        const before = builder.sharedParameters.length;
        builder.applyBundle(templateId, endpoints, options);
        indexPlacement(templateId, entity, before);
    };

    // ---- ports
    const portNodes = new Map();
    for (const port of ports) {
        const arrivals = supply.get(port.id);
        const berthCapacity = arrivals * settings.berthHeadroom;
        note(port.name, 'Berth capacity', berthCapacity, 'TEU/day', 'assumed', `${settings.berthHeadroom} times its arrivals.`);
        portNodes.set(port.id, place('port', port.name, {
            name: port.name, position: position(port),
            initialValues: { queue: arrivals * berthingDays, stock: arrivals * 3, waitDays: arrivals * berthingDays / berthCapacity },
            shared: { vesselArrivals: arrivals, berthCapacity, outageCapacity: berthCapacity }
        }));
        const indexed = parameterIndex.findLast((entry) => entry.entity === port.name && entry.key === 'vesselArrivals');
        const shared = builder.sharedParameters.find((item) => item.id === indexed?.sharedParameterId);
        if (!shared) throw new Error(`The arrivals of ${port.name} could not be found.`);
        // Arrivals that follow the port's history: a stored schedule on its own arrivals parameter. The
        // parameter keeps the average as its value, used again if the schedule is removed.
        const history = histories.get(port.id);
        if (history) {
            shared.schedule = { interpolation: 'hold', samples: history.samples };
            indexed.schedule = { from: history.from, to: history.to, days: history.samples.length };
        }
        // Live, so a scenario fork can change them (a disrupted chokepoint), with a slider up to four times the
        // busiest day.
        const busiest = Math.max(arrivals, ...(history?.samples.map((sample) => sample[1]) ?? []));
        const maximum = niceCeiling(4 * busiest);
        builder.setLive(indexed.symbol, { minimum: 0, maximum, step: maximum / 100 });
        Object.assign(indexed, { live: true, minimum: 0, maximum });
    }

    // ---- zones (warehouses), their lanes from ports, and towns
    const flowsByZone = new Map();
    for (const key of support) {
        const [zoneId, portId] = key.split('|');
        if (!flowsByZone.has(zoneId)) flowsByZone.set(zoneId, []);
        flowsByZone.get(zoneId).push({ port: ports.find((port) => port.id === portId), rate: flows.get(key), leg: legs.get(key) });
    }
    const lanes = [];
    const warehouses = new Map();
    for (const zone of usedZones) {
        const zoneFlows = flowsByZone.get(zone.id).filter((flow) => flow.rate > 1e-9);
        const total = zoneDemand.get(zone.id);
        const laneSpecs = zoneFlows.map((flow) => ({ ...flow, leadTime: Number(((flow.leg.hours + settings.gateHours) / 24).toFixed(4)) }));
        const onOrder = laneSpecs.reduce((sum, lane) => sum + lane.rate * (responseDays + lane.leadTime), 0);
        const planningLeadTime = onOrder / total;
        const warehouse = place('warehouse', zone.name, {
            name: zone.name, position: position(zone),
            initialValues: { stock: total * coverDays, onOrder, forecast: total, orderRate: total },
            shared: { planningLeadTime }
        });
        note(zone.name, 'Planned replenishment time', planningLeadTime, 'day', 'routed', 'Average order-to-arrival time over its lanes.');
        for (const [laneIndex, lane] of laneSpecs.entries()) {
            const busyTrucks = 2 * lane.rate * lane.leadTime / truckCapacity;
            const fleet = Math.ceil(busyTrucks + settings.idleReserve * lane.rate * loadDays / truckCapacity);
            const laneName = `Road ${lane.port.name} → ${zone.name}`;
            const kilometres = Number(lane.leg.kilometres.toFixed(1));
            const leadTime = lane.leadTime;
            const node = place('roadLane', laneName, {
                name: laneName, position: between(lane.port, zone, laneIndex * 0.8),
                initialValues: roadLaneState(lane.rate, leadTime, fleet, { truckCapacity, loadDays, responseDays }),
                shared: { leadTime, distance: kilometres, fleetSize: fleet }
            });
            bundle('roadShipment', laneName, { origin: portNodes.get(lane.port.id), lane: node, destination: warehouse }, { shared: { orderShare: lane.rate / total } });
            const how = {
                routed: [`${lane.leg.hours.toFixed(1)} h over major roads`, 'Over major roads.'],
                local: [`${lane.leg.hours.toFixed(1)} h estimated over local streets (the sites are close)`, 'Straight line lengthened for local streets.'],
                'straight-line': [`${lane.leg.hours.toFixed(1)} h, a straight-line estimate (no road route was found)`, 'Straight line lengthened for detours.']
            }[lane.leg.basis];
            note(laneName, 'Travel time', leadTime, 'day', lane.leg.basis === 'routed' ? 'routed' : 'assumed', `${how[0]}, plus ${settings.gateHours} h at the gates.`);
            note(laneName, 'Distance', kilometres, 'km', lane.leg.basis === 'routed' ? 'routed' : 'assumed', how[1]);
            note(laneName, 'Fleet', fleet, 'trucks', 'assumed', `Enough for the baseline flow of ${lane.rate.toFixed(1)} TEU/day, plus a reserve.`);
            lanes.push({ name: laneName, from: lane.port.name, to: zone.name, rate: lane.rate, leadTime, kilometres, fleet, basis: lane.leg.basis });
        }
        warehouses.set(zone.id, warehouse);
    }

    // ---- towns, each served by its zones
    for (const town of towns) {
        const townDemand = demand.get(town.id);
        const node = place('demandZone', town.name, {
            name: town.name, position: position(town),
            initialValues: { backlog: townDemand * responseDays, demandRate: townDemand },
            shared: { baseDemand: townDemand }
        });
        for (const allocation of allocations.filter((item) => item.town === town)) {
            const zoneTotal = zoneDemand.get(allocation.zone.id);
            bundle('delivery', `${town.name} from ${allocation.zone.name}`, { warehouse: warehouses.get(allocation.zone.id), zone: node }, {
                shared: { share: allocation.share * townDemand / zoneTotal, demandShare: allocation.share }
            });
            if (allocations.filter((item) => item.town === town).length > 1) {
                note(town.name, `Share served from ${allocation.zone.name}`, allocation.share * 100, '%', 'assumed', `By the zone's size and road access, and ${allocation.leg.hours.toFixed(1)} h by road.`);
            }
        }
    }

    const document = builder.document({ days: settings.days, stepDays: settings.stepMinutes / 1440, outputDays: settings.outputMinutes / 1440 });
    return {
        document, provenance, warnings, parameterIndex, lanes,
        // Each port's arrivals as built: its average, and the held schedule it follows when it has one -- what a
        // scenario that changes them starts from. And the run's length in days.
        ports: ports.map((port) => ({
            name: port.name, arrivals: supply.get(port.id), schedule: histories.get(port.id)?.samples ?? null,
            usual: normals.get(port.id) ?? null, shift: port.activity?.shift ?? null
        })),
        days: settings.days,
        // The ports whose arrivals follow their history, and the dates model day 0 and the last day stand for.
        histories: [...histories].map(([id, history]) => ({ port: ports.find((port) => port.id === id).name, from: history.from, to: history.to, days: history.samples.length })),
        unusedZones: unusedZones.map((zone) => zone.name),
        // One entry per town and zone serving it: the zone's share of the town's demand.
        served: allocations.map((allocation) => ({ town: allocation.town.name, zone: allocation.zone.name, share: allocation.share, demand: allocation.share * demand.get(allocation.town.id), hours: allocation.leg.hours }))
    };
}
