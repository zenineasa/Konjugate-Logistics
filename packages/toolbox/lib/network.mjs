/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The network the user places on the map: pins, each with a role, and links between them. A pin's figures
// start as defaults labelled assumed and become the user's once changed; a pin adopted from a suggestion
// (a port from OpenStreetMap and IMF PortWatch, a warehouse estate, a town) keeps where it came from.
//
// Links run from a source (supplier or port) to a warehouse, from a warehouse to a store, dark store
// or customer area, and from one warehouse to another: a standing link (a hub restocking a spoke, with its share of
// what the spoke needs) or a backup (`backup`: nothing until a scenario orders over it). Links between warehouses are
// never suggested: they are the user's to draw. They are suggested until the user draws, moves or deletes one: a link the user drew is
// theirs and is never suggested away, and a suggested link the user deleted is not suggested again.
//
// Each demand pin is suggested its nearest warehouse by road. Each warehouse is suggested every source while
// the network is small, so the builder can always balance what the sources ship with what the warehouses
// pass on (a source's supply is fixed; with too few links it may have nowhere to go); in a larger network,
// its nearest few, and each source its nearest few warehouses. The builder leaves out a suggested supply
// link that would carry next to nothing, and says so; links the user drew are built as drawn.

import { groupOfRole, roleNames } from './sites.mjs';
import { calendarOf, calendarProblem, hoursForModel, kindsFor } from './calendars.mjs';
import { categoriesForModel, categoriesProblem, hasMix, mixForModel } from './categories.mjs';
import { carriersFor, catalogueForModel, linkKind, linkVehicleProblem, vehicleProblem, vehiclesOf } from './vehicles.mjs';

// The network counts goods in pallets: a site's figures, a vehicle's capacity and the model's stocks and flows. A port's
// volume is in containers (TEU), counted as `palletsPerTeu` pallets each.
export const unit = 'pallets';

// `positive`: nothing (0) means the default, as an empty field does: a site with no room or no stock target sells nothing.
const capacityField = (detail) => ({ key: 'capacity', label: 'Storage capacity', unit: 'pallets', value: null, positive: true, detail });
const coverField = (value, detail) => ({ key: 'cover', label: 'Stock cover', unit: 'days', value, positive: true, detail });
// What a store loses when its shelves are short, and what a sale is worth: the summary counts lost sales in pallets and
// in money. 0 lost is a figure (everyone waits), so the field takes it; it is a share, so no more than 100.
const lostField = (value, detail) => ({ key: 'lostSales', label: 'Sales lost when out', unit: '%', value, max: 100, detail });
const saleValueField = () => ({ key: 'saleValue', label: 'Value of a pallet sold', unit: 'a pallet', value: 1000, positive: true, detail: 'What its sales bring in a pallet: the summary prices the sales it loses at this.' });

