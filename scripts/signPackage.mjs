/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Signs every built .kjp/.kja in out/ under the konjugate.logistics namespace prefix (reserved in
// Konjugate core's registry/ -- see that repo's docs/registry.md). The private key never lives
// in this repo; it's read here from an environment variable so it can come from a CI secret
// (see .github/workflows/release.yml) or a local, gitignored file for a manual release build.
//
// Usage: LOGISTICS_SIGNING_PRIVATE_KEY="$(cat key.pem)" node scripts/signPackage.mjs

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logisticsRoot, konjugateModule } from './konjugatePaths.mjs';

const { signPackageArchive } = await import(pathToFileURL(konjugateModule('src/packageArchive.mjs')));

const privateKey = process.env.LOGISTICS_SIGNING_PRIVATE_KEY;
if (!privateKey) throw new Error('LOGISTICS_SIGNING_PRIVATE_KEY is not set -- nothing to sign with. See docs/registry.md in the Konjugate core repo for how a key is generated and registered.');

const outputDirectory = join(logisticsRoot, 'out');
const targets = (await readdir(outputDirectory)).filter((name) => name.endsWith('.kjp') || name.endsWith('.kja'));
if (targets.length === 0) throw new Error(`No .kjp/.kja files found in ${outputDirectory} -- run the build first.`);

for (const name of targets) {
    const path = join(outputDirectory, name);
    const signed = signPackageArchive(await readFile(path), { privateKey, prefix: 'konjugate.logistics' });
    await writeFile(path, signed);
    console.log(`Signed ${name}`);
}
