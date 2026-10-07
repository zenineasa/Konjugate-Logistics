/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Builds a runnable model from a curated region or a network placed on the map: each port or supplier,
// logistics zone (warehouse) and town (store, dark store or customer area) becomes a node from the
// component templates, each town draws on zones, each zone is supplied by ports over road lanes whose
// travel times and distances come from routing, and every initial value is the steady state, so the
// baseline holds still. Every value records where it came from: sourced, routed, assumed or the user's own.
//
// Who serves whom comes from `links` when the user's network gives them ({ supply: [{ port, zone, leg }],
// serve: [{ zone, town, leg }] }, by site id, a leg the window already routed or null to route it here), and
// otherwise from gravity: each town from its nearest few zones, each zone from its nearest few ports.
//
// A network with a vehicle catalogue (`options.vehicles`, as every network placed in the window has) counts pallets,
// and each of its links runs on the vehicle types it names ({ type, fleet } on the link): every lane's two sizes are
// two types from the catalogue, each type one set of shared parameters for every lane it runs on. Its stores and dark
// stores hold stock: each is a Warehouse node (its stock room, "<name> stock") restocked by road from its warehouses,
// and a Demand zone (its shoppers, "<name>") that buys from that stock. Customer areas are served as towns are, by
// deliveries with no vehicles. Without a catalogue, the model is as it has been: TEU, two truck sizes for the whole
// region, and every demand pin a Demand zone served by deliveries.

import { laneCorridors } from './corridors.mjs';
import { toLocal } from './geo.mjs';
import { allocateFleet, parseOperator } from './operator.mjs';
import { carriersFor } from './vehicles.mjs';
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
    // Ports (by name) with a standby lane to every zone they don't already supply: no flow and no trucks in the
    // baseline, for a scenario that diverts cargo to them.
    standbyPorts: [],
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
    // What the model counts: 'TEU', or 'pallets' for a network of suppliers, warehouses and stores; a port's containers
    // then count as this many pallets each (an assumption to adjust).
    unit: 'TEU',
    palletsPerTeu: 10,
    // The user's times on some links scaling the estimates on the rest: { factor, count }, or null.
    timeFactor: null,
    // The vehicle types a network placed on the map runs on ({ id, name, capacity, costPerKm, costPerDay, speed,
    // loadingHours, toStores, basis }), or null.
    vehicles: null,
    // Hours added to a delivery to a store for loading at the warehouse's dock and unloading at the store's door (a
    // supply lane adds `gateHours`).
    storeGateHours: 1,
    // At a store: how quickly a shopper buys what is on the shelf, and how quickly the shelves can be emptied, in days.
    saleDays: 0.1,
    shelfDrawDownDays: 0.1,
    // The stock cover a store and a dark store aim for, in days of sales, unless the user set their own.
    storeCoverDays: 2,
    darkStoreCoverDays: 1,
    // Of the sales a store or a dark store cannot make for want of stock, the share lost (its shoppers go elsewhere, its
    // orders are cancelled) rather than waiting for a delivery, unless the user set their own; and what a pallet sold
    // is worth, to price them.
    storeLostShare: 0.8,
    darkStoreLostShare: 0.5,
    saleValue: 1000,
    // The product categories a network placed on the map carries ({ id, name, chilled, share, leadDays, basis }), or
    // null for goods of one kind. Each category is its own copy of the network, so its goods are conserved on their own.
    categories: null,
    // A supplier makes what is ordered from it over this many days unless it, or its category, has a lead time of its
    // own; and the most it can make a day is `berthHeadroom` times what is ordered from it, unless the user set it.
    supplierLeadDays: 2,
    days: 90, stepMinutes: 15, outputMinutes: 60
};

const number = (value, digits = 0) => Number(value).toLocaleString('en', { maximumFractionDigits: digits });

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

// A road lane carrying `rate` TEU/day over `leadTime` days with `fleet` trucks (and `fleet2` of a second size), in
// steady state: loaded trucks on the road, empty ones returning, the rest idle at the origin. Loads are shared between
// the sizes by their idle capacity, which in steady state is each size's share of the fleets' total capacity:
// s = fleet2 c2 / (fleet c1 + fleet2 c2), whatever the flow.
export function roadLaneState(rate, leadTime, fleet, { truckCapacity, loadDays, responseDays, fleet2 = 0, truckCapacity2 = 1 }) {
    const loaded = rate * leadTime / 3;
    const capacity = fleet * truckCapacity + fleet2 * truckCapacity2;
    const share2 = capacity > 0 ? fleet2 * truckCapacity2 / capacity : 0;
    const size = (trucks, share, perTruck) => {
        const loadedTrucks = rate * share * leadTime / perTruck;
        const returning = Math.max(0, Math.min(rate * share / perTruck * leadTime, trucks - loadedTrucks));
        return { loadedTrucks, returning, idle: Math.max(0, trucks - loadedTrucks - returning) };
    };
    const first = size(fleet, 1 - share2, truckCapacity);
    const second = fleet2 > 0 ? size(fleet2, share2, truckCapacity2) : { loadedTrucks: 0, returning: 0, idle: 0 };
    const busy = first.loadedTrucks + first.returning + second.loadedTrucks + second.returning;
    const idle = first.idle + second.idle;
    return {
        loaded1: loaded, loaded2: loaded, loaded3: loaded,
        loadedTrucks: first.loadedTrucks, returning: first.returning, idleTrucks: first.idle,
        loadedTrucks2: second.loadedTrucks, returning2: second.returning, idleTrucks2: second.idle,
        requested: rate * responseDays, arriving: rate,
        canLoad: (first.idle * truckCapacity + second.idle * truckCapacity2) / loadDays,
        utilisation: busy + idle > 0 ? busy / (busy + idle) : 0
    };
}