export const roles = {
    supplier: {
        label: 'Supplier', kind: 'source',
        fields: [
            { key: 'supply', label: 'Supplies', unit: 'pallets a day', value: 50, detail: 'What is ordered from it in a normal week. It makes what is ordered, each order taking its lead time.' },
            { key: 'makes', label: 'Can make at most', unit: 'pallets a day', value: null, positive: true, detail: 'The most it starts a day; orders beyond that wait, and arrive late. Empty: half as much again as it supplies.' }
        ]
    },
    port: {
        label: 'Port', kind: 'source',
        fields: [{ key: 'teuPerDay', label: 'Handed inland', unit: 'TEU a day', value: null, detail: 'Empty: from IMF PortWatch when the port is matched, else the assumed volume a port. Each container counts as 10 pallets.' }]
    },
    warehouse: {
        label: 'Warehouse', kind: 'warehouse',
        fields: [
            { key: 'floorArea', label: 'Floor area', unit: 'm²', value: null, detail: 'Weights how much of a demand pin linked to several warehouses it serves. Empty: a typical warehouse.' },
            capacityField('The most it can hold. It never orders more than it has room for. Empty: no limit.'),
            coverField(3, 'The stock it aims to hold, in days of what it sends out, on top of what is on its way.'),
            { key: 'holdingCost', label: 'Holding cost', unit: 'a pallet a day', value: 0.5, detail: 'What a pallet in stock costs a day (space, capital, insurance).' },
            // Not in the model: added to the running cost when sites are compared, and what a candidate must earn back.
            { key: 'fixedCost', label: 'Fixed cost', unit: 'a month', value: null, positive: true, detail: 'Rent, staff and the rest of what it costs to have, whatever it handles. Counted when candidate sites are compared. Empty: nothing.' },
            { key: 'openingCost', label: 'Cost to open', unit: 'once', value: null, positive: true, detail: 'For a candidate: what opening it costs, once. Its payback is counted against this. Empty: nothing.' }
        ]
    },
    store: {
        label: 'Store', kind: 'demand',
        fields: [
            { key: 'demand', label: 'Sells', unit: 'pallets a day', value: 5, detail: 'Sold from its own stock; of what it cannot sell for want of stock, some is lost and the rest waits for a delivery.' },
            capacityField('Shelves and back room: the most it can hold. Empty: no limit.'),
            coverField(2, 'The stock it aims to hold, in days of sales, on top of what is on its way.'),
            lostField(80, 'Of the sales it cannot make for want of stock, the share its shoppers make elsewhere rather than wait for. 0: every shopper waits.'),
            saleValueField()
        ]
    },
    darkStore: {
        label: 'Dark store', kind: 'demand',
        fields: [
            { key: 'demand', label: 'Delivers', unit: 'pallets a day', value: 3, detail: 'Sold from its own stock, as a store, until online orders and the last mile come.' },
            capacityField('The most it can hold. Empty: no limit.'),
            coverField(1, 'The stock it aims to hold, in days of orders, on top of what is on its way.'),
            lostField(50, 'Of the orders it cannot fill for want of stock, the share cancelled rather than delivered late. 0: every order waits.'),
            saleValueField()
        ]
    },
    customerArea: {
        label: 'Customer area', kind: 'demand',
        fields: [
            { key: 'demand', label: 'Orders', unit: 'pallets a day', value: null, detail: 'Empty: a share of what the sources supply, by population. Delivered by a parcel or courier service, with no stock or vehicles of its own.' },
            { key: 'population', label: 'Population', unit: 'people', value: 20000, detail: 'Weights its share when it has no orders of its own.' }
        ]
    }
};
export const roleIds = Object.keys(roles);
export const kindOf = (role) => roles[role]?.kind ?? null;
// Every source to every warehouse up to this many links; beyond, each warehouse from its nearest few sources and each
// source to its nearest few warehouses.
export const completeSupplyUpTo = 24;
export const sourcesPerWarehouse = 4;
export const warehousesPerSource = 2;

let counter = 0;
const newId = (role) => `pin:${role}:${Date.now().toString(36)}${(counter++).toString(36)}`;

// "Store 4": the next number not already used for the role.
export function defaultName(role, pins) {
    const label = roles[role].label;
    const used = new Set(pins.filter((pin) => pin.role === role).map((pin) => pin.name));
    for (let index = 1; ; index += 1) if (!used.has(`${label} ${index}`)) return `${label} ${index}`;
}

// A new pin. `fields` given are the user's (or sourced, with `basis`); the role's others start as its assumed defaults.
export function createPin(role, point, { id = newId(role), name, pins = [], fields = {}, basis = 'user', source = 'placed on the map', candidate = null } = {}) {
    if (!roles[role]) throw new Error(`"${role}" is not a role.`);
    const values = {};
    for (const field of roles[role].fields) {
        const given = fields[field.key];
        if (given !== undefined && given !== null && given !== '') values[field.key] = typeof given === 'object' ? given : { value: Number(given), basis: 'user' };
        else values[field.key] = { value: field.value, basis: field.value === null ? null : 'assumed' };
    }
    return { id, role, name: name || defaultName(role, pins), lat: point.lat, lon: point.lon, basis, source, fields: values, ...(candidate ? { candidate } : {}) };
}

