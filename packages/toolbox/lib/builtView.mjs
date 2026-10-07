/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A built model as the user thinks of it: sites and links. A network with product categories is built as one copy of
// itself for each category (regionModel.mjs), so a link is a lane for each category it carries and a store a stock room
// and its shoppers for each category it sells. The window chooses, describes and draws by site and by link; this module
// adds a build's copies up into those (`siteView`), adds a run's series up the same way (`mergeSeries`), and spreads a
// scenario chosen for a link, a port or a store over its copies (`closureAcross`, `affectedAcross`, `diversionAcross`).
//
// A model of goods of one kind, or a build saved before categories, is its own view: every site and link has one copy,
// itself.

import { closurePlan, diversionPlan, keptOutPlan } from './scenarios.mjs';

const tidy = (value) => Number(value.toFixed(9));
// Signals that are a level or a share of something, not an amount: a link's or a site's is its categories' highest.
const highest = new Set(['waitDays', 'utilisation', 'spaceUsed']);

export function siteView(built) {
    const categories = built.categories?.length > 1 ? built.categories : null;
    const categoryName = new Map((built.categories ?? []).map((category) => [category.id, category.name]));
    // What each site-level name stands for in the model: the nodes of its copies.
    const members = new Map();
    const siteOf = new Map();
    const join = (name, member) => {
        if (!members.has(name)) members.set(name, []);
        if (!members.get(name).includes(member)) members.get(name).push(member);
        siteOf.set(member, name);
    };
    const grouped = (items, nameOf, start, add) => {
        const byName = new Map();
        for (const item of items ?? []) {
            const name = nameOf(item);
            if (!byName.has(name)) byName.set(name, start(item, name));
            add(byName.get(name), item);
            byName.get(name).members.push(item);
        }
        return [...byName.values()];
    };
    const lanes = grouped(built.lanes, (lane) => lane.link ?? lane.name,
        (lane, name) => {
            const to = lane.link === undefined ? lane.to : lane.kind === 'store' ? `${lane.site} stock` : lane.site;
            return { ...lane, name, from: lane.fromSite ?? lane.from, to, category: null, rate: 0, fleet: 0, fleet2: 0, standby: true, ...(lane.vehicles ? { vehicles: [] } : {}), members: [] };
        },
        (whole, lane) => {
            join(whole.name, lane.name);
            join(whole.to, lane.to);
            join(whole.from, lane.from);
            whole.rate += lane.rate;
            whole.fleet = tidy(whole.fleet + lane.fleet);
            whole.fleet2 = tidy(whole.fleet2 + (lane.fleet2 ?? 0));
            whole.standby = whole.standby && Boolean(lane.standby);
            for (const item of lane.vehicles ?? []) {
                const same = whole.vehicles.find((other) => other.type === item.type);
                if (same) Object.assign(same, { fleet: tidy(same.fleet + item.fleet), user: same.user || item.user });
                else whole.vehicles.push({ ...item });
            }
        });
    const ports = grouped(built.ports, (port) => port.site ?? port.name,
        (port, name) => ({ ...port, name, category: null, arrivals: 0, berths: 0, usual: null, schedule: null, members: [] }),
        (whole, port) => {
            join(whole.name, port.name);
            whole.arrivals += port.arrivals;
            whole.berths += port.berths;
            if (port.usual !== null && port.usual !== undefined) whole.usual = (whole.usual ?? 0) + port.usual;
            // Its copies follow the same days of the same history, each its share of it.
            if (port.schedule) whole.schedule = whole.schedule ? whole.schedule.map(([time, value], index) => [time, value + (port.schedule[index]?.[1] ?? 0)]) : port.schedule.map((sample) => [...sample]);
        });
    const towns = grouped(built.towns, (town) => town.site ?? town.name,
        (town, name) => ({ ...town, name, category: null, demand: 0, members: [] }),
        (whole, town) => { join(whole.name, town.name); whole.demand += town.demand; });
    const stores = built.stores ? grouped(built.stores, (item) => item.site ?? item.name,
        (item, name) => ({ ...item, name, category: null, stock: item.site === undefined ? item.stock : `${name} stock`, demand: 0, members: [] }),
        (whole, item) => { join(whole.name, item.name); join(whole.stock, item.stock); whole.demand += item.demand; })
        .map((whole) => ({ ...whole, members: whole.members.map((item) => ({ ...item, categoryName: categoryName.get(item.category) ?? null })) })) : built.stores;
    const demandOf = new Map(towns.map((town) => [town.name, town.demand]));
    const served = grouped(built.served, (item) => `${item.town}|${item.zone}`,
        (item) => ({ ...item, category: null, demand: 0, members: [] }),
        (whole, item) => { whole.demand += item.demand; })
        .map(({ members: _, ...item }) => ({ ...item, share: demandOf.get(item.town) > 0 ? item.demand / demandOf.get(item.town) : item.share }));
    return {
        categories, lanes, ports, towns, stores, served, members,
        // The site or link a node of the model is a copy of.
        siteOf: (name) => siteOf.get(name) ?? name,
        rawLanes: (link) => lanes.find((lane) => lane.name === link)?.members ?? [],
        rawPorts: (site) => ports.find((port) => port.name === site)?.members ?? [],
        rawTowns: (site) => towns.find((town) => town.name === site)?.members ?? []
    };
}

