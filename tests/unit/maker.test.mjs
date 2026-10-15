/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A maker: a site that makes one category from another (a bakery bread from flour). Its links, what stops a build,
// what the builder is sent (its store of what it uses and its making, two entries), the model built, and the CSV.

import assert from 'node:assert/strict';
import test from 'node:test';
import { categoriesForModel, createCategory, setMix } from '../../packages/toolbox/lib/categories.mjs';
import { createPin, defaultRecipe, linkProblem, makerProblem, networkFromSites, networkProblems, networkSelection, roles } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { parseSites, writeSites } from '../../packages/toolbox/lib/sites.mjs';
import { defaultCatalogue, linkKind } from '../../packages/toolbox/lib/vehicles.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';

const categories = [createCategory({ id: 'bread', name: 'Bread', share: 50, shelfDays: 2 }), createCategory({ id: 'flour', name: 'Flour', share: 50, shelfDays: 180 })];
const at = (lat, lon) => ({ lat, lon });
function bakeryNetwork() {
    const pins = [];
    const add = (role, point, options) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    const mill = add('supplier', at(46.05, 8.92), { name: 'Mill', fields: { supply: 32 } });
    setMix(mill, 'bread', 0, categories);
    const bakery = add('maker', at(46.0, 8.95), { name: 'Bakery', fields: { supply: 40, perUnit: 0.8 } });
    bakery.recipe = { makes: 'bread', uses: 'flour' };
    const depot = add('warehouse', at(45.98, 8.96), { name: 'Depot' });
    const store = add('store', at(45.97, 8.97), { name: 'Store', fields: { demand: 40 } });
    setMix(store, 'flour', 0, categories);
    const link = (from, to) => ({ id: `${from.id}>${to.id}`, from: from.id, to: to.id, basis: 'user', leg: { kilometres: 10, hours: 0.3, basis: 'routed' } });
    return { pins, mill, bakery, depot, store, links: [link(mill, bakery), link(bakery, depot), link(depot, store)] };
}

test('a maker takes what it uses from a source or a warehouse, and sends what it makes to a warehouse; it is the seventh role', () => {
    const { mill, bakery, depot, store } = bakeryNetwork();
    assert.equal(roles.maker.label, 'Maker');
    assert.equal(linkProblem(mill, bakery), null);
    assert.equal(linkProblem(depot, bakery), null);
    assert.equal(linkProblem(bakery, depot), null);
    assert.match(linkProblem(bakery, store), /^Store is supplied through a warehouse in this version/);
    assert.match(linkProblem(store, bakery), /supplies nothing/);
    assert.deepEqual([linkKind('supplier', 'maker'), linkKind('warehouse', 'maker'), linkKind('maker', 'warehouse'), linkKind('maker', 'maker')], ['supply', 'transfer', 'supply', 'supply']);
    assert.deepEqual(defaultRecipe(categories), { makes: 'bread', uses: 'flour' });
    assert.equal(defaultRecipe(categories.slice(0, 1)), null);
});

test('a maker\'s recipe and links are checked before a build: two different categories, some used, something in and somewhere out', () => {
    const { pins, bakery, links } = bakeryNetwork();
    const catalogue = defaultCatalogue();
    assert.deepEqual(networkProblems(pins, links, catalogue, categories).filter((problem) => problem.level === 'error'), []);
    assert.match(makerProblem({ ...bakery, recipe: { makes: 'bread', uses: 'bread' } }, categories), /makes what it uses/);
    assert.match(makerProblem(bakery, categories.slice(0, 1)), /add a second category/);
    assert.match(makerProblem({ ...bakery, fields: { ...bakery.fields, perUnit: { value: 0, basis: 'user' } } }, categories), /uses nothing/);
    const texts = (list) => networkProblems(pins, list, catalogue, categories).filter((problem) => problem.level === 'error').map((problem) => problem.text).join(' ');
    assert.match(texts(links.slice(1)), /Bakery makes from Flour, and nothing brings it any: link a supplier of Flour, or a warehouse, to it\./);
    assert.match(texts([links[0], links[2]]), /Bakery sends what it makes nowhere: link it to a warehouse\./);
});

