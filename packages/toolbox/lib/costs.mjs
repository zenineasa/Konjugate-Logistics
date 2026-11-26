/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How these costs are worked out: for every cost a result reports, the rule it follows in words, the inputs it uses
// with their values and where each came from, and where each is set; and what the costs leave out.
//
// Nothing here estimates anything. The values are the model's as built (its provenance, its lanes and its stores, as
// `regionModel.mjs` records them), which are what a run used; the rules are the component templates' equations
// (`packages/engine/components`) and the summary's sums (`summariseRun` in `toolbox.mjs`, `siteComparison.mjs`),
// said in words. A site's fixed cost and cost to open are not in the model: they come from the sites' cards.

import { isCandidate } from './network.mjs';

// The costs a result reports, in the order it shows them: the summary's money figures (each a { baseline, scenario }
// pair in a result's `totals`, the running cost their sum) and the candidate site comparison's.
export const reportedCosts = [
    { key: 'transport', label: 'Transport cost', in: 'totals' },
    { key: 'fleet', label: 'Fleet cost', in: 'totals' },
    { key: 'holding', label: 'Holding cost', in: 'totals' },
    { key: 'running', label: 'Running cost', in: 'totals' },
    { key: 'lostValue', label: 'Value of sales lost', in: 'totals' },
    { key: 'backlog', label: 'Backlog cost', in: 'totals' },
    { key: 'monthly', label: 'Cost a month', in: 'sites' },
    { key: 'fixed', label: 'Fixed cost', in: 'sites' },
    { key: 'opening', label: 'Cost to open', in: 'sites' }
];

// What the costs leave out, from the limits the docs state (handover.md, direction.md): said plainly, so a figure is
// not read as more than it is.
export const notIncluded = [
    'Congestion: roads never slow with traffic, so a busy road costs no more a kilometre than an empty one.',
    'Drivers as people: a vehicle\'s cost per day stands for its driver, and its hours for their shifts; no overtime, rest rules or rosters.',
    'Changes in prices: a cost per km (fuel, tyres) and a cost per day hold for the whole run.',
    'What the goods cost to buy or make: the value of sales lost is what the sales would have brought, not a margin.',
    'Handling: loading, unloading and picking cost nothing beyond the time they take.',
    'Deliveries to a customer area: they stand for a parcel or courier service, with no vehicles and no cost.',
    'Ports and suppliers: berths, anchorage and making cost nothing in the model.',
    'Goods wasted past their shelf life: counted in pallets, not priced.',
    'Fixed costs and the cost to open a site: not in the model; counted only when candidate sites are compared.',
    'Anything after the run ends, or before the scenario starts: costs are counted from the scenario\'s first day to the run\'s last.'
];

const basisWords = { user: 'yours', sourced: 'sourced', routed: 'routed', assumed: 'assumed', synthetic: 'synthetic', estimated: 'assumed', none: 'none' };
export const basisWord = (basis) => basisWords[basis] ?? 'assumed';

// A site's name from a node or entity of one category's copy ("Warehouse 1: Chilled"), given the network's sites.
function siteOf(entity, siteNames) {
    if (siteNames.has(entity)) return entity;
    const at = entity.lastIndexOf(': ');
    return at > 0 && siteNames.has(entity.slice(0, at)) ? entity.slice(0, at) : entity;
}

