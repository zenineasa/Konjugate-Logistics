/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A stand-in for Konjugate's launcher host, so the toolbox window can be tested in a plain browser: the window's
// files are served from the package, `window.konjugateLauncher` calls back into Node, the importer runs here as the
// host runs it (with the host's limits on what goes in and comes out), and the network is answered from the synthetic
// region. No engine, unless KONJUGATE_ENGINE=export: then a scenario runs as Konjugate's code export writes the model
// (the Electron interaction test runs them in the real app).

import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import importRegion from '../../packages/toolbox/importers/region.mjs';
import { konjugateDir, konjugateModule, logisticsRoot } from '../../scripts/konjugatePaths.mjs';
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
export const limits = { options: 2 * 1024 * 1024, importerData: 8 * 1024 * 1024, sessionWindow: 2 * 1024 * 1024, input: 10 * 1024 * 1024 };

// Konjugate's own cache of what an add-on fetched, in a scratch folder: the window test exercises the real one.
const { createAddonCache } = await import(pathToFileURL(konjugateModule('src/addonCache.mjs')));
// And its store of large files kept for the user (map extracts), on a scratch folder, its downloads from `host.downloads`.
const { createFileStore } = await import(pathToFileURL(konjugateModule('src/addonFileStore.mjs')));
// And its check on an address a window may open: https, a host the manifest lists.
const { addressAllowed, storedFileKinds } = await import(pathToFileURL(konjugateModule('src/launcherHost.mjs')));
const manifest = JSON.parse(await readFile(join(logisticsRoot, 'packages', 'toolbox', 'addon.json'), 'utf8'));

export const placeAnswer = [{ display_name: 'Port Alder, Synthetic Coast', type: 'harbour', lat: '-29.99', lon: '-19.9', boundingbox: ['-29.9', '-29.8', '-19.75', '-19.6'] }];

