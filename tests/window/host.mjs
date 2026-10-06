/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A stand-in for Konjugate's launcher host, so the toolbox window can be tested in a plain browser: the window's
// files are served from the package, `window.konjugateLauncher` calls back into Node, the importer runs here as the
// host runs it (with the host's limits on what goes in and comes out), and the network is answered from the synthetic
// region. No engine: a scenario cannot run here (the Electron interaction test runs them).

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import importRegion from '../../packages/toolbox/importers/region.mjs';
import { konjugateDir, logisticsRoot } from '../../scripts/konjugatePaths.mjs';
import { equationHelpers } from '../../scripts/templatePlacement.mjs';
import { syntheticPortwatch, syntheticRegion } from '../fixtures/syntheticRegion.mjs';

// Playwright: Konjugate's own (a development dependency of the checkout beside this one), else one on NODE_PATH.
export function loadPlaywright() {
    for (const from of [join(konjugateDir, 'package.json'), import.meta.url]) {
        try { return createRequire(from)('playwright'); } catch {}
    }
    throw new Error('Playwright is not installed: run npm install in the Konjugate checkout beside this one.');
}

const plugin = JSON.parse(await readFile(join(logisticsRoot, 'packages', 'engine', 'plugin.json'), 'utf8'));
const helpers = {
    reconcileEquationBindings: equationHelpers.reconcileEquationBindings,
    validateEquationLatex: equationHelpers.validateEquationLatex,
    async readPackageJson(relativePath) {
        if (/^geography\/[\w.]+\.json$/.test(relativePath)) return JSON.parse(await readFile(join(logisticsRoot, 'packages', 'toolbox', relativePath), 'utf8'));
        const id = relativePath.match(/^templates\/(\w+)\.json$/)?.[1];
        const contribution = plugin.contributes.find((entry) => entry.kind === 'component' && entry.componentId === id);
        if (!contribution) throw new Error(`No ${relativePath} in the package.`);
        return JSON.parse(await readFile(join(logisticsRoot, 'packages', 'engine', contribution.entry), 'utf8'));
    }
};

// The host's limits (Konjugate's launcherHost.mjs).
export const limits = { options: 2 * 1024 * 1024, importerData: 8 * 1024 * 1024, sessionWindow: 2 * 1024 * 1024 };

export const placeAnswer = [{ display_name: 'Port Alder, Synthetic Coast', type: 'harbour', lat: '-29.99', lon: '-19.9', boundingbox: ['-29.9', '-29.8', '-19.75', '-19.6'] }];

