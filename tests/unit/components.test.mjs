/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { konjugateModule, logisticsRoot } from '../../scripts/konjugatePaths.mjs';
import { buildPortNetwork } from '../../scripts/portNetwork.mjs';

const { validateComponentTemplate } = await import(pathToFileURL(konjugateModule('src/componentTemplate.mjs')));
const packageDirectory = join(logisticsRoot, 'packages', 'engine');
const manifest = JSON.parse(await readFile(join(packageDirectory, 'plugin.json'), 'utf8'));
const componentContributions = manifest.contributes.filter((contribution) => contribution.kind === 'component');
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
    assert.equal(document.nodes.length, 6);
    assert.equal(document.edges.length, 2 + 3 * 3);
    const symbols = document.sharedParameters.map((shared) => shared.symbol);
    assert.equal(symbols.filter((symbol) => symbol === 'secondsPerDay').length, 1);
    assert.ok(symbols.includes('leadTime') && symbols.includes('leadTime2'), 'Each warehouse must get its own lead time.');
    assert.equal(document.sharedParameters.find((shared) => shared.symbol === 'leadTime2').value, 3);
});
