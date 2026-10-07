/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { completeFields, createPin, networkSelection, setField } from '../../packages/toolbox/lib/network.mjs';
import {
    catalogueForModel, completeCatalogue, createVehicle, defaultCatalogue, linkKind, linkVehicleProblem, setVehicleField, vehicleProblem, vehiclesOf
} from '../../packages/toolbox/lib/vehicles.mjs';

test('the default catalogue has five types, one refrigerated, every figure assumed, heavy trucks kept off store deliveries', () => {
    const catalogue = defaultCatalogue();
    assert.deepEqual(catalogue.map((type) => type.id), ['heavyTruck', 'mediumTruck', 'smallTruck', 'miniVan', 'refrigeratedTruck']);
    assert.deepEqual(catalogue.map((type) => type.refrigerated), [false, false, false, false, true]);
    assert.ok(catalogue.every((type) => Object.values(type.fields).every((field) => field.basis === 'assumed' && field.value > 0)));
    assert.deepEqual(catalogue.map((type) => type.toStores), [false, true, true, true, true]);
    assert.ok(catalogue.every((type) => vehicleProblem(type) === null));
});

test('a figure changed is the user\'s; cleared or nothing, it is the default again', () => {
    const [heavy] = defaultCatalogue();
    setVehicleField(heavy, 'capacity', '33');
    assert.deepEqual(heavy.fields.capacity, { value: 33, basis: 'user' });
    setVehicleField(heavy, 'capacity', '0');
    assert.deepEqual(heavy.fields.capacity, { value: 30, basis: 'assumed' });
    setVehicleField(heavy, 'speed', '');
    assert.deepEqual(heavy.fields.speed, { value: 80, basis: 'assumed' });
    const added = createVehicle({ name: 'Cargo bike', capacity: 0.2, speed: 15 }, defaultCatalogue());
    assert.equal(added.id, 'vehicle1');
    assert.deepEqual([added.fields.capacity, added.fields.speed.basis, added.fields.costPerKm.basis], [{ value: 0.2, basis: 'user' }, 'user', 'assumed']);
    assert.match(vehicleProblem({ ...added, name: ' ' }), /needs a name/);
});

test('a link runs on its kind\'s usual vehicle until it chooses its own, and on none to a customer area', () => {
    const catalogue = defaultCatalogue();
    assert.equal(linkKind('supplier', 'warehouse'), 'supply');
    assert.equal(linkKind('port', 'warehouse'), 'supply');
    assert.equal(linkKind('warehouse', 'store'), 'store');
    assert.equal(linkKind('warehouse', 'darkStore'), 'darkStore');
    assert.equal(linkKind('warehouse', 'customerArea'), 'customerArea');
    assert.equal(linkKind('store', 'warehouse'), null);
    assert.deepEqual(vehiclesOf({}, 'supply', catalogue), [{ type: 'heavyTruck', fleet: null }]);
    assert.deepEqual(vehiclesOf({}, 'store', catalogue), [{ type: 'mediumTruck', fleet: null }]);
    assert.deepEqual(vehiclesOf({}, 'darkStore', catalogue), [{ type: 'miniVan', fleet: null }]);
    assert.deepEqual(vehiclesOf({}, 'customerArea', catalogue), []);
    const own = { vehicles: [{ type: 'smallTruck', fleet: 4 }, { type: 'miniVan', fleet: null }, { type: 'mediumTruck', fleet: 1 }] };
    assert.deepEqual(vehiclesOf(own, 'store', catalogue), [{ type: 'smallTruck', fleet: 4 }, { type: 'miniVan', fleet: null }], 'at most two types');
    // A type taken out of the catalogue: the link falls back to what its kind uses.
    const withoutVans = catalogue.filter((type) => type.id !== 'miniVan');
    assert.deepEqual(vehiclesOf({ vehicles: [{ type: 'miniVan', fleet: 2 }] }, 'darkStore', withoutVans), [{ type: 'mediumTruck', fleet: null }]);
});

test('a type that may not deliver to stores is refused on a link to one, naming it', () => {
    const catalogue = defaultCatalogue();
    assert.equal(linkVehicleProblem([{ type: 'heavyTruck' }], 'supply', catalogue), null);
    assert.equal(linkVehicleProblem([{ type: 'heavyTruck' }], 'store', catalogue, { from: 'Depot', to: 'Mall' }), 'Heavy truck may not deliver to stores: choose another vehicle for Depot → Mall.');
    assert.match(linkVehicleProblem([{ type: 'miniVan' }, { type: 'heavyTruck' }], 'darkStore', catalogue), /^Heavy truck may not deliver to dark stores/);
});