export function createHost() {
    const region = syntheticRegion();
    const portwatch = syntheticPortwatch();
    const files = new Map(); // `${role}/${name}` -> { role, name, text, retrievedAt }
    const requests = [];
    const chosen = {}; // role -> text the next chooseFile picks
    let session = null;
    const kindOf = (query) => (query.includes('"landuse"="port"') ? 'ports' : query.includes('"building"="warehouse"') ? 'logistics'
        : query.includes('"highway"') ? 'roads' : query.includes('"railway"="rail"') ? 'rail' : query.includes('"place"') ? 'places' : null);
    const answerFor = (url) => {
        const address = new URL(url);
        if (address.hostname === 'overpass-api.de' && address.pathname === '/api/interpreter') return JSON.stringify(region[kindOf(address.searchParams.get('data'))]);
        if (address.hostname === 'services9.arcgis.com' && address.pathname.includes('/PortWatch_ports_database/')) return JSON.stringify(portwatch.portwatchPorts);
        if (address.hostname === 'services9.arcgis.com' && address.pathname.includes('/Daily_Ports_Data/') && address.searchParams.get('where') === "portid='port9001'") return JSON.stringify(portwatch.portwatchActivity);
        return null;
    };
    const handlers = {
        async useSample() {
            files.clear();
            for (const [role, answer] of Object.entries(region)) files.set(`${role}/sample`, { role, name: `${role}.json`, text: JSON.stringify(answer) });
            return {};
        },
        async clearFile({ role, name }) {
            for (const key of [...files.keys()]) if (key.startsWith(`${role}/`) && (!name || key === `${role}/${name}`)) files.delete(key);
            return {};
        },
        async fetchText({ url }) {
            requests.push(url);
            const address = new URL(url);
            if (address.hostname === 'nominatim.openstreetmap.org') return { text: JSON.stringify(placeAnswer) };
            if (address.href === 'https://overpass-api.de/api/status') return { text: 'Rate limit: 2\n2 slots available now.\n' };
            throw new Error(`${address.hostname} answered 404.`);
        },
        async fetchFile({ role, url, name }) {
            requests.push(url);
            const text = answerFor(url);
            if (text === null) throw new Error(`${new URL(url).hostname} answered 404.`);
            files.set(`${role}/${name}`, { role, name, text, url, retrievedAt: new Date().toISOString() });
            return { bytes: Buffer.byteLength(text) };
        },
        async chooseFile({ role }) {
            if (chosen[role] === undefined) return { chosen: false };
            files.set(`${role}/chosen`, { role, name: `${role}.csv`, text: chosen[role] });
            delete chosen[role];
            return { chosen: true };
        },
        async runImport({ options = {} }) {
            if (JSON.stringify(options).length > limits.options) throw new Error('The options are larger than the host accepts.');
            const result = await importRegion({ files: [...files.values()].map(({ role, name, text }) => ({ role, name, text, encoding: 'utf-8' })), helpers, options });
            if (result.data && JSON.stringify(result.data).length > limits.importerData) throw new Error('The importer returned more data than the host accepts.');
            if (!result.ok || !result.document) return { imported: false, report: result.report, data: result.data };
            return { imported: true, report: result.report, data: result.data };
        },
        async openInCanvas({ session: kept }) {
            if (kept) {
                const text = JSON.stringify(kept);
                if (text.length > limits.sessionWindow) throw new Error('The window\'s session is larger than the host keeps.');
                session = JSON.parse(text);
            }
            return {};
        },
        async restoreSession() {
            return { session, savedAt: session ? new Date().toISOString() : null, inputs: [...files.values()].map(({ role, url, retrievedAt }) => ({ role, url, retrievedAt })) };
        },
        async runScenario() { throw new Error('No engine in the window test.'); }
    };
    return {
        files, requests, chosen,
        get session() { return session; },
        set session(value) { session = value; },
        async call(name, args) {
            try {
                return { ok: true, ...await handlers[name](args ?? {}) };
            } catch (error) {
                return { ok: false, message: error.message };
            }
        }
    };
}

const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// Opens the window in `page`, served from the package at http://toolbox.test/, with the host stand-in behind it.
export async function openWindow(page, host, { inspect = true } = {}) {
    await page.route('http://toolbox.test/**', async (route) => {
        const path = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
        try {
            const body = await readFile(join(logisticsRoot, 'packages', 'toolbox', path));
            await route.fulfill({ status: 200, body, contentType: types[extname(path)] ?? 'application/octet-stream' });
        } catch {
            await route.fulfill({ status: 404, body: 'not found' });
        }
    });
    if (!page.hostBound) {
        await page.exposeFunction('logisticsHost', (name, args) => host.call(name, args));
        await page.addInitScript(() => {
            const call = (name) => (...args) => window.logisticsHost(name, args[0]);
            window.konjugateLauncher = Object.freeze({
                chooseFile: (importerId, role) => window.logisticsHost('chooseFile', { importerId, role }),
                clearFile: (importerId, role, name) => window.logisticsHost('clearFile', { importerId, role, name }),
                fetchText: (url) => window.logisticsHost('fetchText', { url }),
                fetchFile: (importerId, role, url, name) => window.logisticsHost('fetchFile', { importerId, role, url, name }),
                useSample: (importerId) => window.logisticsHost('useSample', { importerId }),
                runImport: (importerId, options) => window.logisticsHost('runImport', { importerId, options }),
                runScenario: (scenarioId, options) => window.logisticsHost('runScenario', { scenarioId, ...options }),
                openInCanvas: (scenarioId, options = {}) => window.logisticsHost('openInCanvas', { scenarioId, ...options }),
                restoreSession: call('restoreSession'),
                onProgress: () => {}
            });
        });
        page.hostBound = true;
    }
    await page.goto(`http://toolbox.test/index.html${inspect ? '?inspect' : ''}`);
    await page.waitForLoadState('domcontentloaded');
}
