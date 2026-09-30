/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Generates the plugin's example models from the component templates, so an example always carries
// what the templates currently say. `npm run build` ships them in the package; `npm run build:models`
// writes them to models/ so a model's structure is reviewable in git.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { konjugateModule, logisticsRoot } from './konjugatePaths.mjs';
import { buildPortNetworkModel } from './portNetwork.mjs';

const { encodeProjectFile } = await import(pathToFileURL(konjugateModule('src/projectFile.mjs')));

// Port and warehouse network: the port network of scripts/portNetwork.mjs, balanced so the baseline
// holds still, with three live controls to fork on: the gate capacity during the outage window
// (days 20 to 50), the demand step multiplier (from day 20) and vessel arrivals.
export async function portWarehouseNetwork() {
    const model = await buildPortNetworkModel();
    model.setLive('outageCapacity', { minimum: 0, maximum: 150, step: 5 });
    model.setLive('stepMultiplier', { minimum: 0.5, maximum: 2, step: 0.05 });
    model.setLive('vesselArrivals', { minimum: 0, maximum: 250, step: 5 });
    const document = model.document({ days: 120 });
    document.metadata.projectName = 'Port and warehouse network';
    const states = Object.fromEntries(document.nodes.flatMap((node) => node.states.map((state) => [`${node.name}.${state.symbol}`, state.id])));
    return { document, states };
}

const models = { portWarehouseNetwork };

export async function buildModels(outputDirectory = join(logisticsRoot, 'models')) {
    await mkdir(outputDirectory, { recursive: true });
    const written = [];
    for (const [name, build] of Object.entries(models)) {
        const target = join(outputDirectory, `${name}.kjt`);
        const { document, states } = await build();
        await writeFile(target, await encodeProjectFile(JSON.stringify(document, null, 2)));
        written.push({ name, path: target, states, document });
        console.log(`Wrote ${target}`);
    }
    return written;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await buildModels();
