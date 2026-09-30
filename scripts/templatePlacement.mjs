/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Loads this plugin's component templates, checked by Konjugate's own template validator, and
// builds models from them with the toolbox's ModelBuilder (packages/toolbox/lib/modelBuilder.mjs)
// using the Konjugate checkout's equation helpers. Tests and example models use this so they run
// exactly what the templates say.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelBuilder as ToolboxModelBuilder } from '../packages/toolbox/lib/modelBuilder.mjs';
import { konjugateModule, logisticsRoot } from './konjugatePaths.mjs';

export const equationHelpers = await import(pathToFileURL(konjugateModule('src/equationModel.mjs')));
const { validateComponentTemplate } = await import(pathToFileURL(konjugateModule('src/componentTemplate.mjs')));

const packageDirectory = join(logisticsRoot, 'packages', 'engine');

export async function loadTemplates() {
    const manifest = JSON.parse(await readFile(join(packageDirectory, 'plugin.json'), 'utf8'));
    const templates = new Map();
    for (const contribution of manifest.contributes.filter((entry) => entry.kind === 'component')) {
        const template = validateComponentTemplate(JSON.parse(await readFile(join(packageDirectory, contribution.entry), 'utf8')));
        templates.set(template.id, template);
    }
    return templates;
}

export class ModelBuilder extends ToolboxModelBuilder {
    constructor(templates) {
        super(templates, equationHelpers);
    }
}