export async function createHost() {
    const cache = createAddonCache({ directory: join(await mkdtemp(join(tmpdir(), 'konjugate-window-cache-')), 'cache') });
    // Where scenario runs write their programs and results.
    const scratch = await mkdtemp(join(tmpdir(), 'konjugate-window-runs-'));
    const region = syntheticRegion();
    const portwatch = syntheticPortwatch();
    const files = new Map(); // `${role}/${name}` -> { role, name, text, retrievedAt }
    const requests = [];
    const opened = []; // pages the window opened in the browser
    const chosen = {}; // role -> text the next chooseFile picks
    let session = null;
    const kindOf = (query) => (query.includes('"landuse"="port"') ? 'ports' : query.includes('"building"="warehouse"') ? 'logistics'
        : query.includes('"highway"') ? 'roads' : query.includes('"railway"="rail"') ? 'rail' : query.includes('"place"') ? 'places' : null);
    const answerFor = (url) => {
        const address = new URL(url);
        // Geofabrik's index of extracts, as a test sets it (host.mapIndex).
        if (address.href === 'https://download.geofabrik.de/index-v1.json' && host.mapIndex) return JSON.stringify(host.mapIndex);
        if (address.hostname === 'overpass-api.de' && address.pathname === '/api/interpreter') return JSON.stringify(region[kindOf(address.searchParams.get('data'))]);
        if (address.hostname === 'services9.arcgis.com' && address.pathname.includes('/PortWatch_ports_database/')) return JSON.stringify(portwatch.portwatchPorts);
        if (address.hostname === 'services9.arcgis.com' && address.pathname.includes('/Daily_Ports_Data/') && address.searchParams.get('where') === "portid='port9001'") return JSON.stringify(portwatch.portwatchActivity);
        return null;
    };
    const store = createFileStore({ directory: join(scratch, 'addonFiles') });
    // What a download asks for: a file of `host.downloads` (address -> bytes), its MD5 sum beside it, or an index.
    const fetchDownload = async (url) => {
        const address = new URL(url);
        if (url.endsWith('.md5')) {
            const bytes = host.downloads[url.slice(0, -4)];
            return bytes ? new Response(`${createHash('md5').update(bytes).digest('hex')}  file\n`) : new Response('', { status: 404 });
        }
        const bytes = host.downloads[address.href];
        if (!bytes) return new Response('', { status: 404 });
        const chunks = [];
        for (let at = 0; at < bytes.length; at += 4096) chunks.push(bytes.subarray(at, at + 4096));
        return new Response(new ReadableStream({ pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); } }), { headers: { 'content-length': String(bytes.length) } });
    };
    const handlers = {
        // As Konjugate's host does (addonFileStore.mjs): kept files listed, brought in, downloaded, described, removed, used.
        async storedFiles() { return { files: await store.list(), bytes: await store.usage() }; },
        async storeFiles({ details, accept, title }) {
            // The dialog's filter and title are noted; the check of what is chosen is Konjugate's own.
            const kinds = storedFileKinds(accept);
            host.storeDialog = { title, filters: kinds.filters };
            const paths = host.chosen.store ?? [];
            delete host.chosen.store;
            for (const path of paths) kinds.check(path);
            const kept = [];
            for (const path of paths) kept.push(await store.putCopy({ path, details }));
            return { files: kept };
        },
        async downloadFile({ url, server, checksumUrl, details, downloadId }) {
            if (!manifest.permissions.includes('files.store')) throw new Error('This launcher was not granted files.store.');
            const file = await store.download({ url, server, checksumUrl, details, hosts: manifest.network.hosts, fetchImpl: fetchDownload,
                onProgress: ({ done, total }) => host.progress.push({ stage: 'download', downloadId, done, total }) });
            return { file };
        },
        async cancelDownload() { return {}; },
        async fileSize({ url }) { return { bytes: await store.size({ url, hosts: manifest.network.hosts, fetchImpl: fetchDownload }) }; },
        async describeStoredFile({ id, details }) { return { file: await store.describe(id, details) }; },
        async removeStoredFile({ id }) { await store.remove(id); return {}; },
        async useStoredFiles({ role, ids }) {
            const entries = [];
            for (const id of ids) entries.push(await store.get(id));
            for (const [key, file] of files) if (file.role === role) files.delete(key);
            for (const entry of entries) files.set(`${role}/${entry.id}`, { role, name: entry.name, data: new Uint8Array(await readFile(entry.path)), binary: true, stored: entry.id });
            return { files: entries.map(({ path, ...entry }) => entry) };
        },
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
        // As Konjugate's host does: from the cache when asked to use it and it holds the address, else fetched (and kept).
        async fetchFile({ role, url, name, cache: mode = 'off', maximumAgeDays }) {
            // A busy public server, as a test sets it (host.busy: how many answers to refuse).
            if (host.busy > 0 && new URL(url).hostname === 'overpass-api.de') { host.busy -= 1; throw new Error('overpass-api.de answered 429.'); }
            const hit = mode === 'use' ? await cache.get(url, { maximumAgeDays: maximumAgeDays ?? undefined }) : null;
            let text;
            let retrievedAt;
            if (hit) {
                text = hit.bytes.toString('utf8');
                retrievedAt = hit.retrievedAt;
            } else {
                requests.push(url);
                text = answerFor(url);
                if (text === null) throw new Error(`${new URL(url).hostname} answered 404.`);
                retrievedAt = new Date().toISOString();
                if (mode !== 'off') await cache.put(url, Buffer.from(text), { retrievedAt });
            }
            files.set(`${role}/${name}`, { role, name, text, url, retrievedAt });
            return { bytes: Buffer.byteLength(text), cached: Boolean(hit), retrievedAt };
        },
        // Opening a page in the browser: checked as Konjugate checks it, and recorded instead of opened.
        async openLink({ url }) {
            if (!manifest.permissions.includes('links.open')) throw new Error('This launcher was not granted links.open.');
            opened.push(addressAllowed(url, manifest.links?.hosts ?? []));
            return {};
        },
        async cacheInfo() { return cache.info(); },
        async clearCache() { await cache.clear(); return {}; },
        // Kept with the project without a model: as openInCanvas keeps it.
        async keepSession({ session: kept }) {
            const text = JSON.stringify(kept);
            if (text.length > limits.sessionWindow) throw new Error('The window\'s session is larger than the host keeps.');
            session = JSON.parse(text);
            host.kept += 1;
            return {};
        },
        async chooseFile({ role }) {
            if (chosen[role] === undefined) return { chosen: false };
            // A binary role's file is bytes ({ name, data }), noted and handed to the importer when it runs.
            // Several at once ([{ name, data }]) for a role that takes several: they replace the role's earlier ones.
            const binaries = Array.isArray(chosen[role]) ? chosen[role] : chosen[role]?.data ? [chosen[role]] : null;
            if (binaries) {
                for (const [key, file] of files) if (file.role === role) files.delete(key);
                for (const item of binaries) files.set(`${role}/${item.name}`, { role, name: item.name, data: item.data, binary: true });
                const answer = { chosen: true, name: binaries[0].name, names: binaries.map((item) => item.name), bytes: binaries.reduce((sum, item) => sum + item.data.length, 0) };
                delete chosen[role];
                return answer;
            }
            files.set(`${role}/chosen`, { role, name: `${role}.csv`, text: chosen[role] });
            delete chosen[role];
            return { chosen: true };
        },
        async runImport({ options = {} }) {
            if (JSON.stringify(options).length > limits.options) throw new Error('The options are larger than the host accepts.');
            // As Konjugate's host does: binary files only for a run that asks for them, and they stay chosen after it.
            const given = [...files.values()].filter((file) => !file.binary || options.useBinaryFiles === true);
            // A test may hold a run open, to look at the window while it waits.
            if (host.holdImport) await host.holdImport;
            const heard = [];
            const reporting = { ...helpers, progress: (progress) => heard.push({ stage: 'import', importerId: 'region', ...progress }) };
            const result = await importRegion({ files: given.map(({ role, name, text, data }) => (data ? { role, name, data } : { role, name, text, encoding: 'utf-8' })), helpers: reporting, options });
            host.progress.push(...heard);
            if (result.data && JSON.stringify(result.data).length > limits.importerData) throw new Error('The importer returned more data than the host accepts.');
            // As Konjugate's host does: what the importer derived takes the place of the files of those roles and of the
            // binary file it read, each a text file of a declared role that is not binary and within the size a file may be.
            if (result.ok && result.derived?.length) {
                for (const item of result.derived) {
                    const declared = manifest.contributes.importers[0].files.find((file) => file.role === item.role);
                    if (!declared || declared.binary || typeof item.text !== 'string') throw new Error('An importer may derive files only of its own roles that are not binary.');
                    if (Buffer.byteLength(item.text) > limits.input) throw new Error('A derived file is larger than the 10 MB limit.');
                }
                for (const [key, file] of files) if (!file.binary && result.derived.some((item) => item.role === file.role)) files.delete(key);
                for (const item of result.derived) files.set(`${item.role}/${item.name}`, { role: item.role, name: item.name, text: item.text, source: item.source });
                host.imported = null;
            }
            if (!result.ok || !result.document) return { imported: false, report: result.report, data: result.data };
            host.imported = { document: result.document, parameterIndex: result.parameterIndex };
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
            return { session, savedAt: session ? new Date().toISOString() : null, inputs: [...files.values()].filter((file) => !file.binary).map(({ role, url, retrievedAt, source }) => ({ role, url, retrievedAt, ...(source ? { derivedFrom: source } : {}) })) };
        },
        // With KONJUGATE_ENGINE=export, a scenario runs as Konjugate's code export writes the model (see
        // tests/engine/harness.mjs): the baseline, and the model with the supplied paths as stored schedules from the fork,
        // which before the fork hold the baseline's values, as a fork from the baseline does. Otherwise there is no engine.
        async runScenario({ supplied, forkAt = 0, runTime, signals = [] }) {
            if (process.env.KONJUGATE_ENGINE !== 'export') throw new Error('No engine in the window test.');
            if (!host.imported) throw new Error('Import your data first.');
            const { runDocument } = await import('../engine/harness.mjs');
            const days = runTime / 86400;
            const branch = async (name, document) => {
                const run = await runDocument(scratch, name, document, days);
                const step = document.runConfigurations[0].outputInterval;
                return Object.fromEntries(document.nodes.map((node) => [node.name, Object.fromEntries(node.states.filter((state) => signals.includes(state.symbol))
                    .map((state) => [state.symbol, run.series(`${node.name}.${state.symbol}`).map((value, index) => [index * step, value])]))]));
            };
            const forked = structuredClone(host.imported.document);
            // `dropChanges`: a host that runs the fork and applies none of its changes, as Konjugate up to 1.1.10 did on a
            // model its engine partitioned.
            for (const [key, { entities, samples }] of host.dropChanges ? [] : Object.entries(supplied?.byParameter ?? {})) {
                for (const entity of entities) {
                    const indexed = host.imported.parameterIndex.find((entry) => entry.key === key && entry.entity === entity);
                    if (!indexed) throw new Error(`No ${key} of ${entity} to change.`);
                    forked.sharedParameters.find((item) => item.id === indexed.sharedParameterId).schedule = { interpolation: 'linear', samples: samples[entity].map(([time, value]) => [forkAt + time, value]) };
                }
            }
            host.scenarioRuns += 1;
            return { forkTime: forkAt, runTime, branches: [{ id: 'baseline', label: 'Baseline', series: await branch('baseline', host.imported.document) }, { id: 'scenario', label: 'Scenario', series: await branch(`scenario${host.scenarioRuns}`, forked) }] };
        }
    };
    const host = {
        files, requests, opened, chosen, cache, kept: 0, imported: null, scenarioRuns: 0, dropChanges: false, progress: [], downloads: {}, busy: 0,
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
    return host;
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
                openLink: (url) => window.logisticsHost('openLink', { url }),
                fetchFile: (importerId, role, url, name, options = {}) => window.logisticsHost('fetchFile', { importerId, role, url, name, cache: options.cache, maximumAgeDays: options.maximumAgeDays }),
                cacheInfo: () => window.logisticsHost('cacheInfo', {}),
                clearCache: () => window.logisticsHost('clearCache', {}),
                keepSession: (session) => window.logisticsHost('keepSession', { session }),
                useSample: (importerId) => window.logisticsHost('useSample', { importerId }),
                runImport: (importerId, options) => window.logisticsHost('runImport', { importerId, options }),
                runScenario: (scenarioId, options) => window.logisticsHost('runScenario', { scenarioId, ...options }),
                openInCanvas: (scenarioId, options = {}) => window.logisticsHost('openInCanvas', { scenarioId, ...options }),
                restoreSession: call('restoreSession'),
                // As Konjugate's host passes them on: what an importer says of its progress, to the window.
                onProgress: (callback) => { window.logisticsProgress = callback; },
                storedFiles: call('storedFiles'),
                storeFiles: (details, options = {}) => window.logisticsHost('storeFiles', { details, accept: options.accept ?? null, title: options.title ?? null }),
                downloadFile: (url, options = {}) => window.logisticsHost('downloadFile', { url, ...options }),
                cancelDownload: (downloadId) => window.logisticsHost('cancelDownload', { downloadId }),
                fileSize: (url) => window.logisticsHost('fileSize', { url }),
                describeStoredFile: (id, details) => window.logisticsHost('describeStoredFile', { id, details }),
                removeStoredFile: (id) => window.logisticsHost('removeStoredFile', { id }),
                useStoredFiles: (importerId, role, ids) => window.logisticsHost('useStoredFiles', { importerId, role, ids })
            });
        });
        page.hostBound = true;
    }
    await page.goto(`http://toolbox.test/index.html${inspect ? '?inspect' : ''}`);
    await page.waitForLoadState('domcontentloaded');
}
