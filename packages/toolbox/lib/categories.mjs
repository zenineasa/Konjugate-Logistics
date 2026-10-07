/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The product categories a network carries: a small catalogue (ambient, chilled and frozen goods by default), each
// with its usual share of what a site supplies or sells, the lead time of its suppliers and whether it needs
// refrigerated vehicles. A category's figures start as defaults labelled assumed and become the user's once changed,
// as a site's and a vehicle type's do.
//
// A source (supplier or port) and a demand site (store, dark store or customer area) carries every category in its
// usual share until the user gives it a mix of its own: a weight for each category, 0 for one it does not carry. A
// supplier may also have a lead time of its own for a category.
//
// In the model each category is its own copy of the network (regionModel.mjs), so its goods are conserved on their
// own and a store can run out of one while another stays in stock.

export const categoryFields = [
    { key: 'share', label: 'Usual share', unit: '%', digits: 1, detail: 'Of what a site supplies or sells, until the site has a mix of its own. The shares are weighed against each other, so they need not add up to 100.' },
    { key: 'leadDays', label: 'Supplier lead time', unit: 'days', digits: 2, detail: 'From an order reaching a supplier to the goods standing ready to load, unless the supplier has its own for the category.' },
    // `optional`: empty is a figure too (the goods keep), unless the category's default says otherwise.
    { key: 'shelfDays', label: 'Keeps for', unit: 'days', digits: 1, optional: true, detail: 'Its shelf life at a warehouse or a store: what a site holds beyond what it expects to send out or sell in this many days is wasted, and no site aims to hold more. Empty: the goods keep (chilled goods, 10 days, until you say).' }
];

// The catalogue a new network starts with: assumptions to replace with the user's own.
export const defaultCategories = [
    { id: 'ambient', name: 'Ambient', share: 60, leadDays: 3, shelfDays: null, chilled: false },
    { id: 'chilled', name: 'Chilled', share: 25, leadDays: 1, shelfDays: 10, chilled: true },
    { id: 'frozen', name: 'Frozen', share: 15, leadDays: 5, shelfDays: null, chilled: true }
];
// Enough to tell a network's goods apart without a model too large to read: each category is a copy of the network.
export const mostCategories = 6;

const asField = (value) => ({ value: value ?? null, basis: value === null || value === undefined ? null : 'assumed' });
const templateOf = (id) => defaultCategories.find((category) => category.id === id) ?? { share: 10, leadDays: 2, shelfDays: null };

export function defaultCategoryCatalogue() {
    return defaultCategories.map((category) => ({
        id: category.id, name: category.name, chilled: category.chilled,
        fields: Object.fromEntries(categoryFields.map((field) => [field.key, asField(category[field.key])]))
    }));
}

function newCategoryId(others) {
    const used = new Set(others.map((category) => category.id));
    for (let index = 1; ; index += 1) if (!used.has(`category${index}`)) return `category${index}`;
}

function nextCategoryName(others) {
    const used = new Set(others.map((category) => category.name));
    for (let index = 1; ; index += 1) if (!used.has(`Category ${index}`)) return `Category ${index}`;
}

// A category from its figures: those given are the user's; the rest start as assumed defaults.
export function createCategory({ id, name, chilled = false, basis = 'user', ...given } = {}, others = []) {
    const template = templateOf(id);
    const fields = {};
    for (const field of categoryFields) {
        const value = given[field.key];
        fields[field.key] = value !== undefined && value !== null && value !== ''
            ? (typeof value === 'object' ? value : { value: Number(value), basis })
            : asField(template[field.key]);
    }
    return { id: id ?? newCategoryId(others), name: name || nextCategoryName(others), chilled: Boolean(chilled), fields };
}

// A field changed in the catalogue: the user's value, or back to the category's default when cleared.
export function setCategoryField(category, key, text) {
    const field = categoryFields.find((item) => item.key === key);
    if (!field) return category;
    const value = Number(text);
    category.fields[key] = text !== '' && text !== null && Number.isFinite(value) && value > 0
        ? { value, basis: 'user' }
        : asField(templateOf(category.id)[key]);
    return category;
}

