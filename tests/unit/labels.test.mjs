/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Place names on the map: the larger places first, smaller ones only zoomed in, none overlapping.

import assert from 'node:assert/strict';
import test from 'node:test';
import { choosePlaceLabels, kilometresPerPixel, maximumNames } from '../../packages/toolbox/lib/labels.mjs';
import { seeded } from '../fixtures/roadGrid.mjs';

// A city of 300 suburbs and quarters 30 km across, with two towns beside it; positions in kilometres from its centre.
function denseCity() {
    const random = seeded(17);
    const places = [{ name: 'Bigcity', place: 'city', x: 0, y: 0, population: 8000000 }, { name: 'Northtown', place: 'town', x: 5, y: -40, population: 90000 }, { name: 'Smalltown', place: 'town', x: -40, y: 10, population: 20000 }];
    for (let index = 0; index < 300; index += 1) places.push({ name: `${index % 2 ? 'Quarter' : 'Suburb'} ${index}`, place: index % 2 ? 'quarter' : 'suburb', x: (random() - 0.5) * 30, y: (random() - 0.5) * 30 });
    return places;
}
// The map at `unit` kilometres a pixel, centred on `centre`, 1000 by 700 pixels.
const view = (unit, centre = { x: 0, y: 0 }) => ({
    unit, size: (place) => (place.place === 'city' ? 13 : 10),
    toScreen: (place) => {
        const x = 500 + (place.x - centre.x) / unit;
        const y = 350 + (place.y - centre.y) / unit;
        return x >= 0 && x <= 1000 && y >= 0 && y <= 700 ? { x, y } : null;
    }
});
const overlapFree = (written, size = 10) => {
    for (const [index, a] of written.entries()) {
        for (const b of written.slice(index + 1)) {
            const wa = a.place.name.length * size * 0.58;
            const wb = b.place.name.length * size * 0.58;
            assert.ok(Math.abs(a.x - b.x) * 2 >= wa / 2 + wb / 2 || Math.abs(a.y - b.y) >= size, `${a.place.name} and ${b.place.name} overlap`);
        }
    }
};

test('zoomed out over a dense city, only the city and its towns are named', () => {
    const written = choosePlaceLabels(denseCity(), view(0.2));
    assert.deepEqual(written.map((item) => item.place.name), ['Bigcity', 'Northtown', 'Smalltown']);
});

test('zoomed in, suburbs are named, then quarters, never overlapping and never more than a readable number', () => {
    const places = denseCity();
    const suburbs = choosePlaceLabels(places, view(0.05));
    assert.equal(suburbs[0].place.name, 'Bigcity', 'the city first');
    assert.ok(suburbs.some((item) => item.place.place === 'suburb'));
    assert.ok(!suburbs.some((item) => item.place.place === 'quarter'), 'no quarters yet');
    assert.ok(suburbs.length < 150, `${suburbs.length} names: the overlapping ones left out`);
    overlapFree(suburbs);
    const quarters = choosePlaceLabels(places, view(0.015));
    assert.ok(quarters.some((item) => item.place.place === 'quarter'));
    assert.ok(quarters.length <= maximumNames);
    overlapFree(quarters);
});

test('a more populous place is named before a smaller one of the same kind where they would overlap', () => {
    const places = [{ name: 'Littleton', place: 'town', x: 0, y: 0, population: 5000 }, { name: 'Greatton', place: 'town', x: 0.5, y: 0, population: 50000 }];
    assert.deepEqual(choosePlaceLabels(places, view(kilometresPerPixel.town / 2)).map((item) => item.place.name), ['Greatton']);
});

test('a place name gives way to a site\'s name already written there, and is written where the map is clear', () => {
    const places = [{ name: 'Nelamangala', place: 'town', x: 100, y: 100 }, { name: 'Hoskote', place: 'town', x: 400, y: 100 }];
    const options = { unit: 0.1, size: () => 11, toScreen: (place) => ({ x: place.x, y: place.y }) };
    assert.deepEqual(choosePlaceLabels(places, options).map((item) => item.place.name), ['Hoskote', 'Nelamangala']);
    // "Nelamangala DC" is written beside its pin, over where the town's name would go.
    const taken = [{ left: 95, right: 190, top: 90, bottom: 104 }];
    assert.deepEqual(choosePlaceLabels(places, { ...options, taken }).map((item) => item.place.name), ['Hoskote']);
    assert.deepEqual(taken.length, 1, 'the boxes given are left as they were');
});
