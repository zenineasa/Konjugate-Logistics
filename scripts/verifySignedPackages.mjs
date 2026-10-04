/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Checks every .kjp/.kja in out/ against Konjugate core's registry/ and fails (non-zero exit)
// unless all of them come back "verified" -- a CI self-check that a signing step actually
// produced something the registry agrees with, not a runtime gate (see docs/registry.md: nothing
// in Konjugate itself refuses to install an unsigned or unverified package; this script only
// guards this repo's own release pipeline against shipping a signature that doesn't check out).

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logisticsRoot, konjugateModule } from './konjugatePaths.mjs';

const { loadNamespaceRegistry, verifyPackageArchive } = await import(pathToFileURL(konjugateModule('src/packageArchive.mjs')));
const namespaces = await loadNamespaceRegistry(konjugateModule('registry'));

const outputDirectory = join(logisticsRoot, 'out');
const targets = (await readdir(outputDirectory)).filter((name) => name.endsWith('.kjp') || name.endsWith('.kja'));
if (targets.length === 0) throw new Error(`No .kjp/.kja files found in ${outputDirectory} -- run the build (and sign) first.`);

let failed = false;
for (const name of targets) {
    const archive = await readFile(join(outputDirectory, name));
    const result = verifyPackageArchive(archive, { namespaces });
    console.log(`${name}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    if (result.status !== 'verified') failed = true;
}
if (failed) throw new Error('Not every package verified. See docs/registry.md if this is unexpected.');
console.log('All packages verified.');