// A field changed on the card: the user's value, or back to the role's assumed default when cleared.
export function setField(pin, key, text) {
    const field = roles[pin.role].fields.find((item) => item.key === key);
    if (!field) return pin;
    const value = Number(text);
    pin.fields[key] = text !== '' && text !== null && Number.isFinite(value) && (field.positive ? value > 0 : value >= 0) && !(value > (field.max ?? Infinity))
        ? { value, basis: 'user' }
        : { value: field.value, basis: field.value === null ? null : 'assumed' };
    return pin;
}

// A pin from an older session made whole: the role's fields it lacks start as their assumed defaults.
export function completeFields(pin) {
    pin.fields ??= {};
    for (const field of roles[pin.role]?.fields ?? []) {
        if (!pin.fields[field.key]) pin.fields[field.key] = { value: field.value, basis: field.value === null ? null : 'assumed' };
    }
    return pin;
}

// Whether a link may run from one pin to the other, and why not.
export function linkProblem(from, to) {
    if (!from || !to) return 'A link joins two sites.';
    if (from.id === to.id) return 'A link joins two different sites.';
    const a = kindOf(from.role);
    const b = kindOf(to.role);
    if (a === 'source' && b === 'warehouse') return null;
    if (a === 'warehouse' && b === 'demand') return null;
    if (a === 'source' && b === 'demand') return `${to.name} is supplied through a warehouse in this version: link ${from.name} to a warehouse, and the warehouse to ${to.name}.`;
    if (a === 'demand') return `${from.name} supplies nothing: a ${roleNames[from.role]} is at the end of the network. Draw links from warehouses to it.`;
    if (a === 'source' && b === 'source') return 'Sources supply warehouses, not each other.';
    if (b === 'source') return `${to.name} is a source: nothing is shipped to it. Draw links from it to a warehouse.`;
    if (a === 'warehouse' && b === 'warehouse') return null;
    return 'These two sites cannot be linked.';
}

export const linkId = (from, to) => `${from}>${to}`;

// A candidate: a warehouse that is not open, placed and linked to be compared with the network as it is. It is left
// out of the network (and its links with it) unless it is opened for a comparison.
export const isCandidate = (pin) => pin?.role === 'warehouse' && pin.candidate === true;
// The network with these candidates open (by pin id) and the rest left out: the pins and links a build takes.
export function openNetwork(pins, links, open = []) {
    const opened = new Set(open);
    const kept = pins.filter((pin) => !isCandidate(pin) || opened.has(pin.id));
    const ids = new Set(kept.map((pin) => pin.id));
    return { pins: kept, links: links.filter((link) => ids.has(link.from) && ids.has(link.to)) };
}

// Links suggested for the pins, keeping every link the user drew. `dismissed` holds the ids of suggested links the user
// deleted; `router` is createNetworkRouter's. A suggested link that is suggested again keeps its object (and its leg).
export function suggestLinks(pins, links, router, dismissed = new Set()) {
    const byId = new Map(pins.map((pin) => [pin.id, pin]));
    const valid = (link) => byId.has(link.from) && byId.has(link.to) && !linkProblem(byId.get(link.from), byId.get(link.to));
    const user = links.filter((link) => link.basis === 'user' && valid(link));
    const previous = new Map(links.filter((link) => link.basis !== 'user').map((link) => [link.id, link]));
    const taken = new Set(user.map((link) => link.id));
    const suggested = [];
    const suggest = (from, to) => {
        const id = linkId(from.id, to.id);
        if (taken.has(id) || dismissed.has(id)) return;
        taken.add(id);
        suggested.push(previous.get(id) ?? { id, from: from.id, to: to.id, basis: 'suggested' });
    };
    const warehouses = pins.filter((pin) => kindOf(pin.role) === 'warehouse');
    const sources = pins.filter((pin) => kindOf(pin.role) === 'source');
    // Each demand pin with no link of the user's: from its nearest warehouse that is open (a candidate's stores are the
    // user's to choose; its suppliers are suggested as any warehouse's are, so it is supplied once it opens).
    const working = warehouses.filter((pin) => !isCandidate(pin));
    if (working.length) {
        const nearest = router.nearestSources(working.map((pin) => ({ id: pin.id, lat: pin.lat, lon: pin.lon })));
        for (const pin of pins.filter((item) => kindOf(item.role) === 'demand')) {
            if (user.some((link) => link.to === pin.id)) continue;
            const found = nearest(pin);
            if (found) suggest(byId.get(found.id), pin);
        }
    }
    // Each warehouse with no supply link of the user's: from every source, or its nearest few in a larger network.
    const open = warehouses.filter((warehouse) => !user.some((link) => link.to === warehouse.id));
    if (sources.length && open.length) {
        const complete = sources.length * warehouses.length <= completeSupplyUpTo;
        for (const warehouse of open) {
            const ranked = complete ? sources : sources.map((source) => ({ source, hours: router.route(source, warehouse).hours })).sort((a, b) => a.hours - b.hours).map((item) => item.source);
            for (const source of complete ? ranked : ranked.slice(0, sourcesPerWarehouse)) suggest(source, warehouse);
        }
        // And each source, to its nearest few warehouses.
        if (!complete) {
            for (const source of sources) {
                const ranked = open.map((warehouse) => ({ warehouse, hours: router.route(source, warehouse).hours })).sort((a, b) => a.hours - b.hours);
                for (const { warehouse } of ranked.slice(0, warehousesPerSource)) suggest(source, warehouse);
            }
        }
    }
    return [...user, ...suggested];
}

