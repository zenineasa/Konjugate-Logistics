/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The vehicles a network runs on: a small catalogue of types, each with its capacity in pallets, its costs, its
// top speed, how long it takes to load, whether it may deliver to stores (city streets) and whether it is refrigerated
// (chilled and frozen goods go by refrigerated vehicles only; other goods by any), and on every link the
// one or two types that carry it, each with a fleet the toolbox sizes or the user sets.
//
// A type's figures start as defaults labelled assumed and become the user's once changed, as a site's do. In the
// model each type is one set of shared parameters (its capacity, costs and loading time), used by every lane it runs
// on, so changing a van's capacity changes it on every link vans carry; each lane keeps its own fleet of each type,
// counted and conserved as the two truck sizes of a road lane are.
//
// Deliveries to a customer area have no vehicles: they stand for a parcel or courier service, with a response time.
//
// A type runs by one mode (modes.mjs): road, rail or water. A link carries only types of its own mode. A new network's
// catalogue has road vehicles alone; a freight train or a barge, with assumed figures, is added to it the first time a
// link goes by rail or by water.

import { calendarProblem, changeCalendar, wholeCalendar } from './calendars.mjs';
import { linkMode, modes } from './modes.mjs';

export const vehicleFields = [
    { key: 'capacity', label: 'Capacity', unit: 'pallets', digits: 1, detail: 'What one vehicle carries, in the pallets the network counts in.' },
    { key: 'costPerKm', label: 'Cost per km', unit: 'a km', digits: 2, detail: 'Running cost (fuel, tyres, driver time on the road) per kilometre driven, loaded or empty.' },
    { key: 'costPerDay', label: 'Cost per day', unit: 'a day', digits: 0, detail: 'Fixed cost of having one (lease, insurance, driver), busy or idle.' },
    { key: 'speed', label: 'Top speed', unit: 'km/h', digits: 0, detail: 'A link takes at least its length at this speed, however fast its roads are.' },
    { key: 'loadingHours', label: 'Loading time', unit: 'hours', digits: 2, detail: 'At the origin, per trip: how quickly idle vehicles can be loaded.' }
];

// The catalogue a new network starts with: assumptions to replace with the user's own fleet's figures. Costs are in
// the network's cost units, the same for every type.
// The refrigerated type a catalogue with none is given when its network carries chilled goods (a session from before
// categories).
const refrigeratedTruck = { id: 'refrigeratedTruck', name: 'Refrigerated truck', capacity: 10, costPerKm: 1.4, costPerDay: 110, speed: 70, loadingHours: 0.75, toStores: true, refrigerated: true };
export const defaultVehicles = [
    { id: 'heavyTruck', name: 'Heavy truck', capacity: 30, costPerKm: 1.6, costPerDay: 120, speed: 80, loadingHours: 1, toStores: false },
    { id: 'mediumTruck', name: 'Medium truck', capacity: 12, costPerKm: 1.1, costPerDay: 80, speed: 70, loadingHours: 0.75, toStores: true },
    { id: 'smallTruck', name: 'Small truck', capacity: 6, costPerKm: 0.8, costPerDay: 60, speed: 60, loadingHours: 0.5, toStores: true },
    { id: 'miniVan', name: 'Mini-van', capacity: 2, costPerKm: 0.5, costPerDay: 40, speed: 50, loadingHours: 0.25, toStores: true },
    refrigeratedTruck
];
// The type a link by rail or by water is first given, every figure assumed, in the same units as the trucks: a freight
// train of about 40 wagons (some 80 containers of twenty feet, or 800 pallets), at 50 km/h on average with its stops,
// loaded in 8 hours; a large Rhine barge (110 m, some 200 containers of twenty feet, or 2,000 pallets), at 12 km/h on
// average (faster downstream than up: a lane has one time both ways), loaded in 12 hours. Neither delivers to stores.
export const modeVehicles = {
    rail: { id: 'freightTrain', name: 'Freight train', mode: 'rail', capacity: 800, costPerKm: 20, costPerDay: 3000, speed: 50, loadingHours: 8, toStores: false },
    water: { id: 'barge', name: 'Barge', mode: 'water', capacity: 2000, costPerKm: 8, costPerDay: 2000, speed: 12, loadingHours: 12, toStores: false }
};
// The mode a type runs by: road unless it says otherwise.
export const typeMode = (type) => (modes[type?.mode] ? type.mode : 'road');
const templateOf = (id) => defaultVehicles.find((type) => type.id === id) ?? Object.values(modeVehicles).find((type) => type.id === id) ?? null;

// A link's vehicles, by what it joins: heavy trucks from sources to warehouses, medium trucks to stores, mini-vans to
// dark stores; none to a customer area.
export const defaultTypeFor = { supply: 'heavyTruck', transfer: 'heavyTruck', store: 'mediumTruck', darkStore: 'miniVan' };
// A link carries at most two types: a road lane has two vehicle sizes.
export const typesPerLink = 2;

