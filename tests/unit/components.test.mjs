/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { konjugateModule, logisticsRoot } from '../../scripts/konjugatePaths.mjs';
import { buildModels } from '../../scripts/buildModels.mjs';
import { buildPortNetwork } from '../../scripts/portNetwork.mjs';

const { validateComponentTemplate } = await import(pathToFileURL(konjugateModule('src/componentTemplate.mjs')));
const packageDirectory = join(logisticsRoot, 'packages', 'engine');
const manifest = JSON.parse(await readFile(join(packageDirectory, 'plugin.json'), 'utf8'));
const componentContributions = manifest.contributes.filter((contribution) => contribution.kind === 'component');
const exampleContributions = manifest.contributes.filter((contribution) => contribution.kind === 'example');
const templates = await Promise.all(componentContributions.map(async (contribution) => JSON.parse(await readFile(join(packageDirectory, contribution.entry), 'utf8'))));

test('every contributed component passes Konjugate\'s template validator', () => {
    componentContributions.forEach((contribution, index) => {
        assert.equal(templates[index].id, contribution.componentId);
        assert.ok(templates[index].domains.includes('logistics'));
        validateComponentTemplate(templates[index]);
    });
});

test('no component file is left uncontributed', async () => {
    const files = (await readdir(join(packageDirectory, 'components'))).sort();
    assert.deepEqual(files, componentContributions.map((entry) => entry.entry.replace('components/', '')).sort());
});

test('time is in seconds: every per-day rate goes through the one project-wide seconds-per-day constant', () => {
    for (const template of templates) {
        const declared = template.sharedParameters.find((shared) => shared.symbol === 'secondsPerDay');
        assert.ok(declared, `${template.id} must declare secondsPerDay.`);
        assert.equal(declared.value, 86400);
        assert.equal(declared.scope, 'project', `${template.id}: secondsPerDay must be one definition across the model.`);
    }
});

test('a project-scoped shared parameter means the same thing in every template that declares it', () => {
    const bySymbol = new Map();
    for (const template of templates) {
        for (const shared of template.sharedParameters.filter((candidate) => candidate.scope === 'project')) {
            const seen = bySymbol.get(shared.symbol);
            if (seen) assert.deepEqual({ ...shared, key: undefined }, { ...seen.shared, key: undefined }, `${shared.symbol} differs between ${seen.id} and ${template.id}.`);
            else bySymbol.set(shared.symbol, { id: template.id, shared });
        }
    }
});

test('the port network places from the templates with every equation valid and every endpoint matched', async () => {
    const document = await buildPortNetwork();
    // A port, two road lanes, two warehouses, three zones; ten edges per road shipment (taking and loading trucks of each size, and placing the order), five per delivery (with the two that drop lost sales).
    assert.equal(document.nodes.length, 8);
    assert.equal(document.edges.length, 2 * 10 + 3 * 5);
    const symbols = document.sharedParameters.map((shared) => shared.symbol);
    assert.equal(symbols.filter((symbol) => symbol === 'secondsPerDay').length, 1);
    assert.equal(symbols.filter((symbol) => symbol === 'truckCapacity').length, 1, 'Truck capacity is one definition across lanes and shipments.');
    assert.ok(symbols.includes('leadTime') && symbols.includes('leadTime2'), 'Each road lane must get its own travel time.');
    assert.equal(document.sharedParameters.find((shared) => shared.symbol === 'leadTime2').value, 3);
    const withRail = await buildPortNetwork({ railShare: 0.4 });
    assert.equal(withRail.edges.length, 2 * 10 + 6 + 3 * 5, 'A rail shipment has six edges: no trucks to take.');
});

test('a road shipment conserves what it moves: containers into the lane equal those taken from the origin', async () => {
    const templates = new Map(await Promise.all(componentContributions.map(async (contribution) => {
        const template = JSON.parse(await readFile(join(packageDirectory, contribution.entry), 'utf8'));
        return [template.id, template];
    })));
    const shipment = templates.get('roadShipment');
    const byName = Object.fromEntries(shipment.edges.map((edge) => [edge.name, edge]));
    // Goods and arrivals are bidirectional (what one side loses the other gains); the order book,
    // trucks and on-order counts are matched directed edges on the same shipment expression.
    assert.equal(byName.Dispatch.bidirectional, true);
    assert.equal(byName.Arrive.bidirectional, true);
    assert.equal(byName['Clear orders'].latex, `-${byName.Dispatch.latex}`);
    assert.equal(byName.Receive.latex, `-${byName.Arrive.latex}`);
    assert.match(byName['Take trucks'].latex, /truckCapacity/);
});

test('every contributed example has a generated model and a guide, and every guide is contributed', async () => {
    const built = await buildModels(join(logisticsRoot, 'out', 'models'));
    const guides = (await readdir(join(logisticsRoot, 'guides'))).map((name) => name.replace(/\.md$/, '')).sort();
    assert.deepEqual(exampleContributions.map((entry) => entry.exampleId).sort(), guides);
    for (const contribution of exampleContributions) {
        const model = built.find((candidate) => candidate.name === contribution.exampleId);
        assert.ok(model, `No generated model for ${contribution.exampleId}.`);
        assert.equal(contribution.entry, `examples/${contribution.exampleId}.kjt`);
        assert.equal(contribution.guide, `examples/${contribution.exampleId}.md`);
        assert.equal(contribution.thumbnail, `examples/${contribution.exampleId}.png`);
        assert.ok(contribution.domains.includes('logistics'));
        // Its live controls are what the guide forks on: each has a slider holding its value.
        const live = model.document.sharedParameters.filter((shared) => shared.mode === 'live');
        assert.ok(live.length > 0, `${contribution.exampleId} has no live control to fork on.`);
        for (const shared of live) {
            assert.ok(shared.control.minimum <= shared.value && shared.value <= shared.control.maximum, `${shared.symbol} lies outside its slider.`);
        }
    }
});