test('the builder is sent a maker as its store of what it uses and its making, and builds a model that bakes from flour', async () => {
    const { pins, bakery, links } = bakeryNetwork();
    const catalogue = defaultCatalogue();
    const chosen = networkSelection(pins, links, { catalogue, categories });
    const store = chosen.selection.zones.find((zone) => zone.maker);
    const making = chosen.selection.ports.find((port) => port.maker);
    assert.deepEqual(store.maker, { input: 'flour', output: 'bread', outputName: 'Bread', perUnit: 0.8, makes: 40, basis: 'user', port: `make:${bakery.id}` });
    assert.deepEqual([making.id, making.supplier, making.teuPerDay, making.mix], [`make:${bakery.id}`, true, 40, { bread: 1 }]);
    assert.deepEqual(chosen.links.supply.map((link) => [link.port, link.zone]), [[pins[0].id, bakery.id], [`make:${bakery.id}`, pins[2].id]]);
    const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
    const selection = Object.fromEntries(Object.entries(chosen.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
    const templates = await loadTemplates();
    const builder = new ModelBuilder(templates);
    const built = buildRegionModel({ builder, selection, route: () => ({ kilometres: 10, hours: 0.3, basis: 'routed' }), links: chosen.links, options: { vehicles: chosen.vehicles, unit: chosen.unit, categories: categoriesForModel(categories) } });
    const document = builder.document({ days: 10, stepDays: 15 / 1440, outputDays: 1 / 24 });
    assert.ok(document.nodes.some((node) => node.type === 'Maker' && node.name === 'Bakery: Bread'));
    // Fed from its store of flour: edges join the two.
    const named = new Map(document.nodes.map((node) => [node.id, node.name]));
    const between = document.edges.filter((edge) => [named.get(edge.source.nodeId), named.get(edge.target.nodeId)].sort().join('|') === 'Bakery: Bread|Bakery: Flour');
    assert.equal(between.length, 6, 'the six edges of its feed');
    assert.deepEqual(built.lanes.map((lane) => [lane.name, Number(lane.rate.toFixed(6))]).sort(), [['Road Bakery → Depot: Bread', 40], ['Road Depot → Store: Bread', 40], ['Road Mill → Bakery: Flour', 32]]);
    const uses = built.provenance.find((item) => item.entity === 'Bakery: Flour' && item.parameter === 'Uses');
    assert.match(uses.detail, /^0\.8 of Flour for each pallet of Bread it makes, at the 40 a day it is set to make\./);
    // A circle of makers cannot be built; nor a maker in a network with one category.
    const one = categoriesForModel(categories.slice(0, 1));
    assert.throws(() => buildRegionModel({ builder: new ModelBuilder(templates), selection, route: () => null, links: chosen.links, options: { vehicles: chosen.vehicles, unit: chosen.unit, categories: one } }), /at least two categories/);
});

test('a maker is saved to the CSV with its recipe, and read back with it', () => {
    const { pins, links } = bakeryNetwork();
    const text = writeSites(pins, links, categories);
    assert.match(text, /^Bakery,maker,46,8\.95,40,,,,,Mill,,,,Bread from Flour:0\.8$/m);
    const read = parseSites(text);
    assert.deepEqual(read.errors, []);
    const back = networkFromSites(read.sites, [], categories);
    const bakery = back.pins.find((pin) => pin.role === 'maker');
    assert.deepEqual([bakery.recipe, bakery.fields.perUnit, bakery.fields.supply.value], [{ makes: 'bread', uses: 'flour', basis: 'user' }, { value: 0.8, basis: 'user' }, 40]);
    assert.deepEqual(back.problems, []);
    assert.match(parseSites('name,kind,latitude,longitude,recipe\nBakery,maker,46,9,Bread out of Flour\n').errors[0], /is not a recipe, as in Bread from Flour:0\.8/);
    // A mill is not taken for a maker (a flour mill may be a bakery's supplier): its line is refused, saying the kinds
    // there are; plant is a maker.
    const kinds = parseSites('name,kind,latitude,longitude\nMill,mill,46,9\nWorks,plant,46,9\n');
    assert.deepEqual([kinds.errors.length, kinds.sites.zones.map((site) => site.role)], [1, ['maker']]);
    const unknown = networkFromSites(parseSites('name,kind,latitude,longitude,recipe\nBakery,maker,46,9,Cheese from Milk:10\n').sites, [], categories);
    assert.match(unknown.problems[0], /^Bakery's recipe names "Cheese" and "Milk", which this network does not have/);
});