// What is wrong with the catalogue, if anything.
export function categoriesProblem(catalogue) {
    if (!catalogue.length) return 'A network carries at least one category.';
    if (catalogue.length > mostCategories) return `A network carries at most ${mostCategories} categories: each is a copy of the network in the model.`;
    const names = new Set();
    for (const category of catalogue) {
        const name = category?.name?.trim();
        if (!name) return 'A category needs a name.';
        if (names.has(name.toLowerCase())) return `Two categories are named ${name}: give each its own name.`;
        names.add(name.toLowerCase());
        for (const field of categoryFields) {
            const value = category.fields?.[field.key]?.value;
            if (field.optional && (value === null || value === undefined)) continue;
            if (!(Number(value) > 0)) return `${name}: its ${field.label.toLowerCase()} must be more than nothing.`;
        }
    }
    return null;
}

// The catalogue as the model builder reads it: plain numbers, each with where it came from.
export function categoriesForModel(catalogue) {
    return catalogue.map((category) => ({
        id: category.id, name: category.name.trim(), chilled: Boolean(category.chilled),
        ...Object.fromEntries(categoryFields.map((field) => [field.key, Number(category.fields[field.key]?.value) > 0 ? Number(category.fields[field.key].value) : null])),
        basis: Object.fromEntries(categoryFields.map((field) => [field.key, category.fields[field.key]?.basis ?? null]))
    }));
}

// A session's catalogue made whole; the default catalogue for none (a session from before categories).
export function completeCategories(saved) {
    if (!Array.isArray(saved) || !saved.length) return defaultCategoryCatalogue();
    return saved.filter((category) => category?.id).slice(0, mostCategories).map((category) => createCategory({
        id: category.id, name: category.name, chilled: category.chilled === true,
        ...Object.fromEntries(categoryFields.map((field) => [field.key, category.fields?.[field.key] ?? null]))
    }, saved));
}

// Which sites have a mix: where goods enter the network and where they are sold. A warehouse carries what passes through it.
export const hasMix = (role) => ['supplier', 'port', 'store', 'darkStore', 'customerArea'].includes(role);

// A site's mix over the catalogue: for each category its weight, its share of the site's goods (0 to 1) and whether
// the weight is the site's own. A site with no mix of its own, or whose own weighs nothing, takes the usual shares.
export function mixOf(pin, catalogue) {
    const own = pin?.mix && catalogue.some((category) => Number(pin.mix[category.id]) > 0);
    const weights = catalogue.map((category) => (own ? Math.max(0, Number(pin.mix[category.id]) || 0) : Number(category.fields.share.value)));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return catalogue.map((category, index) => ({ id: category.id, name: category.name, weight: weights[index], share: total > 0 ? weights[index] / total : 0, basis: own ? 'user' : 'assumed' }));
}

// A category's weight in a site's mix set by the user (0 or nothing: the site does not carry it). The other
// categories keep the shares they had, as weights. A mix left with nothing in it is refused: the pin is returned as it
// was, with `false`.
export function setMix(pin, id, text, catalogue) {
    const value = Math.max(0, Number(text) || 0);
    const next = Object.fromEntries(mixOf(pin, catalogue).map((item) => [item.id, item.basis === 'user' ? item.weight : Number((item.share * 100).toFixed(2))]));
    next[id] = value;
    if (!Object.values(next).some((weight) => weight > 0)) return false;
    pin.mix = next;
    return true;
}

// Back to the usual shares.
export function clearMix(pin) {
    delete pin.mix;
    return pin;
}

// A supplier's own lead time for a category (days), or back to the category's when cleared.
export function setLeadDays(pin, id, text) {
    const value = Number(text);
    pin.leadDays = { ...(pin.leadDays ?? {}) };
    if (text !== '' && text !== null && Number.isFinite(value) && value > 0) pin.leadDays[id] = value;
    else delete pin.leadDays[id];
    if (!Object.keys(pin.leadDays).length) delete pin.leadDays;
    return pin;
}

// What the model builder reads of a site's categories: its own mix (weights by category id, of the categories there
// are) and, for a supplier, its own lead times.
export function mixForModel(pin, catalogue) {
    const ids = new Set(catalogue.map((category) => category.id));
    const mix = mixOf(pin, catalogue);
    const entry = {};
    if (mix[0]?.basis === 'user') entry.mix = Object.fromEntries(mix.map((item) => [item.id, item.weight]));
    const lead = Object.entries(pin.leadDays ?? {}).filter(([id, value]) => ids.has(id) && Number(value) > 0);
    if (pin.role === 'supplier' && lead.length) entry.leadDaysBy = Object.fromEntries(lead.map(([id, value]) => [id, { value: Number(value), basis: 'user' }]));
    return entry;
}