// `built`: the model as built (the window's `state.built`). `network`: the window's inputs, to say where each is set:
// { pins, links, vehicles (the catalogue), categories }. `result`: the run shown (a summary, with `totals`, `start`,
// `days`, `describe`, `absolute`), or null; `compared`: the run set beside it ({ number, describe, totals, builtAt }),
// or null; `sites`: the candidate comparison (`state.siteComparison`), or null. `builtAgain`: the model was built
// again after the run shown; `edited`: the network was changed after it was built.
export function explainCosts({ built, network = {}, result = null, compared = null, sites = null, builtAgain = false, edited = false }) {
    if (!built) return null;
    const { pins = [], links = [], vehicles = [], categories = [] } = network;
    const provenance = built.provenance ?? [];
    const lanes = built.lanes ?? [];
    const stores = built.stores ?? [];
    const siteNames = new Set(pins.map((pin) => pin.name));
    const pinNamed = (name) => pins.find((pin) => pin.name === name) ?? null;
    const at = (entity, parameter) => provenance.find((entry) => entry.entity === entity && entry.parameter === parameter) ?? null;
    const modelWide = (pattern) => provenance.find((entry) => entry.entity === 'Every component' && pattern.test(entry.parameter)) ?? null;
    const siteTarget = (name, field) => (pinNamed(name) ? { kind: 'site', id: pinNamed(name).id, field } : null);
    const linkTarget = (from, to) => {
        const [a, b] = [pinNamed(from), pinNamed(to)];
        const link = a && b ? links.find((each) => each.from === a.id && each.to === b.id) : null;
        return link ? { kind: 'link', id: link.id } : null;
    };
    const vehicleTarget = (name) => {
        const type = vehicles.find((each) => each.name === name);
        return type ? { kind: 'vehicle', id: type.id } : null;
    };
    const categoryTarget = (id) => (categories.some((each) => each.id === id) ? { kind: 'category', id } : null);
    const categoryName = (id) => built.categories?.find((each) => each.id === id)?.name ?? categories.find((each) => each.id === id)?.name ?? id;
    const unit = built.unit === 'TEU' ? 'TEU' : 'pallet';
    const entry = (name, value, valueUnit, basis, target = null, note = '') => ({ name, value, unit: valueUnit, basis: basisWord(basis), target, ...(note ? { note } : {}) });

    // ---- the vehicles: each type's costs, and how many of it the build put on its links.
    const working = lanes.filter((lane) => !lane.standby);
    const typeInputs = [];
    const typeNames = built.vehicles ? built.vehicles.map((type) => type.name) : [];
    for (const name of typeNames) {
        const perKm = at(name, 'Cost per km');
        const perDay = at(name, 'Cost per day');
        if (!perKm && !perDay) continue;
        const count = working.reduce((sum, lane) => sum + (lane.vehicles ?? []).filter((item) => item.name === name).reduce((all, item) => all + (Number(item.fleet) || 0), 0), 0);
        typeInputs.push({ name, perKm, perDay, count: Math.round(count * 1000) / 1000, target: vehicleTarget(name) });
    }
    // A model with no vehicle catalogue (the earlier workflow) runs on two truck sizes, the operator's or the library's.
    const truckSizes = built.vehicles ? [] : provenance.filter((item) => /^(Truck cost per km|Cost per km|Cost per truck per day)/.test(item.parameter));

    // ---- the links: one row a link, however many categories it carries; its distance as the model has it.
    const byLink = new Map();
    for (const lane of lanes) {
        const key = lane.link ?? lane.name;
        const types = (lane.vehicles ?? []).map((item) => item.name);
        if (byLink.has(key)) { byLink.get(key).types = [...new Set([...byLink.get(key).types, ...types])]; continue; }
        const distance = at(lane.name, 'Distance');
        byLink.set(key, {
            name: `${lane.fromSite ?? lane.from} → ${lane.site ?? lane.to}`, value: distance?.value ?? lane.kilometres, basis: distance?.basis ?? lane.basis,
            standby: Boolean(lane.standby), mode: lane.mode ?? 'road', target: linkTarget(lane.fromSite, lane.site),
            types: [...new Set(types)]
        });
    }
    const distances = [...byLink.values()];

    // ---- holding: every warehouse and maker's store and every store's stock room, at the holding cost parameter the model
    // links it to (`built.holding`), and whose figure that is: its own, or the one every stock without a figure of its
    // own shares. A session built before that record falls back on the provenance.
    const holdingWide = modelWide(/^Holding cost per/);
    const ownNote = (name) => provenance.find((item) => item.parameter === 'Holding cost' && siteOf(item.entity, siteNames) === name) ?? null;
    const storeSites = [...new Set(stores.map((item) => item.site))];
    const holdingInputs = [];
    if (Array.isArray(built.holding)) {
        // One row a site (its category copies are linked alike), the stores' stock rooms together where they agree.
        const bySite = new Map();
        for (const item of built.holding) if (!bySite.has(item.site)) bySite.set(item.site, item);
        const linked = (item) => (item.from === item.site
            ? { basis: ownNote(item.site)?.basis ?? 'user', note: '' }
            : { basis: holdingWide?.basis ?? 'assumed', note: 'The figure every stock without one of its own shares, a default.' });
        for (const item of [...bySite.values()].filter((each) => !each.store)) {
            const how = linked(item);
            holdingInputs.push(entry(item.site, item.value, `a ${unit} a day`, how.basis, siteTarget(item.site, 'holdingCost'), how.note));
        }
        const rooms = new Map();
        for (const item of [...bySite.values()].filter((each) => each.store)) {
            const key = `${item.value}|${item.from ?? ''}`;
            if (!rooms.has(key)) rooms.set(key, { ...item, sites: [] });
            rooms.get(key).sites.push(item.site);
        }
        for (const group of rooms.values()) {
            const how = linked(group);
            holdingInputs.push(entry(`Stock room${group.sites.length === 1 ? '' : 's'} of ${listedNames(group.sites)}`, group.value, `a ${unit} a day`, how.basis, null,
                `${how.note ? `${how.note} ` : ''}A store's card has no holding cost of its own.`));
        }
    } else {
        const holders = [...new Set(lanes.filter((lane) => lane.kind !== 'store').map((lane) => siteOf(lane.site ?? lane.to, siteNames)))];
        for (const name of holders) {
            const own = ownNote(name);
            holdingInputs.push(own
                ? entry(name, own.value, `a ${unit} a day`, own.basis, siteTarget(name, 'holdingCost'))
                : entry(name, holdingWide?.value ?? null, `a ${unit} a day`, holdingWide?.basis ?? 'assumed', siteTarget(name, 'holdingCost'), 'As the model records it; built before the toolbox said which figure each stock is linked to: build again to see.'));
        }
        if (storeSites.length) {
            holdingInputs.push(entry(`Stock rooms of ${listedNames(storeSites)}`, holdingWide?.value ?? null, `a ${unit} a day`, holdingWide?.basis ?? 'assumed', null,
                'As the model records it; built before the toolbox said which figure each stock is linked to: build again to see. A store\'s card has no holding cost of its own.'));
        }
    }

    // ---- sales lost: by store, the share lost when short and the value of a pallet sold (a category's, where it has one).
    const lostInputs = [];
    const valueInputs = [];
    for (const site of storeSites) {
        const copies = stores.filter((item) => item.site === site);
        const lostNote = copies.map((item) => at(item.name, 'Sales lost when out of stock') ?? at(item.name, 'Orders lost when out of stock')).find(Boolean);
        lostInputs.push(entry(site, copies[0].lostShare * 100, '%', lostNote?.basis ?? 'assumed', siteTarget(site, 'lostSales')));
        // One row a store when its categories share its value, else one a category.
        const priced = copies.map((item) => {
            const ofCategory = item.category ? at(item.name, 'Value of a pallet sold') : null;
            return { item, value: item.saleValue, basis: ofCategory ? ofCategory.basis : item.saleValueBasis, byCategory: Boolean(ofCategory) };
        });
        const same = priced.every((each) => each.value === priced[0].value && each.basis === priced[0].basis && each.byCategory === priced[0].byCategory);
        if (same && !priced[0].byCategory) valueInputs.push(entry(site, priced[0].value, `a ${unit}`, priced[0].basis, siteTarget(site, 'saleValue')));
        else {
            for (const each of priced) {
                valueInputs.push(entry(`${site}, ${categoryName(each.item.category)}`, each.value, `a ${unit}`, each.basis,
                    each.byCategory ? { ...categoryTarget(each.item.category), field: 'saleValue' } : siteTarget(site, 'saleValue'), each.byCategory ? `${categoryName(each.item.category)}'s value, at every store.` : ''));
            }
        }
    }
    const backlogWide = modelWide(/^Backlog cost per/);

    // ---- the candidate sites: fixed costs and costs to open, from the cards (not in the model).
    const warehouses = pins.filter((pin) => pin.role === 'warehouse');
    const figure = (pin, key) => (Number(pin.fields?.[key]?.value) > 0 ? { value: Number(pin.fields[key].value), basis: pin.fields[key].basis ?? 'user' } : null);
    const fixedInputs = warehouses.map((pin) => {
        const given = figure(pin, 'fixedCost');
        return given ? entry(pin.name, given.value, 'a month', given.basis, { kind: 'site', id: pin.id, field: 'fixedCost' }, isCandidate(pin) ? 'A candidate.' : '')
            : entry(pin.name, null, 'a month', 'none', { kind: 'site', id: pin.id, field: 'fixedCost' }, 'None given: counts for nothing.');
    });
    const openingInputs = warehouses.filter(isCandidate).map((pin) => {
        const given = figure(pin, 'openingCost');
        return given ? entry(pin.name, given.value, 'once', given.basis, { kind: 'site', id: pin.id, field: 'openingCost' })
            : entry(pin.name, null, 'once', 'none', { kind: 'site', id: pin.id, field: 'openingCost' }, 'None given: its payback cannot be worked out.');
    });

    // ---- the figures each cost came to, in the run shown and the run set beside it.
    const pair = (key) => {
        const totals = result?.totals;
        if (!totals) return null;
        if (key === 'running') return ['transport', 'fleet', 'holding'].reduce((sum, part) => ({ baseline: sum.baseline + (totals[part]?.baseline ?? 0), scenario: sum.scenario + (totals[part]?.scenario ?? 0) }), { baseline: 0, scenario: 0 });
        return totals[key] ?? null;
    };
    const besideOf = (key) => {
        const totals = compared?.totals;
        if (!totals) return null;
        if (key === 'running') return ['transport', 'fleet', 'holding'].reduce((sum, part) => sum + (totals[part]?.scenario ?? 0), 0);
        return totals[key]?.scenario ?? null;
    };
    const figures = (key) => {
        const shown = pair(key);
        if (!shown) return null;
        return { scenario: shown.scenario, ...(result.absolute ? {} : { baseline: shown.baseline }), ...(besideOf(key) !== null ? { compared: besideOf(key) } : {}) };
    };

    const transportInputs = [
        ...typeInputs.filter((type) => type.perKm).map((type) => entry(`${type.name}: cost per km`, type.perKm.value, 'a km', type.perKm.basis, type.target && { ...type.target, field: 'costPerKm' })),
        ...truckSizes.filter((item) => /per km/.test(item.parameter)).map((item) => entry(item.parameter, item.value, 'a km', item.basis, null, item.entity === 'Every component' ? 'The model-wide figure.' : item.detail)),
        ...distances.map((link) => entry(`${link.name}: distance`, link.value, 'km', link.basis, link.target,
            [link.mode !== 'road' ? `By ${link.mode}.` : '', link.types.length ? `Carried by ${link.types.map((type) => `${type.toLowerCase()}s`).join(' and ')}.` : '', link.standby ? 'On standby: no trips unless a scenario sends goods over it.' : ''].filter(Boolean).join(' ')))
    ];
    const fleetInputs = [
        ...typeInputs.filter((type) => type.perDay).map((type) => entry(`${type.name}: cost per day`, type.perDay.value, 'a day', type.perDay.basis, type.target && { ...type.target, field: 'costPerDay' }, `${type.count} on the links as built.`)),
        ...truckSizes.filter((item) => /per day/.test(item.parameter)).map((item) => entry(item.parameter, item.value, 'a day', item.basis, null, item.entity === 'Every component' ? 'The model-wide figure.' : item.detail))
    ];

    const costs = [
        {
            key: 'transport', how: 'Every trip a vehicle makes on a link is charged, when it arrives, twice the link\'s distance (there loaded, back empty) at its type\'s cost per km. Transport cost = trips × 2 × distance × cost per km, added up over every link and vehicle type. Trains and barges are vehicle types like trucks. A trip still on its way when the run ends is not counted; one that arrived has its way back counted already.',
            inputs: transportInputs
        },
        {
            key: 'fleet', how: 'Every vehicle on a link, loaded, on its way back or idle, is charged its type\'s cost per day for every day it is there. Fleet cost = vehicles × days × cost per day, added up over every link. With several categories a link\'s vehicles are shared among them by what each needs; the counts below add the shares up. A scenario that hires vehicles adds their days from when they come; one that cuts a fleet lets only idle vehicles go.',
            inputs: fleetInputs
        },
        {
            key: 'holding', how: `Every ${unit} in stock at a warehouse, a maker's store or a store's stock room is charged that site's holding cost for every day it is there. Holding cost = ${unit}s in stock × days × holding cost a ${unit} a day. Goods on the road, at a port or at a supplier are not charged.`,
            inputs: holdingInputs
        },
        {
            key: 'running', how: 'Running cost = transport cost + fleet cost + holding cost. It leaves out the value of sales lost and the backlog cost, which are shown on their own.',
            inputs: []
        },
        {
            key: 'lostValue', how: `When a store's stock cannot meet what its shoppers ask for, its share "Sales lost when out" of the shortfall is lost (they buy elsewhere) and the rest waits for a delivery. Value of sales lost = ${unit}s lost × value of a ${unit} sold: a category's value where it has one, else the store's. It is what the sales would have brought, not a margin or a profit.`,
            inputs: [...lostInputs.map((item) => ({ ...item, name: `${item.name}: sales lost when out` })), ...valueInputs.map((item) => ({ ...item, name: `${item.name}: value of a ${unit} sold` }))]
        },
        {
            key: 'backlog', how: `Every ${unit} ordered and not yet delivered (shoppers waiting at a store, orders waiting at a customer area) is charged the backlog cost for every day it waits. Backlog cost = ${unit}s waiting × days × backlog cost a ${unit} a day. A measure of service, not money spent: it is not in the running cost.`,
            inputs: backlogWide ? [entry('Backlog cost', backlogWide.value, `a ${unit} a day`, backlogWide.basis, null, 'The model-wide figure: not set in the window.')] : []
        },
        {
            key: 'monthly', how: 'Each network compared is built and run on its own over the same days. Cost a month = (transport + fleet + holding cost in normal weeks) ÷ days run × 30 + the fixed costs of its open warehouses. A month is 30 days of the run, not a forecast of a real month.',
            inputs: []
        },
        {
            key: 'fixed', how: 'The fixed costs a month you gave the warehouses open in that network, added as they are: rent and staff do not depend on what a site handles, so they are not in the model.',
            inputs: fixedInputs
        },
        {
            key: 'opening', how: 'A candidate\'s cost to open, once. It is earned back after cost to open ÷ what the candidate saves a month in normal weeks (or ÷ what one disruption costs less with it), when it saves anything.',
            inputs: openingInputs
        }
    ].map((cost) => ({ ...cost, label: reportedCosts.find((item) => item.key === cost.key).label, in: reportedCosts.find((item) => item.key === cost.key).in, figures: cost.key === 'monthly' || cost.key === 'fixed' || cost.key === 'opening' ? null : figures(cost.key) }));

    // ---- what the figures are of.
    const notes = [];
    if (result) {
        notes.push(`Counted from day ${round(result.start)} to the end of the run, ${round(result.days)} days.`);
        if (result.absolute) notes.push('The network as planned: one run, nothing to set it against.');
        else notes.push(`The baseline and the scenario follow the same rules on the same inputs, apart from what the scenario changed: ${result.describe ?? 'see above'}`);
    }
    if (compared) notes.push(`Run ${compared.number} ${compared.sameBuild === false ? 'ran on the network as it was built then: its inputs may differ from these.' : 'ran on the same build, so on these inputs, apart from what its scenario changed.'}`);
    if (builtAgain) notes.push('The network was built again after this run: the inputs below are the model\'s as built now, and may differ from those this run used.');
    else if (edited) notes.push('You changed the network after it was built: the inputs below are the model\'s as built, which this run used; the cards may now say otherwise.');
    const shownSites = Boolean(sites?.rows?.length) || warehouses.some(isCandidate);
    return {
        notes,
        costs: costs.filter((cost) => cost.in === 'totals' || shownSites),
        notIncluded,
        knownLimits: [
            ...(storeSites.length ? ['A store or a dark store has no holding cost of its own: its stock room is charged the figure every stock without one of its own shares, shown under Holding cost.'] : []),
            ...(storeSites.length ? ['A store\'s own value of a pallet sold is not yet in the model\'s record of where its inputs came from: the values shown are those the summary prices sales lost at.'] : [])
        ]
    };
}

// Names as a sentence lists them: "A", "A and B", "A, B and C".
const listedNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const round = (value) => Number(value).toLocaleString('en', { maximumFractionDigits: 1 });