// One network of goods of one kind: the whole model, or with `scope` ({ category, shares, layout, ... }, see
// buildRegionModel) one category's copy of it, its nodes named "<site>: <category>".
function buildScope({ builder, selection, route, links = null, settings, scope = null }) {
    const templates = builder.templates;
    // A network with vehicle types runs on them; the rest of the region on two truck sizes.
    const catalogue = links && settings.vehicles?.length ? settings.vehicles : null;
    const unit = settings.unit === 'pallets' ? 'pallets' : 'TEU';
    const perTeu = unit === 'pallets' ? settings.palletsPerTeu : 1;
    if (unit === 'pallets') {
        // A cost per pallet, a stock in pallets; and with vehicle types, vehicles where the templates say trucks.
        builder.unitNames = { 'cost/TEU': 'cost/pallet', TEU: 'pallets', ...(catalogue ? { truck: 'vehicle', trucks: 'vehicles' } : {}) };
        builder.nameNames = { 'TEU-day': 'pallet-day', TEU: 'pallets', ...(catalogue ? { trucks: 'vehicles', truck: 'vehicle', Truck: 'Vehicle' } : {}) };
    }
    // A fleet operator, the user's own or a synthetic one: its truck sizes and costs become the region's, and its
    // contracted lanes run on its trucks. Not with vehicle types of the network's own.
    const operator = settings.operator && !catalogue ? parseOperator(settings.operator) : null;
    const operatorBasis = operator?.synthetic ? 'synthetic' : 'user';
    const truckCapacity = operator ? operator.trucks[0].teu : templateValue(templates, 'roadLane', 'truckCapacity');
    const truckCapacity2 = operator?.trucks[1]?.teu ?? templateValue(templates, 'roadLane', 'truckCapacity2');
    const loadDays = templateValue(templates, 'roadLane', 'loadDays');
    const responseDays = templateValue(templates, 'roadShipment', 'responseDays');
    const coverDays = templateValue(templates, 'warehouse', 'coverDays');
    const storageCapacity = templateValue(templates, 'warehouse', 'storageCapacity');
    const drawDownDays = templateValue(templates, 'delivery', 'drawDownDays');
    const originDrainDays = templateValue(templates, 'roadShipment', 'originDrainDays');
    const berthingDays = templateValue(templates, 'port', 'berthingDays');

    const provenance = [];
    const warnings = [];
    if (settings.operator && catalogue) warnings.push('The fleet operator is not used: this network runs on its own vehicle types.');
    const ports = selection.ports ?? [];
    const zones = selection.zones ?? [];
    const towns = selection.towns ?? [];
    // A category's copy of a site is named after both, as is everything said about it.
    const label = (name) => (scope && !scope.single ? `${name}: ${scope.category.name}` : name);
    const siteNames = new Set([...ports, ...zones, ...towns].map((site) => site.name));
    const note = (entity, parameter, value, unit, basis, detail) => provenance.push({ entity: siteNames.has(entity) ? label(entity) : entity, parameter, value, unit, basis, detail });
    // The share of a source's supply, or of a store's sales, that is this category, and how to say so.
    const part = (site) => (scope ? scope.shares.get(site.id) ?? 0 : 1);
    const partNote = (site) => (scope && !scope.single ? ` ${scope.category.name} is ${number(part(site) * 100, 1)}% of what it ${site.supplier ? 'supplies' : towns.includes(site) ? 'sells or orders' : 'hands inland'} (${scope.mixBasis.get(site.id) === 'user' ? 'your mix' : 'the categories\' usual shares, assumed'}).` : '');
    if (!ports.length) throw new Error(links ? 'Place a supplier or a port: it is where goods enter the network.' : 'Keep at least one port: it is where containers enter the region.');
    if (!zones.length) throw new Error(links ? 'Place a warehouse: stores and customers are served from warehouses.' : 'Keep at least one logistics zone: towns are served from zones.');
    if (!towns.length) throw new Error(links ? 'Place a store, a dark store or a customer area: it is where the demand is.' : 'Keep at least one town or customer: it is where the demand is.');
    const names = new Map();
    for (const site of [...ports, ...zones, ...towns]) names.set(site.name, (names.get(site.name) ?? 0) + 1);
    const twice = [...names].filter(([, count]) => count > 1).map(([name]) => name);
    if (twice.length) throw new Error(`Two sites are named ${twice.join(', ')}: give each its own name, as the model and its scenarios find sites by name.`);

    // ---- supply: the user's figures; then IMF PortWatch activity; otherwise an assumed volume shared by port land
    const supply = new Map();
    const histories = new Map(); // port id -> { samples: [[seconds, TEU/day]], from, to } when arrivals follow history
    // A port's usual arrivals, in TEU a day, when its history has a break: the level before a fall (or after a rise),
    // so a scenario can tell when the period modelled is already far below it.
    const normals = new Map();
    const normalOf = (activity, port) => (activity.shift ? Math.max(activity.shift.before, activity.shift.after) / settings.tonnesPerTeu * settings.inlandShare * perTeu * part(port) : null);
    const secondsPerDay = templateValue(templates, 'port', 'secondsPerDay');
    const sourced = (port) => !port.supplier && !(Number(port.teuPerDay) > 0) && port.activity?.importTonnesPerDay > 0;
    const assumedPorts = ports.filter((port) => !port.supplier && !(Number(port.teuPerDay) > 0) && !sourced(port));
    const landOf = (port) => Number(port.areaSquareKilometres) || 0;
    const largestLand = Math.max(0, ...assumedPorts.map(landOf));
    // A harbour mapped as a point, or one of the user's own, still takes a tenth of the largest port's share.
    const portWeight = (port) => (largestLand > 0 ? Math.max(landOf(port), 0.1 * largestLand) : 1);
    const assumedWeight = assumedPorts.reduce((total, port) => total + portWeight(port), 0);
    for (const port of ports) {
        if (sourced(port)) {
            const activity = port.activity;
            // In the model's unit: TEU, or pallets at `palletsPerTeu` a TEU.
            const teu = (tonnes) => tonnes / settings.tonnesPerTeu * settings.inlandShare * perTeu * part(port);
            // The defaults are assumptions; a value the user set is theirs (from a figure they trust, which the model cannot see).
            const weight = settings.tonnesPerTeu === tonnesPerTeu ? `an assumed ${settings.tonnesPerTeu} t a TEU` : `${settings.tonnesPerTeu} t a TEU (yours)`;
            const conversion = `at ${weight}${settings.inlandShare === 1 ? ', counting containers that only change ships there' : `, ${Math.round(settings.inlandShare * 100)}% of them handed inland (yours)`}${perTeu !== 1 ? `, each TEU counted as an assumed ${perTeu} pallets` : ''}`;
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
                normals.set(port.id, normalOf(activity, port));
                note(port.name, 'Containers handed inland', value, `${unit}/day`, 'sourced',
                    `IMF PortWatch (Source: International Monetary Fund), ${activity.name}: the arrivals follow each day's container imports from ${from} (model day 0) to ${to} (${samples.length} days), averaging ${Math.round(value * settings.tonnesPerTeu / settings.inlandShare / perTeu / part(port)).toLocaleString('en')} t a day, ${conversion}.${shiftNote}${partNote(port)}`);
                continue;
            }
            // A steady average: over the chosen period when one is given, otherwise over the whole history fetched.
            const averaged = settings.historyFrom && period.length
                ? { tonnes: period.reduce((total, row) => total + row[1], 0) / period.length, from: period[0][0], to: period.at(-1)[0], days: period.length }
                : { tonnes: activity.importTonnesPerDay, from: activity.from, to: activity.to, days: activity.days };
            const value = teu(averaged.tonnes);
            supply.set(port.id, value);
            normals.set(port.id, normalOf(activity, port));
            note(port.name, 'Containers handed inland', value, `${unit}/day`, 'sourced',
                `IMF PortWatch (Source: International Monetary Fund), ${activity.name}: container imports averaging ${Math.round(averaged.tonnes).toLocaleString('en')} t a day over ${averaged.from} to ${averaged.to} (${averaged.days} days), ${conversion}.${shiftNote}${partNote(port)}`);
            continue;
        }
        const user = Number(port.teuPerDay) > 0;
        if (port.supplier) {
            // A supplier ships what it is set to, whatever is ordered: the user's figure, or the role's default.
            const value = (user ? Number(port.teuPerDay) : 0) * part(port);
            supply.set(port.id, value);
            note(port.name, 'Supplied', value, `${unit}/day`, user ? (port.teuPerDayBasis ?? 'user') : 'user',
                `${port.teuPerDaySource ?? (user ? 'Your figure.' : 'Set to nothing: it supplies nothing until you give it a figure.')}${partNote(port)} What is ordered from it in the baseline; it makes what is ordered, up to what it can make.`);
            continue;
        }
        const value = (user ? Number(port.teuPerDay) : settings.portTeuPerDay * assumedPorts.length * portWeight(port) / assumedWeight) * perTeu * part(port);
        supply.set(port.id, value);
        const assumption = largestLand > 0 && assumedPorts.length > 1
            ? `Assumed, with no port activity matched: ${settings.portTeuPerDay} TEU/day a port on average, shared by port land (${landOf(port).toFixed(1)} km²${landOf(port) < 0.1 * largestLand ? ', counted as a tenth of the largest' : ''}).`
            : 'Assumed, with no port activity matched.';
        const counted = perTeu !== 1 ? ` Each TEU counted as an assumed ${perTeu} pallets.` : '';
        note(port.name, 'Containers handed inland', value, `${unit}/day`, user ? (port.teuPerDayBasis ?? 'user') : 'assumed', `${user ? (port.teuPerDaySource ?? 'Your figure.') : assumption}${counted}${partNote(port)}`);
    }
    const totalSupply = [...supply.values()].reduce((total, value) => total + value, 0);

    // ---- demand: fixed where given, the rest split by population
    const fixed = towns.filter((town) => Number(town.teuPerDay) > 0);
    const ownDemand = (town) => Number(town.teuPerDay) * part(town);
    const fixedTotal = fixed.reduce((total, town) => total + ownDemand(town), 0);
    const weighted = towns.filter((town) => !(Number(town.teuPerDay) > 0));
    let remainder = totalSupply - fixedTotal;
    let fixedScale = 1;
    const supplied = ports.some((port) => port.supplier) ? 'the suppliers and ports supply' : 'the ports hand inland';
    if (remainder < 0 || (remainder > 0 && !weighted.length)) {
        fixedScale = totalSupply / fixedTotal;
        remainder = 0;
        warnings.push(`The customers' own demand (${fixedTotal.toFixed(0)} ${unit}/day) differs from what ${supplied} (${totalSupply.toFixed(0)} ${unit}/day); it was scaled to match so the baseline holds still.`);
    }
    const weightOf = (town) => (Number(town.population) || settings.assumedPopulation) * part(town);
    const weightTotal = weighted.reduce((total, town) => total + weightOf(town), 0);
    const demand = new Map();
    for (const town of fixed) {
        demand.set(town.id, ownDemand(town) * fixedScale);
        const assumed = town.teuPerDayBasis === 'assumed';
        const figure = assumed ? `Assumed: the default for a ${town.role === 'darkStore' ? 'dark store' : town.role === 'customerArea' ? 'customer area' : 'store'}, until you set it` : 'Your figure';
        note(town.name, 'Demand', demand.get(town.id), `${unit}/day`, fixedScale === 1 && !assumed ? 'user' : 'assumed', `${fixedScale === 1 ? `${figure}.` : `${figure}, scaled by ${fixedScale.toFixed(2)} to match what ${supplied}.`}${partNote(town)}`);
    }
    for (const town of weighted) {
        demand.set(town.id, remainder * weightOf(town) / weightTotal);
        note(town.name, 'Demand', demand.get(town.id), `${unit}/day`, 'assumed',
            `Share of the ports' inland volume by population (${{
                OpenStreetMap: 'population from OpenStreetMap',
                user: 'your population figure',
                shared: `an even share of ${town.city ?? 'the city'}'s population among its suburbs, an assumption`
            }[town.populationBasis] ?? 'assumed size'}).${partNote(town)}`);
    }

    // ---- towns to zones: each town draws on up to zonesPerTown nearby zones, by significance and nearness
    const zoneWeight = (zone) => Number(zone.significance) > 0 && Number.isFinite(Number(zone.significance)) ? Number(zone.significance)
        : Number(zone.floorAreaSquareMetres) > 0 ? Number(zone.floorAreaSquareMetres) : null;
    const knownWeights = zones.map(zoneWeight).filter((value) => value !== null).sort((a, b) => a - b);
    // A zone of the user's own, with no floor area given, counts as a typical one of the region.
    const typicalWeight = knownWeights.length ? knownWeights[Math.floor(knownWeights.length / 2)] : 1;
    const allocations = []; // { town, zone, share, leg }
    const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
    const portById = new Map(ports.map((port) => [port.id, port]));
    if (links) {
        // The user's network: each town from the zones linked to it, shared by their size and road access.
        for (const link of [...links.serve, ...links.supply]) {
            if (!zoneById.has(link.zone) || !(link.town === undefined ? portById.has(link.port) : towns.some((town) => town.id === link.town))) {
                throw new Error('A link joins a site that is no longer in the network. Place the sites again, or reload the map.');
            }
        }
        for (const town of towns) {
            const linked = links.serve.filter((link) => link.town === town.id);
            if (!linked.length) throw new Error(`${town.name} has no warehouse linked to it. Drag a link from a warehouse to it.`);
            const options = linked.map((link) => {
                const zone = zoneById.get(link.zone);
                const leg = link.leg ?? route(zone, town);
                return { zone, leg, weight: (zoneWeight(zone) ?? typicalWeight) * Math.exp(-leg.hours / settings.townGravityHours) };
            });
            const total = options.reduce((sum, option) => sum + option.weight, 0);
            for (const option of options) allocations.push({ town, zone: option.zone, share: option.weight / total, leg: option.leg });
        }
    }
    for (const town of links ? [] : towns) {
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
    // ---- warehouses restocked from other warehouses (`links.transfer`: { from, to, leg, share, backup }). A standing
    // link carries its share of what the warehouse it leads to sends out, every day: a hub restocking a spoke. A backup
    // link carries nothing until a scenario orders over it. What a warehouse sends out is then what its own stores and
    // customers take and what it sends on to other warehouses; what it needs from suppliers and ports is that, less
    // what other warehouses send it.
    const transferLinks = (links?.transfer ?? []).filter((link) => zoneById.has(link.from) && zoneById.has(link.to) && link.from !== link.to);
    const standingLinks = transferLinks.filter((link) => !link.backup);
    const transferRate = new Map();
    const sourceNeed = new Map(zoneDemand);
    {
        // Downstream first: a warehouse's need is known once every warehouse it restocks has had its say.
        const pending = new Map(zones.map((zone) => [zone.id, standingLinks.filter((link) => link.from === zone.id).length]));
        const ready = zones.filter((zone) => pending.get(zone.id) === 0).map((zone) => zone.id);
        let settled = 0;
        while (ready.length) {
            const id = ready.shift();
            settled += 1;
            const total = zoneDemand.get(id) ?? 0;
            const incoming = standingLinks.filter((link) => link.to === id);
            const sourced = (links?.supply ?? []).some((link) => link.zone === id && supply.get(link.port) > 0);
            const given = incoming.filter((link) => link.share > 0);
            const left = 1 - given.reduce((sum, link) => sum + link.share, 0);
            const open = incoming.length - given.length + (sourced ? 1 : 0);
            if (left < -1e-9) throw new Error(`${zoneById.get(id).name} is to take ${number((1 - left) * 100)}% of what it needs from other warehouses: give its links shares that add up to 100% or less.`);
            if (!open && left > 1e-9 && incoming.length) throw new Error(`${zoneById.get(id).name} takes ${number((1 - left) * 100)}% of what it needs from other warehouses and has no supplier or port for the rest: link one to it, or leave a link's share empty.`);
            let fromWarehouses = 0;
            for (const link of incoming) {
                const share = link.share > 0 ? link.share : Math.max(0, left) / open;
                transferRate.set(link, { share, rate: share * total });
                fromWarehouses += share;
                zoneDemand.set(link.from, (zoneDemand.get(link.from) ?? 0) + share * total);
                pending.set(link.from, pending.get(link.from) - 1);
                if (pending.get(link.from) === 0) ready.push(link.from);
            }
            sourceNeed.set(id, total * Math.max(0, 1 - fromWarehouses));
        }
        if (settled < zones.length) throw new Error(`${zones.filter((zone) => pending.get(zone.id) > 0).map((zone) => zone.name).join(' and ')} restock each other in a circle: one of those links must be a backup, or go.`);
    }
    for (const link of transferLinks.filter((item) => item.backup)) transferRate.set(link, { share: 0, rate: 0 });
    const usedZones = zones.filter((zone) => zoneDemand.get(zone.id) > 0);
    const unusedZones = zones.filter((zone) => !(zoneDemand.get(zone.id) > 0));
    // The warehouses that need a supplier or a port: not one restocked wholly by other warehouses.
    const sourcedZones = usedZones.filter((zone) => sourceNeed.get(zone.id) > 1e-9);
    if (scope) { /* a warehouse that carries none of one category may carry another: buildRegionModel says which carry none */ } else if (unusedZones.length && links) warnings.push(`${unusedZones.map((zone) => zone.name).join(', ')} ${unusedZones.length === 1 ? 'serves' : 'serve'} no store or customer area, so ${unusedZones.length === 1 ? 'it was' : 'they were'} left out of the model.`);
    else if (unusedZones.length) warnings.push(`${unusedZones.map((zone) => zone.name).join(', ')} ${unusedZones.length === 1 ? 'serves' : 'serve'} none of the kept towns (${unusedZones.length === 1 ? 'it is' : 'they are'} not among the nearest few to any), so ${unusedZones.length === 1 ? 'it was' : 'they were'} left out of the model. Keep a town nearby, or add a customer of your own, to use ${unusedZones.length === 1 ? 'it' : 'them'}.`);

    // ---- zones to ports: nearest ports, balanced so every port ships what arrives and every zone gets what it needs
    // Each zone's leg from each port: the window's for a link it routed, else routed here when first needed.
    const legs = new Map();
    for (const link of links?.supply ?? []) if (link.leg) legs.set(`${link.zone}|${link.port}`, link.leg);
    const legOf = (key) => {
        if (!legs.has(key)) {
            const [zoneId, portId] = key.split('|');
            legs.set(key, route(portById.get(portId), zoneById.get(zoneId)));
        }
        return legs.get(key);
    };
    if (!links) for (const zone of sourcedZones) for (const port of ports) legOf(`${zone.id}|${port.id}`);
    // A port that hands nothing inland over the period (no container imports in it) has no lanes in the baseline; it
    // stays in the model, where a scenario can divert cargo to it over standby lanes.
    const supplying = ports.filter((port) => supply.get(port.id) > 0);
    if (!supplying.length) throw new Error(links ? 'None of the suppliers and ports supplies anything. Give a supplier what it supplies, or a port a volume of your own.' : 'None of the kept ports hands anything inland over the period chosen. Choose another period, or give a port a volume of your own.');
    const idle = ports.filter((port) => !(supply.get(port.id) > 0));
    if (idle.length) warnings.push(`${idle.map((port) => port.name).join(', ')} ${idle.length === 1 ? 'hands' : 'hand'} nothing inland over the period chosen, so ${idle.length === 1 ? 'it has' : 'they have'} no lanes; cargo can still be diverted to ${idle.length === 1 ? 'it' : 'them'} in a scenario.`);
    const supplyOf = new Map(supplying.map((port) => [port.id, supply.get(port.id)]));
    const pairFor = (zone, port) => {
        const key = `${zone.id}|${port.id}`;
        return { key, zone: zone.id, port: port.id, weight: supply.get(port.id) * Math.exp(-legOf(key).hours / settings.gravityHours) };
    };
    const nearestPorts = (zone) => [...supplying].sort((a, b) => legOf(`${zone.id}|${a.id}`).hours - legOf(`${zone.id}|${b.id}`).hours);
    const pairsOf = (keys) => sourcedZones.flatMap((zone) => supplying.filter((port) => keys.has(`${zone.id}|${port.id}`)).map((port) => pairFor(zone, port)));
    // Each zone draws on its nearest few ports, one more at a time until every port ships what arrives and every zone gets what it needs.
    let support = null;
    let flows = null;
    let portsPerZone = Math.min(settings.portsPerZone, supplying.length);
    if (links) {
        // The user's network: the lanes are the links, balanced so every source ships what it supplies.
        const used = new Set(sourcedZones.map((zone) => zone.id));
        support = new Set(links.supply.filter((link) => used.has(link.zone) && supply.get(link.port) > 0).map((link) => `${link.zone}|${link.port}`));
        for (const zone of sourcedZones) {
            if (![...support].some((key) => key.startsWith(`${zone.id}|`))) throw new Error(`${zone.name} has no supplier or port linked to it that supplies anything. Drag a link from one to it.`);
        }
        for (const port of supplying) {
            if (![...support].some((key) => key.endsWith(`|${port.id}`))) throw new Error(`${port.name} supplies ${supply.get(port.id).toFixed(0)} ${unit} a day, but no warehouse that serves anyone is linked to it. Link it to one, or set it to supply nothing.`);
        }
        flows = balanceFlows(pairsOf(support), sourceNeed, supplyOf);
        if (!flows) {
            throw new Error('The links cannot carry what every source supplies to the warehouses that need it: a source supplies more than its warehouses pass on, or a warehouse needs more than its sources supply. Link more sources to warehouses, or change what they supply or what the stores sell.');
        }
        portsPerZone = settings.portsPerZone + 1;
    }
    for (; !links && portsPerZone <= supplying.length && !flows; portsPerZone += 1) {
        support = new Set();
        for (const zone of sourcedZones) nearestPorts(zone).slice(0, portsPerZone).forEach((port) => support.add(`${zone.id}|${port.id}`));
        for (const port of supplying) {
            if ([...support].some((key) => key.endsWith(`|${port.id}`))) continue;
            const nearest = [...sourcedZones].sort((a, b) => legOf(`${a.id}|${port.id}`).hours - legOf(`${b.id}|${port.id}`).hours)[0];
            support.add(`${nearest.id}|${port.id}`);
        }
        flows = balanceFlows(pairsOf(support), sourceNeed, supplyOf);
    }
    if (!flows) throw new Error('The flows between ports and zones could not be balanced.');
    if (!links && portsPerZone - 1 > settings.portsPerZone) warnings.push(`The nearest ${settings.portsPerZone} ports could not supply every zone in balance, so zones draw on up to ${portsPerZone - 1}.`);
    // Then drop the smallest lanes, one at a time, while the rest still balances (a user's links are kept as drawn).
    const drawn = new Set((links?.supply ?? []).filter((link) => link.user).map((link) => `${link.zone}|${link.port}`));
    for (;;) {
        const small = [...support].filter((key) => {
            if (drawn.has(key)) return false;
            const [zoneId, portId] = key.split('|');
            const onlyForPort = [...support].filter((other) => other.endsWith(`|${portId}`)).length === 1;
            const onlyForZone = [...support].filter((other) => other.startsWith(`${zoneId}|`)).length === 1;
            return !onlyForPort && !onlyForZone && flows.get(key) < Math.max(settings.minimumShare * sourceNeed.get(zoneId), settings.minimumLaneTeuPerDay);
        }).sort((a, b) => flows.get(a) - flows.get(b));
        let dropped = false;
        for (const key of small) {
            const trial = new Set(support);
            trial.delete(key);
            const balanced = balanceFlows(pairsOf(trial), sourceNeed, supplyOf);
            if (balanced) { support = trial; flows = balanced; dropped = true; break; }
        }
        if (!dropped) break;
    }

    // Suggested supply links left out: they would carry next to nothing (or lead to a warehouse that serves no one).
    const unusedLinks = (links?.supply ?? []).filter((link) => !support.has(`${link.zone}|${link.port}`) && portById.has(link.port) && zoneById.has(link.zone))
        .map((link) => ({ from: portById.get(link.port).name, to: zoneById.get(link.zone).name, why: !(zoneDemand.get(link.zone) > 0) ? 'serves no one' : !(supply.get(link.port) > 0) ? 'supplies nothing' : 'carries too little' }));

    // ---- layout: north up, the region spread over about 80 units so names on the canvas stay apart
    // A category's copy of the network has a place of its own on the canvas, beside the others (see categoryShifts).
    const { origin, scale } = scope?.layout ?? layoutOf([...ports, ...usedZones, ...towns]);
    const [shiftX, shiftY] = scope?.shift ?? [0, 0];
    const position = (item) => {
        const point = toLocal(item, origin);
        return [Number((point.x * scale + shiftX).toFixed(3)), Number((point.y * scale + shiftY).toFixed(3)), 0];
    };
    const between = (a, b, offset = 0) => {
        const p = position(a);
        const q = position(b);
        return [Number(((p[0] + q[0]) / 2).toFixed(3)), Number(((p[1] + q[1]) / 2 + offset).toFixed(3)), 0];
    };

    // Shared parameters a placement created, by template key, so scenarios can find them by entity.
    const parameterIndex = [];
    const indexPlacement = (templateId, entity, before) => {
        const created = new Set(builder.sharedParameters.slice(before));
        for (const declared of templates.get(templateId).sharedParameters ?? []) {
            if (declared.scope === 'project') continue;
            const shared = builder.lastShared?.get(declared.key);
            if (shared && created.has(shared)) {
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
    // Makes an entity's own parameter live, with a slider from 0 to `maximum`, so a scenario fork can change it.
    const makeLive = (entity, key, maximum, step = maximum / 100) => {
        const indexed = parameterIndex.findLast((entry) => entry.entity === entity && entry.key === key);
        if (!indexed) throw new Error(`The parameter "${key}" of ${entity} could not be found.`);
        builder.setLive(indexed.symbol, { minimum: 0, maximum, step });
        Object.assign(indexed, { live: true, minimum: 0, maximum });
    };

    // ---- ports
    const portNodes = new Map();
    // A supplier's order book: what waits on a lane from it is what it still has to make or has ready.
    const suppliers = new Map();
    const handlingDays = templateValue(templates, 'supplier', 'orderHandlingDays');
    for (const port of ports) {
        const arrivals = supply.get(port.id);
        const portName = label(port.name);
        if (port.supplier) {
            // Made to order: every order takes its lead time, and it starts no more a day than it can make.
            const set = (key) => Number(port[key]) > 0 && port[`${key}Basis`] !== 'assumed';
            const categoryLead = Number(scope?.category.leadDays) > 0 ? Number(scope.category.leadDays) : null;
            const wanted = set('leadDays') ? Number(port.leadDays) : categoryLead ?? settings.supplierLeadDays;
            const leadTime = Math.max(wanted, 6 * settings.stepMinutes / 1440);
            const capacity = set('makes') ? Number(port.makes) * part(port) : arrivals * settings.berthHeadroom;
            if (capacity < arrivals - 1e-9) throw new Error(`${port.name} can make ${number(capacity, 1)} ${unit} a day, less than the ${number(arrivals, 1)} ordered from it. Give it more to make, or have it supply less.`);
            note(port.name, 'Lead time', leadTime, 'day', set('leadDays') ? 'user' : categoryLead !== null && scope.category.basis?.leadDays === 'user' ? 'user' : 'assumed',
                `${set('leadDays') ? 'Your figure.' : categoryLead !== null ? `The lead time of ${scope.category.name}${scope.category.basis?.leadDays === 'user' ? ' (yours)' : ', assumed until you set it'}.` : 'Assumed, until you set it.'} From an order reaching it to the goods standing ready to load: it makes to order.${leadTime > wanted ? ` Raised to ${number(leadTime * 24, 1)} h, the shortest the model's ${settings.stepMinutes}-minute steps follow faithfully.` : ''}`);
            note(port.name, 'Most it can make', capacity, `${unit}/day`, set('makes') ? 'user' : 'assumed', set('makes') ? `Your figure.${partNote(port)}` : `${settings.berthHeadroom} times what is ordered from it in the baseline, assumed until you set it.`);
            portNodes.set(port.id, place('supplier', portName, {
                name: portName, position: position(port),
                initialValues: { toMake: arrivals * handlingDays, making1: arrivals * leadTime / 3, making2: arrivals * leadTime / 3, making3: arrivals * leadTime / 3, stock: arrivals * originDrainDays, makeRate: arrivals },
                shared: { supplierLeadTime: leadTime, supplierCapacity: capacity }
            }));
            suppliers.set(port.id, { leadTime, capacity, pipelineDays: handlingDays + leadTime + originDrainDays });
            // Live, so a scenario can make it late or short: up to four times its lead time and what the network orders.
            makeLive(portName, 'supplierLeadTime', niceCeiling(Math.max(4 * leadTime, leadTime + 14)));
            makeLive(portName, 'supplierCapacity', niceCeiling(4 * Math.max(capacity, totalSupply, 1)));
            continue;
        }
        const berthCapacity = arrivals * settings.berthHeadroom;
        note(port.name, 'Berth capacity', berthCapacity, `${unit}/day`, 'assumed', `${settings.berthHeadroom} times its arrivals.`);
        portNodes.set(port.id, place('port', portName, {
            name: portName, position: position(port),
            // The wait counts at least a TEU a day of berths, as the template does, so a port with none is not 0/0.
            initialValues: { queue: arrivals * berthingDays, stock: arrivals * 3, waitDays: arrivals * berthingDays / Math.max(berthCapacity, 1) },
            shared: { vesselArrivals: arrivals, berthCapacity, outageCapacity: berthCapacity }
        }));
        const indexed = parameterIndex.findLast((entry) => entry.entity === portName && entry.key === 'vesselArrivals');
        const shared = builder.sharedParameters.find((item) => item.id === indexed?.sharedParameterId);
        if (!shared) throw new Error(`The arrivals of ${port.name} could not be found.`);
        // Arrivals that follow the port's history: a stored schedule on its own arrivals parameter. The
        // parameter keeps the average as its value, used again if the schedule is removed.
        const history = histories.get(port.id);
        if (history) {
            shared.schedule = { interpolation: 'hold', samples: history.samples };
            indexed.schedule = { from: history.from, to: history.to, days: history.samples.length };
        }
        // Live, so a scenario fork can change them (a disrupted chokepoint, or cargo diverted to this port), with a
        // slider up to four times the busiest day or the whole region's arrivals, whichever is more: any port may be
        // the one cargo is diverted to.
        const busiest = Math.max(arrivals, ...(history?.samples.map((sample) => sample[1]) ?? []));
        makeLive(portName, 'vesselArrivals', niceCeiling(4 * Math.max(busiest, totalSupply)));
        // And its berths, so a scenario can let a port take cargo diverted to it: up to four times the region's arrivals.
        const berthMaximum = niceCeiling(4 * Math.max(berthCapacity, totalSupply));
        makeLive(portName, 'berthCapacity', berthMaximum);
        makeLive(portName, 'outageCapacity', berthMaximum);
    }

    // ---- vehicles: each type is one set of shared parameters (capacity, costs, loading time) for every lane and
    // shipment it runs on, so a change to a type reaches every link it carries; each lane keeps its own fleet of it.
    const typeById = new Map((catalogue ?? []).map((type) => [type.id, type]));
    const typesNoted = scope?.typesNoted ?? new Set();
    const noteType = (type) => {
        if (typesNoted.has(type.id)) return;
        typesNoted.add(type.id);
        const basisOf = (key) => (type.basis?.[key] === 'user' ? 'user' : 'assumed');
        const said = (key) => (basisOf(key) === 'user' ? 'Your figure.' : 'Assumed: the catalogue\'s default, until you set it.');
        note(type.name, 'Capacity', type.capacity, `${unit}/vehicle`, basisOf('capacity'), said('capacity'));
        note(type.name, 'Cost per km', type.costPerKm, 'cost/km', basisOf('costPerKm'), said('costPerKm'));
        note(type.name, 'Cost per day', type.costPerDay, 'cost/day', basisOf('costPerDay'), said('costPerDay'));
        note(type.name, 'Top speed', type.speed, 'km/h', basisOf('speed'), `${said('speed')} A link takes at least its length at this speed.`);
        note(type.name, 'Loading time', type.loadingHours, 'h', basisOf('loadingHours'), `${said('loadingHours')} A lane loads as fast as the slower of its two types.`);
    };
    const asType = (type, what, name, typeUnit, value) => ({ symbol: `${type.id}${what}`, name: `${type.name}: ${name}`, unit: typeUnit, value });
    // How a lane of these types places its shared parameters: its first and second size as the two types (the first
    // twice, with no fleet of the second, when it has one), and its loading time as the slower type's.
    const vehicleAs = (types) => {
        const [first, second = types[0]] = types;
        const slower = types.reduce((slowest, type) => (type.loadingHours > slowest.loadingHours ? type : slowest));
        const capacity = (type) => asType(type, 'Capacity', 'capacity', `${unit}/vehicle`, type.capacity);
        const lane = {
            truckCapacity: capacity(first), truckCapacity2: capacity(second),
            costPerKm: asType(first, 'CostPerKm', 'cost per km', 'cost/km', first.costPerKm), costPerKm2: asType(second, 'CostPerKm', 'cost per km', 'cost/km', second.costPerKm),
            truckDayCost: asType(first, 'DayCost', 'cost per day', 'cost/day', first.costPerDay), truckDayCost2: asType(second, 'DayCost', 'cost per day', 'cost/day', second.costPerDay),
            loadDays: asType(slower, 'LoadDays', 'loading time', 'day', slower.loadingHours / 24)
        };
        return { lane, shipment: { truckCapacity: lane.truckCapacity, truckCapacity2: lane.truckCapacity2 } };
    };
    // A link with no vehicles of its own (a standby lane, a link from an older session): its kind's usual type.
    const usualChoice = (kind) => {
        const usual = kind === 'store'
            ? catalogue.find((type) => type.id === 'mediumTruck' && type.toStores) ?? catalogue.find((type) => type.toStores)
            : catalogue.find((type) => type.id === 'heavyTruck') ?? catalogue[0];
        return usual ? [{ type: usual.id, fleet: null }] : [];
    };
    // A chilled category goes only by the link's refrigerated types, or, when it has none, by the first that may go there.
    const choiceOf = (chosen, kind, where) => {
        const usual = chosen?.length ? chosen : catalogue ? usualChoice(kind) : null;
        if (!usual || !scope?.category.chilled) return usual;
        const cold = carriersFor(usual, kind === 'store' ? 'store' : 'supply', catalogue, true);
        if (!cold.length) throw new Error(`${where} carries ${scope.category.name}, which needs a refrigerated vehicle, and no vehicle type ${kind === 'store' ? 'that may deliver to stores ' : ''}is refrigerated. Tick Refrigerated on a vehicle type, or add one.`);
        return cold;
    };
    // The types a link names, as the catalogue has them.
    const typesOf = (chosen, label) => (chosen ?? []).slice(0, 2).map((item) => {
        const type = typeById.get(item.type);
        if (!type) throw new Error(`${label} runs on a vehicle type that is not in the catalogue. Choose its vehicles again.`);
        return type;
    });

    // ---- zones (warehouses), their lanes from ports, and towns
    const flowsByZone = new Map();
    const supplyLinkOf = new Map((links?.supply ?? []).map((link) => [`${link.zone}|${link.port}`, link]));
    for (const key of support) {
        const [zoneId, portId] = key.split('|');
        if (!flowsByZone.has(zoneId)) flowsByZone.set(zoneId, []);
        flowsByZone.get(zoneId).push({ port: ports.find((port) => port.id === portId), rate: flows.get(key), leg: legOf(key), link: supplyLinkOf.get(key) ?? null });
    }
    const lanes = [];
    // Each lane's ends and the roads it was routed over, for the map's corridors.
    const laneGeometry = [];
    const warehouses = new Map();
    const laneTime = (flow) => Number(((flow.leg.hours + settings.gateHours) / 24).toFixed(4));
    // The operator's trucks, shared among its contracted lanes by what each needs on the road: loaded and returning
    // trucks for its flow, plus a reserve of loads, in TEU of capacity.
    const laneNeed = (rate, leadTime, laneLoadDays = loadDays) => 2 * rate * leadTime + settings.idleReserve * rate * laneLoadDays;
    const allocation = operator ? allocateFleet(operator, usedZones.flatMap((zone) => (flowsByZone.get(zone.id) ?? []).filter((flow) => flow.rate > 1e-9).map((flow) => ({
        from: flow.port.name, to: zone.name, origin: flow.port, need: laneNeed(flow.rate, laneTime(flow))
    })))) : {};
    const operatorLanes = [];
    const standbyPorts = ports.filter((port) => (settings.standbyPorts ?? []).includes(port.name));
    const unknownStandby = (settings.standbyPorts ?? []).filter((name) => !ports.some((port) => port.name === name));
    if (unknownStandby.length) warnings.push(`No standby lanes from ${unknownStandby.join(', ')}: not a kept port.`);

    // The shortest travel and loading times the model's steps follow faithfully, with vehicle types (whose lanes can be
    // short city trips): a lane's goods pass three stages, so a trip lasts at least six steps, and its idle vehicles
    // are loaded over at least two. Lanes without types keep their times as routed, with two hours at the gates.
    const stepDays = settings.stepMinutes / 1440;
    const shortestLeadDays = catalogue ? 6 * stepDays : 0;
    const shortestLoadDays = 2 * stepDays;
    // A lane's timing over `leg` for its vehicle `types` (or null): at least its length at the slowest type's top speed,
    // plus the hours at its gates, in days.
    // A time of the user's on the link (`leg.own`, door to door) is taken as it is, and its distance if given; otherwise,
    // with `settings.timeFactor` ({ factor, count }, from the user's times on other links), the estimate is scaled by it.
    const factor = settings.timeFactor?.factor > 0 ? settings.timeFactor.factor : null;
    const laneTiming = (leg, types, kind) => {
        const own = leg.own?.hours > 0 ? leg.own : null;
        const kilometres = Number((own?.kilometres > 0 ? own.kilometres : leg.kilometres).toFixed(1));
        const slowest = types?.length ? Math.min(...types.map((type) => type.speed)) : Infinity;
        const roadHours = Math.max(leg.hours, kilometres / slowest);
        const gate = kind === 'store' ? settings.storeGateHours : settings.gateHours;
        const estimated = !own && factor !== null;
        const exact = Number(((own ? own.hours : (roadHours + gate) * (estimated ? factor : 1)) / 24).toFixed(4));
        const leadTime = Math.max(exact, Number(shortestLeadDays.toFixed(4)));
        return { kilometres, slowest, roadHours, gate, leadTime, raised: leadTime > exact, own, estimated };
    };

    // A road lane and the shipment over it, from `origin` to `destination` (nodes), carrying `rate` a day at `share` of
    // what the destination orders. `kind` is 'supply' (from a port or supplier to a warehouse) or 'store' (from a
    // warehouse to a store's stock); `chosen` the link's vehicles ({ type, fleet }), with a catalogue.
    const placeLane = ({ name: link, kind, origin, destination, originSite, destinationSite, rate, share, leg, chosen: given = null, standby = false, offset = 0, destinationTotal: allItTakes = null }) => {
        const name = label(link);
        const ends = link.replace(/^Road /, '');
        const chosen = choiceOf(given, kind, ends);
        const types = catalogue ? typesOf(chosen, ends) : null;
        if (types && !types.length) throw new Error(`${ends} has no vehicles. Choose a vehicle for it.`);
        types?.forEach(noteType);
        const { kilometres, slowest, roadHours, gate, leadTime, raised, own, estimated } = laneTiming(leg, types, kind);
        const capacity1 = types ? types[0].capacity : truckCapacity;
        const capacity2 = types ? (types[1] ?? types[0]).capacity : truckCapacity2;
        const loading = types ? Math.max(...types.map((type) => type.loadingHours)) / 24 : loadDays;
        const laneLoadDays = types ? Math.max(loading, shortestLoadDays) : loadDays;
        const need = laneNeed(rate, leadTime, laneLoadDays);
        const contract = kind === 'supply' ? allocation[`${originSite.name}|${destinationSite.name}`] : null;
        let fleet;
        let fleet2;
        let needs = null;
        if (contract) [fleet, fleet2] = [contract.counts[0] ?? 0, contract.counts[1] ?? 0];
        else if (types) {
            // Sized as the toolbox sizes a lane, half of what it needs from each type when it has two, unless the user set it.
            // With categories, the link's vehicles of a type (the user's count, or what its categories need together,
            // in whole vehicles) are shared among its categories by what each needs: each has its own.
            const counts = types.map((type, index) => {
                const typeNeed = need / types.length;
                const whole = scope?.fleets?.get(`${link}|${type.id}`);
                if (whole) return whole.need > 0 ? (whole.user ?? Math.ceil(whole.need / type.capacity - 1e-9)) * typeNeed / whole.need : 0;
                return chosen[index].fleet ?? Math.ceil(typeNeed / type.capacity);
            });
            [fleet, fleet2 = 0] = counts;
            needs = types.map((type, index) => ({ type: type.id, need: need / types.length, user: chosen[index].fleet }));
        } else [fleet, fleet2] = [Math.ceil(need / capacity1), 0];
        const placedAs = types ? vehicleAs(types) : null;
        // From a supplier, what waits on the lane is what the supplier still has to make or has ready.
        const maker = kind === 'supply' ? suppliers.get(originSite.id) ?? null : null;
        const node = place('roadLane', name, {
            name, position: between(originSite, destinationSite, offset),
            initialValues: roadLaneState(rate, leadTime, fleet, { truckCapacity: capacity1, loadDays: laneLoadDays, responseDays: maker ? maker.pipelineDays : responseDays, fleet2, truckCapacity2: capacity2 }),
            shared: { leadTime, distance: kilometres, fleetSize: fleet, fleetSize2: fleet2 }, ...(placedAs ? { as: placedAs.lane } : {})
        });
        // To keep up, a lane needs its loaded and returning vehicles and a loading period's flow idle at the origin.
        const minimum = 2 * rate * leadTime + rate * laneLoadDays;
        const fleetCapacity = fleet * capacity1 + fleet2 * capacity2;
        if (contract) {
            operatorLanes.push({ name, depot: contract.depot, fleet, fleet2, capacity: fleetCapacity, need: minimum });
            if (fleetCapacity < minimum - 1e-9) warnings.push(`${operator.name} has ${fleetCapacity.toFixed(0)} TEU of trucks on ${name}, but its flow needs ${minimum.toFixed(0)} (on the road and loading): the lane will fall behind from the start.`);
        }
        const ownFleet = types && chosen.some((item, index) => index < types.length && item.fleet !== null);
        if (ownFleet && fleetCapacity < minimum - 1e-9) {
            warnings.push(`${label(ends)} has room for ${fleetCapacity.toFixed(0)} ${unit} in its vehicles, but its flow needs ${minimum.toFixed(0)} (on the road and loading): it will fall behind from the start.`);
        }
        // From a warehouse (to a store, or to another warehouse) the orders also reach the warehouse's forecast.
        bundle(kind === 'store' || kind === 'transfer' ? 'storeShipment' : maker ? 'supplierShipment' : 'roadShipment', name, { origin, lane: node, destination }, {
            // From a supplier: its share of the supplier's ready goods, what it orders of all the supplier makes.
            shared: { orderShare: share, ...(maker ? { supplyShare: supply.get(originSite.id) > 0 ? rate / supply.get(originSite.id) : 0 } : {}) }, ...(placedAs ? { as: placedAs.shipment } : {})
        });
        // Live, so a scenario can close the road, send vehicles on a detour, move its orders to the destination's
        // other lanes, or change its fleet: up to three times the vehicles it starts with.
        makeLive(name, 'laneOpen', 1);
        makeLive(name, 'orderShare', 1);
        // A detour may add up to the window's 72 hours each way, over proportionally more kilometres.
        const detourFactor = Math.max(4, (leadTime + 3) / leadTime);
        makeLive(name, 'leadTime', niceCeiling(Math.max(4 * leadTime, leadTime + 3)));
        makeLive(name, 'distance', niceCeiling(detourFactor * Math.max(kilometres, 1)));
        // Any lane may come to carry all its destination's orders (a diversion to its port, a closure of the others).
        const destinationTotal = allItTakes ?? rate / Math.max(share, 1e-9);
        const fleetMaximum = niceCeiling(Math.max(10, 3 * Math.max(fleet, fleet2), 3 * Math.ceil(laneNeed(destinationTotal, leadTime, laneLoadDays) / Math.min(capacity1, capacity2))));
        makeLive(name, 'fleetSize', fleetMaximum, 1);
        makeLive(name, 'fleetSize2', fleetMaximum, 1);
        const how = {
            routed: [`${leg.hours.toFixed(1)} h over major roads`, 'Over major roads.'],
            local: [`${leg.hours.toFixed(1)} h estimated over local streets (the sites are close)`, 'Straight line lengthened for local streets.'],
            'straight-line': [`${leg.hours.toFixed(1)} h, a straight-line estimate (no road route was found)`, 'Straight line lengthened for detours.']
        }[leg.basis];
        const slowed = roadHours > leg.hours + 1e-9 ? `; ${roadHours.toFixed(1)} h at the ${slowest} km/h a ${types.find((type) => type.speed === slowest).name.toLowerCase()} can go` : '';
        const floor = raised ? ` Raised to ${number(leadTime * 24, 1)} h, the shortest trip the model's ${settings.stepMinutes}-minute steps follow faithfully.` : '';
        if (own) {
            const said = { yours: 'Your time', google: 'Your time, read off Google Maps', osm: 'Your time, read off OpenStreetMap' }[own.how] ?? 'Your time';
            const when = { peak: ' at the morning or evening peak', midday: ' in the middle of the day', night: ' at night' }[own.when] ?? '';
            note(name, 'Travel time', leadTime, 'day', 'user', `${said}${when}${own.checkedOn ? ` on ${own.checkedOn}` : ''}, door to door: ${number(own.hours, 2)} h${own.note ? ` (${own.note})` : ''}. The route suggested ${number(leg.hours + gate, 1)} h.${floor}`);
        } else {
            const scaled = estimated ? ` Times ${number(factor, 2)}: estimated from your ${settings.timeFactor.count} times on other links, which take that many times the route's estimate.` : '';
            note(name, 'Travel time', leadTime, 'day', estimated ? 'assumed' : leg.basis === 'routed' ? 'routed' : 'assumed', `${how[0]}${slowed}, plus ${gate} h ${kind === 'store' ? 'at the dock and the store\'s door' : 'at the gates'}.${scaled}${floor}`);
        }
        if (laneLoadDays > loading + 1e-12) note(name, 'Loading time', laneLoadDays * 24, 'h', 'assumed', `Its vehicles load in ${number(loading * 24, 2)} h; raised to ${number(laneLoadDays * 24, 2)} h, the shortest the model's ${settings.stepMinutes}-minute steps follow faithfully.`);
        note(name, 'Distance', kilometres, 'km', own?.kilometres > 0 ? 'user' : leg.basis === 'routed' ? 'routed' : 'assumed', own?.kilometres > 0 ? 'Your figure.' : how[1]);
        const vehicleWord = catalogue ? 'vehicles' : 'trucks';
        if (contract) {
            note(name, 'Fleet', fleet, 'trucks', operatorBasis, `${operator.name}'s ${operator.trucks[0].label} trucks from its ${contract.depot}, shared among its contracted lanes by what each needs${operator.synthetic ? ' (invented)' : ''}.`);
            if (operator.trucks[1]) note(name, 'Fleet, second size', fleet2, 'trucks', operatorBasis, `${operator.name}'s ${operator.trucks[1].label} trucks from its ${contract.depot}${operator.synthetic ? ' (invented)' : ''}.`);
        } else if (standby) {
            note(name, 'Fleet', fleet, vehicleWord, 'assumed', kind === 'transfer' ? 'A backup: it carries nothing, and has no vehicles, until a scenario has its warehouse order over it.' : 'On standby: it carries nothing, and has no vehicles, until a scenario diverts cargo to its port.');
        } else if (types) {
            types.forEach((type, index) => {
                const count = index ? fleet2 : fleet;
                const own = chosen[index].fleet !== null;
                const whole = scope?.fleets?.get(`${link}|${type.id}`);
                const shared = whole ? ` ${scope.category.name}'s share of the link's ${number(whole.user ?? Math.ceil(whole.need / type.capacity - 1e-9))}, by what each category needs: a category's goods have vehicles of their own.` : '';
                note(name, `Fleet of ${type.name.toLowerCase()}s`, count, 'vehicles', own ? 'user' : 'assumed', `${own ? 'Your figure.' : `Enough for ${types.length === 2 ? 'half of ' : ''}the baseline flow of ${rate.toFixed(1)} ${unit}/day, plus a reserve.`}${shared}`);
            });
        } else {
            note(name, 'Fleet', fleet, 'trucks', 'assumed', `Enough for the baseline flow of ${rate.toFixed(1)} ${unit}/day, plus a reserve.`);
        }
        lanes.push({
            name, kind, from: origin.name, to: destination.name, site: destinationSite.name, fromSite: originSite.name, link, category: scope?.category.id ?? null, needs, rate, leadTime, kilometres, fleet, fleet2,
            operator: Boolean(contract), standby, basis: leg.basis, timeBasis: own ? 'user' : estimated ? 'estimated' : leg.basis, truckCapacity: capacity1, truckCapacity2: capacity2, loadDays: laneLoadDays,
            ...(types ? { vehicles: types.map((type, index) => ({ type: type.id, name: type.name, fleet: index ? fleet2 : fleet, user: chosen[index].fleet !== null })) } : {})
        });
        if (kind === 'supply' || kind === 'transfer') laneGeometry.push({ name: link, rate, standby, basis: leg.basis, origin: originSite, destination: destinationSite, path: leg.path ?? null });
        return node;
    };

    // A Warehouse node holding stock for `total` a day, ordering over lanes ({ rate, leadTime }): its stock what its cover
    // and its storage capacity allow, and the steady state of its order rule. `cover` and `capacity` are the site's own
    // (with their bases) or null for the defaults; `coverAs` places its cover as a shared parameter of stores.
    const placeStock = ({ entity, site, total, laneSpecs, minimumDays, defaultCover, coverAs = null, what }) => {
        // A figure of the site's own: one the user set (an assumed one is the role's default, which the model has too).
        const own = (key) => Number(site[key]) > 0 && site[`${key}Basis`] !== 'assumed';
        // Goods that keep only so long: no site aims to hold more than it sends out or sells within their shelf life, since
        // what it held beyond that would be wasted.
        const shelf = Number(scope?.category.shelfDays) > 0 ? Number(scope.category.shelfDays) : null;
        const wantedCover = own('coverDays') ? Number(site.coverDays) : defaultCover;
        const cover = shelf !== null ? Math.min(wantedCover, shelf) : wantedCover;
        if (cover < wantedCover - 1e-9) warnings.push(`${site.name} aims to hold ${number(cover, 2)} days of ${scope.category.name}, not its ${number(wantedCover, 2)} days of cover: ${scope.category.name} keeps ${number(shelf, 2)} days, and what it held beyond that would be wasted.`);
        // With categories, each has its share of the site's room, by what the site handles of it.
        const room = scope?.room?.get(site.id) ?? 1;
        const capacity = own('capacity') ? Number(site.capacity) * room : storageCapacity;
        const target = total * cover;
        const stock = Math.min(target, capacity);
        const onOrder = laneSpecs.reduce((sum, lane) => sum + lane.rate * ((lane.waitDays ?? responseDays) + lane.leadTime), 0);
        const planningLeadTime = onOrder / total;
        // It must hold what it hands on before its stock runs down: else the baseline cannot hold still.
        const minimum = total * minimumDays;
        if (stock < minimum - 1e-9) {
            const hours = `${number(minimumDays * 24, 1)} hours`;
            throw new Error(capacity < target
                ? `${site.name} can hold ${number(capacity, 2)} ${unit}, less than the ${number(minimum, 2)} it ${what} in ${hours}. Give it more storage capacity, or move some of its demand elsewhere.`
                : `${site.name}'s stock cover of ${number(cover, 2)} days is less than the ${number(minimumDays, 2)} it needs to ${what === 'sells' ? 'sell' : 'send out'} what it does. Give it a cover of at least ${number(minimumDays, 2)} days.`);
        }
        if (capacity < target - 1e-9) warnings.push(`${site.name} has room for ${number(capacity, 2)} ${unit}, less than its ${number(cover, 2)} days of cover (${number(target, 1)}): it holds ${number(capacity, 2)}, ${number(capacity / total, 2)} days of what it ${what}.`);
        const as = {
            // Its own cover, or one held to its goods' shelf life, is its own parameter: its order rule aims for that, not for
            // the cover every other warehouse or store shares.
            ...(own('coverDays') || cover < wantedCover - 1e-9 ? { coverDays: { own: true, value: cover } } : coverAs ? { coverDays: coverAs } : {}),
            ...(own('holdingCost') ? { holdingCostPerDay: { own: true, value: Number(site.holdingCost) } } : {})
        };
        // A store's stock room sits just above its shoppers on the canvas.
        const at = position(site);
        if (what === 'sells') at[1] = Number((at[1] + 0.6).toFixed(3));
        const node = place('warehouse', entity, {
            name: entity, position: at,
            initialValues: { stock, onOrder, forecast: total, orderRate: total, spaceUsed: stock / capacity },
            shared: { planningLeadTime, storageCapacity: capacity, ...(shelf !== null ? { shelfDays: shelf } : {}) }, as
        });
        note(site.name, 'Planned replenishment time', planningLeadTime, 'day', 'routed', 'Average order-to-arrival time over its lanes.');
        if (shelf !== null) note(site.name, 'Shelf life', shelf, 'day', scope.category.basis?.shelfDays === 'user' ? 'user' : 'assumed', `${scope.category.basis?.shelfDays === 'user' ? 'Your figure for' : 'Assumed for'} ${scope.category.name}. What it holds beyond what it expects to ${what === 'sells' ? 'sell' : 'send out'} in this time is wasted, and counted. Each site is judged on its own: time spent at a warehouse is not taken off the shelf life at a store.`);
        if (own('coverDays') || coverAs) note(site.name, 'Stock cover target', cover, 'day', own('coverDays') ? (site.coverDaysBasis ?? 'user') : 'assumed', own('coverDays') ? 'Your figure.' : `Assumed: the default for a ${what === 'sells' ? 'store' : 'warehouse'}, until you set it.`);
        if (own('capacity')) note(site.name, 'Storage capacity', capacity, unit, site.capacityBasis ?? 'user', scope ? `${number(room * 100, 1)}% of your ${number(Number(site.capacity), 1)}: ${scope.category.name}'s share of what the site handles. Each category has its own room.` : 'Your figure.');
        if (own('holdingCost')) note(site.name, 'Holding cost', Number(site.holdingCost), `cost/${unit}/day`, site.holdingCostBasis ?? 'user', 'Your figure.');
        return node;
    };

    // Which zones serve customer areas (deliveries draw on a day's stock) and which only restock stores (shipments draw
    // on half a day's).
    const stocked = (town) => Boolean(catalogue) && (town.role === 'store' || town.role === 'darkStore');
    const deliversTo = new Set(allocations.filter((item) => !stocked(item.town)).map((item) => item.zone.id));
    const transfersInto = new Map();
    for (const zone of usedZones) {
        const zoneFlows = (flowsByZone.get(zone.id) ?? []).filter((flow) => flow.rate > 1e-9);
        const total = zoneDemand.get(zone.id);
        const standby = standbyPorts.filter((port) => !zoneFlows.some((flow) => flow.port === port))
            .map((port) => ({ port, rate: 0, leg: legOf(`${zone.id}|${port.id}`), standby: true, link: null }));
        const laneSpecs = [...zoneFlows, ...standby].map((flow) => {
            // The lane's travel time as placeLane works it out: at least the slowest of its vehicles' speeds allows.
            const types = catalogue ? typesOf(choiceOf(flow.link?.vehicles, 'supply', `${flow.port.name} → ${zone.name}`), `${flow.port.name} → ${zone.name}`) : null;
            return { ...flow, leadTime: laneTiming(flow.leg, types, 'supply').leadTime, waitDays: suppliers.get(flow.port.id)?.pipelineDays ?? responseDays };
        });
        // And what other warehouses send it, over lanes placed once every warehouse is: they count towards what is on its way.
        const transfersIn = transferLinks.filter((link) => link.to === zone.id && zoneDemand.get(link.from) > 0).map((link) => {
            const ends = `${zoneById.get(link.from).name} → ${zone.name}`;
            const types = catalogue ? typesOf(choiceOf(link.vehicles, 'transfer', ends), ends) : null;
            return { link, rate: transferRate.get(link).rate, leadTime: laneTiming(link.leg ?? route(zoneById.get(link.from), zone), types, 'transfer').leadTime, waitDays: responseDays };
        });
        transfersInto.set(zone.id, transfersIn);
        const warehouse = placeStock({
            entity: label(zone.name), site: zone, total, laneSpecs: [...laneSpecs, ...transfersIn], defaultCover: coverDays, what: 'sends out',
            minimumDays: deliversTo.has(zone.id) ? drawDownDays : originDrainDays
        });
        for (const [laneIndex, lane] of laneSpecs.entries()) {
            placeLane({
                name: `Road ${lane.port.name} → ${zone.name}`, kind: 'supply', origin: portNodes.get(lane.port.id), destination: warehouse,
                originSite: lane.port, destinationSite: zone, rate: lane.rate, share: Math.min(1, lane.rate / total), leg: lane.leg,
                chosen: lane.link?.vehicles ?? null, standby: Boolean(lane.standby), offset: laneIndex * 0.8
            });
        }
        warehouses.set(zone.id, warehouse);
    }
    // The lanes between warehouses: a standing one carrying its share of what the warehouse it leads to sends out, a
    // backup one on standby, with no flow and no vehicles until a scenario orders over it.
    for (const zone of usedZones) {
        for (const [laneIndex, transfer] of (transfersInto.get(zone.id) ?? []).entries()) {
            const from = zoneById.get(transfer.link.from);
            const { share } = transferRate.get(transfer.link);
            placeLane({
                name: `Road ${from.name} → ${zone.name}`, kind: 'transfer', origin: warehouses.get(from.id), destination: warehouses.get(zone.id),
                originSite: from, destinationSite: zone, rate: transfer.rate, share, leg: transfer.link.leg ?? route(from, zone),
                chosen: transfer.link.vehicles ?? null, standby: Boolean(transfer.link.backup), offset: -(laneIndex + 1) * 0.8, destinationTotal: zoneDemand.get(zone.id)
            });
            if (!transfer.link.backup) note(zone.name, `Share restocked from ${from.name}`, share * 100, '%', transfer.link.share > 0 ? 'user' : 'assumed', transfer.link.share > 0 ? 'Your figure, on the link.' : 'What is left once its links with a share of their own have theirs, split evenly among the rest of its sources: assumed until you set it on the link.');
        }
    }

    // ---- towns, each served by its zones: a customer area (or a town) by deliveries; a store or dark store, with a
    // catalogue, from its own stock, restocked by road from its warehouses.
    const serveLinkOf = new Map((links?.serve ?? []).map((link) => [`${link.zone}|${link.town}`, link]));
    const stores = [];
    // Every delivery: a store's sales from its own stock, a customer area's or a town's deliveries from a warehouse. Its
    // share of the stock it draws on is live, so a scenario can stop it (a store closed, a warehouse down).
    const deliveries = [];
    const placeDelivery = (entity, from, to, site, options) => {
        bundle('delivery', entity, { warehouse: from, zone: to }, options);
        makeLive(entity, 'share', 1);
        deliveries.push({ name: entity, from: from.name, to: to.name, site, category: scope?.category.id ?? null, share: options.shared.share });
    };
    for (const town of towns) {
        const townDemand = demand.get(town.id);
        const itsAllocations = allocations.filter((item) => item.town === town);
        const shop = stocked(town);
        const townName = label(town.name);
        const node = place('demandZone', townName, {
            name: townName, position: position(town),
            initialValues: { backlog: townDemand * (shop ? settings.saleDays : responseDays), demandRate: townDemand },
            shared: { baseDemand: townDemand }
        });
        // Live, so a scenario can step demand up: to four times the town's own.
        makeLive(townName, 'baseDemand', niceCeiling(4 * townDemand));
        if (shop) {
            const stockName = label(`${town.name} stock`);
            const kindName = town.role === 'darkStore' ? 'dark store' : 'store';
            const laneSpecs = itsAllocations.map((item) => {
                const link = serveLinkOf.get(`${item.zone.id}|${town.id}`);
                const types = typesOf(choiceOf(link?.vehicles, 'store', `${item.zone.name} → ${town.name}`), `${item.zone.name} → ${town.name}`);
                if (!types.length) throw new Error(`${item.zone.name} → ${town.name} has no vehicles. Choose a vehicle for it.`);
                const barred = types.filter((type) => !type.toStores);
                if (barred.length) throw new Error(`${barred.map((type) => type.name).join(' and ')} may not deliver to ${kindName}s: choose another vehicle for ${item.zone.name} → ${town.name}.`);
                return { allocation: item, link, rate: item.share * townDemand, leadTime: laneTiming(item.leg, types, 'store').leadTime };
            });
            const storeCover = town.role === 'darkStore' ? settings.darkStoreCoverDays : settings.storeCoverDays;
            const stockNode = placeStock({
                entity: stockName, site: town, total: townDemand, laneSpecs, defaultCover: storeCover, what: 'sells', minimumDays: settings.shelfDrawDownDays,
                coverAs: town.role === 'darkStore'
                    ? { symbol: 'darkStoreCoverDays', name: 'Stock cover target at dark stores', value: storeCover }
                    : { symbol: 'storeCoverDays', name: 'Stock cover target at stores', value: storeCover }
            });
            // Shoppers buy from the shelves within the sale time, drawing at most the stock there per shelf draw-down time;
            // of what the shelves cannot sell, a share is lost and the rest waits. The share is the store's own when the
            // user set it, else one for every store (or dark store), so it can be changed for all at once.
            const ownLost = Number.isFinite(town.lostShare) && town.lostShareBasis !== 'assumed';
            const lostShare = ownLost ? town.lostShare : town.role === 'darkStore' ? settings.darkStoreLostShare : settings.storeLostShare;
            placeDelivery(label(`${town.name} sales`), stockNode, node, town.name, {
                shared: { share: 1, demandShare: 1 },
                as: {
                    responseDays: { symbol: 'saleDays', name: 'Sale time at stores', value: settings.saleDays },
                    drawDownDays: { symbol: 'shelfDrawDownDays', name: 'Shelf draw-down time', value: settings.shelfDrawDownDays },
                    lostShare: ownLost ? { own: true, value: lostShare }
                        : town.role === 'darkStore' ? { symbol: 'darkStoreLostShare', name: 'Orders lost when out of stock at dark stores', value: lostShare }
                            : { symbol: 'storeLostShare', name: 'Sales lost when out of stock at stores', value: lostShare }
                }
            });
            note(town.name, kindName === 'store' ? 'Sales lost when out of stock' : 'Orders lost when out of stock', lostShare * 100, '%', ownLost ? 'user' : 'assumed',
                ownLost ? 'Your figure.' : `Assumed: the default for a ${kindName}, until you set it. Of what it cannot sell for want of stock, this share is lost; the rest waits for a delivery.`);
            // What a pallet sold is worth: the category's, where it has one (the same at every store); else the store's own
            // or the default.
            const categoryValue = Number(scope?.category.saleValue) > 0 ? Number(scope.category.saleValue) : null;
            const ownValue = categoryValue !== null || (Number(town.saleValue) > 0 && town.saleValueBasis !== 'assumed');
            const saleValue = categoryValue ?? (ownValue ? Number(town.saleValue) : settings.saleValue);
            if (categoryValue !== null) note(town.name, 'Value of a pallet sold', categoryValue, `cost/${unit === 'pallets' ? 'pallet' : unit}`, scope.category.basis?.saleValue === 'user' ? 'user' : 'assumed', `The value of a pallet of ${scope.category.name}, at every store. The sales it loses are priced at this.`);
            for (const [laneIndex, lane] of laneSpecs.entries()) {
                const zone = lane.allocation.zone;
                placeLane({
                    name: `Road ${zone.name} → ${town.name}`, kind: 'store', origin: warehouses.get(zone.id), destination: stockNode,
                    originSite: zone, destinationSite: town, rate: lane.rate, share: lane.allocation.share, leg: lane.allocation.leg,
                    chosen: lane.link?.vehicles ?? null, offset: laneIndex * 0.8
                });
                if (laneSpecs.length > 1) note(town.name, `Share ordered from ${zone.name}`, lane.allocation.share * 100, '%', 'assumed', `By the warehouse's size and road access, and ${lane.allocation.leg.hours.toFixed(1)} h by road.`);
            }
            stores.push({ name: townName, site: town.name, category: scope?.category.id ?? null, stock: stockName, role: town.role, demand: townDemand, lostShare, saleValue, saleValueBasis: ownValue ? 'user' : 'assumed' });
            continue;
        }
        for (const allocation of itsAllocations) {
            const zoneTotal = zoneDemand.get(allocation.zone.id);
            placeDelivery(label(`${town.name} from ${allocation.zone.name}`), warehouses.get(allocation.zone.id), node, town.name, {
                shared: { share: allocation.share * townDemand / zoneTotal, demandShare: allocation.share }
            });
            if (itsAllocations.length > 1) {
                note(town.name, `Share served from ${allocation.zone.name}`, allocation.share * 100, '%', 'assumed', `By the zone's size and road access, and ${allocation.leg.hours.toFixed(1)} h by road.`);
            }
        }
    }
    if (stores.length && !scope?.index) note('Every store', 'Sale time and shelf draw-down time', settings.saleDays, 'day', 'assumed', `A shopper buys what is on the shelf within ${number(settings.saleDays * 24, 1)} hours, and the shelves can be emptied in as long: a store sells what it has; of what it has not, some sales are lost and the rest wait.`);

    if (operator && lanes.length) {
        const [first, second] = operator.trucks;
        const set = (symbol, value, name, unit, detail) => {
            if (!builder.sharedParameters.some((item) => item.symbol === symbol)) return;
            builder.setShared(symbol, value);
            note(operator.name, name, value, unit, operatorBasis, detail);
        };
        const invented = operator.synthetic ? ' (invented)' : '';
        set('truckCapacity', first.teu, `Truck capacity, ${first.label}`, 'TEU/truck', `The operator's first truck size${invented}.`);
        set('costPerKm', first.costPerKm, `Cost per km, ${first.label}`, `${operator.currency}/km`, `The operator's running cost${invented}; it applies to every lane's trucks of this size.`);
        set('truckDayCost', first.costPerDay, `Cost per truck per day, ${first.label}`, `${operator.currency}/day`, `The operator's fixed cost per truck${invented}.`);
        if (second) {
            set('truckCapacity2', second.teu, `Truck capacity, ${second.label}`, 'TEU/truck', `The operator's second truck size${invented}.`);
            set('costPerKm2', second.costPerKm, `Cost per km, ${second.label}`, `${operator.currency}/km`, `The operator's running cost${invented}.`);
            set('truckDayCost2', second.costPerDay, `Cost per truck per day, ${second.label}`, `${operator.currency}/day`, `The operator's fixed cost per truck${invented}.`);
        }
        const unmatched = operator.contracts.filter((contract) => !lanes.some((lane) => lane.from === contract.from && lane.to === contract.to));
        if (unmatched.length) warnings.push(`${operator.name}'s contract${unmatched.length === 1 ? '' : 's'} for ${unmatched.map((contract) => `${contract.from} → ${contract.to}`).join(', ')} match${unmatched.length === 1 ? 'es' : ''} no lane in the model.`);
    }

    const category = scope?.category.id ?? null;
    return {
        provenance, warnings, parameterIndex, lanes, laneGeometry, stores, deliveries, unusedLinks, unusedZones,
        // What each warehouse sends out and each store sells, by site id: what a category's share of a site's room goes by.
        totals: new Map([...zoneDemand, ...demand]),
        // Each port's arrivals as built: its average, and the held schedule it follows when it has one -- what a
        // scenario that changes them starts from. A supplier's: what is ordered from it, the most it can make and its lead time.
        ports: ports.map((port) => ({
            name: label(port.name), site: port.name, category, supplier: Boolean(port.supplier), arrivals: supply.get(port.id),
            berths: suppliers.get(port.id)?.capacity ?? supply.get(port.id) * settings.berthHeadroom, schedule: histories.get(port.id)?.samples ?? null,
            ...(suppliers.has(port.id) ? { leadDays: suppliers.get(port.id).leadTime } : {}),
            usual: normals.get(port.id) ?? null, shift: port.activity?.shift ?? null
        })),
        // How the toolbox sizes a lane's fleet, for a scenario that hires trucks.
        trucking: { truckCapacity, loadDays, idleReserve: settings.idleReserve },
        standbyPorts: standbyPorts.map((port) => port.name),
        operator: operator ? { name: operator.name, synthetic: operator.synthetic, currency: operator.currency, trucks: operator.trucks, depots: operator.depots, lanes: operatorLanes } : null,
        // The ports whose arrivals follow their history, and the dates model day 0 and the last day stand for.
        histories: [...histories].map(([id, history]) => ({ port: ports.find((port) => port.id === id).name, from: history.from, to: history.to, days: history.samples.length })),
        // Each town's demand as built, what a scenario that steps it up starts from.
        towns: towns.map((town) => ({ name: label(town.name), site: town.name, category, demand: demand.get(town.id) })),
        unit, perTeu,
        vehicles: catalogue ? catalogue.map((type) => ({ id: type.id, name: type.name, capacity: type.capacity, refrigerated: Boolean(type.refrigerated) })) : null,
        // One entry per town and zone serving it: the zone's share of the town's demand.
        served: allocations.map((allocation) => ({ town: allocation.town.name, zone: allocation.zone.name, category, share: allocation.share, demand: allocation.share * demand.get(allocation.town.id), hours: allocation.leg.hours })),
        latitudes: [...ports, ...usedZones].map((item) => item.lat),
        setByOperator: operator ? ['truckCapacity', 'costPerKm', 'truckDayCost', ...(operator.trucks[1] ? ['truckCapacity2', 'costPerKm2', 'truckDayCost2'] : [])] : []
    };
}

// Where the canvas puts a model's sites: north up, spread over about 80 units so names stay apart.
function layoutOf(everything) {
    const origin = { lat: everything.reduce((total, item) => total + item.lat, 0) / everything.length, lon: everything.reduce((total, item) => total + item.lon, 0) / everything.length };
    const local = everything.map((item) => toLocal(item, origin));
    const extent = Math.max(1, ...local.map((point) => Math.max(Math.abs(point.x), Math.abs(point.y))));
    const scale = 40 / extent;
    const span = (axis) => (Math.max(...local.map((point) => point[axis])) - Math.min(...local.map((point) => point[axis]))) * scale;
    return { origin, scale, width: span('x'), height: span('y') };
}

// Where each category's copy of the network goes on the canvas: in a grid, left to right then top to bottom, each the
// network's own width and height apart with room between for its names, the whole centred where one network would be.
// With the copies on top of each other their names could not be told apart. The grid is the one that keeps the model
// most compact (the shortest diagonal): Konjugate fits a model to the window by its size, and names are drawn at one
// size however far the camera stands, so a long thin row of copies would be shown small under a pile of names. A
// network wider than it is tall has its copies one above the other. One category has the canvas to itself.
export function categoryShifts(count, { width, height }, gap = 14) {
    const [stepX, stepY] = [width + gap, height + gap];
    const diagonal = (columns) => Math.hypot(columns * stepX, Math.ceil(count / columns) * stepY);
    const columns = Array.from({ length: count }, (_, index) => index + 1).reduce((best, candidate) => (diagonal(candidate) < diagonal(best) - 1e-9 ? candidate : best), 1);
    const rows = Math.ceil(count / columns);
    return Array.from({ length: count }, (_, index) => {
        const [column, row] = [index % columns, Math.floor(index / columns)];
        return [Number(((column - (columns - 1) / 2) * stepX).toFixed(3)), Number((((rows - 1) / 2 - row) * stepY).toFixed(3))];
    });
}

// The model from its parts: one network, or one copy of it per category.
function assemble(parts, { builder, settings, categories = null }) {
    const [first] = parts;
    const all = (key) => parts.flatMap((part) => part[key]);
    const unique = (items) => [...new Set(items)];
    const provenance = all('provenance');
    // The model-wide constants every component shares: the component library's defaults unless the operator set them,
    // so every input the model runs on says where it comes from. Seconds per day is a unit, not an input.
    const templates = builder.templates;
    const projectScope = new Map([...templates.values()].flatMap((template) => (template.sharedParameters ?? []).filter((declared) => declared.scope === 'project').map((declared) => [declared.symbol, declared])));
    const setByOperator = new Set(first.setByOperator);
    const inert = {
        outageStart: 'The berth outage window; no port has an outage unless its outage capacity is lowered.',
        outageEnd: 'The berth outage window; no port has an outage unless its outage capacity is lowered.',
        stepMultiplier: 'A step in every town’s demand; none while it is 1.',
        stepDay: 'When the step in demand comes; none while its multiplier is 1.'
    };
    for (const shared of builder.sharedParameters) {
        if (!projectScope.has(shared.symbol) || shared.symbol === 'secondsPerDay' || setByOperator.has(shared.symbol)) continue;
        provenance.push({ entity: 'Every component', parameter: shared.name, value: shared.value, unit: shared.unit, basis: 'assumed', detail: inert[shared.symbol] ?? 'The component library’s default, shared by every component that uses it.' });
    }
    // The roads the lanes run on, simplified as the map simplifies its roads: about half a pixel on a 1000-pixel map.
    // A link's categories travel the same road: one lane on the map, carrying them all.
    const geometry = new Map();
    for (const lane of all('laneGeometry')) {
        if (geometry.has(lane.name)) geometry.get(lane.name).rate += lane.rate;
        else geometry.set(lane.name, { ...lane });
    }
    const latitudes = all('latitudes');
    const corridors = laneCorridors([...geometry.values()], { tolerance: Math.max(20, (Math.max(...latitudes) - Math.min(...latitudes)) * 111320 / 2000) });
    const document = builder.document({ days: settings.days, stepDays: settings.stepMinutes / 1440, outputDays: settings.outputMinutes / 1440 });
    // A warehouse left out: one that serves no one in any category.
    const unusedZones = first.unusedZones.filter((zone) => parts.every((part) => part.unusedZones.some((other) => other.id === zone.id))).map((zone) => zone.name);
    const histories = new Map(all('histories').map((item) => [item.port, item]));
    const unusedLinks = new Map(all('unusedLinks').map((item) => [`${item.from}|${item.to}`, item]));
    return {
        document, provenance, warnings: unique(all('warnings')), parameterIndex: all('parameterIndex'),
        // Every lane, a link's one for each category it carries: { name, link, category, from and to (nodes), fromSite and site, ... }.
        lanes: all('lanes'), ports: all('ports'), days: settings.days, trucking: first.trucking, standbyPorts: first.standbyPorts, operator: first.operator,
        histories: [...histories.values()], unusedZones,
        // The supply links the network gave that are not lanes in the model in some category, and why.
        unusedLinks: [...unusedLinks.values()],
        // The roads the lanes run on, for the map: [{ points, rate, lanes, basis, standby }].
        corridors,
        towns: all('towns'),
        // The stores and dark stores that hold stock, one entry for each category they sell: { name (its shoppers' node),
        // site, category, stock (its stock room's node), role, demand }.
        stores: all('stores'),
        // Every delivery, a store's sales included: { name, from (the stock it draws on), to, site, category, share }.
        deliveries: all('deliveries'),
        // What the model counts, how many of it a TEU is, the vehicle types its lanes run on (null for two truck sizes)
        // and the categories it carries (null for goods of one kind).
        unit: first.unit, perTeu: first.perTeu, vehicles: first.vehicles,
        categories: categories ? categories.map((category) => ({ id: category.id, name: category.name, chilled: Boolean(category.chilled), ...(Number(category.shelfDays) > 0 ? { shelfDays: Number(category.shelfDays) } : {}) })) : null,
        served: all('served')
    };
}

// Builds the model. With `options.categories` (a network placed in the window), every category is its own copy of the
// network: a site's supply or sales are shared among the categories by its own mix (`mix` on its entry: { [category
// id]: weight }) or else by the categories' usual shares, a supplier may have a lead time for each (`leadDaysBy`), a
// chilled category goes by refrigerated vehicles only, and a link's vehicles and a site's room are shared among the
// categories by what each needs. Vehicles are not shared between categories as they run: each has its own on a link.
export function buildRegionModel({ builder, selection, route, links = null, options = {} }) {
    const settings = { ...regionModelDefaults, ...options };
    const categories = links && settings.vehicles?.length && settings.categories?.length ? settings.categories : null;
    if (!categories) return assemble([buildScope({ builder, selection, route, links, settings })], { builder, settings });
    const names = categories.map((category) => String(category.name ?? '').trim());
    if (names.some((name) => !name)) throw new Error('A category has no name. Name it in the Categories list.');
    if (new Set(names).size !== names.length) throw new Error('Two categories have the same name: give each its own.');
    const single = categories.length === 1;
    const sites = [...(selection.ports ?? []), ...(selection.towns ?? [])];
    // Each site's mix: its own weights, or the categories' usual shares; over the categories there are.
    const shares = new Map(categories.map((category) => [category.id, new Map()]));
    const mixBasis = new Map();
    for (const site of sites) {
        const own = site.mix && categories.some((category) => site.mix[category.id] !== undefined);
        const weight = (category) => Math.max(0, Number(own ? site.mix[category.id] ?? 0 : category.share ?? 1) || 0);
        const total = categories.reduce((sum, category) => sum + weight(category), 0);
        if (!(total > 0)) throw new Error(`${site.name} ${site.supplier ? 'supplies' : 'carries'} none of the categories. Give it at least one.`);
        for (const category of categories) shares.get(category.id).set(site.id, weight(category) / total);
        mixBasis.set(site.id, own ? 'user' : 'assumed');
    }
    const everything = [...(selection.ports ?? []), ...(selection.zones ?? []), ...(selection.towns ?? [])];
    const layout = everything.length ? layoutOf(everything) : null;
    const shifts = layout ? categoryShifts(categories.length, layout) : [];
    const scopes = categories.map((category, index) => {
        const its = shares.get(category.id);
        const ports = (selection.ports ?? []).filter((port) => its.get(port.id) > 0).map((port) => {
            const lead = port.leadDaysBy?.[category.id];
            return Number(lead?.value) > 0 ? { ...port, leadDays: Number(lead.value), leadDaysBasis: lead.basis ?? 'user' } : port;
        });
        const towns = (selection.towns ?? []).filter((town) => its.get(town.id) > 0);
        const kept = new Set([...ports, ...towns].map((site) => site.id));
        return {
            category, index, single, shares: its, mixBasis, layout, shift: shifts[index] ?? [0, 0],
            selection: { ports, zones: selection.zones ?? [], towns },
            links: { supply: links.supply.filter((link) => kept.has(link.port)), serve: links.serve.filter((link) => kept.has(link.town)), transfer: links.transfer ?? [] }
        };
    });
    const run = (scope, onto, extra) => {
        try {
            return buildScope({ builder: onto, selection: scope.selection, route, links: scope.links, settings, scope: { ...scope, ...extra } });
        } catch (error) {
            throw single ? error : new Error(`${scope.category.name}: ${error.message}`);
        }
    };
    // Built once to learn what each category needs on each link and at each site, then for good with the link's
    // vehicles and the site's room shared by that.
    const fleets = new Map();
    const siteTotals = new Map();
    const drafts = single ? [] : scopes.map((scope) => run(scope, builder.fresh(), { typesNoted: new Set() }));
    for (const draft of drafts) {
        for (const lane of draft.lanes) {
            for (const item of lane.needs ?? []) {
                const key = `${lane.link}|${item.type}`;
                const whole = fleets.get(key) ?? { need: 0, user: null };
                fleets.set(key, { need: whole.need + item.need, user: whole.user ?? item.user });
            }
        }
        for (const [id, total] of draft.totals) siteTotals.set(id, (siteTotals.get(id) ?? 0) + total);
    }
    const typesNoted = new Set();
    const parts = scopes.map((scope, index) => run(scope, builder, single ? { typesNoted } : {
        typesNoted, fleets,
        room: new Map([...drafts[index].totals].map(([id, total]) => [id, siteTotals.get(id) > 0 ? total / siteTotals.get(id) : 0]))
    }));
    return assemble(parts, { builder, settings, categories });
}
