/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import importRegion from '../../packages/toolbox/importers/region.mjs';
import { createPin, networkSelection, routeLinks, suggestLinks } from '../../packages/toolbox/lib/network.mjs';
import {
    calibration, formatDuration, googleMapsUrl, modelHours, openStreetMapUrl, parseDuration, parseTravelTimes, suspectTime, timeFrom, writeTravelTimes
} from '../../packages/toolbox/lib/travelTimes.mjs';
import { defaultCatalogue } from '../../packages/toolbox/lib/vehicles.mjs';
import { createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { equationHelpers } from '../../scripts/templatePlacement.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logisticsRoot } from '../../scripts/konjugatePaths.mjs';
import { syntheticRegion } from '../fixtures/syntheticRegion.mjs';

test('a time is read as people type it and as a map shows it, and written back plainly', () => {
    assert.equal(parseDuration('1:25'), 1 + 25 / 60);
    assert.equal(parseDuration('85 min'), 85 / 60);
    assert.equal(parseDuration('1 h 25 min'), 1 + 25 / 60);
    assert.equal(parseDuration('1 hr 25 mins'), 1 + 25 / 60);
    assert.equal(parseDuration('2 hours'), 2);
    assert.equal(parseDuration('1,5'), 1.5);
    assert.equal(parseDuration('45 Min'), 0.75);
    for (const nothing of ['', 'soon', '0', '1:75', '-1']) assert.equal(parseDuration(nothing), null, nothing);
    assert.deepEqual([formatDuration(1 + 25 / 60), formatDuration(0.75), formatDuration(3), formatDuration(0)], ['1 h 25 min', '45 min', '3 h', '']);
    assert.match(timeFrom('soon').error, /"soon" is not a time/);
    assert.match(timeFrom('100 h').error, /more than three days/);
    assert.deepEqual(timeFrom('1:10', { when: 'peak', how: 'google', checkedOn: '2026-10-07' }).time, { hours: 1 + 10 / 60, when: 'peak', how: 'google', checkedOn: '2026-10-07' });
});

test('the maps open the directions between the two sites, by car', () => {
    const from = { lat: 12.97159, lon: 77.594566 };
    const to = { lat: 13.0358, lon: 77.597 };
    const google = new URL(googleMapsUrl(from, to));
    assert.equal(google.hostname, 'www.google.com');
    assert.deepEqual([google.searchParams.get('api'), google.searchParams.get('origin'), google.searchParams.get('destination'), google.searchParams.get('travelmode')], ['1', '12.971590,77.594566', '13.035800,77.597000', 'driving']);
    const osm = new URL(openStreetMapUrl(from, to));
    assert.equal(osm.hostname, 'www.openstreetmap.org');
    assert.equal(osm.searchParams.get('route'), '12.971590,77.594566;13.035800,77.597000');
});

test('a time that looks wrong against the route is flagged, saying why', () => {
    const leg = { hours: 0.5, kilometres: 30 };
    assert.equal(modelHours(leg, 'supply'), 2.5, 'two hours at the gates from a source');
    assert.equal(modelHours(leg, 'store'), 1.5, 'one at the dock and the store\'s door');
    assert.equal(suspectTime({ hours: 2 }, leg, 'supply'), null);
    assert.match(suspectTime({ hours: 0.1 }, leg, 'supply'), /too fast for a road/);
    assert.match(suspectTime({ hours: 0.55 }, leg, 'supply'), /under 40% of the 2 h 30 min the route suggests/);
    assert.match(suspectTime({ hours: 7 }, leg, 'supply'), /more than 2\.5 times/);
    assert.match(suspectTime({ hours: 3.5 }, { hours: 0.2, kilometres: 2 }, 'store'), /more than 2\.5 times/);
    assert.match(suspectTime({ hours: 1.2 }, { hours: 0.05, kilometres: 3.5 }, 'store'), /under 3 km\/h/);
});

test('a calibration is the middle ratio of the user\'s times to the route\'s estimates, from two or more', () => {
    const entry = (hours, routed, kind = 'store') => ({ time: hours ? { hours } : null, leg: { hours: routed, kilometres: 10 }, kind });
    assert.equal(calibration([entry(3, 1), entry(null, 1)]), null, 'one time is not enough');
    // Estimates of 2 h (1 + 1 at the gates): ratios 1.5, 1.6 and 4 (an odd one), so the middle one is 1.6.
    const found = calibration([entry(3, 1), entry(3.2, 1), entry(8, 1), entry(null, 2)]);
    assert.deepEqual(found, { factor: 1.6, count: 3, low: 1.5, high: 4 });
    assert.equal(calibration([entry(3, 1), entry(4, 1)]).factor, 1.75, 'the mean of the middle two of an even count');
});

test('times are written as a CSV and read back, from a file or cells pasted from a spreadsheet', () => {
    const rows = [
        { from: 'Our depot', to: 'Mall, east', time: { hours: 1 + 10 / 60, kilometres: 32, when: 'peak', note: 'Google Maps, Tuesday 8 am' } },
        { from: 'Our depot', to: 'Corner shop', time: null }
    ];
    const text = writeTravelTimes(rows);
    assert.equal(text, 'from,to,time,kilometres,when,note\nOur depot,"Mall, east",1:10,32,peak,"Google Maps, Tuesday 8 am"\n');
    const read = parseTravelTimes(text);
    assert.deepEqual(read.errors, []);
    assert.deepEqual(read.rows, [{ from: 'Our depot', to: 'Mall, east', time: { hours: 1 + 10 / 60, kilometres: 32, when: 'peak', how: 'yours', note: 'Google Maps, Tuesday 8 am' } }]);
    // Pasted cells: tab-separated, no header, the columns in order.
    const pasted = parseTravelTimes('Our depot\tMall\t85 min\nOur depot\tKiosk\tsoon\n');
    assert.deepEqual(pasted.rows.map((row) => [row.from, row.to, row.time.hours]), [['Our depot', 'Mall', 85 / 60]]);
    assert.match(pasted.errors[0], /^Line 2: "soon" is not a time/);
    assert.match(parseTravelTimes('from,to,km\nA,B,3\n').errors[0], /no time column/);
});

const plugin = JSON.parse(await readFile(join(logisticsRoot, 'packages', 'engine', 'plugin.json'), 'utf8'));
const helpers = {
    reconcileEquationBindings: equationHelpers.reconcileEquationBindings,
    validateEquationLatex: equationHelpers.validateEquationLatex,
    async readPackageJson(relativePath) {
        if (/^geography\/[\w.]+\.json$/.test(relativePath)) return JSON.parse(await readFile(join(logisticsRoot, 'packages', 'toolbox', relativePath), 'utf8'));
        const id = relativePath.match(/^templates\/(\w+)\.json$/)?.[1];
        const contribution = plugin.contributes.find((entry) => entry.kind === 'component' && entry.componentId === id);
        return JSON.parse(await readFile(join(logisticsRoot, 'packages', 'engine', contribution.entry), 'utf8'));
    }
};
const roadsOnly = () => { const { roads, places } = syntheticRegion(); return Object.entries({ roads, places }).map(([role, answer]) => ({ role, name: `${role}.json`, text: JSON.stringify(answer), encoding: 'utf-8' })); };

test('a lane takes the user\'s own time door to door; the rest, with a calibration, the route\'s estimate scaled by it', async () => {
    const roads = await importRegion({ files: roadsOnly(), helpers, options: { step: 'roads' } });
    const router = createNetworkRouter(roads.data.graph);
    const pins = [];
    const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    add('supplier', { lat: -29.72, lon: -19.88 }, { name: 'Mill', fields: { supply: 30 } });
    const depot = add('warehouse', { lat: -29.9, lon: -19.7 }, { name: 'Depot' });
    const shop = add('store', { lat: -29.95, lon: -19.72 }, { name: 'Shop', fields: { demand: 20 } });
    add('store', { lat: -29.85, lon: -19.69 }, { name: 'Kiosk', fields: { demand: 10 } });
    const links = suggestLinks(pins, [], router);
    routeLinks(pins, links, router);
    const toShop = links.find((link) => link.from === depot.id && link.to === shop.id);
    toShop.time = { hours: 2.5, kilometres: 9, when: 'peak', how: 'google', checkedOn: '2026-10-07' };
    const build = (settings) => importRegion({ files: roadsOnly(), helpers, options: { step: 'buildNetwork', network: networkSelection(pins, links, { catalogue: defaultCatalogue() }), settings } });
    const plain = await build({});
    assert.equal(plain.ok, true, JSON.stringify(plain.report));
    const lane = (result, site) => result.data.lanes.find((item) => item.site === site);
    assert.equal(lane(plain, 'Shop').timeBasis, 'user');
    assert.ok(Math.abs(lane(plain, 'Shop').leadTime - 2.5 / 24) < 1e-4, 'door to door: no gate hours added, no vehicle speed applied');
    assert.equal(lane(plain, 'Shop').kilometres, 9, 'the distance given');
    const said = plain.data.provenance.find((entry) => entry.entity === 'Road Depot → Shop' && entry.parameter === 'Travel time');
    assert.equal(said.basis, 'user');
    assert.match(said.detail, /^Your time, read off Google Maps at the morning or evening peak on 2026-10-07, door to door: 2\.5 h\. The route suggested [\d.]+ h\.$/);
    assert.equal(plain.data.provenance.find((entry) => entry.entity === 'Road Depot → Shop' && entry.parameter === 'Distance').basis, 'user');
    assert.equal(lane(plain, 'Kiosk').timeBasis, 'routed');
    // With a factor from the user's times on other links, the Kiosk's lane is its routed estimate scaled by it.
    const scaled = await build({ timeFactor: { factor: 1.6, count: 4 } });
    const kiosk = lane(scaled, 'Kiosk');
    assert.equal(kiosk.timeBasis, 'estimated');
    assert.ok(Math.abs(kiosk.leadTime / lane(plain, 'Kiosk').leadTime - 1.6) < 0.01 || kiosk.leadTime * 24 >= 1.5, 'scaled by 1.6, unless the shortest trip the steps follow is longer');
    assert.match(scaled.data.provenance.find((entry) => entry.entity === 'Road Depot → Kiosk' && entry.parameter === 'Travel time').detail, /Times 1\.6: estimated from your 4 times on other links/);
    assert.ok(Math.abs(lane(scaled, 'Shop').leadTime - 2.5 / 24) < 1e-4, 'a time of the user\'s is not scaled');
    // A factor out of reason is not used.
    assert.equal(lane(await build({ timeFactor: { factor: 50, count: 2 } }), 'Kiosk').timeBasis, 'routed');
});
