/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultUserData, konjugateModule, logisticsRoot } from './konjugatePaths.mjs';

const { installPackageArchive } = await import(pathToFileURL(konjugateModule('src/packageArchive.mjs')));

// Installs every built package into <userData>/packages with the same code path the app uses.
// Usage: node scripts/installDev.mjs [userDataDirectory]
export async function installBuiltPackages(userData = defaultUserData()) {
    const outputDirectory = join(logisticsRoot, 'out');
    const installed = [];
    for (const name of await readdir(outputDirectory)) {
        const extension = name.match(/\.(kja|kjp)$/)?.[1];
        if (!extension) continue;
        installed.push(await installPackageArchive(await readFile(join(outputDirectory, name)), {
            extension, directory: join(userData, 'packages'), overwrite: true
        }));
        console.log(`Installed ${name} into ${join(userData, 'packages')}`);
    }
    return installed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await installBuiltPackages(process.argv[2]);