// A run's series ({ [node]: { [signal]: [[seconds, value], ...] } }) by site and link: amounts added up over a site's
// copies, levels and shares at their highest.
export function mergeSeries(series, view) {
    if (!view.categories) return series;
    const merged = {};
    for (const [name, raw] of view.members) {
        const parts = raw.map((node) => series[node]).filter(Boolean);
        if (!parts.length) continue;
        merged[name] = {};
        for (const signal of new Set(parts.flatMap((part) => Object.keys(part)))) {
            const lists = parts.map((part) => part[signal]).filter((list) => list?.length);
            if (!lists.length) continue;
            const pick = highest.has(signal) ? (values) => Math.max(...values) : (values) => values.reduce((sum, value) => sum + value, 0);
            merged[name][signal] = lists[0].map((point, index) => [point[0], pick(lists.map((list) => list[index]?.[1] ?? 0))]);
        }
    }
    return merged;
}

// Several plans' supplied paths as one: per parameter, every plan's entities and samples.
export function mergeSupplied(list) {
    const merged = {};
    for (const supplied of list) {
        for (const [key, { entities, samples }] of Object.entries(supplied)) {
            merged[key] ??= { entities: [], samples: {} };
            for (const entity of entities) if (!merged[key].entities.includes(entity)) merged[key].entities.push(entity);
            Object.assign(merged[key].samples, samples);
        }
    }
    return merged;
}

// A build's categories, each with the lanes, ports and towns of its copy of the network; one group with everything for
// goods of one kind.
function categoryGroups(built) {
    if (!(built.categories?.length > 1)) return [{ category: null, lanes: built.lanes, ports: built.ports }];
    return built.categories.map((category) => ({ category, lanes: built.lanes.filter((lane) => lane.category === category.id), ports: built.ports.filter((port) => port.category === category.id) }));
}

// A link's road closed: every category it carries is held up alike, and each orders elsewhere from its own other lanes.
export function closureAcross(built, view, { closed, ...rest }) {
    const raw = view.rawLanes(closed);
    if (!raw.length) throw new Error(`There is no lane "${closed}" in the model.`);
    const plans = raw.map((lane) => closurePlan({ lanes: built.lanes, closed: lane.name, ...rest }));
    return {
        supplied: mergeSupplied(plans.map((plan) => plan.supplied)),
        warehouse: view.siteOf(plans[0].warehouse),
        reroutedTo: [...new Set(plans.flatMap((plan) => plan.reroutedTo).map(view.siteOf))],
        teuPerDay: plans.reduce((sum, plan) => sum + plan.teuPerDay, 0),
        detour: plans[0].detour
    };
}

