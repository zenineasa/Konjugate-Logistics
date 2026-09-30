/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { konjugateModule, logisticsRoot } from './konjugatePaths.mjs';

const { createPackageArchive } = await import(pathToFileURL(konjugateModule('src/packageArchive.mjs')));

const packageDirectory = join(logisticsRoot, 'packages', 'engine');
const outputDirectory = join(logisticsRoot, 'out');

// package.json is the single source of the version, so release tags always match the packages.
const { version } = JSON.parse(await readFile(join(logisticsRoot, 'package.json'), 'utf8'));
const manifest = { ...JSON.parse(await readFile(join(packageDirectory, 'plugin.json'), 'utf8')), version };
const files = {};
for (const contribution of manifest.contributes) files[contribution.entry] = await readFile(join(packageDirectory, contribution.entry));

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