// Routes every link whose ends moved since it was last routed (or that was never routed); returns how many were.
export function routeLinks(pins, links, router) {
    const byId = new Map(pins.map((pin) => [pin.id, pin]));
    let routed = 0;
    for (const link of links) {
        const from = byId.get(link.from);
        const to = byId.get(link.to);
        if (!from || !to) continue;
        const ends = `${from.lat},${from.lon}|${to.lat},${to.lon}`;
        if (link.leg && link.ends === ends) continue;
        link.leg = router.route(from, to);
        link.ends = ends;
        routed += 1;
    }
    return routed;
}

// What stops the network from being built (errors) and what the user should know (warnings), each naming its pins.
// `catalogue`: the vehicle types, when the network runs on them; `categories`: the product categories it carries.
export function networkProblems(allPins, allLinks, catalogue = null, categories = null) {
    const problems = [];
    // The network as it is: its candidates are judged apart, below, as they would be once open.
    const { pins, links } = openNetwork(allPins, allLinks);
    for (const candidate of allPins.filter(isCandidate)) {
        const its = allLinks.filter((link) => link.from === candidate.id || link.to === candidate.id);
        if (!its.some((link) => link.from === candidate.id)) problems.push({ level: 'warning', text: `${candidate.name} is a candidate with no store or warehouse to supply: link it to those it would take, to compare it.`, pins: [candidate.id] });
        else if (!its.some((link) => link.to === candidate.id && !link.backup)) problems.push({ level: 'warning', text: `${candidate.name} is a candidate with no supplier, port or warehouse to restock it: link one to it, to compare it.`, pins: [candidate.id] });
    }
    const byId = new Map(pins.map((pin) => [pin.id, pin]));
    const add = (level, text, ids = []) => problems.push({ level, text, pins: ids });
    const of = (kind) => pins.filter((pin) => kindOf(pin.role) === kind);
    if (!of('source').length) add('error', 'Place a supplier or a port: it is where goods enter the network.');
    if (!of('warehouse').length) add('error', 'Place a warehouse: stores and customers are served from warehouses.');
    if (!of('demand').length) add('error', 'Place a store, a dark store or a customer area: it is where the demand is.');
    // Hours that cannot be kept.
    for (const pin of pins) {
        for (const kind of kindsFor(pin.role)) {
            const issue = calendarProblem(calendarOf(pin, kind), pin.name, kind);
            if (issue) add('error', issue, [pin.id]);
        }
    }
    const named = new Map();
    for (const pin of pins) named.set(pin.name, [...(named.get(pin.name) ?? []), pin.id]);
    for (const [name, ids] of named) if (ids.length > 1) add('error', `Two sites are named ${name}: give each its own name.`, ids);
    for (const link of links) {
        const problem = linkProblem(byId.get(link.from), byId.get(link.to));
        if (problem) add('error', problem, [link.from, link.to].filter((id) => byId.has(id)));
        else if (catalogue) {
            const [from, to] = [byId.get(link.from), byId.get(link.to)];
            const kind = linkKind(from.role, to.role);
            const vehicleIssue = linkVehicleProblem(vehiclesOf(link, kind, catalogue), kind, catalogue, { from: from.name, to: to.name });
            if (vehicleIssue) add('error', vehicleIssue, [from.id, to.id]);
        }
    }
    for (const type of catalogue ?? []) {
        const issue = vehicleProblem(type);
        if (issue) add('error', issue);
    }
    if (categories) {
        const issue = categoriesProblem(categories);
        if (issue) add('error', issue);
        // Chilled goods go by refrigerated vehicles: with none that may go where they must, the model cannot be built.
        const chilled = categories.filter((category) => category.chilled);
        if (catalogue && chilled.length) {
            for (const kind of ['supply', 'store']) {
                if (carriersFor([], kind, catalogue, true).length) continue;
                add('error', `${chilled.map((category) => category.name).join(' and ')} ${chilled.length === 1 ? 'needs' : 'need'} a refrigerated vehicle${kind === 'store' ? ' that may deliver to stores' : ''}, and no vehicle type is one. Tick Refrigerated on a vehicle type, or add one.`);
                break;
            }
        }
    }
    const into = (pin) => links.filter((link) => link.to === pin.id && byId.has(link.from));
    const outOf = (pin) => links.filter((link) => link.from === pin.id && byId.has(link.to));
    for (const pin of of('demand')) if (!into(pin).length) add('error', `${pin.name} has no warehouse linked to it. Drag a link from a warehouse to it.`, [pin.id]);
    // A warehouse restocked by others in a circle has nowhere to start from: one of the links must be a backup.
    const standing = links.filter((link) => !link.backup && kindOf(byId.get(link.from)?.role) === 'warehouse' && kindOf(byId.get(link.to)?.role) === 'warehouse');
    const feeds = (from, to, seen = new Set()) => from === to || (!seen.has(from) && seen.add(from) && standing.some((link) => link.from === from && feeds(link.to, to, seen)));
    const circle = standing.find((link) => feeds(link.to, link.from));
    if (circle) add('error', `${byId.get(circle.from).name} and ${byId.get(circle.to).name} restock each other in a circle: make one of those links a backup, or delete it.`, [circle.from, circle.to]);
    for (const pin of of('warehouse')) {
        // A backup link carries nothing in the baseline: it is no supply.
        if (outOf(pin).length && !into(pin).some((link) => !link.backup)) add('error', `${pin.name} has no supplier, port or warehouse that restocks it. Drag a link from one to it.`, [pin.id]);
        if (!outOf(pin).length) add('warning', `${pin.name} serves no store or customer area, so it is left out of the model.`, [pin.id]);
    }
    for (const pin of of('source')) {
        const served = outOf(pin).filter((link) => outOf(byId.get(link.to)).length);
        if (!served.length) add(pin.role === 'port' ? 'warning' : 'error', `${pin.name} supplies no warehouse that serves anyone${pin.role === 'port' ? ': it is kept as a port cargo can be diverted to, with no lanes' : '. Link it to a warehouse, or delete it'}.`, [pin.id]);
    }
    return problems;
}

