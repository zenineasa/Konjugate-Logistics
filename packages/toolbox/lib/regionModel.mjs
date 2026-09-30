/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Builds a runnable model from a curated region: each kept port, logistics zone and town becomes a
// node from the component templates, towns are served from their nearest zone, each zone is supplied
// by nearby ports over road lanes whose travel times and distances come from routing, and every
// initial value is the steady state, so the baseline holds still. Every value records where it came
// from: sourced, routed, assumed or the user's own.

import { toLocal } from './geo.mjs';

export const regionModelDefaults = {
    // Containers a day a port hands inland, until port activity is matched: an assumption to replace.
    portTeuPerDay: 100,
    // Berth capacity as a multiple of the port's arrivals.
    berthHeadroom: 1.5,
    // Hours added to every road trip for gate and yard handling.
    gateHours: 2,
    // A zone orders from at most this many ports, preferring nearer ones.
    portsPerZone: 2,
    // A port's share of a zone's supply below this is dropped (unless the port would be left unused).
    minimumShare: 0.1,
    // How quickly preference falls with travel time: a port this many hours further away gets 1/e the weight.
    gravityHours: 3,
    // Idle trucks kept per lane, in multiples of what one loading period needs.
    idleReserve: 2,
    // Weight of a town or customer with neither a population nor a demand of its own: a small town.
    assumedPopulation: 20000,
    days: 90, stepMinutes: 15, outputMinutes: 60
};

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

    // ---- supply
    const supply = new Map();
    for (const port of ports) {
        const user = Number(port.teuPerDay) > 0;
        const value = user ? Number(port.teuPerDay) : settings.portTeuPerDay;
        supply.set(port.id, value);
        note(port.name, 'Containers handed inland', value, 'TEU/day', user ? (port.teuPerDayBasis ?? 'user') : 'assumed', user ? port.teuPerDaySource : 'Default until port activity is matched.');
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
            `Share of the ports' inland volume by population (${town.populationBasis === 'OpenStreetMap' ? 'population from OpenStreetMap' : town.populationBasis === 'user' ? 'your population figure' : 'assumed size'}).`);
    }

    // ---- towns to their nearest zone
    const townRoutes = new Map();
    const zoneOfTown = new Map();
    for (const town of towns) {
        let best = null;
        for (const zone of zones) {
            const leg = route(zone, town);
            if (!best || leg.hours < best.leg.hours) best = { zone, leg };
        }
        zoneOfTown.set(town.id, best.zone);
        townRoutes.set(town.id, best.leg);
    }
    const zoneDemand = new Map();
    for (const town of towns) zoneDemand.set(zoneOfTown.get(town.id).id, (zoneDemand.get(zoneOfTown.get(town.id).id) ?? 0) + demand.get(town.id));
    const usedZones = zones.filter((zone) => zoneDemand.get(zone.id) > 0);
    const unusedZones = zones.filter((zone) => !(zoneDemand.get(zone.id) > 0));
    if (unusedZones.length) warnings.push(`${unusedZones.map((zone) => zone.name).join(', ')} ${unusedZones.length === 1 ? 'is' : 'are'} nearest to no kept town, so ${unusedZones.length === 1 ? 'it was' : 'they were'} left out of the model.`);

    // ---- zones to ports: nearest ports, balanced so every port ships what arrives and every zone gets what it needs
    const legs = new Map();
    for (const zone of usedZones) for (const port of ports) legs.set(`${zone.id}|${port.id}`, route(port, zone));
    const pairFor = (zone, port) => {
        const key = `${zone.id}|${port.id}`;
        return { key, zone: zone.id, port: port.id, weight: supply.get(port.id) * Math.exp(-legs.get(key).hours / settings.gravityHours) };
    };
    let support = new Set();
    for (const zone of usedZones) {
        [...ports].sort((a, b) => legs.get(`${zone.id}|${a.id}`).hours - legs.get(`${zone.id}|${b.id}`).hours)
            .slice(0, settings.portsPerZone).forEach((port) => support.add(`${zone.id}|${port.id}`));
    }
    for (const port of ports) {
        if ([...support].some((key) => key.endsWith(`|${port.id}`))) continue;
        const nearest = [...usedZones].sort((a, b) => legs.get(`${a.id}|${port.id}`).hours - legs.get(`${b.id}|${port.id}`).hours)[0];
        support.add(`${nearest.id}|${port.id}`);
    }
    const pairsOf = (keys) => usedZones.flatMap((zone) => ports.filter((port) => keys.has(`${zone.id}|${port.id}`)).map((port) => pairFor(zone, port)));
    let flows = balanceFlows(pairsOf(support), zoneDemand, supply);
    if (flows) {
        // Drop small shares where the rest can still balance.
        const pruned = new Set([...support].filter((key) => {
            const [zoneId, portId] = key.split('|');
            const onlyForPort = [...support].filter((other) => other.endsWith(`|${portId}`)).length === 1;
            const onlyForZone = [...support].filter((other) => other.startsWith(`${zoneId}|`)).length === 1;
            return onlyForPort || onlyForZone || flows.get(key) >= settings.minimumShare * zoneDemand.get(zoneId);
        }));
        const prunedFlows = pruned.size < support.size ? balanceFlows(pairsOf(pruned), zoneDemand, supply) : flows;
        if (prunedFlows) { support = pruned; flows = prunedFlows; }
    }
    if (!flows) {
        // Nearby ports alone cannot balance the region: let every zone draw on every port.
        support = new Set(usedZones.flatMap((zone) => ports.map((port) => `${zone.id}|${port.id}`)));
        flows = balanceFlows(pairsOf(support), zoneDemand, supply);
        warnings.push('Nearby ports alone could not supply every zone in balance, so zones also draw on more distant ports.');
    }
    if (!flows) throw new Error('The flows between ports and zones could not be balanced.');

    // ---- layout: north up, the region spread over about 40 units
    const everything = [...ports, ...usedZones, ...towns];
    const origin = { lat: everything.reduce((total, item) => total + item.lat, 0) / everything.length, lon: everything.reduce((total, item) => total + item.lon, 0) / everything.length };
    const local = everything.map((item) => toLocal(item, origin));
    const extent = Math.max(1, ...local.map((point) => Math.max(Math.abs(point.x), Math.abs(point.y))));
    const scale = 20 / extent;
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
                parameterIndex.push({ key: declared.key, entity, symbol: shared.symbol, value: shared.value, unit: shared.unit });
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
    }

    // ---- zones (warehouses), their lanes from ports, and towns
    const flowsByZone = new Map();
    for (const key of support) {
        const [zoneId, portId] = key.split('|');
        if (!flowsByZone.has(zoneId)) flowsByZone.set(zoneId, []);
        flowsByZone.get(zoneId).push({ port: ports.find((port) => port.id === portId), rate: flows.get(key), leg: legs.get(key) });
    }
    const lanes = [];
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
        const served = towns.filter((town) => zoneOfTown.get(town.id).id === zone.id);
        for (const town of served) {
            const townDemand = demand.get(town.id);
            const node = place('demandZone', town.name, {
                name: town.name, position: position(town),
                initialValues: { backlog: townDemand * responseDays, demandRate: townDemand },
                shared: { baseDemand: townDemand }
            });
            bundle('delivery', town.name, { warehouse, zone: node }, { shared: { share: townDemand / total } });
        }
    }

    const document = builder.document({ days: settings.days, stepDays: settings.stepMinutes / 1440, outputDays: settings.outputMinutes / 1440 });
    return {
        document, provenance, warnings, parameterIndex, lanes,
        unusedZones: unusedZones.map((zone) => zone.name),
        served: towns.map((town) => ({ town: town.name, zone: zoneOfTown.get(town.id).name, demand: demand.get(town.id), hours: townRoutes.get(town.id).hours }))
    };
}