test('the catalogue the model builder reads is plain numbers with where each came from; an older session gets the defaults', () => {
    const catalogue = defaultCatalogue();
    setVehicleField(catalogue[3], 'capacity', '2.5');
    const model = catalogueForModel(catalogue);
    assert.deepEqual(model[3], { id: 'miniVan', name: 'Mini-van', toStores: true, refrigerated: false, capacity: 2.5, costPerKm: 0.5, costPerDay: 40, speed: 50, loadingHours: 0.25, basis: { capacity: 'user', costPerKm: 'assumed', costPerDay: 'assumed', speed: 'assumed', loadingHours: 'assumed' } });
    assert.deepEqual(completeCatalogue(undefined).map((type) => type.id), ['heavyTruck', 'mediumTruck', 'smallTruck', 'miniVan', 'refrigeratedTruck']);
    // A catalogue saved before categories has no refrigerated type: it is given the default one, once, so chilled goods can go.
    const before = structuredClone(catalogue).filter((type) => !type.refrigerated).map(({ refrigerated, ...type }) => type);
    assert.deepEqual(completeCatalogue(before).map((type) => type.id), ['heavyTruck', 'mediumTruck', 'smallTruck', 'miniVan']);
    const given = completeCatalogue(before, { refrigerated: true });
    assert.deepEqual(given.map((type) => [type.id, type.refrigerated]).at(-1), ['refrigeratedTruck', true]);
    assert.equal(completeCatalogue(given, { refrigerated: true }).length, 5, 'not given a second one');
    // A saved type keeps its figures, and gets any field it lacks.
    const saved = structuredClone(catalogue);
    delete saved[3].fields.speed;
    const restored = completeCatalogue(saved);
    assert.deepEqual(restored[3].fields.capacity, { value: 2.5, basis: 'user' });
    assert.deepEqual(restored[3].fields.speed, { value: 50, basis: 'assumed' });
});

test('a site\'s storage capacity and cover: nothing is the default, as empty is; a pin from an older session gets them', () => {
    const store = createPin('store', { lat: 0, lon: 0 }, { name: 'Shop' });
    assert.deepEqual([store.fields.capacity, store.fields.cover], [{ value: null, basis: null }, { value: 2, basis: 'assumed' }]);
    setField(store, 'capacity', '0');
    assert.deepEqual(store.fields.capacity, { value: null, basis: null });
    setField(store, 'cover', '0.5');
    assert.deepEqual(store.fields.cover, { value: 0.5, basis: 'user' });
    setField(store, 'demand', '0');
    assert.deepEqual(store.fields.demand, { value: 0, basis: 'user' }, 'a store may sell nothing');
    const old = { role: 'warehouse', fields: { floorArea: { value: 9000, basis: 'user' } } };
    completeFields(old);
    assert.deepEqual(Object.keys(old.fields), ['floorArea', 'capacity', 'cover', 'holdingCost']);
    assert.deepEqual(old.fields.cover, { value: 3, basis: 'assumed' });
});

test('a store loses most of the sales it cannot make, a dark store half; 0 is a figure, more than 100% is not', () => {
    const store = createPin('store', { lat: 0, lon: 0 }, { name: 'Shop' });
    const dark = createPin('darkStore', { lat: 0, lon: 0 }, { name: 'Hub' });
    assert.deepEqual([store.fields.lostSales, dark.fields.lostSales, store.fields.saleValue], [{ value: 80, basis: 'assumed' }, { value: 50, basis: 'assumed' }, { value: 1000, basis: 'assumed' }]);
    setField(store, 'lostSales', '0');
    assert.deepEqual(store.fields.lostSales, { value: 0, basis: 'user' }, 'every shopper waits');
    setField(dark, 'lostSales', '150');
    assert.deepEqual(dark.fields.lostSales, { value: 50, basis: 'assumed' });
    setField(dark, 'saleValue', '2400');
    const [shop, hub] = networkSelection([store, dark], []).selection.towns;
    assert.deepEqual([shop.lostShare, shop.lostShareBasis, shop.saleValue, shop.saleValueBasis], [0, 'user', 1000, 'assumed']);
    assert.deepEqual([hub.lostShare, hub.lostShareBasis, hub.saleValue, hub.saleValueBasis], [0.5, 'assumed', 2400, 'user']);
    const old = { role: 'store', fields: { demand: { value: 4, basis: 'user' } } };
    completeFields(old);
    assert.deepEqual(old.fields.lostSales, { value: 80, basis: 'assumed' }, 'a store from an older session loses the default');
});