// What the importer builds from: the pins as the region builder's selection (by the candidate a pin was adopted from,
// so the importer reads its sourced data again), the links with their legs and vehicles, and the vehicle catalogue.
// `paths: false` leaves the supply links' roads out, when they would be more than the host accepts in one request: the
// lanes are then drawn straight. With no `catalogue`, links carry no vehicles and the model runs on two truck sizes.
export function networkSelection(allPins, allLinks, { paths = true, catalogue = null, categories = null, open = [] } = {}) {
    // Candidates are left out, and their links with them, but those opened for a comparison (`open`, by pin id).
    const { pins, links } = openNetwork(allPins, allLinks, open);
    const selection = { ports: [], zones: [], towns: [] };
    const byId = new Map(pins.map((pin) => [pin.id, pin]));
    const siteId = (pin) => pin.candidate?.id ?? pin.id;
    for (const pin of pins) {
        const entry = { id: siteId(pin), pin: pin.id, role: pin.role, name: pin.name, lat: pin.lat, lon: pin.lon };
        const field = (key) => pin.fields?.[key];
        // A figure set, with where it came from: `name` and `nameBasis` on the entry.
        const carry = (key, name) => { if (field(key)?.value > 0) Object.assign(entry, { [name]: field(key).value, [`${name}Basis`]: field(key).basis }); };
        if (pin.role === 'supplier') {
            Object.assign(entry, { supplier: true, teuPerDay: field('supply').value, teuPerDayBasis: field('supply').basis });
            carry('makes', 'makes');
        }
        // The hours it keeps, where it keeps any.
        Object.assign(entry, hoursForModel(pin));
        // Its own mix of categories, and a supplier's own lead times: nothing when it takes the usual.
        if (categories && hasMix(pin.role)) Object.assign(entry, mixForModel(pin, categories));
        if (pin.role === 'port') carry('teuPerDay', 'teuPerDay');
        if (pin.role === 'warehouse') {
            if (field('floorArea')?.value > 0) Object.assign(entry, { floorAreaSquareMetres: field('floorArea').value, floorAreaBasis: field('floorArea').basis });
            carry('holdingCost', 'holdingCost');
        }
        if (pin.role === 'warehouse' || pin.role === 'store' || pin.role === 'darkStore') {
            carry('capacity', 'capacity');
            carry('cover', 'coverDays');
        }
        if (pin.role === 'store' || pin.role === 'darkStore') {
            // A share lost: 0 is a figure here, so it is carried whatever it is, as a fraction.
            if (field('lostSales')?.value >= 0) Object.assign(entry, { lostShare: field('lostSales').value / 100, lostShareBasis: field('lostSales').basis });
            carry('saleValue', 'saleValue');
        }
        if (kindOf(pin.role) === 'demand') {
            if (field('demand')?.value > 0) Object.assign(entry, { teuPerDay: field('demand').value, teuPerDayBasis: field('demand').basis });
            if (field('population')?.value > 0) Object.assign(entry, { population: field('population').value, populationBasis: field('population').basis === 'user' ? 'user' : field('population').basis === 'sourced' ? 'OpenStreetMap' : 'assumed' });
        }
        selection[groupOfRole[pin.role]].push(entry);
    }
    const usable = links.filter((link) => byId.has(link.from) && byId.has(link.to) && !linkProblem(byId.get(link.from), byId.get(link.to)));
    // A supply link's road is drawn on the map as its lane's corridor (as [lat, lon] pairs, which are smaller to send);
    // a link to a store needs only its time and distance.
    // A link's own time, door to door, when the user gave one (see travelTimes.mjs).
    const leg = (link, withPath) => (link.leg ? {
        kilometres: link.leg.kilometres, hours: link.leg.hours, basis: link.leg.basis, ...(link.time?.hours > 0 ? { own: link.time } : {}),
        path: withPath && paths && link.leg.path?.points?.length ? { points: link.leg.path.points.map((point) => [point.lat, point.lon]) } : null
    } : null);
    const vehicles = (link) => {
        if (!catalogue) return {};
        const carried = vehiclesOf(link, linkKind(byId.get(link.from).role, byId.get(link.to).role), catalogue);
        return carried.length ? { vehicles: carried } : {};
    };
    return {
        selection,
        links: {
            supply: usable.filter((link) => kindOf(byId.get(link.from).role) === 'source').map((link) => ({ port: siteId(byId.get(link.from)), zone: siteId(byId.get(link.to)), leg: leg(link, true), ...(link.basis === 'user' ? { user: true } : {}), ...vehicles(link) })),
            serve: usable.filter((link) => kindOf(byId.get(link.from).role) === 'warehouse' && kindOf(byId.get(link.to).role) === 'demand').map((link) => ({ zone: siteId(byId.get(link.from)), town: siteId(byId.get(link.to)), leg: leg(link, false), ...vehicles(link) })),
            // Between warehouses: a standing link with its share of what the one it leads to needs (nothing: an even
            // share), or a backup.
            transfer: usable.filter((link) => kindOf(byId.get(link.from).role) === 'warehouse' && kindOf(byId.get(link.to).role) === 'warehouse').map((link) => ({
                from: siteId(byId.get(link.from)), to: siteId(byId.get(link.to)), leg: leg(link, true), ...vehicles(link),
                ...(link.backup ? { backup: true } : Number(link.share) > 0 ? { share: Math.min(1, Number(link.share) / 100) } : {})
            }))
        },
        ...(catalogue ? { vehicles: catalogueForModel(catalogue), unit } : {}),
        ...(catalogue && categories ? { categories: categoriesForModel(categories) } : {})
    };
}

