/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildModels } from './buildModels.mjs';
import { konjugateModule, logisticsRoot } from './konjugatePaths.mjs';
import { syntheticRegion } from '../tests/fixtures/syntheticRegion.mjs';

const { createPackageArchive } = await import(pathToFileURL(konjugateModule('src/packageArchive.mjs')));

const packageDirectory = join(logisticsRoot, 'packages', 'engine');
const outputDirectory = join(logisticsRoot, 'out');

// package.json is the single source of the version, so release tags always match the packages.
const { version } = JSON.parse(await readFile(join(logisticsRoot, 'package.json'), 'utf8'));
const manifest = { ...JSON.parse(await readFile(join(packageDirectory, 'plugin.json'), 'utf8')), version };
const files = {};
// Example models are generated from the templates by scripts/buildModels.mjs and shipped with a
// hand-written guide from guides/ and a thumbnail from thumbnails/ (made by
// scripts/generateExampleThumbnails.mjs, which drives the app).
const builtModels = await buildModels(join(outputDirectory, 'models'));
for (const contribution of manifest.contributes) {
    if (contribution.kind === 'example') {
        const built = builtModels.find((model) => model.name === contribution.exampleId);
        if (!built) throw new Error(`No generated model for example ${contribution.exampleId}.`);
        files[contribution.entry] = await readFile(built.path);
        files[contribution.guide] = await readFile(join(logisticsRoot, 'guides', `${contribution.exampleId}.md`));
        // Until npm run generate:example-thumbnails has made one, the example ships without a thumbnail.
        const thumbnail = join(logisticsRoot, 'thumbnails', `${contribution.exampleId}.png`);
        if (existsSync(thumbnail)) files[contribution.thumbnail] = await readFile(thumbnail);
        else {
            console.warn(`No thumbnails/${contribution.exampleId}.png yet; building ${contribution.exampleId} without one.`);
            delete contribution.thumbnail;
        }
    } else {
        files[contribution.entry] = await readFile(join(packageDirectory, contribution.entry));
    }
}

const archive = createPackageArchive({
    packageManifest: {
        format: 'konjugate-package', formatVersion: 1, packageType: 'plugin',
        packageId: manifest.pluginId, name: manifest.name, version: manifest.version,
        contents: { manifest: 'plugin.json' }
    },
    contributionManifest: manifest,
    files
});
await mkdir(outputDirectory, { recursive: true });
const target = join(outputDirectory, `${manifest.pluginId}-${manifest.version}.kjp`);
await writeFile(target, archive);
console.log(`Built ${target}`);

// ---- the Logistics Toolbox add-on (the region import window) -------------------------------------
// It carries its own copy of the component templates its importer builds models from, taken from the
// plugin at build time so the two can never drift, and the synthetic region as its sample (made-up
// data, so the window can be tried and tested without a network).
const toolboxDirectory = join(logisticsRoot, 'packages', 'toolbox');
const toolboxManifest = { ...JSON.parse(await readFile(join(toolboxDirectory, 'addon.json'), 'utf8')), version };
const toolboxFiles = {};
const collectToolbox = async (prefix = '') => {
    for (const entry of await readdir(join(toolboxDirectory, prefix), { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await collectToolbox(relative);
        else if (relative !== 'addon.json') toolboxFiles[relative] = await readFile(join(toolboxDirectory, relative));
    }
};
await collectToolbox();
for (const contribution of manifest.contributes.filter((entry) => entry.kind === 'component')) {
    toolboxFiles[`templates/${contribution.componentId}.json`] = await readFile(join(packageDirectory, contribution.entry));
}
for (const [kind, answer] of Object.entries(syntheticRegion())) toolboxFiles[`samples/${kind}.json`] = Buffer.from(JSON.stringify(answer));
const toolboxArchive = createPackageArchive({
    packageManifest: {
        format: 'konjugate-package', formatVersion: 1, packageType: 'addon',
        packageId: toolboxManifest.addonId, name: toolboxManifest.name, version: toolboxManifest.version,
        contents: { manifest: 'addon.json' }
    },
    contributionManifest: toolboxManifest,
    files: toolboxFiles
});
const toolboxTarget = join(outputDirectory, `${toolboxManifest.addonId}-${toolboxManifest.version}.kja`);
await writeFile(toolboxTarget, toolboxArchive);
console.log(`Built ${toolboxTarget}`);