const asField = (value) => ({ value, basis: 'assumed' });

// A type from its figures: `fields` given are the user's; the rest start as assumed defaults (a medium truck's).
export function createVehicle({ id, name, mode = 'road', toStores = true, refrigerated = false, hours = null, basis = 'user', ...given } = {}, others = []) {
    const template = templateOf(id) ?? (modes[mode] && mode !== 'road' ? modeVehicles[mode] : defaultVehicles[1]);
    const fields = {};
    for (const field of vehicleFields) {
        const value = given[field.key];
        fields[field.key] = value !== undefined && value !== null && value !== ''
            ? (typeof value === 'object' ? value : { value: Number(value), basis })
            : asField(template[field.key]);
    }
    // The hours it runs, where it keeps any: small vehicles deliver by day; a large one with two drivers who take turns
    // runs round the clock, and has none.
    return {
        id: id ?? newVehicleId(others), name: name || nextVehicleName(others), ...(modes[mode] && mode !== 'road' ? { mode } : {}),
        toStores: Boolean(toStores), refrigerated: Boolean(refrigerated), fields, ...(wholeCalendar(hours) ? { hours: wholeCalendar(hours) } : {})
    };
}

export function newVehicleId(others = []) {
    const used = new Set(others.map((type) => type.id));
    for (let index = 1; ; index += 1) if (!used.has(`vehicle${index}`)) return `vehicle${index}`;
}

function nextVehicleName(others) {
    const used = new Set(others.map((type) => type.name));
    for (let index = 1; ; index += 1) if (!used.has(`Vehicle ${index}`)) return `Vehicle ${index}`;
}

// The catalogue with a type of `mode` in it: as it is when it has one, else with the mode's default type added.
export function withModeType(catalogue, mode) {
    if (mode === 'road' || !modeVehicles[mode] || catalogue.some((type) => typeMode(type) === mode)) return catalogue;
    const template = modeVehicles[mode];
    const id = catalogue.some((type) => type.id === template.id) ? newVehicleId(catalogue) : template.id;
    return [...catalogue, {
        id, name: template.name, mode, toStores: false, refrigerated: false,
        fields: Object.fromEntries(vehicleFields.map((field) => [field.key, asField(template[field.key])]))
    }];
}

// The default catalogue, every figure assumed.
export function defaultCatalogue() {
    return defaultVehicles.map((type) => ({
        id: type.id, name: type.name, toStores: type.toStores, refrigerated: Boolean(type.refrigerated),
        fields: Object.fromEntries(vehicleFields.map((field) => [field.key, asField(type[field.key])]))
    }));
}

// A field changed in the catalogue: the user's value, or back to the type's default when cleared.
export function setVehicleField(type, key, text) {
    const field = vehicleFields.find((item) => item.key === key);
    if (!field) return type;
    const value = Number(text);
    const template = templateOf(type.id) ?? (typeMode(type) !== 'road' ? modeVehicles[typeMode(type)] : defaultVehicles[1]);
    type.fields[key] = text !== '' && text !== null && Number.isFinite(value) && value > 0
        ? { value, basis: 'user' }
        : asField(template[key]);
    return type;
}

// The hours a type runs, one figure or one day changed by the user; back to round the clock, it keeps none.
export function setVehicleHours(type, change) {
    const next = changeCalendar(type.hours, change);
    if (next) type.hours = next; else delete type.hours;
    return type;
}

// What a type's figures say is wrong, if anything.
export function vehicleProblem(type) {
    if (!type?.name?.trim()) return 'A vehicle type needs a name.';
    const hours = calendarProblem(wholeCalendar(type.hours), `A ${type.name.toLowerCase()}`, 'runs');
    if (hours) return hours;
    for (const field of vehicleFields) {
        if (!(Number(type.fields?.[field.key]?.value) > 0)) return `${type.name}: its ${field.label.toLowerCase()} must be more than nothing.`;
    }
    return null;
}

// What kind of link it is, for its vehicles: supply (source to warehouse), transfer (warehouse to warehouse), to a
// store or dark store, or to a customer area (no vehicles); null for a link that cannot be.
export function linkKind(fromRole, toRole) {
    if (['supplier', 'port'].includes(fromRole) && toRole === 'warehouse') return 'supply';
    if (fromRole === 'warehouse' && toRole === 'warehouse') return 'transfer';
    if (fromRole === 'warehouse' && toRole === 'store') return 'store';
    if (fromRole === 'warehouse' && toRole === 'darkStore') return 'darkStore';
    if (fromRole === 'warehouse' && toRole === 'customerArea') return 'customerArea';
    return null;
}
export const carriesVehicles = (kind) => kind === 'supply' || kind === 'transfer' || kind === 'store' || kind === 'darkStore';
// Between sites that take any vehicle: heavy trucks may go there, as they may not to a store.
export const anyVehicle = (kind) => kind === 'supply' || kind === 'transfer';