// A suggestion from public data, adopted as a pin: a port, a warehouse estate or a town keeps what was found.
export function pinFromCandidate(candidate, group, pins) {
    const role = { ports: 'port', zones: 'warehouse', towns: 'customerArea' }[group];
    const fields = {};
    if (group === 'zones' && candidate.floorAreaSquareMetres > 0) fields.floorArea = { value: Math.round(candidate.floorAreaSquareMetres), basis: 'sourced' };
    if (group === 'towns' && candidate.population > 0) fields.population = { value: candidate.population, basis: candidate.populationBasis === 'OpenStreetMap' ? 'sourced' : 'assumed' };
    return createPin(role, candidate, { id: `pin:${candidate.id}`, name: candidate.name, pins, fields, basis: 'sourced', source: 'OpenStreetMap', candidate });
}

// Pins and links from a file of sites (parseSites's answer): every site is the user's, linked as its `from` column says.
// `categories` (the network's catalogue) turn a site's mix and a supplier's lead times, given by category name, into
// the site's own; a category the network does not have is said, and left out.
export function networkFromSites(sites, pins = [], categories = []) {
    const categoryNamed = new Map(categories.map((category) => [category.name.trim().toLowerCase(), category]));
    const unknown = [];
    const byCategory = (site, values) => {
        const known = {};
        for (const [name, value] of Object.entries(values ?? {})) {
            const category = categoryNamed.get(name.trim().toLowerCase());
            if (category) known[category.id] = value;
            else unknown.push(`${site.name} names the category "${name}", which this network does not have: add it under Categories and load the file again, or it is left out.`);
        }
        return known;
    };
    const added = [];
    for (const site of [...sites.ports, ...sites.zones, ...sites.towns]) {
        const role = site.role ?? { port: 'port', zone: 'warehouse', town: 'customerArea' }[site.kind];
        const fields = {};
        if (site.teuPerDay > 0) fields[role === 'supplier' ? 'supply' : role === 'port' ? 'teuPerDay' : 'demand'] = site.teuPerDay;
        if (site.floorAreaSquareMetres > 0) fields.floorArea = site.floorAreaSquareMetres;
        if (site.population > 0) fields.population = site.population;
        if (site.capacity > 0) fields.capacity = site.capacity;
        if (site.coverDays > 0) fields.cover = site.coverDays;
        if (site.makes > 0) fields.makes = site.makes;
        const pin = createPin(role, site, { name: site.name, pins: [...pins, ...added.map((item) => item.pin)], fields, source: 'your sites' });
        // A mix names the categories the site carries: one it leaves out, it does not carry.
        const mix = byCategory(site, site.mix);
        if (Object.values(mix).some((weight) => weight > 0)) pin.mix = Object.fromEntries(categories.map((category) => [category.id, mix[category.id] ?? 0]));
        const lead = Object.fromEntries(Object.entries(byCategory(site, site.leadDaysBy)).filter(([, days]) => days > 0));
        if (Object.keys(lead).length) pin.leadDays = lead;
        added.push({ site, pin });
    }
    const all = [...pins, ...added.map((item) => item.pin)];
    const byName = new Map(all.map((pin) => [pin.name, pin]));
    const links = [];
    const problems = [...unknown];
    for (const { site, pin } of added) {
        for (const name of site.from ?? []) {
            const from = byName.get(name);
            if (!from) { problems.push(`${pin.name} is supplied from "${name}", which is not a site in the file or on the map.`); continue; }
            const problem = linkProblem(from, pin);
            if (problem) { problems.push(problem); continue; }
            links.push({ id: linkId(from.id, pin.id), from: from.id, to: pin.id, basis: 'user' });
        }
    }
    return { pins: added.map((item) => item.pin), links, problems };
}
