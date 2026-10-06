/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultUserData, konjugateModule, logisticsRoot } from './konjugatePaths.mjs';

const { installPackageArchive } = await import(pathToFileURL(konjugateModule('src/packageArchive.mjs')));

// Installs every built package into <userData>/packages with the same code path the app uses.
// Usage: node scripts/installDev.mjs [userDataDirectory]
// The archives of this version among the files in out/: an archive left there by an earlier version is not installed.
export function currentArchives(names, version) {
    return names.filter((name) => /\.(kja|kjp)$/.test(name) && name.endsWith(`-${version}.${name.split('.').pop()}`));
}

export async function installBuiltPackages(userData = defaultUserData()) {
    const outputDirectory = join(logisticsRoot, 'out');
    const { version } = JSON.parse(await readFile(join(logisticsRoot, 'package.json'), 'utf8'));
    const installed = [];
    for (const name of currentArchives(await readdir(outputDirectory), version)) {
        const extension = name.split('.').pop();
        // Any other installed version of the package is removed, so Konjugate cannot open an earlier one instead.
        installed.push(await installPackageArchive(await readFile(join(outputDirectory, name)), {
            extension, directory: join(userData, 'packages'), overwrite: true, replaceOtherVersions: true
        }));
        console.log(`Installed ${name} into ${join(userData, 'packages')}`);
    }
    return installed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await installBuiltPackages(process.argv[2]);