// May a type carry a link of this kind by this mode: one of the link's mode, and to a store or a dark store only one
// that may deliver to stores.
export const typeFits = (type, kind, mode = 'road') => typeMode(type) === mode && (anyVehicle(kind) || type.toStores);

// The vehicles a link runs on: its own choice where it made one, of types still in the catalogue and of the link's mode,
// else its kind's default (or the first type of its mode that may go there). Each is { type, fleet } with fleet null
// when the toolbox sizes it. [] for a link by a mode the catalogue has no type of.
export function vehiclesOf(link, kind, catalogue) {
    if (!carriesVehicles(kind) || !catalogue.length) return [];
    const mode = linkMode(link);
    const ofMode = catalogue.filter((type) => typeMode(type) === mode);
    if (!ofMode.length) return [];
    const allowed = (type) => typeFits(type, kind, mode);
    const chosen = (link?.vehicles ?? []).filter((item) => ofMode.some((type) => type.id === item.type)).slice(0, typesPerLink);
    if (chosen.length) return chosen.map((item) => ({ type: item.type, fleet: Number.isFinite(item.fleet) && item.fleet >= 0 ? item.fleet : null }));
    const preferred = (mode === 'road' ? ofMode.find((type) => type.id === defaultTypeFor[kind] && allowed(type)) : null) ?? ofMode.find(allowed) ?? ofMode[0];
    return [{ type: preferred.id, fleet: null }];
}

// The vehicles that carry a chilled category on a link: its refrigerated ones, or, when it has none, the first
// refrigerated type of its mode that may go there ([] when the catalogue has none). Other goods go by all of the link's
// vehicles. `catalogue` is the window's or the model builder's: only a type's id, `mode`, `refrigerated` and `toStores`
// are read.
export function carriersFor(vehicles, kind, catalogue, chilled, mode = 'road') {
    if (!chilled) return vehicles;
    const typeOf = (item) => catalogue.find((type) => type.id === item.type);
    const cold = vehicles.filter((item) => typeOf(item)?.refrigerated);
    if (cold.length) return cold;
    const fallback = catalogue.find((type) => type.refrigerated && typeFits(type, kind, mode));
    return fallback ? [{ type: fallback.id, fleet: null }] : [];
}

// Why a link's vehicles cannot carry it, if they cannot: a type that may not deliver to stores on a link to one.
export function linkVehicleProblem(vehicles, kind, catalogue, { from = 'the warehouse', to = 'the store' } = {}) {
    if (kind !== 'store' && kind !== 'darkStore') return null;
    const barred = vehicles.map((item) => catalogue.find((type) => type.id === item.type)).filter((type) => type && !type.toStores);
    if (!barred.length) return null;
    return `${barred.map((type) => type.name).join(' and ')} may not deliver to ${kind === 'darkStore' ? 'dark stores' : 'stores'}: choose another vehicle for ${from} → ${to}.`;
}

// The catalogue as the model builder reads it: plain numbers, each with where it came from.
export function catalogueForModel(catalogue) {
    return catalogue.map((type) => ({
        id: type.id, name: type.name, mode: typeMode(type), toStores: type.toStores, refrigerated: Boolean(type.refrigerated),
        ...(wholeCalendar(type.hours) ? { hours: wholeCalendar(type.hours) } : {}),
        ...Object.fromEntries(vehicleFields.map((field) => [field.key, Number(type.fields[field.key].value)])),
        basis: Object.fromEntries(vehicleFields.map((field) => [field.key, type.fields[field.key].basis]))
    }));
}

// A session's catalogue made whole: every default field present, unknown fields dropped; the default catalogue for
// none. `refrigerated`: one from before categories, which has no refrigerated type, is given the default one, so its
// chilled goods have something to go by.
export function completeCatalogue(saved, { refrigerated = false } = {}) {
    if (!Array.isArray(saved) || !saved.length) return defaultCatalogue();
    const whole = completeSaved(saved);
    if (refrigerated && !whole.some((type) => type.refrigerated)) whole.push(defaultCatalogue().find((type) => type.id === refrigeratedTruck.id));
    return whole;
}

function completeSaved(saved) {
    return saved.filter((type) => type?.id).map((type) => createVehicle({
        id: type.id, name: type.name, mode: typeMode(type), toStores: type.toStores !== false, refrigerated: type.refrigerated === true, hours: type.hours ?? null,
        ...Object.fromEntries(vehicleFields.map((field) => [field.key, type.fields?.[field.key] ?? null]))
    }, saved));
}