// The ports a chokepoint cut reaches ([{ port, share }], by site), as the copies of them in the model.
export const affectedAcross = (view, affected) => affected.flatMap(({ port, share }) => view.rawPorts(port).map((copy) => ({ port: copy.name, share })));

// A chokepoint's cargo diverted to ports outside it (scenarios.mjs, diversionPlan), category by category: each
// category's cargo goes to the target's copy for that category, a target's berths given for the whole port shared among
// its copies by what each handles. A category the target does not carry, or with no lane from it to a warehouse that
// needs one, cannot be diverted: its cargo stays kept out, and its warehouses stop ordering what will not come.
export function diversionAcross(built, view, { affected, targets, ...rest }) {
    const groups = categoryGroups(built);
    if (groups.length === 1 && !groups[0].category) return diversionPlan({ lanes: built.lanes, ports: built.ports, affected, targets, ...rest });
    const siteName = (port) => port.site ?? port.name;
    for (const target of targets) if (!view.ports.some((port) => port.name === target.to)) throw new Error(`There is no port "${target.to}" in the model.`);
    const plans = [];
    const supplied = [];
    let refused = null;
    for (const group of groups) {
        const reached = affected.flatMap(({ port, share }) => group.ports.filter((copy) => siteName(copy) === port).map((copy) => ({ port: copy.name, share })));
        if (!reached.length) continue;
        const its = targets.map((target) => {
            const copy = group.ports.find((port) => siteName(port) === target.to);
            const whole = view.ports.find((port) => port.name === target.to);
            if (!copy) return null;
            const part = whole.berths > 0 ? copy.berths / whole.berths : 1 / whole.members.length;
            return { ...target, to: copy.name, berths: target.berths === null || target.berths === undefined ? null : target.berths * part };
        }).filter(Boolean);
        try {
            if (!its.length) throw new Error(`${targets.map((target) => target.to).join(' and ')} ${targets.length === 1 ? 'carries' : 'carry'} no ${group.category.name}.`);
            const plan = diversionPlan({ lanes: group.lanes, ports: group.ports, affected: reached, targets: its, ...rest });
            plans.push(plan);
            supplied.push(plan.supplied);
        } catch (error) {
            // This category's cargo is kept out: its warehouses stop ordering it while the cut lasts.
            refused = error;
            const { start, duration, forkAt, runTime, cut } = rest;
            supplied.push(keptOutPlan({ lanes: group.lanes, affected: reached, cut, start, duration, forkAt, runTime }).supplied);
        }
    }
    if (!plans.length) throw refused ?? new Error('The cut reaches no port of the model.');
    const byTarget = new Map();
    for (const item of plans.flatMap((plan) => plan.targets)) {
        const to = view.siteOf(item.to);
        const whole = byTarget.get(to) ?? { to, diverted: item.diverted, berths: 0, teu: 0, lanes: [], trucks: 0, unreachable: [] };
        byTarget.set(to, {
            ...whole, berths: whole.berths + item.berths, teu: whole.teu + item.teu, lanes: [...whole.lanes, ...item.lanes], trucks: whole.trucks + item.trucks,
            unreachable: [...new Set([...whole.unreachable, ...item.unreachable.map(view.siteOf)])]
        });
    }
    const all = [...byTarget.values()];
    return {
        supplied: mergeSupplied(supplied), targets: all,
        divertedTeu: all.reduce((sum, item) => sum + item.teu, 0),
        unreachable: [...new Set(all.flatMap((item) => item.unreachable))],
        lanes: all.flatMap((item) => item.lanes),
        trucks: all.reduce((sum, item) => sum + item.trucks, 0)
    };
}
