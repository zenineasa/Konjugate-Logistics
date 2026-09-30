/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Regenerates the Examples dialog thumbnails for this plugin's examples by driving the real app:
// it installs the built plugin into a scratch userData, opens each example, fits the camera and
// captures the canvas into thumbnails/. Run `npm run generate:example-thumbnails` whenever an
// example's layout changes, then `npm run build` to package the new images.

import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBuiltPackages } from './installDev.mjs';
import { konjugateDir, logisticsRoot } from './konjugatePaths.mjs';

const require = createRequire(join(konjugateDir, 'package.json'));
const { _electron: electron } = require('playwright');
const electronPath = require('electron');

const thumbnailsDir = join(logisticsRoot, 'thumbnails');
await mkdir(thumbnailsDir, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'konjugate-logistics-thumbnails-'));
const userData = join(scratch, 'userData');
await installBuiltPackages(userData);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: electronPath, args: [konjugateDir, `--user-data-dir=${userData}`], env });
try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => typeof window.componentLibrary?.list === 'function');
    // Loading a second example over an unsaved one asks "Discard changes?"; answer it from main.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });

    const exampleIds = await window.evaluate(() => window.projectFiles.listExamples().then(
        (examples) => examples.filter((example) => example.source?.pluginId === 'konjugate.logistics.engine').map((example) => example.id)
    ));
    if (exampleIds.length === 0) throw new Error('No konjugate.logistics.engine examples were found -- is the plugin built?');
    for (const id of exampleIds) {
        await window.click('#exampleButton');
        await window.waitForSelector('#examplesExplorerDialog[open]');
        await window.click(`.examplesExplorerItem[data-example-id="${id}"]`);
        await window.click('#examplesExplorerLoad');
        await window.waitForFunction(() => !document.querySelector('#examplesExplorerDialog').open);
        await window.waitForSelector('.node-label-container');
        await window.click('.cubeFit');
        // Let the fit-to-view camera move settle before capturing.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        // Plugin example ids are file names ("portWarehouseNetwork.kjt").
        const name = `${id.replace(/\.kjt$/, '')}.png`;
        await window.locator('#canvas').screenshot({ path: join(thumbnailsDir, name) });
        console.log(`Wrote thumbnails/${name}`);
    }
} finally {
    await app.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
}
