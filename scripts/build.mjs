/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildModels } from './buildModels.mjs';
import { konjugateModule, logisticsRoot } from './konjugatePaths.mjs';

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
