/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Logistics Toolbox window: load the roads of a city or region, place the network on them (suppliers,
// ports, warehouses, stores, dark stores and customer areas, linked as suggested or as the user draws), bring
// in suggestions from public data only when asked, and build a model in Konjugate's canvas. The window only
// names declared things to the host (an importer, a file role, a listed host); the host fetches, reads files
// and runs the importer.

import { MapView } from './mapView.mjs';
import { cityTileKilometres, maximumCityKilometres, maximumSplitDepth, overpassRequests, overpassStatusUrl, overpassUrl, retryDelaysSeconds, retryPauseSeconds, splitRequest, statusWaitSeconds } from './lib/overpass.mjs';
import { nominatimSearchUrl, rankPlaces } from './lib/places.mjs';
import { chokepointById, chokepointDependence, chokepointRecentUrl, chokepoints, chokepointYearlyUrl, disruptionPlan, summariseTransits } from './lib/chokepoints.mjs';
import { portwatchActivityUrl, portwatchPortsUrl } from './lib/portwatch.mjs';
import { closurePlan, demandPlan, diversionPlan, fleetPlan, heldPath, keptOutPlan } from './lib/scenarios.mjs';
import { createNetworkRouter } from './lib/routing.mjs';
import { completeFields, createPin, kindOf, linkId, linkProblem, networkFromSites, networkProblems, networkSelection, pinFromCandidate, roleIds, roles, routeLinks, setField, suggestLinks } from './lib/network.mjs';
import { carriesVehicles, completeCatalogue, createVehicle, defaultCatalogue, linkKind, setVehicleField, typesPerLink, vehicleFields, vehiclesOf } from './lib/vehicles.mjs';
import { writeSites } from './lib/sites.mjs';
import { addsToSelection, commandHeld, platformKeys } from './lib/platform.mjs';

const api = window.konjugateLauncher;
const $ = (selector) => document.querySelector(selector);
const importerId = 'region';
const maximumSpanKilometres = 250;
// What a build may send the host (it accepts 2 MB of options), with room for the settings.
const maximumNetworkBytes = 1.8 * 1024 * 1024;
// What each suggestion source fetches from OpenStreetMap (beside the roads and place names), and the candidates it shows.
const sources = {
    ports: { label: 'Ports', kinds: ['ports'], group: 'ports', portwatch: true },
    warehouses: { label: 'Warehouses', kinds: ['logistics'], group: 'zones' },
    towns: { label: 'Towns', kinds: [], group: 'towns' }
};
const noticeKinds = { ports: ['ports', 'portwatch'], warehouses: ['warehouses'], towns: ['towns'] };
const allRoles = ['roads', 'places', 'ports', 'logistics', 'rail', 'portwatchPorts', 'portwatchActivity'];
const basisLabel = { user: 'yours', assumed: 'assumed', sourced: 'sourced' };

const state = {
    place: null, bbox: null, roadLevel: 'major',
    // The roads step's answer (map, graph, coverage, notices) and the router over its graph.
    roads: null, router: null,
    // The user's network: pins and links, the suggested links the user deleted and what is selected; and the vehicle
    // types its links run on.
    pins: [], links: [], dismissed: new Set(), selection: [], selected: null, listRole: 'all', vehicles: defaultCatalogue(),
    // Suggestions from public data, by source, once asked for; the roles whose answers the host holds.
    suggestions: {}, available: new Set(), sourceTab: null,
    // When the data in hand was fetched, by kind ({ at, cached }), and whether this area was loaded fresh.
    fetchedAt: {}, fresh: false,
    portVolume: null, built: null, busy: false, rebuildTimer: null,
    // The chokepoint disruption: the user's own shares (port name -> { chokepoint id -> share }), the transits
    // fetched per chokepoint, and the last run's summary.
    dependence: new Map(), transits: new Map(), scenario: null,
    // The scenario tab chosen.
    scenarioTab: 'chokepointDisruption',
    // Ports with standby lanes in the model, for cargo diverted to them.
    standby: new Set()
};

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = (value, digits = 0) => Number(value).toLocaleString('en', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const notice = (level, text) => `<div class="notice ${level}">${escape(text)}</div>`;

async function call(promise) {
    const answer = await promise;
    if (!answer?.ok) throw new Error(answer?.message ?? 'The request failed.');
    return answer;
}

const pinById = (id) => state.pins.find((pin) => pin.id === id);
const pinNamed = (name) => state.pins.find((pin) => pin.name === name);

const map = new MapView($('#map'), {
    onAdd: (role, point) => addPin(role, point),
    onMove: (id, lat, lon) => movePins([{ id, lat, lon }]),
    onMoveMany: (moves) => movePins(moves),
    onSelect: (selected, { adding = false } = {}) => select(selected, { adding }),
    onSelectArea: (bounds, { adding }) => selectArea(bounds, { adding }),
    onToggle: (id) => adopt(id),
    onLink: (from, to) => drawLink(from, to),
    onRelink: (id, end, pin) => relink(id, end, pin),
    onView: () => { placePopover(); closeMenu(); },
    onRename: (id) => rename(id),
    onContextMenu: (context) => openMenu(context)
});

// The platform's keys, as its users press and read them: ⌘ and ⌫ on a Mac, Ctrl and Delete on Windows and Linux.
const keys = platformKeys();

// ---- selection and history ----------------------------------------------------------------------------------
// What is selected: pins and links ([{ kind, id }]); the last one selected is the one the card and the popover show.
function setSelection(list) {
    const seen = new Set();
    state.selection = list.filter((item) => item && !seen.has(`${item.kind}:${item.id}`) && seen.add(`${item.kind}:${item.id}`));
    state.selected = state.selection.at(-1) ?? null;
}
const selectedPins = () => state.selection.filter((item) => item.kind === 'pin').map((item) => pinById(item.id)).filter(Boolean);
const selectedLinks = () => state.selection.filter((item) => item.kind === 'link').map((item) => state.links.find((link) => link.id === item.id)).filter(Boolean);

// Every change to the network can be undone, and redone: a copy of the network before each change, the last hundred
// kept. Changes of one kind in quick succession (a pin nudged with the arrow keys, a figure typed) are one step.
const history = { past: [], future: [], lastLabel: null, lastTime: 0 };
const copyLink = (link) => ({ ...link, ...(link.vehicles ? { vehicles: link.vehicles.map((item) => ({ ...item })) } : {}) });
const snapshot = () => ({ pins: structuredClone(state.pins), links: state.links.map(copyLink), dismissed: [...state.dismissed], selection: [...state.selection], vehicles: structuredClone(state.vehicles) });
function checkpoint(label, { merge = false } = {}) {
    const now = performance.now();
    if (merge && label === history.lastLabel && now - history.lastTime < 1500) { history.lastTime = now; return; }
    history.past.push({ label, network: snapshot() });
    if (history.past.length > 100) history.past.shift();
    history.future = [];
    history.lastLabel = label;
    history.lastTime = now;
    renderHistoryButtons();
}
function restore(network) {
    state.pins = structuredClone(network.pins);
    state.links = network.links.map(copyLink);
    state.dismissed = new Set(network.dismissed);
    state.vehicles = structuredClone(network.vehicles);
    renderVehicles();
    setSelection(network.selection.filter((item) => (item.kind === 'pin' ? pinById(item.id) : state.links.some((link) => link.id === item.id))));
    $('#selectionCard').dataset.for = '';
    networkChanged();
    renderSuggestions();
}
function undo() {
    const step = history.past.pop();
    if (!step) return;
    history.future.push({ label: step.label, network: snapshot() });
    history.lastLabel = null;
    restore(step.network);
    renderHistoryButtons();
    toast(`Undone: ${step.label}.`, { redo: true });
}
function redo() {
    const step = history.future.pop();
    if (!step) return;
    history.past.push({ label: step.label, network: snapshot() });
    history.lastLabel = null;
    restore(step.network);
    renderHistoryButtons();
    toast(`Redone: ${step.label}.`);
}
function renderHistoryButtons() {
    $('#undoButtonTool').disabled = !history.past.length;
    $('#redoButtonTool').disabled = !history.future.length;
    $('#undoButtonTool').title = history.past.length ? `Undo ${history.past.at(-1).label} (${keys.undo})` : `Nothing to undo (${keys.undo})`;
    $('#redoButtonTool').title = history.future.length ? `Redo ${history.future.at(-1).label} (${keys.redo})` : `Nothing to redo (${keys.redo})`;
}
$('#undoButtonTool').addEventListener('click', undo);
$('#popoverDelete').title = `Delete it (${keys.delete})`;
$('#redoButtonTool').addEventListener('click', redo);

// A short message at the foot of the map, with Undo (or Redo) beside it for a few seconds.
function toast(text, { undoable = false, redo: offerRedo = false } = {}) {
    clearTimeout(state.toastTimer);
    $('#undoText').textContent = text;
    $('#undoButton').hidden = !undoable;
    $('#redoButton').hidden = !offerRedo;
    $('#undoToast').hidden = false;
    state.toastTimer = setTimeout(() => { $('#undoToast').hidden = true; }, 8000);
}
$('#undoButton').addEventListener('click', undo);
$('#redoButton').addEventListener('click', redo);

// ---- layout, accordion & splitter ---------------------------------------------------------------------

document.querySelectorAll('.stepHeader').forEach((header) => {
    header.addEventListener('click', (event) => {
        // Prevent toggle if clicking on an interactive element inside header
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
        const step = header.closest('.step');
        if (step) step.classList.toggle('collapsed');
        if (step?.id === 'stepScenario') renderMarks();
    });
});

function updateStepSummaries() {
    const regSummary = $('#stepRegionSummary');
    if (regSummary) {
        if (state.place) regSummary.textContent = `${state.place.display_name.split(',')[0]} · ${$('#marginSelect').value} km`;
        else if (state.roads) regSummary.textContent = 'Sample region';
        else regSummary.textContent = '';
    }
    const networkSummary = $('#stepNetworkSummary');
    if (networkSummary) {
        const count = (kind) => state.pins.filter((pin) => kindOf(pin.role) === kind).length;
        networkSummary.textContent = state.pins.length ? `${count('source')} sources · ${count('warehouse')} warehouses · ${count('demand')} demand · ${state.links.length} links` : '';
    }
    const bldSummary = $('#stepBuildSummary');
    if (bldSummary && state.built) {
        bldSummary.textContent = `${state.built.nodes} nodes · ${state.built.edges} edges`;
    }
    const scnSummary = $('#stepScenarioSummary');
    if (scnSummary && state.scenario) {
        const idName = { chokepointDisruption: 'Chokepoint', chokepointDiversion: 'Chokepoint', roadClosure: 'Road closure', fleetChange: 'Fleet', demandSurge: 'Demand' }[state.scenario.id] ?? 'Scenario';
        scnSummary.textContent = `${idName} run`;
    }
}

// Resizable panel splitter
const splitter = $('#splitter');
const panel = $('#panel');
let resizing = false;
let startX = 0;
let startWidth = 0;

if (splitter && panel) {
    splitter.addEventListener('pointerdown', (event) => {
        resizing = true;
        startX = event.clientX;
        startWidth = panel.getBoundingClientRect().width;
        splitter.setPointerCapture(event.pointerId);
        splitter.classList.add('dragging');
        document.body.style.userSelect = 'none';
    });

    splitter.addEventListener('pointermove', (event) => {
        if (!resizing) return;
        const newWidth = Math.max(320, Math.min(800, startWidth + (event.clientX - startX)));
        panel.style.width = `${newWidth}px`;
    });

    const stopResize = (event) => {
        if (!resizing) return;
        resizing = false;
        splitter.classList.remove('dragging');
        document.body.style.userSelect = '';
        try { splitter.releasePointerCapture(event.pointerId); } catch {}
    };
    splitter.addEventListener('pointerup', stopResize);
    splitter.addEventListener('pointercancel', stopResize);
    splitter.addEventListener('dblclick', () => { panel.style.width = '420px'; });
}

$('#zoomInButton')?.addEventListener('click', () => map.zoom(0.75));
$('#zoomOutButton')?.addEventListener('click', () => map.zoom(1.33));
$('#fitButton').addEventListener('click', () => map.fit());

// ---- the map: a place, its roads ----------------------------------------------------------------------

function boundsAround(place, marginKilometres) {
    const [south, north, west, east] = place.boundingbox.map(Number);
    const dLat = marginKilometres / 111.32;
    const dLon = marginKilometres / (111.32 * Math.cos((south + north) / 2 * Math.PI / 180));
    return { south: south - dLat, north: north + dLat, west: west - dLon, east: east + dLon };
}

function spanOf(bbox) {
    const height = (bbox.north - bbox.south) * 111.32;
    const width = (bbox.east - bbox.west) * 111.32 * Math.cos((bbox.south + bbox.north) / 2 * Math.PI / 180);
    return { width, height };
}

function showArea() {
    if (!state.place) return;
    state.bbox = boundsAround(state.place, Number($('#marginSelect').value));
    const { width, height } = spanOf(state.bbox);
    const city = $('#roadLevelSelect').value === 'city';
    const limit = city ? maximumCityKilometres : maximumSpanKilometres;
    const tooLarge = Math.max(width, height) > limit;
    $('#areaSize').innerHTML = tooLarge
        ? `<span style="color:var(--danger)">${number(width)} × ${number(height)} km: too large${city ? ` for city streets, which are loaded for areas up to ${limit} km across; choose major roads, or a smaller place or area` : `. Public map servers answer areas up to ${limit} km across; choose a smaller place or area`}.</span>`
        : `${number(width)} × ${number(height)} km${Math.max(width, height) > (city ? 2 * cityTileKilometres : 120) ? '. A large area: loading may take a minute.' : ''}`;
    $('#fetchButton').disabled = tooLarge || state.busy;
    $('#freshButton').disabled = tooLarge || state.busy;
}

$('#searchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = $('#searchInput').value.trim();
    if (!query) return;
    $('#regionStatus').innerHTML = '';
    $('#searchButton').disabled = true;
    try {
        const { text } = await call(api.fetchText(nominatimSearchUrl(query)));
        const places = rankPlaces(JSON.parse(text));
        const list = $('#searchResults');
        list.hidden = false;
        list.innerHTML = places.length
            // The kind of area as well as its type: two administrative areas of one name (Rotterdam the city and the
            // municipality, which reaches its port at the sea) otherwise look the same.
            ? places.map((place, index) => `<li><button type="button" data-index="${index}">${escape(place.display_name)} <span class="kind">${escape(place.type ?? '')}${place.addresstype && place.addresstype !== place.type ? ` · ${escape(place.addresstype)}` : ''}</span></button></li>`).join('')
            : '<li><button type="button" disabled>No place found by that name.</button></li>';
        list.querySelectorAll('button[data-index]').forEach((button) => button.addEventListener('click', () => {
            state.place = places[Number(button.dataset.index)];
            list.hidden = true;
            $('#chosenRegion').hidden = false;
            $('#chosenName').textContent = state.place.display_name;
            showArea();
        }));
    } catch (error) {
        $('#regionStatus').innerHTML = notice('error', `The place search failed: ${error.message}`);
    } finally {
        $('#searchButton').disabled = false;
    }
});
$('#marginSelect').addEventListener('change', showArea);
$('#roadLevelSelect').addEventListener('change', showArea);

const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
// The host reports a busy server by its status (429, 502 to 504) or a timeout: worth trying again after a pause.
const busy = (message) => /answered (429|50[234])|did not answer within/.test(message);
// How long the map server says to wait for a free slot; null when its status page says nothing usable.
async function serverWait() {
    try {
        return statusWaitSeconds((await call(api.fetchText(overpassStatusUrl()))).text);
    } catch {
        return null;
    }
}
const countdown = async (row, seconds, why) => {
    for (let left = seconds; left > 0; left -= 1) {
        row.querySelector('.state').textContent = `${why}, trying again in ${left} s`;
        await wait(1);
    }
};

const labels = { ports: 'Ports and anchorages', logistics: 'Warehouses and industrial land', roads: 'Roads', rail: 'Rail', places: 'Place names' };

// Map data is kept in Konjugate's cache of what this add-on fetched (on disk, kept across reinstalls), so an area loaded
// once loads again at once and offline. Data older than this is fetched again; Load fresh fetches it all again now.
const cacheDays = 30;
const fetchMode = (fresh) => ({ cache: fresh ? 'refresh' : 'use', maximumAgeDays: cacheDays });
const dateOf = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
// When the data in hand was fetched, by kind: the oldest part of each, and whether it came from the cache.
const fetched = (kind, answer) => {
    const known = state.fetchedAt[kind];
    state.fetchedAt[kind] = { at: !known || answer.retrievedAt < known.at ? answer.retrievedAt : known.at, cached: (known?.cached ?? true) && Boolean(answer.cached) };
};

// Fetches some kinds of OpenStreetMap data for the region, one request at a time (the public server is shared), with
// a row of `progress` per kind. Tiles too large or too slow are fetched again as quarters; a busy server is waited for.
// Answers from the cache need no server: the server's status is asked only once one answer has come from it.
async function fetchKinds(kinds, progress, { fresh = false } = {}) {
    const requests = overpassRequests(state.bbox, { kinds, roadLevel: state.roadLevel });
    const bytes = {};
    const fromCache = {};
    const parts = {};
    let live = false;
    for (const kind of kinds) delete state.fetchedAt[kind];
    const queue = [...requests];
    while (queue.length) {
        const request = queue.shift();
        const row = progress.querySelector(`[data-kind="${request.kind}"]`);
        const label = request.parts > 1 || request.depth ? `part ${request.part} of ${request.parts}` : 'fetching';
        for (let attempt = 0; ; attempt += 1) {
            if (live || attempt > 0) {
                const before = await serverWait();
                if (before > 0) await countdown(row, before + 1, 'waiting for a free slot');
            }
            row.querySelector('.state').textContent = `${label}…`;
            try {
                const answer = await call(api.fetchFile(importerId, request.kind, overpassUrl(request.query), `${request.kind}-${request.part}.json`, fetchMode(fresh)));
                bytes[request.kind] = (bytes[request.kind] ?? 0) + answer.bytes;
                parts[request.kind] = (parts[request.kind] ?? 0) + 1;
                if (answer.cached) fromCache[request.kind] = (fromCache[request.kind] ?? 0) + 1;
                else live = true;
                fetched(request.kind, answer);
                break;
            } catch (error) {
                // Too large to accept, or too slow to answer in time: fetch the tile again as four quarters.
                if (/larger than the size limit|did not answer within/.test(error.message) && request.depth < maximumSplitDepth) {
                    queue.unshift(...splitRequest(request));
                    break;
                }
                if (!busy(error.message) || attempt >= retryDelaysSeconds.length) {
                    row.classList.add('failed');
                    row.querySelector('.state').textContent = 'failed';
                    throw new Error(`${labels[request.kind]}: ${error.message}${/larger than the size limit/.test(error.message) ? ' Choose a smaller area.' : busy(error.message) ? ' The public map server is overloaded; try again later, or choose a smaller area.' : ''}`);
                }
                await countdown(row, retryPauseSeconds(attempt, await serverWait()), `server busy (${attempt + 1} of ${retryDelaysSeconds.length})`);
            }
        }
        if (!queue.some((next) => next.kind === request.kind) && bytes[request.kind] !== undefined) {
            row.classList.add('done');
            const kept = fromCache[request.kind] ?? 0;
            row.querySelector('.state').textContent = kept === parts[request.kind]
                ? `from the cache, fetched ${dateOf(state.fetchedAt[request.kind].at)}`
                : `${number(bytes[request.kind] / 1024)} KB${kept ? ` (${kept} of ${parts[request.kind]} parts from the cache)` : ''}`;
            state.available.add(request.kind);
        }
    }
    renderCacheSummary();
}

// When the map data in hand was fetched, and a way to fetch it fresh.
function renderDataAge() {
    const roads = state.fetchedAt.roads;
    $('#dataAge').hidden = !roads;
    if (!roads) return;
    $('#dataAgeText').textContent = `Roads fetched on ${dateOf(roads.at)}${roads.cached ? ', from the cache' : ''}.`;
}

// How much the cache of fetched maps holds, and clearing it.
async function renderCacheSummary() {
    if (!api?.cacheInfo) { $('#cacheRow').hidden = true; return; }
    try {
        const info = await call(api.cacheInfo());
        $('#cacheRow').hidden = false;
        $('#cacheSummary').textContent = info.entries
            ? `Maps kept on this computer: ${number(info.bytes / 1048576, 1)} MB, fetched from ${dateOf(info.oldest)}${info.newest && dateOf(info.newest) !== dateOf(info.oldest) ? ` to ${dateOf(info.newest)}` : ''}.`
            : 'No maps kept on this computer yet: an area loaded is kept, to load again at once and offline.';
        $('#clearCacheButton').hidden = !info.entries;
    } catch {
        $('#cacheRow').hidden = true;
    }
}
$('#clearCacheButton').addEventListener('click', async () => {
    try {
        const before = await call(api.cacheInfo());
        await call(api.clearCache());
        toast(`Cleared ${number(before.bytes / 1048576, 1)} MB of kept maps. What is loaded now stays until you load it again.`);
    } catch (error) {
        toast(`The kept maps could not be cleared: ${error.message}`);
    }
    renderCacheSummary();
});

$('#fetchButton').addEventListener('click', () => loadArea({ fresh: false }));
$('#freshButton').addEventListener('click', () => loadArea({ fresh: true }));
$('#dataAgeFresh').addEventListener('click', () => loadArea({ fresh: true }));

// Loads the roads and place names of the area chosen: from the cache where it holds them, or (fresh) all from the map
// servers. Suggestions asked for afterwards follow suit.
async function loadArea({ fresh }) {
    if (!state.bbox || state.busy) return;
    setBusy(true);
    state.fresh = fresh;
    state.roadLevel = $('#roadLevelSelect').value;
    const progress = $('#fetchProgress');
    progress.hidden = false;
    progress.innerHTML = ['roads', 'places'].map((kind) => `<li data-kind="${kind}"><span>${state.roadLevel === 'city' && kind === 'roads' ? 'Roads and city streets' : labels[kind]}</span><span class="state">waiting</span></li>`).join('');
    $('#regionStatus').innerHTML = '';
    try {
        // A new region replaces the last one's data, suggestions included (your own sites file stays).
        for (const role of allRoles) await call(api.clearFile(importerId, role));
        state.available.clear();
        state.suggestions = {};
        state.sample = false;
        await fetchKinds(['roads', 'places'], progress, { fresh });
        await loadRoads({ keepNetwork: true });
        renderDataAge();
    } catch (error) {
        $('#regionStatus').innerHTML = notice('error', error.message);
    } finally {
        setBusy(false);
    }
}

// The roads step: the map and the road graph the network is routed over. A network already placed is kept where it
// lies within the new map, so the roads can be loaded again (city streets after major roads, say).
async function loadRoads({ keepNetwork = false } = {}) {
    const answer = await call(api.runImport(importerId, { step: 'roads', roadLevel: state.roadLevel, ...(state.bbox ? { bbox: state.bbox } : {}) }));
    if (answer.report?.errors?.length) throw new Error(answer.report.errors.join(' '));
    state.roads = answer.data;
    const started = performance.now();
    state.router = createNetworkRouter(answer.data.graph);
    state.routerMilliseconds = performance.now() - started;
    state.portVolume ??= answer.data.defaults.portTeuPerDay;
    $('#portVolume').value = state.portVolume;
    const bbox = answer.data.map.bbox;
    const inside = (pin) => pin.lat >= bbox.south && pin.lat <= bbox.north && pin.lon >= bbox.west && pin.lon <= bbox.east;
    const outside = keepNetwork ? state.pins.filter((pin) => !inside(pin)) : state.pins;
    if (outside.length) {
        const gone = new Set(outside.map((pin) => pin.id));
        state.pins = state.pins.filter((pin) => !gone.has(pin.id));
        state.links = state.links.filter((link) => !gone.has(link.from) && !gone.has(link.to));
        if (keepNetwork) $('#regionStatus').insertAdjacentHTML('beforeend', notice('warning', `${outside.map((pin) => pin.name).join(', ')} ${outside.length === 1 ? 'lies' : 'lie'} outside the new map, so ${outside.length === 1 ? 'it was' : 'they were'} taken off the network.`));
    }
    // Every leg is routed again over these roads.
    for (const link of state.links) delete link.ends;
    $('#mapEmpty').hidden = true;
    $('#attribution').textContent = answer.data.map.attribution;
    map.setOverlay(null);
    map.setMap(answer.data.map);
    const borders = answer.data.map.geography?.borders ?? [];
    $('#legendBorder').hidden = !borders.some((border) => border.settled);
    $('#legendUnsettled').hidden = !borders.some((border) => !border.settled);
    renderCoverage();
    for (const section of ['#stepNetwork', '#stepBuild']) $(section).hidden = false;
    $('#stepRegion').classList.add('completed');
    $('#saveSitesButton').disabled = false;
    renderSuggestions();
    if (!state.restoring) networkChanged({ rebuild: Boolean(state.built) });
}

function renderCoverage() {
    const roads = state.roads?.coverage?.roads;
    const box = $('#coverageSummary');
    box.hidden = !roads;
    if (!roads) return;
    const level = (value) => (value ? `<span class="level ${value}">${value}</span>` : '');
    const byClass = Object.entries(roads.byClass ?? {}).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, value]) => `${name} ${number(value)}`).join(', ');
    box.innerHTML = [
        ['Roads', `${number(roads.kilometres)} km${byClass ? ` (${byClass})` : ''}`, roads.level],
        ['Place names', `${number(state.roads.coverage.places)} cities, towns and suburbs`, null],
        ['Routing', `${number(state.roads.graph.vertices.length)} junctions${state.routerMilliseconds !== undefined ? `, ready in ${number(state.routerMilliseconds)} ms` : ''}`, null]
    ].map(([title, text, value]) => `<div class="item"><b>${title}${level(value)}</b><span>${escape(text)}</span></div>`).join('');
    $('#notices').innerHTML = (state.roads.notices ?? []).map((item) => notice(item.level, item.text)).join('');
}

$('#sampleButton').addEventListener('click', async () => {
    setBusy(true);
    try {
        await call(api.useSample(importerId));
        state.place = null;
        state.bbox = null;
        state.sample = true;
        // The sample holds every kind of data, so its suggestions need no fetch; none is shown until asked for.
        state.available = new Set(allRoles.filter((role) => !role.startsWith('portwatch')));
        state.suggestions = {};
        $('#chosenRegion').hidden = true;
        $('#fetchProgress').hidden = true;
        $('#regionStatus').innerHTML = notice('ok', 'The sample region: a made-up stretch of coast, for trying the toolbox without a network.');
        resetNetwork();
        await loadRoads();
    } catch (error) {
        $('#regionStatus').innerHTML = notice('error', error.message);
    } finally {
        setBusy(false);
    }
});

// ---- the network: pins and links ----------------------------------------------------------------------

function resetNetwork() {
    state.pins = [];
    state.links = [];
    state.dismissed.clear();
    setSelection([]);
    history.past = [];
    history.future = [];
    renderHistoryButtons();
    state.built = null;
    state.scenario = null;
    map.setFlows(null);
    $('#buildResult').innerHTML = '';
    $('#buildStatus').innerHTML = '';
}

// A pin is far from the roads when its access leg is long: its legs are estimates more than routes.
const farMetres = 2000;
function snapOf(pin) {
    const snapped = state.router?.snap(pin);
    return snapped ? snapped.metres : null;
}

// Everything that follows a change to the network: links suggested and routed again (only the legs whose ends moved),
// the map, the lists and the card redrawn and the model marked out of date (and rebuilt, when kept in step).
function networkChanged({ rebuild = true } = {}) {
    if (state.router) {
        state.links = suggestLinks(state.pins, state.links, state.router, state.dismissed);
        const started = performance.now();
        state.lastRouted = { legs: routeLinks(state.pins, state.links, state.router), milliseconds: performance.now() - started };
    }
    renderNetwork();
    updateStepSummaries();
    keepSessionSoon();
    const errors = networkProblems(state.pins, state.links, state.vehicles).filter((problem) => problem.level === 'error');
    $('#buildButton').disabled = state.busy || errors.length > 0 || !state.pins.length;
    $('#buildStatus').innerHTML = errors.length && state.pins.length ? notice('warning', 'Resolve what Network lists to build a model.') : '';
    if (state.built) {
        $('#buildStatus').innerHTML += notice('warning', 'The model no longer matches the network.');
        // Counted, so a rebuild queued behind other work runs only if something changed after the last build began.
        state.edits = (state.edits ?? 0) + 1;
        if (rebuild && $('#keepInStep').checked && !errors.length) {
            clearTimeout(state.rebuildTimer);
            state.rebuildTimer = setTimeout(() => build({ focus: false }), 600);
        }
    }
}

const legHow = (leg) => ({ routed: 'over the roads', local: 'by local streets (the sites are close)', 'straight-line': 'as a straight-line estimate (no road route found)' })[leg.basis] ?? '';

function renderNetwork() {
    const problems = networkProblems(state.pins, state.links, state.vehicles);
    const troubled = new Set(problems.filter((problem) => problem.level === 'error').flatMap((problem) => problem.pins));
    const adopted = new Set(state.pins.map((pin) => pin.candidate?.id).filter(Boolean));
    const roleOfGroup = { ports: 'port', zones: 'warehouse', towns: 'customerArea' };
    const suggestions = Object.entries(state.suggestions).flatMap(([source, found]) => (found.candidates?.[sources[source].group] ?? [])
        .filter((candidate) => !adopted.has(candidate.id))
        .map((candidate) => ({ id: candidate.id, role: roleOfGroup[sources[source].group], name: candidate.name, lat: candidate.lat, lon: candidate.lon, kept: false })));
    map.setSites([
        ...suggestions,
        ...state.pins.map((pin) => {
            const metres = snapOf(pin);
            const far = !state.router ? null : metres === null ? 'too far from any road: its legs are straight-line estimates' : metres > farMetres ? `${number(metres / 1000, 1)} km from the nearest road` : null;
            return { id: pin.id, role: pin.role, name: pin.name, lat: pin.lat, lon: pin.lon, kept: true, problem: troubled.has(pin.id), far };
        })
    ]);
    const unused = new Set((state.built?.unusedLinks ?? []).map((item) => `${item.from}>${item.to}`));
    map.setLinks(state.links.map((link) => {
        const from = pinById(link.from);
        const to = pinById(link.to);
        const leg = link.leg;
        return {
            id: link.id, from: link.from, to: link.to, basis: link.basis, points: leg?.path?.points ?? null,
            unused: Boolean(from && to && unused.has(`${from.name}>${to.name}`)),
            title: leg ? `${number(leg.kilometres, 1)} km, ${number(leg.hours, 1)} h ${legHow(leg)}; ${link.basis === 'user' ? 'your link' : 'suggested'}${vehicleWords(link)}` : ''
        };
    }));
    map.setSelected(state.selection);
    renderNetworkStatus(problems);
    showPortSettings();
    renderPinList(troubled);
    renderCard();
    renderPopover();
    renderVehicles();
    renderMarks();
}

// Beside what is selected on the map: its name, to rename it there, and Delete.
function renderPopover() {
    const popover = $('#pinPopover');
    const pin = state.selected?.kind === 'pin' ? pinById(state.selected.id) : null;
    const link = state.selected?.kind === 'link' ? state.links.find((item) => item.id === state.selected.id) : null;
    // Not while placing pins: it would sit where the next one goes.
    popover.hidden = (!pin && !link) || Boolean(map.addKind);
    if (popover.hidden) return;
    const name = $('#popoverName');
    const several = state.selection.length > 1;
    name.hidden = !pin || several;
    if (pin && document.activeElement !== name) name.value = pin.name;
    $('#popoverRole').textContent = several ? `${state.selection.length} selected` : pin ? roles[pin.role].label : `${pinById(link.from)?.name ?? ''} → ${pinById(link.to)?.name ?? ''}`;
    popover.dataset.for = state.selected.id;
    placePopover();
}

function placePopover() {
    const popover = $('#pinPopover');
    if (popover.hidden || !state.selected) return;
    const pin = state.selected.kind === 'pin' ? pinById(state.selected.id) : null;
    const link = state.selected.kind === 'link' ? state.links.find((item) => item.id === state.selected.id) : null;
    const at = pin ?? (link && pinById(link.to));
    const screen = at ? map.toScreen(at.lat, at.lon) : null;
    if (!screen) { popover.hidden = true; return; }
    // Placed within the map area (an SVG has no offsetTop: measured from both rectangles instead).
    const area = $('.mapArea').getBoundingClientRect();
    const rect = $('#map').getBoundingClientRect();
    const left = Math.max(4, Math.min(rect.width - popover.offsetWidth - 4, screen.x + 16));
    const top = Math.max(4, screen.y - popover.offsetHeight - 14);
    popover.style.left = `${rect.left - area.left + left}px`;
    popover.style.top = `${rect.top - area.top + top}px`;
}

$('#popoverName').addEventListener('change', () => {
    const pin = state.selected?.kind === 'pin' ? pinById(state.selected.id) : null;
    if (pin) renamePin(pin, $('#popoverName').value);
});
// Enter keeps the new name; Escape puts the old one back. Either way the keyboard goes back to the map.
$('#popoverName').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        const pin = state.selected?.kind === 'pin' ? pinById(state.selected.id) : null;
        if (pin) $('#popoverName').value = pin.name;
    }
    if (event.key === 'Enter' || event.key === 'Escape') { event.stopPropagation(); $('#popoverName').blur(); }
});
$('#popoverDelete').addEventListener('click', () => deleteSelected());

function renderPinList(troubled) {
    const counts = Object.fromEntries(roleIds.map((role) => [role, state.pins.filter((pin) => pin.role === role).length]));
    const shown = ['all', ...roleIds.filter((role) => counts[role])];
    if (!shown.includes(state.listRole)) state.listRole = 'all';
    $('#roleTabs').innerHTML = shown.map((role) => `<button type="button" role="tab" data-role="${role}" class="${state.listRole === role ? 'active' : ''}">${role === 'all' ? 'All' : roles[role].label} <span class="count" data-count="${role}">${role === 'all' ? state.pins.length : counts[role]}</span></button>`).join('');
    $('#roleTabs').hidden = !state.pins.length;
    $('#roleTabs').querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { state.listRole = button.dataset.role; renderNetwork(); }));
    const listed = state.pins.filter((pin) => state.listRole === 'all' || pin.role === state.listRole);
    $('#pinList').innerHTML = listed.map((pin) => {
        const into = state.links.filter((link) => link.to === pin.id).map((link) => pinById(link.from)?.name).filter(Boolean);
        const first = roles[pin.role].fields[0];
        const field = pin.fields[first.key];
        const figure = field?.value !== null && field?.value !== undefined ? `${number(field.value)} ${first.unit}${field.basis === 'assumed' ? ' (assumed)' : ''}` : '';
        return `<li data-id="${escape(pin.id)}" class="${state.selection.some((item) => item.id === pin.id) ? 'selected' : ''}${troubled.has(pin.id) ? ' problem' : ''}">
            <i class="swatch ${pin.role}"></i><span class="name" title="${escape(pin.name)}">${escape(pin.name)}</span><span class="muted small">${escape(figure)}</span>
            <span class="detail">${escape(roles[pin.role].label)}${into.length ? ` · from ${into.join(', ')}` : ''}${pin.basis === 'sourced' ? ' · from OpenStreetMap' : ''}</span>
        </li>`;
    }).join('');
    $('#pinList').querySelectorAll('li').forEach((row) => {
        row.addEventListener('click', (event) => select({ kind: 'pin', id: row.dataset.id }, { adding: addsToSelection(event, keys) }));
        row.addEventListener('dblclick', () => rename(row.dataset.id));
        row.addEventListener('mouseenter', () => map.setHighlight(row.dataset.id));
        row.addEventListener('mouseleave', () => map.setHighlight(null));
    });
}

// A pin or link clicked: selected alone, or (with Shift, Cmd or Ctrl) added to the selection, or taken out of it. While
// a link is being drawn from the menu (Link to...), the pin clicked is where it goes.
// The Network step's status: for a network not yet begun, the steps to take, ticked off as they are done (no errors for
// what a newcomer has not had the chance to do yet); then what stops a build, and what to know.
function renderNetworkStatus(problems) {
    const has = (kind) => state.pins.some((pin) => kindOf(pin.role) === kind);
    const steps = [
        ['source', 'Place where goods come from: a supplier (1) or a port (2).'],
        ['warehouse', 'Place a warehouse (3).'],
        ['demand', 'Place stores (4), dark stores (5) or customer areas (6). Links appear on their own.']
    ];
    const starting = steps.some(([kind]) => !has(kind));
    const missing = /^Place (a supplier|a warehouse|a store)/;
    $('#networkStatus').innerHTML = (starting && state.roads ? `<ol class="checklist">${steps.map(([kind, text]) => `<li class="${has(kind) ? 'done' : ''}">${escape(text)}</li>`).join('')}</ol>` : '')
        + problems.filter((problem) => !(starting && missing.test(problem.text))).map((problem) => notice(problem.level, problem.text)).join('');
    const errors = problems.filter((problem) => problem.level === 'error');
    $('#buildButton').title = errors.length ? `Not yet: ${errors[0].text}` : 'Build the model from the network (it opens in the canvas)';
}

function select(selected, { adding = false } = {}) {
    if (state.linkFrom && selected?.kind === 'pin') {
        const from = state.linkFrom;
        stopLinking();
        // That click finished the link: the next one on this pin is not the second of a double click.
        map.lastClick = null;
        if (from !== selected.id) drawLink(from, selected.id);
        return;
    }
    stopLinking();
    if (adding && selected) {
        const has = state.selection.some((item) => item.kind === selected.kind && item.id === selected.id);
        setSelection(has ? state.selection.filter((item) => !(item.kind === selected.kind && item.id === selected.id)) : [...state.selection, selected]);
    } else {
        setSelection(selected ? [selected] : []);
    }
    renderNetwork();
}

// Every pin in a box drawn on the map with Shift.
function selectArea(bounds, { adding }) {
    const inside = state.pins.filter((pin) => pin.lat >= bounds.south && pin.lat <= bounds.north && pin.lon >= bounds.west && pin.lon <= bounds.east).map((pin) => ({ kind: 'pin', id: pin.id }));
    setSelection(adding ? [...state.selection, ...inside] : inside);
    renderNetwork();
}

function selectAll() {
    setSelection(state.pins.map((pin) => ({ kind: 'pin', id: pin.id })));
    renderNetwork();
}

function addPin(role, point) {
    checkpoint(`placing a ${roles[role].label.toLowerCase()}`);
    const pin = createPin(role, point, { pins: state.pins });
    state.pins.push(pin);
    setSelection([{ kind: 'pin', id: pin.id }]);
    networkChanged();
}

function movePins(moves, { label = null, merge = false } = {}) {
    const pins = moves.map((move) => pinById(move.id)).filter(Boolean);
    if (!pins.length) return;
    checkpoint(label ?? `moving ${pins.length === 1 ? pins[0].name : `${pins.length} sites`}`, { merge });
    for (const move of moves) Object.assign(pinById(move.id) ?? {}, { lat: move.lat, lon: move.lon });
    networkChanged();
}

// The selected pins moved a few pixels with the arrow keys (Shift: further).
function nudge(dx, dy, far) {
    const pins = selectedPins();
    if (!pins.length) return;
    const kilometres = map.unit() * (far ? 50 : 8);
    const moves = pins.map((pin) => ({ id: pin.id, lat: pin.lat - dy * kilometres / 111.32, lon: pin.lon + dx * kilometres / (111.32 * Math.cos(pin.lat * Math.PI / 180)) }));
    movePins(moves, { label: `moving ${pins.length === 1 ? pins[0].name : `${pins.length} sites`}`, merge: true });
}

// Copies of the selected pins beside them, with their figures, as the user's own sites; selected, to be moved.
function duplicateSelected() {
    const pins = selectedPins();
    if (!pins.length) return;
    checkpoint(`duplicating ${pins.length === 1 ? pins[0].name : `${pins.length} sites`}`);
    const offset = map.unit() * 24;
    const copies = pins.map((pin) => {
        const copy = createPin(pin.role, { lat: pin.lat - offset / 111.32, lon: pin.lon + offset / (111.32 * Math.cos(pin.lat * Math.PI / 180)) }, {
            pins: state.pins, name: copyName(pin.name),
            fields: Object.fromEntries(Object.entries(pin.fields).filter(([, field]) => field.basis === 'user').map(([key, field]) => [key, field.value]))
        });
        state.pins.push(copy);
        return copy;
    });
    setSelection(copies.map((pin) => ({ kind: 'pin', id: pin.id })));
    networkChanged();
}
function copyName(name) {
    for (let index = 2; ; index += 1) {
        const candidate = `${name.replace(/ \(\d+\)$/, '')} (${index})`;
        if (!pinNamed(candidate)) return candidate;
    }
}

function rename(id) {
    stopLinking();
    setAddRole(null);
    setSelection([{ kind: 'pin', id }]);
    renderNetwork();
    $('#popoverName').focus();
    $('#popoverName').select();
}

// Link to...: the next pin clicked is where the link goes.
function startLinking(id) {
    state.linkFrom = id;
    $('#mapHint').hidden = false;
    $('#mapHint').textContent = `Click the site to link ${pinById(id)?.name} to. Escape to cancel.`;
}
function stopLinking() {
    if (!state.linkFrom) return;
    state.linkFrom = null;
    $('#mapHint').hidden = !map.addKind;
}

// What a pin keeps of the candidate it was adopted from: what the window shows and the scenarios use (the importer reads
// the rest again from the map data when it builds).
function slimCandidate(candidate) {
    const keep = ['id', 'name', 'lat', 'lon', 'areaSquareKilometres', 'commercial', 'anchorages', 'portwatch', 'chokepoints', 'floorAreaSquareMetres', 'floorAreaBasis', 'buildings', 'population', 'populationBasis', 'city'];
    const slim = Object.fromEntries(keep.filter((key) => candidate[key] !== undefined).map((key) => [key, candidate[key]]));
    if (candidate.activity) {
        const { importTonnesPerDay, containerCallsPerDay, from, to, shift } = candidate.activity;
        slim.activity = { importTonnesPerDay, containerCallsPerDay, from, to, ...(shift ? { shift } : {}) };
    }
    return slim;
}

function adoptCandidate(candidate, group) {
    if (state.pins.some((pin) => pin.candidate?.id === candidate.id)) return null;
    const pin = pinFromCandidate(slimCandidate(candidate), group, state.pins);
    // A town and a port of one name (Port Alder the port, Port Alder the town) are two sites.
    if (pinNamed(pin.name)) pin.name = `${pin.name} (${roles[pin.role].label.toLowerCase()})`;
    state.pins.push(pin);
    return pin;
}

// A suggestion clicked on the map, or adopted from the list: a pin with what was found there.
function adopt(candidateId) {
    for (const [source, found] of Object.entries(state.suggestions)) {
        const group = sources[source].group;
        const candidate = found.candidates?.[group]?.find((item) => item.id === candidateId);
        if (!candidate) continue;
        checkpoint(`adopting ${candidate.name}`);
        const pin = adoptCandidate(candidate, group);
        if (pin) setSelection([{ kind: 'pin', id: pin.id }]);
        networkChanged();
        renderSuggestions();
        return;
    }
}

// A link drawn by the user. Drawing into a site makes the links already suggested into it the user's too: the user is
// now choosing what supplies it, and the others are not taken away.
// A link that cannot be is refused where the user is looking (the map) and in the Network step.
function refuse(problem) {
    toast(problem);
    $('#networkStatus').insertAdjacentHTML('afterbegin', notice('error', problem));
}

function drawLink(fromId, toId, { record = true } = {}) {
    const problem = linkProblem(pinById(fromId), pinById(toId));
    if (problem) {
        refuse(problem);
        return;
    }
    if (record) checkpoint(`linking ${pinById(fromId).name} to ${pinById(toId).name}`);
    const id = linkId(fromId, toId);
    state.dismissed.delete(id);
    for (const link of state.links) if (link.to === toId) link.basis = 'user';
    const existing = state.links.find((link) => link.id === id);
    if (existing) existing.basis = 'user';
    else state.links.push({ id, from: fromId, to: toId, basis: 'user' });
    setSelection([{ kind: 'link', id }]);
    networkChanged();
}

// One end of a link dragged to another site.
function relink(id, end, pinId) {
    const link = state.links.find((item) => item.id === id);
    if (!link) return;
    const from = end === 'from' ? pinId : link.from;
    const to = end === 'to' ? pinId : link.to;
    if (from === link.from && to === link.to) return;
    const problem = linkProblem(pinById(from), pinById(to));
    if (problem) {
        refuse(problem);
        return;
    }
    checkpoint(`moving the link from ${pinById(link.from)?.name} to ${pinById(link.to)?.name}`);
    removeLink(link);
    drawLink(from, to, { record: false });
}

function removeLink(link) {
    state.links = state.links.filter((item) => item !== link);
    // A suggested link the user took away is not suggested again; and the other links into its site are the user's now.
    state.dismissed.add(link.id);
    for (const other of state.links) if (other.to === link.to) other.basis = 'user';
}

function removePin(pin) {
    state.pins = state.pins.filter((item) => item !== pin);
    state.links = state.links.filter((link) => link.from !== pin.id && link.to !== pin.id);
    setSelection(state.selection.filter((item) => item.id !== pin.id));
}

// Everything selected deleted at once (a pin with its links), as one step to undo.
function deleteSelected() {
    const pins = selectedPins();
    const links = selectedLinks().filter((link) => !pins.some((pin) => pin.id === link.from || pin.id === link.to));
    if (!pins.length && !links.length) return;
    const what = pins.length + links.length > 1
        ? [pins.length ? `${pins.length} site${pins.length === 1 ? '' : 's'}` : '', links.length ? `${links.length} link${links.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')
        : pins.length ? pins[0].name : `the link from ${pinById(links[0].from)?.name} to ${pinById(links[0].to)?.name}`;
    checkpoint(`deleting ${what}`);
    for (const link of links) removeLink(link);
    for (const pin of pins) removePin(pin);
    setSelection([]);
    networkChanged();
    renderSuggestions();
    toast(`Deleted ${what}.`, { undoable: true });
}

// ---- the vehicles on the links -----------------------------------------------------------------------------------
// A link's kind for its vehicles (supply, store, dark store, customer area), and the vehicles it runs on.
const kindOfLink = (link) => linkKind(pinById(link.from)?.role, pinById(link.to)?.role);
const linkVehicles = (link) => vehiclesOf(link, kindOfLink(link), state.vehicles);
const typeNamed = (id) => state.vehicles.find((type) => type.id === id);
// May this type carry this link: anything to a warehouse; to a store or dark store only what may deliver to stores.
const typeAllowed = (type, link) => kindOfLink(link) === 'supply' || type.toStores;
// "; on medium trucks" for a link's title on the map.
function vehicleWords(link) {
    const carried = linkVehicles(link);
    if (!carried.length) return kindOfLink(link) === 'customerArea' ? '; by a delivery service' : '';
    return `; on ${carried.map((item) => `${typeNamed(item.type)?.name.toLowerCase()}s`).join(' and ')}`;
}

// The links given carried by `typeId` (as their first type, keeping a second that differs), each made the user's: one
// step to undo. Links that carry no vehicles, or may not take that type, are left as they are and said so.
function carryBy(links, typeId) {
    const type = typeNamed(typeId);
    if (!type) return;
    const able = links.filter((link) => carriesVehicles(kindOfLink(link)) && typeAllowed(type, link));
    const left = links.length - able.length;
    if (!able.length) {
        refuse(links.length === 1 && carriesVehicles(kindOfLink(links[0])) ? `${type.name} may not deliver to stores: choose another vehicle.` : 'Deliveries to a customer area have no vehicles of their own.');
        return;
    }
    checkpoint(`carrying ${able.length === 1 ? `${pinById(able[0].from)?.name} → ${pinById(able[0].to)?.name}` : `${able.length} links`} by ${type.name.toLowerCase()}`);
    for (const link of able) {
        const second = linkVehicles(link)[1];
        link.vehicles = [{ type: typeId, fleet: null }, ...(second && second.type !== typeId ? [second] : [])];
        link.basis = 'user';
    }
    $('#selectionCard').dataset.for = '';
    networkChanged();
    toast(`${able.length === 1 ? 'The link is' : `${able.length} links are`} carried by ${type.name.toLowerCase()}s${left ? `; ${left} other${left === 1 ? '' : 's'} left as ${left === 1 ? 'it was' : 'they were'}` : ''}.`, { undoable: true });
}

// One of a link's vehicles changed on its card: its type, its fleet (empty: sized by the toolbox), added or taken off.
function changeLinkVehicles(link, change, label) {
    checkpoint(label, { merge: true });
    const carried = linkVehicles(link).map((item) => ({ ...item }));
    change(carried);
    link.vehicles = carried.slice(0, typesPerLink);
    link.basis = 'user';
    $('#selectionCard').dataset.for = '';
    networkChanged();
}

// The next type a link may take, for V: through the catalogue, wrapping round.
function cycleVehicles() {
    const links = selectedLinks().filter((link) => carriesVehicles(kindOfLink(link)));
    if (!links.length) { refuse('Select a link that runs on vehicles first: V gives it the next vehicle type.'); return; }
    const current = linkVehicles(links[0])[0]?.type;
    const allowed = state.vehicles.filter((type) => links.every((link) => typeAllowed(type, link)));
    if (!allowed.length) return;
    const next = allowed[(allowed.findIndex((type) => type.id === current) + 1) % allowed.length];
    carryBy(links, next.id);
}

// ---- the vehicle catalogue ------------------------------------------------------------------------------------------
// The types every link chooses from: each a card of its figures (each labelled assumed or yours), whether it may deliver
// to stores, and how many links run on it.
function renderVehicles() {
    const panel = $('#vehicleList');
    if (!panel) return;
    // Being typed in: keep the fields as they are.
    if (panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox') return;
    const uses = (type) => state.links.filter((link) => linkVehicles(link).some((item) => item.type === type.id)).length;
    $('#vehiclesSummary').textContent = `${state.vehicles.length} type${state.vehicles.length === 1 ? '' : 's'}`;
    panel.innerHTML = state.vehicles.map((type) => `
        <li class="vehicle" data-type="${escape(type.id)}">
            <div class="row"><input type="text" data-vehicle-name value="${escape(type.name)}" aria-label="Name of the vehicle type"><span class="muted small">${uses(type) ? `on ${uses(type)} link${uses(type) === 1 ? '' : 's'}` : 'unused'}</span>
                <button class="link remove" type="button" data-vehicle-delete title="Delete this type" aria-label="Delete ${escape(type.name)}"${state.vehicles.length === 1 ? ' disabled' : ''}>✕</button></div>
            ${vehicleFields.map((field) => {
                const value = type.fields[field.key];
                return `<div class="field" title="${escape(field.detail)}"><label for="vehicle-${escape(type.id)}-${field.key}">${escape(field.label)}</label><span><input type="number" min="0" step="any" id="vehicle-${escape(type.id)}-${field.key}" data-vehicle-field="${field.key}" value="${value.value}"> <span class="muted">${escape(field.unit)}</span></span><span class="basis ${value.basis}">${escape(basisLabel[value.basis])}</span></div>`;
            }).join('')}
            <label class="row small"><input type="checkbox" data-vehicle-stores ${type.toStores ? 'checked' : ''}> May deliver to stores and dark stores</label>
        </li>`).join('');
    panel.querySelectorAll('[data-type]').forEach((row) => {
        const type = state.vehicles.find((item) => item.id === row.dataset.type);
        row.querySelector('[data-vehicle-name]').addEventListener('change', (event) => {
            const name = event.target.value.trim();
            if (!name || name === type.name) { event.target.value = type.name; return; }
            if (state.vehicles.some((other) => other !== type && other.name === name)) { refuse(`There is already a vehicle type named ${name}.`); event.target.value = type.name; return; }
            checkpoint(`renaming the ${type.name.toLowerCase()}`);
            type.name = name;
            vehiclesChanged();
        });
        row.querySelectorAll('[data-vehicle-field]').forEach((input) => input.addEventListener('change', () => {
            checkpoint(`changing the ${type.name.toLowerCase()}'s ${vehicleFields.find((field) => field.key === input.dataset.vehicleField).label.toLowerCase()}`, { merge: true });
            setVehicleField(type, input.dataset.vehicleField, input.value);
            input.blur();
            vehiclesChanged();
        }));
        row.querySelector('[data-vehicle-stores]').addEventListener('change', (event) => {
            checkpoint(`${event.target.checked ? 'letting' : 'keeping'} the ${type.name.toLowerCase()} ${event.target.checked ? 'deliver to' : 'off'} stores`);
            type.toStores = event.target.checked;
            vehiclesChanged();
        });
        row.querySelector('[data-vehicle-delete]').addEventListener('click', () => deleteVehicle(type));
    });
}
function vehiclesChanged() {
    renderVehicles();
    $('#selectionCard').dataset.for = '';
    networkChanged();
}
function addVehicle() {
    checkpoint('adding a vehicle type');
    const type = createVehicle({}, state.vehicles);
    state.vehicles.push(type);
    $('#vehicles').open = true;
    vehiclesChanged();
    $(`#vehicleList [data-type="${type.id}"] [data-vehicle-name]`)?.select();
}
// A type deleted: the links that ran on it run on what their kind usually takes.
function deleteVehicle(type) {
    if (state.vehicles.length === 1) return;
    const on = state.links.filter((link) => linkVehicles(link).some((item) => item.type === type.id)).length;
    checkpoint(`deleting the ${type.name.toLowerCase()}`);
    state.vehicles = state.vehicles.filter((item) => item !== type);
    vehiclesChanged();
    toast(`Deleted the ${type.name.toLowerCase()}${on ? `: its ${on} link${on === 1 ? ' runs' : 's run'} on ${on === 1 ? 'its' : 'their'} usual vehicles now` : ''}.`, { undoable: true });
}
$('#addVehicleButton').addEventListener('click', addVehicle);
renderVehicles();

// ---- the keyboard ------------------------------------------------------------------------------------------
// Every action has a button or a menu item; these are the quicker ways, listed under ? (and in each menu and tooltip).
const shortcuts = [
    ['1 to 6', 'Place a supplier, port, warehouse, store, dark store or customer area (again to stop)'],
    ['Escape', 'Stop placing, cancel a link, close a menu, or clear the selection'],
    [keys.deleteKeys, 'Delete what is selected'],
    [keys.undo, 'Undo'], [keys.redo, 'Redo'],
    [keys.selectAll, 'Select every site'], [keys.duplicate, 'Duplicate the selected sites'],
    [keys.addClick, 'Add to the selection, or take out of it'],
    ['Shift-drag on the map', `Select the sites in a box (with ${keys.modifier} too: add them)`],
    ['Shift-drag from a site', 'Link it to another site'],
    ['Arrow keys (Shift: further)', 'Move the selected sites'],
    ['Enter or F2, or click twice', 'Rename the selected site'],
    ['L', 'Link the selected site to the next one clicked'],
    ['V', 'Carry the selected links by the next vehicle type'],
    ['F', 'Fit the map to the selection, or to the network'], ['0', 'Fit the map to the region'], ['+ and -', 'Zoom'],
    [keys.menu, 'The menu of a site, a link or the map'], ['?', 'Show or hide these shortcuts']
];
$('#shortcutList').innerHTML = shortcuts.map(([keys, what]) => `<tr><td><kbd>${escape(keys)}</kbd></td><td>${escape(what)}</td></tr>`).join('');
const toggleShortcuts = (show = $('#shortcuts').hidden) => { $('#shortcuts').hidden = !show; };
$('#shortcutsButton').addEventListener('click', () => toggleShortcuts());
$('#shortcutsClose').addEventListener('click', () => toggleShortcuts(false));

document.addEventListener('keydown', (event) => {
    const typing = event.target.closest?.('input, select, textarea');
    // The platform's command key only: ⌘ on a Mac (where Control is for menus), Ctrl elsewhere (where the Windows key
    // belongs to the system).
    const mod = commandHeld(event, keys);
    if (event.key === 'Escape') {
        if (!$('#contextMenu').hidden) closeMenu();
        else if (!$('#shortcuts').hidden) toggleShortcuts(false);
        else if (state.linkFrom) stopLinking();
        else if (map.addKind) setAddRole(null);
        else if (!typing) select(null);
        return;
    }
    if (typing || !state.roads) return;
    const key = event.key.toLowerCase();
    let handled = true;
    if (mod && key === 'z' && !event.shiftKey) undo();
    else if ((mod && key === 'z' && event.shiftKey) || (mod && key === 'y')) redo();
    else if (mod && key === 'a') selectAll();
    else if (mod && key === 'd') duplicateSelected();
    else if (mod) handled = false;
    else if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected();
    else if (/^[1-6]$/.test(event.key)) { const role = roleIds[Number(event.key) - 1]; setAddRole(map.addKind === role ? null : role); }
    else if ((event.key === 'Enter' || event.key === 'F2') && state.selected?.kind === 'pin') rename(state.selected.id);
    else if (key === 'l' && state.selected?.kind === 'pin') startLinking(state.selected.id);
    else if (key === 'v') cycleVehicles();
    else if (event.key.startsWith('Arrow')) nudge({ ArrowLeft: -1, ArrowRight: 1 }[event.key] ?? 0, { ArrowUp: -1, ArrowDown: 1 }[event.key] ?? 0, event.shiftKey);
    else if (key === 'f') fitNetwork();
    else if (event.key === '0') map.fit();
    else if (event.key === '+' || event.key === '=') map.zoom(0.75);
    else if (event.key === '-' || event.key === '_') map.zoom(1.33);
    else if (event.key === '?') toggleShortcuts();
    else handled = false;
    if (handled) event.preventDefault();
});

// The map fitted to the selected sites, or to the whole network.
function fitNetwork() {
    const pins = selectedPins().length ? selectedPins() : state.pins;
    if (!pins.length) { map.fit(); return; }
    map.fitTo(pins);
}

// ---- the menu of a pin, a link, a suggestion or the map (a right click) ---------------------------------------
function openMenu({ target, point, clientX, clientY }) {
    if (!state.roads) return;
    // A right click on something outside the selection selects it, as file browsers do.
    if (target && (target.kind === 'pin' || target.kind === 'link') && !state.selection.some((item) => item.kind === target.kind && item.id === target.id)) {
        setSelection([target]);
        renderNetwork();
    }
    const items = [];
    const item = (label, keys, action, { danger = false } = {}) => items.push({ label, keys, action, danger });
    const pins = selectedPins();
    const links = selectedLinks();
    if (target?.kind === 'suggestion') {
        item('Adopt it into the network', 'click', () => adopt(target.id));
    } else if (target?.kind === 'pin' && pins.length > 1) {
        item(`Duplicate ${pins.length} sites`, keys.duplicate, duplicateSelected);
        item(`Fit the map to them`, 'F', fitNetwork);
        item(`Delete ${pins.length} sites${links.length ? ` and ${links.length} links` : ''}`, keys.delete, deleteSelected, { danger: true });
    } else if (target?.kind === 'pin') {
        const pin = pinById(target.id);
        item('Rename', 'Enter', () => rename(pin.id));
        item('Link it to another site…', 'L', () => startLinking(pin.id));
        for (const role of roleIds.filter((role) => role !== pin.role)) item(`Make it a ${roles[role].label.toLowerCase()}`, '', () => changeRole(pin, role));
        item('Duplicate', keys.duplicate, duplicateSelected);
        item('Delete', keys.delete, deleteSelected, { danger: true });
    } else if (target?.kind === 'link') {
        const link = state.links.find((each) => each.id === target.id);
        if (link?.basis !== 'user') item('Make it mine (keep it as it is)', '', () => { checkpoint('keeping a suggested link'); link.basis = 'user'; networkChanged(); });
        // The vehicles it runs on: every type that may take all the links selected.
        const carrying = links.filter((each) => carriesVehicles(kindOfLink(each)));
        const current = carrying.length === 1 ? linkVehicles(carrying[0])[0]?.type : null;
        for (const type of state.vehicles.filter((each) => carrying.length && each.id !== current && carrying.every((each2) => typeAllowed(each, each2)))) {
            item(`Carry ${carrying.length > 1 ? `${carrying.length} links` : 'it'} by ${type.name.toLowerCase()}`, 'V', () => carryBy(carrying, type.id));
        }
        item(links.length > 1 ? `Delete ${links.length} links` : 'Delete', keys.delete, deleteSelected, { danger: true });
    } else {
        roleIds.forEach((role, index) => item(`Place a ${roles[role].label.toLowerCase()} here`, String(index + 1), () => addPin(role, point)));
        if (state.pins.length) item('Select every site', keys.selectAll, selectAll);
        item('Fit the map to the network', 'F', fitNetwork);
        item('Fit the map to the region', '0', () => map.fit());
    }
    const menu = $('#contextMenu');
    menu.innerHTML = items.map((entry, index) => `<button type="button" role="menuitem" data-index="${index}" class="${entry.danger ? 'danger' : ''}"><span>${escape(entry.label)}</span>${entry.keys ? `<kbd>${escape(entry.keys)}</kbd>` : ''}</button>`).join('');
    menu.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { closeMenu(); items[Number(button.dataset.index)].action(); }));
    menu.hidden = false;
    $('#pinPopover').hidden = true;
    const area = $('.mapArea').getBoundingClientRect();
    menu.style.left = `${Math.min(clientX - area.left, area.width - menu.offsetWidth - 6)}px`;
    menu.style.top = `${Math.min(clientY - area.top, area.height - menu.offsetHeight - 6)}px`;
    menu.querySelector('button')?.focus();
}
function closeMenu() {
    if ($('#contextMenu').hidden) return;
    $('#contextMenu').hidden = true;
    renderPopover();
}
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('#contextMenu')) closeMenu(); });
// Up and down move through the menu, as in any menu.
$('#contextMenu').addEventListener('keydown', (event) => {
    const buttons = [...$('#contextMenu').querySelectorAll('button')];
    const at = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { buttons[(at + 1) % buttons.length].focus(); event.preventDefault(); }
    if (event.key === 'ArrowUp') { buttons[(at - 1 + buttons.length) % buttons.length].focus(); event.preventDefault(); }
});

function changeRole(pin, role) {
    checkpoint(`making ${pin.name} a ${roles[role].label.toLowerCase()}`);
    Object.assign(pin, createPin(role, pin, { id: pin.id, name: pin.name, source: pin.source, basis: pin.basis, candidate: pin.candidate ?? null }));
    $('#selectionCard').dataset.for = '';
    networkChanged();
}

// The card of what is selected: a pin's name, role, figures (each labelled where it comes from), its road and its links;
// or a link's ends, how it was routed and whose it is.
function renderCard() {
    const card = $('#selectionCard');
    const selected = state.selected;
    const pin = selected?.kind === 'pin' ? pinById(selected.id) : null;
    const link = selected?.kind === 'link' ? state.links.find((item) => item.id === selected.id) : null;
    card.hidden = !pin && !link;
    if (state.selection.length > 1) {
        // Several selected: what they are, and what can be done to all of them.
        const pins = selectedPins();
        const links = selectedLinks();
        card.dataset.for = state.selection.map((item) => item.id).join('|');
        const carrying = links.filter((link) => carriesVehicles(kindOfLink(link)));
        const offered = state.vehicles.filter((type) => carrying.every((link) => typeAllowed(type, link)));
        card.innerHTML = `
            <h3>${[pins.length ? `${pins.length} site${pins.length === 1 ? '' : 's'}` : '', links.length ? `${links.length} link${links.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')} selected</h3>
            <div class="detail">${escape(pins.map((item) => item.name).join(', '))}</div>
            ${carrying.length ? `<div class="field"><label for="carryAll">Carry ${carrying.length === links.length ? 'them' : `the ${carrying.length} that run on vehicles`} by</label><select id="carryAll" title="V gives them the next type"><option value="">choose a vehicle</option>${offered.map((type) => `<option value="${escape(type.id)}">${escape(type.name)}</option>`).join('')}</select></div>` : ''}
            <div class="row">${pins.length ? `<button class="button small" type="button" id="duplicateSelection" title="${keys.duplicate}">Duplicate</button><button class="button small" type="button" id="fitSelection" title="F">Fit the map to them</button>` : ''}<button class="button small danger" type="button" id="deleteSelection" title="${keys.delete}">Delete</button></div>
            <div class="detail">Drag any of them on the map to move them together; the arrow keys move them too. Shift-click to add or take out one.</div>`;
        $('#duplicateSelection')?.addEventListener('click', duplicateSelected);
        $('#fitSelection')?.addEventListener('click', fitNetwork);
        $('#carryAll')?.addEventListener('change', (event) => { if (event.target.value) carryBy(carrying, event.target.value); });
        $('#deleteSelection').addEventListener('click', deleteSelected);
        return;
    }
    if (pin) {
        // Being typed in: keep the fields as they are.
        if (card.dataset.for === pin.id && card.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
        card.dataset.for = pin.id;
        const found = pin.candidate;
        // Its links, as lists to add to and take from: what supplies it, and what it supplies.
        const linkList = (direction) => {
            const own = state.links.filter((item) => (direction === 'in' ? item.to : item.from) === pin.id);
            const others = state.pins.filter((other) => other.id !== pin.id && !own.some((item) => (direction === 'in' ? item.from : item.to) === other.id)
                && !linkProblem(direction === 'in' ? other : pin, direction === 'in' ? pin : other));
            if (!own.length && !others.length) return '';
            const title = direction === 'in' ? 'Supplied from' : 'Supplies';
            return `<div class="links"><b>${title}</b><ul>${own.map((item) => {
                const other = pinById(direction === 'in' ? item.from : item.to);
                return `<li><button class="link" type="button" data-select-link="${escape(item.id)}">${escape(other?.name ?? '')}</button> <span class="basis ${item.basis === 'user' ? 'user' : ''}">${item.basis === 'user' ? 'yours' : 'suggested'}</span><button class="link remove" type="button" data-remove-link="${escape(item.id)}" title="Remove this link" aria-label="Remove the link with ${escape(other?.name ?? '')}">✕</button></li>`;
            }).join('')}</ul>${others.length ? `<select data-add-link="${direction}" aria-label="${title}: add a site"><option value="">+ add a site</option>${others.map((other) => `<option value="${escape(other.id)}">${escape(other.name)} (${escape(roles[other.role].label.toLowerCase())})</option>`).join('')}</select>` : ''}</div>`;
        };
        card.innerHTML = `
            <h3><i class="swatch ${pin.role}"></i><select id="pinRole" aria-label="Role">${roleIds.map((role) => `<option value="${role}" ${role === pin.role ? 'selected' : ''}>${roles[role].label}</option>`).join('')}</select></h3>
            <input type="text" id="pinName" value="${escape(pin.name)}" aria-label="Name">
            ${roles[pin.role].fields.map((field) => {
                const value = pin.fields[field.key] ?? {};
                const placeholder = field.key === 'teuPerDay' ? (found?.activity ? 'from PortWatch' : `${number(state.portVolume ?? 100)} assumed`) : field.key === 'capacity' ? 'no limit' : '';
                return `<div class="field"><label for="field-${field.key}">${escape(field.label)}</label><span><input type="number" min="0" step="any" id="field-${field.key}" data-field="${field.key}" value="${value.value ?? ''}" placeholder="${escape(placeholder)}"> <span class="muted">${escape(field.unit)}</span></span><span class="basis ${value.basis ?? ''}">${escape(basisLabel[value.basis] ?? '')}</span></div><div class="detail">${escape(field.detail)}</div>`;
            }).join('')}
            <div class="detail road">${escape(roadText(pin))}</div>
            ${found ? `<div class="detail">Adopted from OpenStreetMap${found.activity ? `; IMF PortWatch: about ${number(found.activity.importTonnesPerDay)} t of container imports a day, ${found.activity.from} to ${found.activity.to}` : ''}${found.population ? `; population ${number(found.population)}` : ''}${found.floorAreaSquareMetres ? `; ${number(found.floorAreaSquareMetres)} m² of floor area` : ''}.</div>` : ''}
            ${linkList('in')}${linkList('out')}
            <div class="row"><button class="button small" type="button" id="duplicatePin" title="${keys.duplicate}">Duplicate</button><button class="button small danger" type="button" id="deletePin" title="${keys.delete}">Delete</button></div>`;
        $('#pinName').addEventListener('change', () => renamePin(pin, $('#pinName').value));
        $('#pinRole').addEventListener('change', () => changeRole(pin, $('#pinRole').value));
        card.querySelectorAll('[data-field]').forEach((input) => input.addEventListener('change', () => {
            checkpoint(`changing ${pin.name}'s ${input.dataset.field}`, { merge: true });
            setField(pin, input.dataset.field, input.value);
            card.dataset.for = '';
            networkChanged();
        }));
        card.querySelectorAll('[data-select-link]').forEach((button) => button.addEventListener('click', () => select({ kind: 'link', id: button.dataset.selectLink })));
        card.querySelectorAll('[data-remove-link]').forEach((button) => button.addEventListener('click', () => {
            const item = state.links.find((each) => each.id === button.dataset.removeLink);
            if (!item) return;
            checkpoint(`removing the link from ${pinById(item.from)?.name} to ${pinById(item.to)?.name}`);
            removeLink(item);
            card.dataset.for = '';
            networkChanged();
        }));
        card.querySelectorAll('[data-add-link]').forEach((choice) => choice.addEventListener('change', () => {
            if (!choice.value) return;
            const [from, to] = choice.dataset.addLink === 'in' ? [choice.value, pin.id] : [pin.id, choice.value];
            drawLink(from, to);
            // Stay on the site, to add more.
            setSelection([{ kind: 'pin', id: pin.id }]);
            card.dataset.for = '';
            renderNetwork();
        }));
        $('#duplicatePin').addEventListener('click', duplicateSelected);
        $('#deletePin').addEventListener('click', deleteSelected);
    } else if (link) {
        // Being typed in: keep the fields as they are.
        if (card.dataset.for === link.id && card.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
        card.dataset.for = link.id;
        const from = pinById(link.from);
        const to = pinById(link.to);
        const leg = link.leg;
        const unused = (state.built?.unusedLinks ?? []).find((item) => item.from === from?.name && item.to === to?.name);
        card.innerHTML = `
            <h3>${escape(from?.name)} → ${escape(to?.name)}</h3>
            <div class="detail">${leg ? `${number(leg.kilometres, 1)} km, ${number(leg.hours, 1)} h ${legHow(leg)}.` : 'Not routed yet.'} ${link.basis === 'user' ? 'Your link.' : 'Suggested.'}</div>
            ${unused ? `<div class="detail">Left out of the model: it ${escape(unused.why)}.</div>` : ''}
            ${renderLinkVehicles(link)}
            <div class="row">${link.basis === 'user' ? '' : '<button class="button small" type="button" id="keepLink">Make it mine</button>'}<button class="button small danger" type="button" id="deleteLink" title="${keys.delete}">Delete</button></div>
            <div class="detail">Drag either end on the map to another site to move it.</div>`;
        $('#keepLink')?.addEventListener('click', () => { checkpoint('keeping a suggested link'); link.basis = 'user'; networkChanged(); });
        $('#deleteLink').addEventListener('click', deleteSelected);
        wireLinkVehicles(link);
    } else {
        card.dataset.for = '';
    }
}

// A link's vehicles on its card: each type it runs on, with its fleet (empty: sized by the toolbox, as the last build
// sized it), a second type to add or take off; or why it has none.
function renderLinkVehicles(link) {
    const kind = kindOfLink(link);
    if (kind === 'customerArea') return '<div class="detail">Delivered by a parcel or courier service: no vehicles of its own.</div>';
    if (!carriesVehicles(kind)) return '';
    const carried = linkVehicles(link);
    const lane = state.built?.lanes?.find((item) => item.from === pinById(link.from)?.name && (item.site ?? item.to) === pinById(link.to)?.name);
    const sized = (index) => lane?.vehicles?.[index] && lane.vehicles[index].type === carried[index].type ? `auto (${number(lane.vehicles[index].fleet)})` : 'auto';
    const row = (item, index) => `<div class="field vehicleChoice">
            <select data-link-vehicle="${index}" aria-label="${index ? 'Second vehicle type' : 'Vehicle type'}" title="V gives it the next type">${state.vehicles.map((type) => `<option value="${escape(type.id)}" ${type.id === item.type ? 'selected' : ''} ${typeAllowed(type, link) ? '' : 'disabled'}>${escape(type.name)}${typeAllowed(type, link) ? '' : ' (not to stores)'}</option>`).join('')}</select>
            <span><input type="number" min="0" step="1" data-link-fleet="${index}" value="${item.fleet ?? ''}" placeholder="${escape(sized(index))}" aria-label="How many"> <span class="muted">vehicles</span></span>
            <span class="basis ${item.fleet === null ? 'assumed' : 'user'}">${item.fleet === null ? 'sized' : 'yours'}</span>
            ${index ? `<button class="link remove" type="button" data-link-vehicle-remove title="Take this type off the link" aria-label="Take ${escape(typeNamed(item.type)?.name ?? '')} off the link">✕</button>` : ''}
        </div>`;
    return `<div class="links"><b>Vehicles</b>${carried.map(row).join('')}
        ${carried.length < typesPerLink && state.vehicles.length > 1 ? '<button class="link" type="button" id="addLinkVehicle">+ a second type</button>' : ''}
        <div class="detail">Empty: as many as its flow needs, plus a reserve. Two types share its loads by their capacity.</div></div>`;
}
function wireLinkVehicles(link) {
    const card = $('#selectionCard');
    const ends = `${pinById(link.from)?.name} → ${pinById(link.to)?.name}`;
    card.querySelectorAll('[data-link-vehicle]').forEach((choice) => choice.addEventListener('change', () => {
        const index = Number(choice.dataset.linkVehicle);
        changeLinkVehicles(link, (carried) => {
            carried[index] = { type: choice.value, fleet: null };
            // The same type twice is one type.
            if (carried.length === 2 && carried[0].type === carried[1].type) carried.splice(1, 1);
        }, `choosing the vehicles of ${ends}`);
    }));
    card.querySelectorAll('[data-link-fleet]').forEach((input) => input.addEventListener('change', () => {
        const index = Number(input.dataset.linkFleet);
        const value = input.value === '' ? null : Math.max(0, Math.round(Number(input.value)));
        changeLinkVehicles(link, (carried) => { carried[index].fleet = Number.isFinite(value) ? value : null; }, `changing the fleet of ${ends}`);
    }));
    card.querySelector('[data-link-vehicle-remove]')?.addEventListener('click', () => changeLinkVehicles(link, (carried) => carried.splice(1, 1), `taking a vehicle off ${ends}`));
    $('#addLinkVehicle')?.addEventListener('click', () => {
        const carried = linkVehicles(link);
        const other = state.vehicles.find((type) => typeAllowed(type, link) && !carried.some((item) => item.type === type.id));
        if (!other) { refuse('Every vehicle type that may take this link already does.'); return; }
        changeLinkVehicles(link, (list) => list.push({ type: other.id, fleet: null }), `adding a vehicle to ${ends}`);
    });
}

function renamePin(pin, text) {
    const name = String(text ?? '').trim();
    if (!name || name === pin.name) return;
    checkpoint(`renaming ${pin.name}`);
    pin.name = name;
    $('#selectionCard').dataset.for = '';
    networkChanged();
}

function roadText(pin) {
    if (!state.router) return '';
    const metres = snapOf(pin);
    if (metres === null) return 'Too far from any road loaded: its legs are straight-line estimates.';
    return metres > farMetres ? `${number(metres / 1000, 1)} km from the nearest road loaded: its legs start with a long access leg.` : `On the roads (${number(metres)} m from the nearest).`;
}

// The palette: a role chosen, then clicks on the map place pins of it, until Escape or the same role again.
function setAddRole(role) {
    map.setAddKind(role);
    document.querySelectorAll('[data-add]').forEach((each) => each.classList.toggle('active', each.dataset.add === role));
    $('#mapHint').hidden = !role;
    if (role) $('#mapHint').textContent = `Click the map to place a ${roles[role].label.toLowerCase()}, as many as you like. Escape (or ${roleIds.indexOf(role) + 1} again) to stop.`;
    renderPopover();
}
document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
    if (!state.roads) { $('#regionStatus').innerHTML = notice('warning', 'Load the roads of a place, or use the sample region, first.'); return; }
    setAddRole(map.addKind === button.dataset.add ? null : button.dataset.add);
}));

// ---- the network: a file of sites -------------------------------------------------------------------------

$('#sitesButton').addEventListener('click', async () => {
    try {
        const chosen = await call(api.chooseFile(importerId, 'sites'));
        if (!chosen.chosen) return;
        setBusy(true);
        const answer = await call(api.runImport(importerId, { step: 'sites' }));
        if (answer.report?.errors?.length) throw new Error(answer.report.errors.join(' '));
        checkpoint('loading your sites');
        const loaded = networkFromSites(answer.data.sites, state.pins);
        state.pins.push(...loaded.pins);
        state.links.push(...loaded.links);
        const warnings = [...(answer.report?.warnings ?? []), ...loaded.problems];
        $('#regionStatus').innerHTML = notice('ok', `${loaded.pins.length} site${loaded.pins.length === 1 ? '' : 's'} and ${loaded.links.length} link${loaded.links.length === 1 ? '' : 's'} from your file.${state.roads ? '' : ' Load the roads of their region, or use the sample region, to route them.'}`) + warnings.map((text) => notice('warning', text)).join('');
        for (const section of ['#stepNetwork', '#stepBuild']) $(section).hidden = false;
        networkChanged();
        $('#saveSitesButton').disabled = false;
    } catch (error) {
        $('#regionStatus').innerHTML = notice('error', error.message);
    } finally {
        setBusy(false);
    }
});

// The network as a CSV the user keeps: Load your sites reads it back.
$('#saveSitesButton').addEventListener('click', () => {
    const text = writeSites(state.pins, state.links);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    link.download = 'network.csv';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    state.savedCsv = text;
});

// ---- suggestions from public data, only when asked for ------------------------------------------------------

document.querySelectorAll('[data-fetch-source]').forEach((button) => button.addEventListener('click', () => fetchSuggestions(button.dataset.fetchSource)));

async function fetchSuggestions(source) {
    if (state.busy || !state.roads) return;
    const row = $(`[data-source-state="${source}"]`);
    setBusy(true);
    row.className = 'state small';
    $('#suggestionNotices').innerHTML = '';
    let portwatchProblem = null;
    try {
        const missing = sources[source].kinds.filter((kind) => !state.available.has(kind));
        if (missing.length) {
            if (!state.bbox) throw new Error('The sample region holds no more data to suggest from.');
            const progress = $('#fetchProgress');
            progress.hidden = false;
            progress.innerHTML = missing.map((kind) => `<li data-kind="${kind}"><span>${labels[kind]}</span><span class="state">waiting</span></li>`).join('')
                + (sources[source].portwatch ? '<li data-kind="portwatch"><span>Port activity (IMF PortWatch)</span><span class="state">waiting</span></li>' : '');
            row.textContent = 'fetching…';
            await fetchKinds(missing, progress, { fresh: state.fresh });
            if (sources[source].portwatch) portwatchProblem = await fetchPortActivity(progress.querySelector('[data-kind="portwatch"]'));
        }
        await discoverSuggestions([...new Set([...Object.keys(state.suggestions), source])]);
        state.sourceTab = source;
        $('#suggestions').open = true;
        renderSuggestions();
        renderNetwork();
        if (portwatchProblem) $('#suggestionNotices').insertAdjacentHTML('afterbegin', notice('warning', `Port activity could not be fetched from IMF PortWatch (${portwatchProblem}), so every port starts with an assumed volume. Load the roads and ask for ports again later to match it.`));
    } catch (error) {
        row.className = 'state small failed';
        row.textContent = 'failed';
        $('#suggestionNotices').innerHTML = notice('error', error.message);
        $('#suggestions').open = true;
        $('#suggestionView').hidden = false;
    } finally {
        setBusy(false);
    }
}

// The suggestions of the sources asked for, from the data the host holds.
async function discoverSuggestions(asked) {
    const answer = await call(api.runImport(importerId, { step: 'discover', sources: asked, ...(state.bbox ? { bbox: state.bbox } : {}) }));
    if (answer.report?.errors?.length) throw new Error(answer.report.errors.join(' '));
    const data = answer.data;
    state.suggestions = Object.fromEntries(asked.map((source) => [source, {
        candidates: { [sources[source].group]: data.candidates[sources[source].group] ?? [] },
        coverage: data.coverage[source], notices: data.notices.filter((item) => noticeKinds[source].includes(item.kind))
    }]));
    map.setOverlay(data.overlay);
    if (data.attribution && !$('#attribution').textContent.includes(data.attribution)) $('#attribution').textContent = `${$('#attribution').textContent} · ${data.attribution}`;
    renderHistoryHint();
}

// IMF PortWatch: the ports around the region, then a year of history for each that matches a port found.
// Optional: if it fails, the ports are still suggested with assumed volumes, and the problem is returned.
async function fetchPortActivity(row) {
    const show = (text) => { row.querySelector('.state').textContent = text; };
    const fetchWithRetry = async (role, url, name) => {
        for (let attempt = 0; ; attempt += 1) {
            try {
                const answer = await call(api.fetchFile(importerId, role, url, name, fetchMode(state.fresh)));
                fetched(role, answer);
                return answer;
            } catch (error) {
                if (!busy(error.message) || attempt >= 1) throw error;
                await countdown(row, retryDelaysSeconds[0], 'server busy');
            }
        }
    };
    try {
        show('ports…');
        let bytes = (await fetchWithRetry('portwatchPorts', portwatchPortsUrl(state.bbox), 'portwatch-ports.json')).bytes;
        // Which listed ports match a port found: discovery decides, so ask it before fetching histories.
        const first = await call(api.runImport(importerId, { step: 'discover', sources: ['ports'], bbox: state.bbox }));
        const portids = [...new Set((first.data?.candidates.ports ?? []).map((port) => port.portwatch?.portid).filter(Boolean))];
        for (const [index, portid] of portids.entries()) {
            show(`history ${index + 1} of ${portids.length}…`);
            bytes += (await fetchWithRetry('portwatchActivity', portwatchActivityUrl(portid), `portwatch-${portid}.json`)).bytes;
        }
        row.classList.add('done');
        show(`${portids.length} port${portids.length === 1 ? '' : 's'} matched, ${number(bytes / 1024)} KB`);
        state.available.add('portwatchPorts');
        state.available.add('portwatchActivity');
        return null;
    } catch (error) {
        row.classList.add('failed');
        show('not available');
        // Without the ports list, a partial set of histories would only confuse: clear both.
        for (const role of ['portwatchPorts', 'portwatchActivity']) await call(api.clearFile(importerId, role)).catch(() => {});
        return error.message;
    }
}

function describeCandidate(site, group) {
    if (group === 'ports') {
        const land = `${number(site.areaSquareKilometres, 2)} km² of port land${site.commercial ? ', commercial' : ''}${site.anchorages ? `, ${site.anchorages} anchorage${site.anchorages === 1 ? '' : 's'}` : ''}`;
        if (site.activity) return `${land} · IMF PortWatch (${site.portwatch.name}): about ${number(site.activity.importTonnesPerDay / conversion().tonnesPerTeu * conversion().inlandShare)} TEU/day inland, ${number(site.activity.containerCallsPerDay, 1)} container ships a day, ${site.activity.from} to ${site.activity.to}`;
        return site.portwatch ? `${land} · IMF PortWatch (${site.portwatch.name}): no recent activity` : land;
    }
    if (group === 'zones') {
        const basis = { mapped: 'mapped', approximate: 'from building outlines', estimated: 'estimated from industrial land' }[site.floorAreaBasis] ?? site.floorAreaBasis;
        return `${number(site.floorAreaSquareMetres / 1000)}k m² floor area (${basis})${site.buildings ? `, ${site.buildings} buildings` : ''}${site.roadKilometres !== null && site.roadKilometres !== undefined ? `, ${number(site.roadKilometres, 1)} km to a major road` : ''}`;
    }
    const basis = { assumed: ' (assumed)', shared: ` (an even share of ${site.city}'s population)` }[site.populationBasis] ?? '';
    return `Population ${number(site.population)}${basis}${site.suburbs?.length ? ` · ${site.suburbs.length} suburb${site.suburbs.length === 1 ? '' : 's'}: ${site.suburbs.slice(0, 4).join(', ')}${site.suburbs.length > 4 ? '…' : ''}` : ''}`;
}

function renderSuggestions() {
    const asked = Object.keys(state.suggestions);
    for (const source of Object.keys(sources)) {
        const row = $(`[data-source-state="${source}"]`);
        const found = state.suggestions[source];
        if (found) {
            row.className = 'state small done';
            const kind = sources[source].kinds[0];
            const when = kind && state.fetchedAt[kind] ? `, fetched ${dateOf(state.fetchedAt[kind].at)}${state.fetchedAt[kind].cached ? ' (kept)' : ''}` : '';
            row.textContent = `${found.candidates[sources[source].group]?.length ?? 0} found${when}`;
        } else if (!row.classList.contains('failed')) {
            row.className = 'state small';
            row.textContent = '';
        }
    }
    $('#suggestionView').hidden = !asked.length;
    if (!asked.length) return;
    if (!asked.includes(state.sourceTab)) state.sourceTab = asked[0];
    $('#sourceTabs').innerHTML = asked.map((source) => `<button type="button" role="tab" data-tab="${source}" class="${source === state.sourceTab ? 'active' : ''}">${sources[source].label}</button>`).join('');
    $('#sourceTabs').querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { state.sourceTab = button.dataset.tab; renderSuggestions(); }));
    const group = sources[state.sourceTab].group;
    const candidates = state.suggestions[state.sourceTab].candidates[group] ?? [];
    const adopted = new Set(state.pins.map((pin) => pin.candidate?.id).filter(Boolean));
    $('#suggestionNotices').innerHTML = (state.suggestions[state.sourceTab].notices ?? []).map((item) => notice(item.level, item.text)).join('');
    $('#candidateList').innerHTML = candidates.map((site) => `
        <li data-id="${escape(site.id)}" class="${adopted.has(site.id) ? 'adopted' : ''}">
            <span></span>
            <span class="name" title="${escape(site.name)}">${escape(site.name)}</span>
            ${adopted.has(site.id) ? '<span class="muted small">in your network</span>' : `<button class="link" type="button" data-adopt="${escape(site.id)}">Adopt</button>`}
            <span class="detail">${escape(describeCandidate(site, group))}</span>
        </li>`).join('');
    $('#candidateList').querySelectorAll('[data-adopt]').forEach((button) => button.addEventListener('click', () => adopt(button.dataset.adopt)));
    $('#candidateList').querySelectorAll('li').forEach((row) => {
        row.addEventListener('mouseenter', () => map.setHighlight(row.dataset.id));
        row.addEventListener('mouseleave', () => map.setHighlight(null));
    });
}

$('#applyTop').addEventListener('click', () => {
    const count = Math.max(0, Math.round(Number($('#topN').value) || 0));
    const group = sources[state.sourceTab]?.group;
    if (!group) return;
    checkpoint(`adopting the top ${count}`);
    for (const candidate of (state.suggestions[state.sourceTab].candidates[group] ?? []).slice(0, count)) adoptCandidate(candidate, group);
    networkChanged();
    renderSuggestions();
});

// ---- the model ----------------------------------------------------------------------------------------------

$('#portVolume').addEventListener('input', () => {
    const value = Number($('#portVolume').value);
    if (value > 0) state.portVolume = value;
});
$('#portVolume').addEventListener('change', () => {
    const value = Number($('#portVolume').value);
    if (value > 0) state.portVolume = value;
    networkChanged();
});
$('#arrivalsSelect').addEventListener('change', () => networkChanged());
$('#historyFromInput').addEventListener('change', () => networkChanged());
// How PortWatch's tonnes become TEU handed inland: the weight of a TEU, and the share not transhipped.
function conversion() {
    const tonnes = Number($('#tonnesPerTeuInput').value);
    const share = Number($('#inlandShareInput').value);
    return {
        tonnesPerTeu: tonnes >= 1 && tonnes <= 40 ? tonnes : 10,
        inlandShare: share > 0 && share <= 100 ? share / 100 : 1
    };
}
for (const selector of ['#tonnesPerTeuInput', '#inlandShareInput']) $(selector).addEventListener('change', () => { renderSuggestions(); networkChanged(); });

// A fleet operator: none, an invented one made for the model's lanes, or the user's own from a JSON file.
function showOperatorChoice() {
    $('#operatorFileButton').hidden = $('#operatorSelect').value !== 'file';
}
$('#operatorSelect').addEventListener('change', () => {
    showOperatorChoice();
    // Your own needs its file first; the build asks for it if it is missing.
    if ($('#operatorSelect').value !== 'file' || state.operatorFile) networkChanged();
    else $('#operatorFileButton').click();
});
$('#operatorFileButton').addEventListener('click', async () => {
    try {
        const chosen = await call(api.chooseFile(importerId, 'operator'));
        if (!chosen.chosen) return;
        state.operatorFile = true;
        $('#operatorFileButton').textContent = 'Choose another file';
        networkChanged();
    } catch (error) {
        $('#buildStatus').innerHTML = notice('error', error.message);
    }
});

// The port settings show once the network has a port.
const showPortSettings = () => { $('#portSettings').hidden = !state.pins.some((pin) => pin.role === 'port'); };

async function build({ focus = false } = {}) {
    // Asked while something else runs (another build, a fetch, a scenario): build once that ends, if anything changed
    // after the last build began, so no change is lost and nothing is rebuilt for nothing.
    if (state.busy) { state.buildAgain = true; return; }
    const editsAtStart = state.edits ?? 0;
    setBusy(true);
    $('#buildStatus').innerHTML = notice('', 'Building the model…');
    try {
        if (state.router) routeLinks(state.pins, state.links, state.router);
        // The host accepts 2 MB of options: a large network's roads are left out, and its lanes drawn straight.
        let network = networkSelection(state.pins, state.links, { catalogue: state.vehicles });
        const straight = JSON.stringify(network).length > maximumNetworkBytes;
        if (straight) network = networkSelection(state.pins, state.links, { paths: false, catalogue: state.vehicles });
        const answer = await call(api.runImport(importerId, {
            step: 'buildNetwork', ...(state.bbox ? { bbox: state.bbox } : {}), network,
            settings: { portTeuPerDay: state.portVolume, arrivals: $('#arrivalsSelect').value, historyFrom: $('#historyFromInput').value || null, ...conversion(), operator: null, standbyPorts: [...state.standby] }
        }));
        if (!answer.imported) throw new Error((answer.report?.errors ?? ['The model could not be built.']).join(' '));
        state.built = answer.data;
        // The host now holds this model, so a scenario can run on it.
        state.imported = true;
        state.builtEdits = editsAtStart;
        await call(api.openInCanvas(null, { focus, silent: true, session: sessionState() }));
        $('#showButton').disabled = false;
        const histories = state.built.histories ?? [];
        $('#buildStatus').innerHTML = notice('ok', `${answer.report.summary}: ${state.built.nodes} nodes and ${state.built.edges} relationships, now in the canvas.`)
            + (histories.length ? notice('', `Arrivals follow IMF PortWatch history: ${histories.map((item) => `${item.port} from ${item.from} (model day 0) to ${item.to}`).join('; ')}.`) : '')
            + state.built.warnings.map((text) => notice('warning', text)).join('')
            + (straight ? notice('', 'The lanes are drawn straight on the map: the roads of this many links are more than the window may send in one go. Their times and distances are routed over the roads as usual.') : '')
            + (state.built.unusedLinks?.length ? notice('', `Suggested links left out of the model: ${state.built.unusedLinks.map((item) => `${item.from} → ${item.to} (it ${item.why})`).join(', ')}. Make one yours to build it anyway.`) : '');
        renderBuilt();
        renderNetwork();
        $('#stepNetwork').classList.add('completed');
        $('#stepBuild').classList.add('completed');
        updateStepSummaries();
        state.scenario = null;
        renderScenario({ fetchTransits: true });
    } catch (error) {
        $('#buildStatus').innerHTML = notice('error', error.message);
    } finally {
        setBusy(false);
    }
}

// The lanes on the map: what the model was built to carry or, after a scenario run, what each lane carried while the
// scenario lasted, drawn against the same scale so a lane that lost its cargo is visibly thinner, and coloured where it
// carried less or more than in the baseline over the same days.
function renderFlows() {
    const built = state.built;
    const flows = state.scenario?.flows && built?.corridors ? state.scenario.flows : null;
    const toggle = $('#flowView');
    toggle.hidden = !flows;
    if (flows) {
        toggle.querySelector('[data-flows="scenario"]').textContent = `Scenario, day ${number(state.scenario.start)} to ${number(state.scenario.until)}`;
        toggle.querySelectorAll('[data-flows]').forEach((button) => button.classList.toggle('active', button.dataset.flows === (state.mapShows ?? 'scenario')));
    }
    const during = flows && state.mapShows !== 'baseline' ? flows : null;
    $('#legendFell').hidden = !during;
    $('#legendRose').hidden = !during;
    renderMarks();
    if (!built) { map.setFlows(null); return; }
    const positions = new Map(state.pins.map((pin) => [pin.name, pin]));
    const sum = (names, index) => names.reduce((total, name) => total + (during[name]?.[index] ?? 0), 0);
    map.setFlows({
        // The roads the lanes run on (a build saved before corridors falls back to straight lanes).
        corridors: built.corridors?.map((corridor) => {
            if (!during) return corridor;
            const baseline = sum(corridor.lanes, 0);
            const rate = sum(corridor.lanes, 1);
            // Changed when it moved by more than a tenth and more than a TEU a day; stopped when almost nothing moved.
            const change = baseline >= 1 && rate < 0.05 * baseline ? 'stopped' : rate < 0.9 * baseline - 1 ? 'fell' : rate > 1.1 * baseline + 1 ? 'rose' : null;
            return { ...corridor, rate, baseline, change };
        }) ?? null,
        // One scale for both views: the busiest corridor as built.
        scale: during ? Math.max(1, ...built.corridors.map((corridor) => corridor.rate)) : null,
        lanes: built.lanes.filter((lane) => positions.has(lane.from) && positions.has(lane.site ?? lane.to)).map((lane) => ({
            from: positions.get(lane.from), to: positions.get(lane.site ?? lane.to), rate: lane.rate,
            title: `${laneEnds(lane)}: ${number(lane.rate, 1)} ${goods()}/day, ${number(lane.kilometres, 1)} km, ${number(lane.leadTime * 24, 1)} h, ${trucksOf(lane)}${lane.vehicles ? '' : ' trucks'}${lane.operator ? ` (${built.operator.name})` : ''}`
        })),
        // Who serves whom is drawn by the links themselves.
        serves: [],
        unit: goods()
    });
}

// Where on the map a lane's X goes: half way along the road its link was routed over, else half way between its ends.
function laneMidpoint(lane) {
    const from = pinNamed(lane.from);
    const to = pinNamed(lane.site ?? lane.to);
    if (!from || !to) return null;
    const points = state.links.find((link) => link.from === from.id && link.to === to.id)?.leg?.path?.points;
    if (!points?.length) return { lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 };
    const step = (a, b) => Math.hypot(b.lat - a.lat, (b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180));
    const total = points.slice(1).reduce((sum, point, index) => sum + step(points[index], point), 0);
    let walked = 0;
    for (let index = 1; index < points.length; index += 1) {
        const length = step(points[index - 1], points[index]);
        if (walked + length >= total / 2 && length > 0) {
            const share = (total / 2 - walked) / length;
            return { lat: points[index - 1].lat + share * (points[index].lat - points[index - 1].lat), lon: points[index - 1].lon + share * (points[index].lon - points[index - 1].lon) };
        }
        walked += length;
    }
    return points[Math.floor(points.length / 2)];
}

// A red X on a closed road: on the road a road closure scenario closed, while the map shows that scenario; and, fainter,
// on the road chosen in the Road closure tab before it runs, once the user has turned to that tab or chosen a road there
// (not merely because it is the tab open after a build) and while the Scenarios step is open. A detour keeps the road
// open: no X.
function renderMarks() {
    const marks = [];
    const built = state.built;
    const ran = state.scenario?.id === 'roadClosure' ? state.scenario.closure : null;
    const showing = ran && state.mapShows !== 'baseline' && ran.mode !== 'detour';
    if (built && showing) {
        const lane = built.lanes.find((item) => item.name === ran.lane);
        const at = lane && laneMidpoint(lane);
        if (at) marks.push({ ...at, kind: 'closed', title: `${laneEnds(lane)}: ${ran.open > 0 ? `open ${ran.open}% of the way` : 'closed'} from day ${ran.startDay} for ${ran.days} days` });
    }
    const choosing = built && state.closureChosen && !$('#stepScenario').hidden && !$('#stepScenario').classList.contains('collapsed')
        && state.scenarioTab === 'roadClosure' && $('#closureModeSelect').value !== 'detour';
    const chosen = choosing ? built.lanes.find((item) => item.name === $('#closureLaneSelect').value) : null;
    if (chosen && !(showing && chosen.name === ran.lane)) {
        const at = laneMidpoint(chosen);
        if (at) marks.push({ ...at, kind: 'planned', title: `${laneEnds(chosen)}: to be closed when the scenario runs` });
    }
    map.setMarks(marks);
    $('#legendClosed').hidden = !marks.length;
    $('#legendClosedText').textContent = marks.some((mark) => mark.kind === 'closed') ? 'Road closed' : 'Road to close';
}

function renderBuilt() {
    renderFlows();
    const built = state.built;
    const basisLabel = { routed: 'routed', local: 'local streets', 'straight-line': 'straight line' };
    const count = (basis) => built.provenance.filter((entry) => entry.basis === basis).length;
    const bases = ['assumed', 'synthetic', 'user'].filter((basis) => count(basis)).map((basis) => `${count(basis)} ${basis === 'user' ? 'yours' : basis}`);
    $('#buildResult').innerHTML = `
        <table>
            <thead><tr><th>Road lane</th><th class="number">${goods()}/day</th><th class="number">km</th><th class="number">hours</th><th class="number" title="${built.operator ? `${escape(built.operator.trucks.map((truck) => truck.label).join(' + '))}` : built.vehicles ? 'Of each vehicle type it runs on' : 'Trucks of the first size'}">${built.vehicles ? 'vehicles' : 'trucks'}</th></tr></thead>
            <tbody>${built.lanes.map((lane) => `<tr><td>${escape(laneEnds(lane))} <span class="basis ${lane.basis === 'routed' ? '' : 'assumed'}">${basisLabel[lane.basis]}</span>${lane.operator ? ` <span class="basis ${built.operator.synthetic ? 'synthetic' : 'user'}">operator</span>` : ''}${lane.standby ? ' <span class="basis" title="Carries nothing until cargo is diverted to its port">standby</span>' : ''}</td><td class="number">${number(lane.rate, 1)}</td><td class="number">${number(lane.kilometres, 1)}</td><td class="number">${number(lane.leadTime * 24, 1)}</td><td class="number">${trucksOf(lane)}</td></tr>`).join('')}</tbody>
        </table>
        ${renderOperator(built.operator)}
        <table>
            <thead><tr><th>Store or customer area</th><th>Served from</th><th class="number">${goods()}/day</th></tr></thead>
            <tbody>${built.served.map((item) => `<tr><td>${escape(item.town)}</td><td>${escape(item.zone)}</td><td class="number">${number(item.demand, 1)}</td></tr>`).join('')}</tbody>
        </table>
        <details><summary>Where every value comes from (${built.provenance.length}${bases.length ? `; ${bases.join(', ')}` : ''})</summary>
            <table><thead><tr><th>Site</th><th>Value</th><th>Basis</th></tr></thead>
            <tbody>${built.provenance.map((entry) => `<tr><td>${escape(entry.entity)}</td><td>${escape(entry.parameter)}: ${number(entry.value, entry.unit === 'day' ? 3 : 1)} ${escape(entry.unit)}<div class="basis">${escape(entry.detail ?? '')}</div></td><td><span class="basis ${['assumed', 'synthetic', 'user'].includes(entry.basis) ? entry.basis : ''}">${escape(entry.basis === 'user' ? 'yours' : entry.basis)}</span></td></tr>`).join('')}</tbody></table>
        </details>`;
}

// A lane's trucks: of the first size, plus the second when it has any; with vehicle types, each by its name.
const trucksOf = (lane) => (lane.vehicles
    ? lane.vehicles.map((item) => `${item.fleet} ${item.name.toLowerCase()}${item.fleet === 1 ? '' : 's'}`).join(' + ')
    : lane.fleet2 ? `${lane.fleet} + ${lane.fleet2}` : `${lane.fleet}`);
// What the model counts: pallets for a network with vehicle types, TEU for one built before them.
const goods = () => state.built?.unit ?? 'TEU';
// A lane's ends as the user named them: a store's lane ends at the store, not at its stock room's node.
const laneEnds = (lane) => `${lane.from} → ${lane.site ?? lane.to}`;

// The fleet operator: its trucks and costs, its depots, and each lane it carries with the capacity it has there
// against what the lane's flow needs on the road.
function renderOperator(operator) {
    if (!operator) return '';
    const label = operator.synthetic ? '<span class="basis synthetic">synthetic: invented and plausible, not a real company</span>' : '<span class="basis user">yours</span>';
    return `
        <p class="small"><b>${escape(operator.name)}</b> ${label}</p>
        <table><thead><tr><th>Truck</th><th class="number">TEU</th><th class="number">per km</th><th class="number">per day</th></tr></thead>
            <tbody>${operator.trucks.map((truck) => `<tr><td>${escape(truck.label)}</td><td class="number">${number(truck.teu)}</td><td class="number">${number(truck.costPerKm, 2)}</td><td class="number">${number(truck.costPerDay)}</td></tr>`).join('')}</tbody></table>
        <table><thead><tr><th>Lane it carries</th><th>Depot</th><th class="number">trucks</th><th class="number" title="TEU of trucks on the lane, against what its flow needs to keep up: the trucks on the road, loaded and returning, and a loading period's flow idle at the port">capacity / need</th></tr></thead>
            <tbody>${operator.lanes.map((lane) => `<tr><td>${escape(lane.name.replace(/^Road /, ''))}</td><td>${escape(lane.depot)}</td><td class="number">${trucksOf(lane)}</td><td class="number${lane.capacity < lane.need ? ' worse' : ''}">${number(lane.capacity)} / ${number(lane.need)}</td></tr>`).join('')}</tbody></table>
        <p class="muted small">Costs are in ${escape(operator.currency ?? 'cost units')}. Lanes it does not carry use its truck sizes and costs too, with a fleet sized to their flow.</p>`;
}

// A click is a change of its own: if a build is running, the model is built again once it ends.
$('#buildButton').addEventListener('click', () => { state.edits = (state.edits ?? 0) + 1; build({ focus: false }); });
$('#showButton').addEventListener('click', async () => {
    // The session goes with it, so settings changed since the last build are kept when the project is saved.
    try { await call(api.openInCanvas(null, { focus: true, silent: true, session: sessionState() })); } catch (error) { $('#buildStatus').innerHTML = notice('error', error.message); }
});

// ---- the session kept with the project ------------------------------------------------------------------
// Kept after every change too, not only with a build: a network placed and not yet built is saved with the project.
function keepSessionSoon() {
    if (!api?.keepSession || state.restoring) return;
    clearTimeout(state.keepTimer);
    state.keepTimer = setTimeout(() => {
        if (state.restoring || !state.roads) return;
        api.keepSession(sessionState()).catch?.(() => {});
    }, 800);
}

// Everything the window needs to carry on where it was: the place, the network and the last build's tables. The host
// keeps the fetched map data beside it, so a saved project reopens its region offline.
function sessionState() {
    return {
        version: 2, place: state.place ? { display_name: state.place.display_name, boundingbox: state.place.boundingbox } : null,
        margin: $('#marginSelect').value, bbox: state.bbox, roadLevel: state.roadLevel, sample: Boolean(state.sample), portVolume: state.portVolume,
        // Links without their legs, which are routed again when the session is restored (from the same roads, the same legs).
        pins: state.pins, links: state.links.map(({ id, from, to, basis, vehicles }) => ({ id, from, to, basis, ...(vehicles ? { vehicles } : {}) })), vehicles: state.vehicles,
        dismissed: [...state.dismissed], suggestions: Object.keys(state.suggestions), available: [...state.available], listRole: state.listRole,
        built: state.built, keepInStep: $('#keepInStep').checked,
        arrivals: $('#arrivalsSelect').value, historyFrom: $('#historyFromInput').value || null, ...conversion(),
        operator: $('#operatorSelect').value || null, operatorFile: Boolean(state.operatorFile), standby: [...state.standby],
        disruption: { ...disruptionSettings(), dependence: [...state.dependence], transits: [...state.transits].filter(([, value]) => value && !value.error) },
        scenarioTab: state.scenarioTab, scenarioSettings: scenarioSettings(), scenario: state.scenario
    };
}

// A session kept by the earlier curation workflow: its kept and added sites become pins, linked as suggested.
async function migrateSession(saved) {
    const asked = Object.keys(sources).filter((source) => sources[source].kinds.every((kind) => state.available.has(kind)));
    if (asked.length) await discoverSuggestions(asked);
    const sourceOf = { ports: 'ports', zones: 'warehouses', towns: 'towns' };
    const changes = new Map(saved.changes ?? []);
    for (const group of ['ports', 'zones', 'towns']) {
        const candidates = state.suggestions[sourceOf[group]]?.candidates[group] ?? [];
        for (const id of saved.kept?.[group] ?? []) {
            const candidate = candidates.find((item) => item.id === id);
            if (!candidate) continue;
            const change = changes.get(id) ?? {};
            const pin = adoptCandidate({ ...candidate, ...(change.lat !== undefined ? { lat: change.lat, lon: change.lon } : {}), ...(change.name ? { name: change.name } : {}) }, group);
            if (pin && change.teuPerDay > 0 && pin.role === 'port') setField(pin, 'teuPerDay', change.teuPerDay);
        }
    }
    for (const site of saved.added ?? []) {
        const role = { port: 'port', zone: 'warehouse', town: 'customerArea' }[site.kind];
        const fields = site.teuPerDay > 0 ? { [role === 'port' ? 'teuPerDay' : 'demand']: site.teuPerDay } : {};
        state.pins.push(createPin(role, site, { name: site.name, pins: state.pins, fields }));
    }
}

async function restoreSession() {
    if (!api?.restoreSession) return;
    let answer;
    try {
        answer = await call(api.restoreSession());
    } catch {
        return;
    }
    const saved = answer.session;
    if (!saved || ![1, 2].includes(saved.version)) return;
    setBusy(true);
    state.restoring = true;
    try {
        state.place = saved.place;
        state.bbox = saved.bbox;
        state.roadLevel = saved.roadLevel ?? 'major';
        state.sample = Boolean(saved.sample);
        if (saved.margin) $('#marginSelect').value = saved.margin;
        $('#roadLevelSelect').value = state.roadLevel;
        if (state.place) {
            $('#chosenRegion').hidden = false;
            $('#chosenName').textContent = state.place.display_name;
        }
        // The roles the host holds: what the session says, else what its inputs list.
        state.available = new Set(saved.available ?? (answer.inputs ?? []).map((input) => input.role));
        state.portVolume = saved.portVolume ?? null;
        $('#keepInStep').checked = saved.keepInStep !== false;
        if (saved.arrivals) $('#arrivalsSelect').value = saved.arrivals;
        $('#historyFromInput').value = saved.historyFrom ?? '';
        $('#tonnesPerTeuInput').value = saved.tonnesPerTeu ?? 10;
        $('#inlandShareInput').value = Math.round((saved.inlandShare ?? 1) * 100);
        $('#operatorSelect').value = saved.operator ?? '';
        state.operatorFile = Boolean(saved.operatorFile);
        state.standby = new Set(saved.standby ?? []);
        if (state.operatorFile) $('#operatorFileButton').textContent = 'Choose another file';
        showOperatorChoice();
        state.scenarioTab = saved.scenarioTab ?? 'chokepointDisruption';
        state.savedScenarioSettings = saved.scenarioSettings ?? null;
        if (saved.disruption) {
            state.dependence = new Map(saved.disruption.dependence ?? []);
            state.transits = new Map(saved.disruption.transits ?? []);
            $('#cutInput').value = saved.disruption.cut ?? 50;
            $('#startInput').value = saved.disruption.startDay ?? 10;
            $('#durationInput').value = saved.disruption.days ?? 30;
            $('#delayedInput').value = saved.disruption.delayed ?? 0;
            $('#catchUpInput').value = saved.disruption.catchUpDays ?? 20;
            $('#divertedInput').value = saved.disruption.diverted ?? 0;
            $('#trucksFoundInput').value = saved.disruption.trucksFound ?? 100;
            $('#divertBerthsInput').value = saved.disruption.divertBerths ?? '';
            $('#demandDuringInput').value = saved.disruption.demandDuring ?? 0;
            state.savedDivertTo = saved.disruption.divertTo ?? null;
            $('#divertedInput2').value = saved.disruption.diverted2 ?? 0;
            $('#divertBerthsInput2').value = saved.disruption.divertBerths2 ?? '';
            state.savedDivertTo2 = saved.disruption.divertTo2 ?? null;
            state.savedChokepoint = saved.disruption.chokepoint ?? null;
        }
        state.built = null;
        // A session from before stock and vehicles: its pins get the figures they lack, and the default vehicles.
        state.pins = (saved.version === 2 ? saved.pins ?? [] : []).map(completeFields);
        state.links = saved.version === 2 ? saved.links ?? [] : [];
        state.vehicles = completeCatalogue(saved.vehicles);
        renderVehicles();
        state.dismissed = new Set(saved.dismissed ?? []);
        state.listRole = saved.listRole ?? 'all';
        await loadRoads({ keepNetwork: true });
        if (saved.version === 2 && saved.suggestions?.length) await discoverSuggestions(saved.suggestions);
        if (saved.version === 1) await migrateSession(saved);
        if (saved.built) state.built = saved.built;
        state.restoring = false;
        renderSuggestions();
        networkChanged({ rebuild: false });
        if (saved.built) {
            renderBuilt();
            $('#showButton').disabled = false;
            state.scenario = saved.scenario ?? null;
            renderScenario();
            $('#buildStatus').innerHTML = notice('ok', `The model in the canvas is the one this session built: ${saved.built.nodes} nodes and ${saved.built.edges} relationships.`);
        }
        const when = answer.savedAt ? new Date(answer.savedAt).toLocaleString() : 'earlier';
        // When the map data the session holds was fetched, by kind.
        state.fetchedAt = {};
        for (const input of (answer.inputs ?? []).filter((item) => item.retrievedAt)) {
            const known = state.fetchedAt[input.role];
            if (!known || input.retrievedAt < known.at) state.fetchedAt[input.role] = { at: input.retrievedAt, cached: false };
        }
        renderDataAge();
        const fetched = (answer.inputs ?? []).filter((input) => input.retrievedAt).map((input) => input.retrievedAt).sort()[0];
        $('#regionStatus').innerHTML = notice('ok', `Restored the session kept with this project (saved ${when}).${fetched ? ` Its map data was fetched on ${new Date(fetched).toLocaleDateString()}; load the roads again for newer data.` : ''}`)
            + (saved.version === 1 ? notice('warning', 'This session was kept by the earlier workflow, which kept sites from lists: they are now pins on the map, linked as suggested. The model in the canvas was built the earlier way; build again to build it from the links shown.') : '');
    } catch (error) {
        $('#regionStatus').innerHTML = notice('error', `The session kept with this project could not be restored: ${error.message}`);
    } finally {
        state.restoring = false;
        setBusy(false);
    }
}

function setBusy(busy) {
    state.busy = busy;
    if (!busy && state.buildAgain) {
        state.buildAgain = false;
        if ((state.edits ?? 0) !== state.builtEdits) setTimeout(() => build({ focus: false }), 0);
    }
    // Run waits too: a scenario asked for while the model is being built would otherwise be silently ignored.
    for (const selector of ['#fetchButton', '#sampleButton', '#sitesButton', '#searchButton', '#runScenarioButton', ...Object.keys(sources).map((source) => `[data-fetch-source="${source}"]`)]) $(selector).disabled = busy;
    if (!busy) showArea();
    const errors = networkProblems(state.pins, state.links, state.vehicles).filter((problem) => problem.level === 'error');
    $('#buildButton').disabled = busy || errors.length > 0 || !state.pins.length;
}

// For the window tests: the state, to read how long routing took (only when the page is opened with ?inspect).
if (new URLSearchParams(location.search).has('inspect')) window.logisticsToolboxState = state;

if (!api) $('#regionStatus').innerHTML = notice('error', 'This window must be opened from Konjugate.');
else { restoreSession(); renderCacheSummary(); }

// ---- the scenarios: a chokepoint disruption --------------------------------------------------------------------------
// Fewer ships through a chokepoint for a while: each kept port's arrivals fall by its share of ships through it times
// the cut. The shares start from geography (a port in an enclosed sea depends on the strait that closes it) and are
// the user's to change. The scenario forks the model on the day the disruption starts.
const day = 86400;

// The port pin of a built port: what was found there when adopted, else the pin itself. A supplier has no sea.
const portSite = (port) => {
    const pin = state.pins.find((item) => item.name === port.name && item.role === 'port');
    return pin ? { ...pin, ...(pin.candidate ?? {}), lat: pin.lat, lon: pin.lon } : null;
};
// A port's shares through each chokepoint: the user's own, else the sea it lies in.
function sharesOf(port) {
    if (port.supplier) return {};
    if (state.dependence.has(port.name)) return state.dependence.get(port.name);
    const site = portSite(port);
    return (site?.chokepoints ?? (site ? chokepointDependence(site) : { shares: {} })).shares;
}
const seaOf = (port) => {
    const site = portSite(port);
    return (site?.chokepoints ?? (site ? chokepointDependence(site) : { sea: null })).sea;
};
// The ports of the model, without its suppliers: what ships reach.
const builtPorts = () => (state.built?.ports ?? []).filter((port) => !port.supplier);

function disruptionSettings() {
    return {
        chokepoint: $('#chokepointSelect').value || null,
        cut: Number($('#cutInput').value), startDay: Number($('#startInput').value), days: Number($('#durationInput').value),
        delayed: Number($('#delayedInput').value) || 0, catchUpDays: Number($('#catchUpInput').value) || 0,
        diverted: Number($('#divertedInput').value) || 0, divertTo: $('#divertToSelect').value || null,
        trucksFound: $('#trucksFoundInput').value === '' ? 100 : Number($('#trucksFoundInput').value),
        divertBerths: Number($('#divertBerthsInput').value) > 0 ? Number($('#divertBerthsInput').value) : null,
        demandDuring: Number($('#demandDuringInput').value) || 0,
        diverted2: Number($('#divertedInput2').value) || 0, divertTo2: $('#divertToSelect2').value || null,
        divertBerths2: Number($('#divertBerthsInput2').value) > 0 ? Number($('#divertBerthsInput2').value) : null
    };
}

function renderScenario({ fetchTransits = false } = {}) {
    const built = state.built;
    $('#stepScenario').hidden = !built?.ports;
    if (!built?.ports) return;
    // The chokepoints a kept port depends on first, then the rest.
    const used = new Set(built.ports.flatMap((port) => Object.entries(sharesOf(port)).filter(([, share]) => share > 0).map(([id]) => id)));
    const previous = $('#chokepointSelect').value || state.savedChokepoint;
    state.savedChokepoint = null;
    const option = (item) => `<option value="${item.id}">${escape(item.name)}</option>`;
    $('#chokepointSelect').innerHTML = (used.size ? `<optgroup label="Your ports depend on">${chokepoints.filter((item) => used.has(item.id)).map(option).join('')}</optgroup>` : '')
        + `<optgroup label="${used.size ? 'Other chokepoints' : 'Chokepoints'}">${chokepoints.filter((item) => !used.has(item.id)).map(option).join('')}</optgroup>`;
    if (previous && chokepointById.has(previous)) $('#chokepointSelect').value = previous;
    // A network with no port has no chokepoint to disrupt: its tab is hidden, and nothing is fetched for it.
    const hasPorts = builtPorts().length > 0;
    $('#scenarioTabs [data-scenario="chokepointDisruption"]').hidden = !hasPorts;
    if (!hasPorts && state.scenarioTab === 'chokepointDisruption') state.scenarioTab = 'roadClosure';
    renderDependence();
    // After a fresh build, fetch the chokepoint's transits; when restoring a session (perhaps offline), show only what was kept.
    if (hasPorts) renderTransits({ fetch: fetchTransits });
    renderScenarioChoices();
    renderScenarioResult();
}

// The ports cargo can be diverted to: kept ports the chokepoint doesn't reach.
function renderDiversion() {
    const chokepoint = $('#chokepointSelect').value;
    const previous = $('#divertToSelect').value || state.savedDivertTo;
    state.savedDivertTo = null;
    const outside = builtPorts().filter((port) => !((sharesOf(port)[chokepoint] ?? 0) > 0));
    $('#divertToSelect').innerHTML = outside.length
        ? outside.map((port) => `<option value="${escape(port.name)}">${escape(port.name)} (berths for ${number(port.berths ?? port.arrivals * 1.5)} ${goods()}/day)</option>`).join('')
        : '<option value="">no kept port outside it</option>';
    if (previous && outside.some((port) => port.name === previous)) $('#divertToSelect').value = previous;
    // A second port: any other kept port outside the chokepoint.
    const previous2 = $('#divertToSelect2').value || state.savedDivertTo2;
    state.savedDivertTo2 = null;
    const others = outside.filter((port) => port.name !== $('#divertToSelect').value);
    $('#divertToSelect2').innerHTML = others.map((port) => `<option value="${escape(port.name)}">${escape(port.name)} (berths for ${number(port.berths ?? port.arrivals * 1.5)} ${goods()}/day)</option>`).join('');
    if (previous2 && others.some((port) => port.name === previous2)) $('#divertToSelect2').value = previous2;
    showDiversionRows();
}
// The trucks and berths row once anything is diverted; the second port once there is one to choose.
function showDiversionRows() {
    const diverting = Number($('#divertedInput').value) > 0;
    $('#diversionRow').hidden = !diverting;
    $('#diversionRow2').hidden = !(diverting && $('#divertToSelect2').options.length);
}
$('#divertedInput').addEventListener('input', showDiversionRows);
$('#divertToSelect').addEventListener('change', renderDiversion);

function renderDependence() {
    renderDiversion();
    const chokepoint = $('#chokepointSelect').value;
    $('#dependenceTable').innerHTML = `<thead><tr><th>Port</th><th>Sea</th><th class="number" title="The share of the port's ships that pass this chokepoint: from the sea it lies in, an assumption you can change">Through it</th></tr></thead><tbody>${
        builtPorts().map((port) => `<tr data-port="${escape(port.name)}"><td>${escape(port.name)}</td><td class="sea">${escape(seaOf(port) ?? 'open sea')}</td>`
            + `<td class="number"><input type="number" min="0" max="100" step="5" value="${Math.round((sharesOf(port)[chokepoint] ?? 0) * 100)}" aria-label="Share of ${escape(port.name)}'s ships through the chokepoint"> %</td></tr>`).join('')
    }</tbody>`;
    $('#dependenceTable').querySelectorAll('input').forEach((input) => input.addEventListener('change', () => {
        const name = input.closest('tr').dataset.port;
        const port = state.built.ports.find((item) => item.name === name);
        const value = Math.min(100, Math.max(0, Number(input.value) || 0)) / 100;
        state.dependence.set(name, { ...sharesOf(port), [$('#chokepointSelect').value]: value });
        input.value = Math.round(value * 100);
        renderDiversion();
        // A port's own drop, as a cut, depends on its share through the chokepoint.
        renderTransits({ fetch: false });
    }));
}

// The chokepoint's container ships a day lately against its busiest full year, from PortWatch: the cut it shows.
async function renderTransits({ fetch = true } = {}) {
    const chokepoint = $('#chokepointSelect').value;
    const box = $('#transitSummary');
    if (!chokepoint) { box.hidden = true; return; }
    box.hidden = false;
    if (!state.transits.has(chokepoint) && !fetch) {
        box.innerHTML = `How busy ${escape(chokepointById.get(chokepoint).name)} is lately: <button class="link" type="button" id="fetchTransits">Fetch its transits from IMF PortWatch</button>`;
        $('#fetchTransits').addEventListener('click', () => renderTransits());
        return;
    }
    if (!state.transits.has(chokepoint)) {
        box.textContent = 'Fetching its transits from IMF PortWatch…';
        try {
            const [yearly, recent] = [await call(api.fetchText(chokepointYearlyUrl(chokepoint))), await call(api.fetchText(chokepointRecentUrl(chokepoint)))];
            state.transits.set(chokepoint, summariseTransits(yearly.text, recent.text));
        } catch (error) {
            state.transits.set(chokepoint, { error: error.message });
        }
        if ($('#chokepointSelect').value !== chokepoint) return;
    }
    // A port's own fall in imports is often the better cut than the strait's: some ships still come, or cargo for it
    // comes another way. For a port that receives only part of its ships through the chokepoint, the cut that gives
    // its fall is that fall over its share.
    const months = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const own = (state.built?.ports ?? []).map((port) => ({ port, share: sharesOf(port)[chokepoint] ?? 0 }))
        .filter(({ port, share }) => share > 0 && port.shift?.change < 0)
        .map(({ port, share }) => ({ name: port.name, fell: Math.round(-port.shift.change * 100), cut: Math.min(100, Math.round(-port.shift.change / share * 100)), month: months(port.shift.month), share }));
    const ownLinks = own.map((item) => ` ${escape(item.name)}'s own imports fell ${item.fell}% from ${item.month}${item.share < 1 ? ` (${Math.round(item.share * 100)}% of its ships pass here)` : ''}: <button class="link" type="button" data-own-cut="${item.cut}" title="Often the better cut for one port: some ships still come, or cargo comes another way">use ${item.cut}%</button>.`).join('');
    const listenOwn = () => box.querySelectorAll('[data-own-cut]').forEach((button) => button.addEventListener('click', () => { $('#cutInput').value = button.dataset.ownCut; }));
    const transits = state.transits.get(chokepoint);
    if (!transits || transits.error) {
        box.innerHTML = `Its transits could not be fetched from IMF PortWatch${transits?.error ? ` (${escape(transits.error)})` : ''}. Set the cut yourself.${ownLinks}`;
        listenOwn();
        return;
    }
    const percent = Math.round(transits.drop * 100);
    box.innerHTML = `${escape(chokepointById.get(chokepoint).name)}: ${number(transits.recent.containerShips, 1)} container ships a day from ${transits.recent.from} to ${transits.recent.to}, against ${number(transits.usual.containerShips, 1)} in ${transits.usual.year}, its busiest full year`
        + (percent > 0 ? `: ${percent}% fewer. <button class="link" type="button" id="useDrop">Use ${percent}%</button>.` : '.')
        + ownLinks
        + ' <span class="muted">IMF PortWatch (Source: International Monetary Fund).</span>';
    $('#useDrop')?.addEventListener('click', () => { $('#cutInput').value = percent; });
    listenOwn();
}

$('#chokepointSelect').addEventListener('change', () => { renderDependence(); renderTransits(); });

// ---- the scenarios: choosing one ----------------------------------------------------------------------------------
// Four scenarios share the days they run for and the summary of what they changed: a chokepoint disruption (above), a
// road closed, the fleet changed and demand stepped up.
const scenarioIds = ['chokepointDisruption', 'roadClosure', 'fleetChange', 'demandSurge'];

function showScenarioTab() {
    document.querySelectorAll('#scenarioTabs button').forEach((button) => button.classList.toggle('active', button.dataset.scenario === state.scenarioTab));
    document.querySelectorAll('.scenarioPanel').forEach((panel) => { panel.hidden = panel.dataset.panel !== state.scenarioTab; });
    renderMarks();
}
document.querySelectorAll('#scenarioTabs button').forEach((button) => button.addEventListener('click', () => {
    state.scenarioTab = button.dataset.scenario;
    if (state.scenarioTab === 'roadClosure') state.closureChosen = true;
    showScenarioTab();
}));

// The lanes, fleets and towns each scenario can choose from, after a build.
function renderScenarioChoices() {
    const built = state.built;
    const saved = state.savedScenarioSettings;
    state.savedScenarioSettings = null;
    const keep = (selector, value) => { if (value !== undefined && value !== null && [...$(selector).options].some((option) => option.value === value)) $(selector).value = value; };
    // An operator that has just appeared is what a fleet change is first about: its lanes, not every lane.
    const operatorAppeared = built.operator && ![...$('#fleetLanesSelect').options].some((option) => option.value === 'operator');
    const previous = {
        lane: $('#closureLaneSelect').value || saved?.closure?.lane,
        fleet: saved?.fleet?.lanes ?? (operatorAppeared ? 'operator' : $('#fleetLanesSelect').value),
        towns: $('#demandTownsSelect').value || saved?.demand?.towns
    };
    // Busiest lanes first: closing one of them matters most.
    $('#closureLaneSelect').innerHTML = [...built.lanes].sort((a, b) => b.rate - a.rate)
        .map((lane) => `<option value="${escape(lane.name)}">${escape(laneEnds(lane))} (${number(lane.rate)} ${goods()}/day)</option>`).join('');
    keep('#closureLaneSelect', previous.lane);
    $('#fleetLanesSelect').innerHTML = (built.operator ? `<option value="operator">every lane ${escape(built.operator.name)} carries</option>` : '')
        + '<option value="all">every lane</option>'
        // With vehicle types: every lane a type runs on, as when vans or drivers of one kind are short.
        + (built.vehicles ?? []).filter((type) => built.lanes.some((lane) => lane.vehicles?.some((item) => item.type === type.id)))
            .map((type) => `<option value="type:${escape(type.id)}">every lane with ${escape(type.name.toLowerCase())}s</option>`).join('')
        + built.lanes.map((lane) => `<option value="lane:${escape(lane.name)}">${escape(laneEnds(lane))}</option>`).join('');
    keep('#fleetLanesSelect', previous.fleet);
    $('#demandTownsSelect').innerHTML = `<option value="all">${built.stores ? 'every store, dark store and customer area' : 'every town'}</option>`
        + [...(built.towns ?? [])].sort((a, b) => b.demand - a.demand).map((town) => `<option value="town:${escape(town.name)}">${escape(town.name)} (${number(town.demand, 1)} ${goods()}/day)</option>`).join('');
    keep('#demandTownsSelect', previous.towns);
    if (saved) {
        if (saved.closure) {
            $('#closureOpenInput').value = saved.closure.open ?? 0;
            $('#closureModeSelect').value = saved.closure.mode ?? 'wait';
            $('#detourHoursInput').value = saved.closure.detourHours ?? 3;
        }
        if (saved.fleet) $('#fleetChangeInput').value = saved.fleet.change ?? -30;
        if (saved.demand) $('#demandChangeInput').value = saved.demand.change ?? 30;
    }
    showScenarioTab();
    renderScenarioHints();
}

function scenarioSettings() {
    return {
        closure: { lane: $('#closureLaneSelect').value || null, mode: $('#closureModeSelect').value, open: Number($('#closureOpenInput').value) || 0, detourHours: Number($('#detourHoursInput').value) || 0 },
        fleet: { lanes: $('#fleetLanesSelect').value || null, change: Number($('#fleetChangeInput').value) },
        demand: { towns: $('#demandTownsSelect').value || null, change: Number($('#demandChangeInput').value) }
    };
}

const fleetLanes = (choice) => {
    const lanes = state.built.lanes;
    if (choice === 'operator') return lanes.filter((lane) => lane.operator);
    if (choice === 'all') return lanes;
    if (choice?.startsWith('type:')) return lanes.filter((lane) => lane.vehicles?.some((item) => `type:${item.type}` === choice));
    return lanes.filter((lane) => `lane:${lane.name}` === choice);
};
// A build saved before demand could be changed has no towns: rebuild to change it.
const demandTowns = (choice) => (choice === 'all' ? state.built.towns ?? [] : (state.built.towns ?? []).filter((town) => `town:${town.name}` === choice));

// What each choice means, in a line under it.
function renderScenarioHints() {
    if (!state.built?.lanes?.length) return;
    const settings = scenarioSettings();
    const lane = state.built.lanes.find((item) => item.name === settings.closure.lane);
    const mode = settings.closure.mode;
    $('#closureOpenRow').hidden = mode === 'detour';
    $('#closureDetourRow').hidden = mode !== 'detour';
    if (lane) {
        const others = state.built.lanes.filter((item) => item.to === lane.to && item !== lane);
        $('#closureHint').textContent = {
            wait: `${number(lane.leadTime * 24, 1)} h a trip today. ${lane.site ?? lane.to}'s orders over it queue until it reopens.`,
            detour: `${number(lane.leadTime * 24, 1)} h a trip today, over ${number(lane.kilometres)} km: the detour adds as many kilometres in proportion.`,
            otherPorts: others.length
                ? `${lane.site ?? lane.to} also orders over ${others.map((item) => `${item.from} (${number(item.rate)} ${goods()}/day)`).join(', ')}, which ship${others.length === 1 ? 's' : ''} only what ${others.length === 1 ? (lane.kind === 'store' ? 'its warehouse holds' : 'its port holds') : (lane.kind === 'store' ? 'their warehouses hold' : 'their ports hold')}.`
                : `${lane.site ?? lane.to} has no other lane: its orders wait for the road to reopen.`
        }[mode];
    }
    const lanes = fleetLanes(settings.fleet.lanes);
    const trucks = lanes.reduce((sum, item) => sum + item.fleet + (item.fleet2 ?? 0), 0);
    $('#fleetHint').textContent = `${lanes.length} lane${lanes.length === 1 ? '' : 's'} with ${number(trucks)} ${state.built.vehicles ? 'vehicles' : 'trucks'}.`;
    const towns = demandTowns(settings.demand.towns);
    $('#demandHint').textContent = `${towns.length} ${state.built.stores ? 'site' : 'town'}${towns.length === 1 ? '' : 's'} ordering ${number(towns.reduce((sum, town) => sum + town.demand, 0), 1)} ${goods()}/day.`;
}
for (const selector of ['#closureLaneSelect', '#closureModeSelect', '#fleetLanesSelect', '#demandTownsSelect']) $(selector).addEventListener('change', renderScenarioHints);
for (const selector of ['#closureLaneSelect', '#closureModeSelect']) $(selector).addEventListener('change', () => { state.closureChosen = true; renderMarks(); });

// ---- the scenarios: running one ------------------------------------------------------------------------------------

// The chokepoint disruption's data, or null when the window has asked the user something first.
function chokepointRun(settings, start, runTime, status) {
    if (!(settings.cut > 0 && settings.cut <= 100)) throw new Error('Cut the transits by more than 0% and at most 100%.');
    if (!(settings.delayed >= 0 && settings.delayed <= 100)) throw new Error('The share of the cargo that arrives later is from 0% to 100%.');
    if (settings.delayed > 0 && !(settings.catchUpDays > 0)) throw new Error('The delayed cargo must arrive over at least a day.');
    // The ports the cargo is diverted to: the first, and a second when it takes a share (only beside a first).
    const targets = settings.diverted > 0 ? [{ to: settings.divertTo, diverted: settings.diverted, berths: settings.divertBerths }, ...(settings.diverted2 > 0 ? [{ to: settings.divertTo2, diverted: settings.diverted2, berths: settings.divertBerths2 }] : [])] : [];
    const divertedAll = targets.reduce((sum, target) => sum + target.diverted, 0);
    if (!(settings.diverted >= 0 && settings.diverted2 >= 0 && settings.delayed + divertedAll <= 100)) throw new Error('The cargo that arrives later and the cargo diverted add up to at most 100% of what is kept out.');
    if (targets.some((target) => !target.to)) throw new Error('Choose a port outside the chokepoint to divert the cargo to.');
    if (targets.length === 2 && targets[0].to === targets[1].to) throw new Error('Divert to two different ports, or to one.');
    const affected = state.built.ports.map((port) => ({ port, share: sharesOf(port)[settings.chokepoint] ?? 0 })).filter((item) => item.share > 0);
    if (!affected.length) throw new Error(`None of the ports depends on ${chokepointById.get(settings.chokepoint).name}. Set a port's share through it to run the disruption.`);
    // A period already far below a port's usual traffic may be the disruption itself: cutting it again counts it twice.
    const already = affected.filter((item) => item.port.usual > 0 && item.port.arrivals < 0.5 * item.port.usual);
    const confirmation = JSON.stringify({ ...settings, ports: already.map((item) => item.port.name), from: $('#historyFromInput').value });
    if (already.length && state.confirmedDisruption !== confirmation) {
        const transits = state.transits.get(settings.chokepoint);
        const busy = transits && !transits.error ? ` PortWatch counts ${number(transits.recent.containerShips, 1)} container ships a day through ${escape(chokepointById.get(settings.chokepoint).name)} lately, against ${number(transits.usual.containerShips, 1)} in ${transits.usual.year}.` : '';
        status.innerHTML = `<div class="notice warning">The period modelled is already far below the usual traffic at ${already.map((item) => `${escape(item.port.name)} (${number(item.port.arrivals)} TEU a day against about ${number(item.port.usual)} before its history ${item.port.shift?.change < 0 ? 'fell' : 'changed'})`).join(', ')}.${busy} Cutting it again would count the disruption twice; choose a period before the break under History from, or <button class="link" type="button" id="runAnyway">run it anyway</button>.</div>`;
        $('#runAnyway').addEventListener('click', () => {
            state.confirmedDisruption = confirmation;
            $('#runScenarioButton').click();
        });
        return null;
    }
    const supplied = { entities: affected.map((item) => item.port.name), samples: {} };
    const volumes = {};
    for (const { port, share } of affected) {
        const plan = disruptionPlan({
            base: port.schedule ?? port.arrivals, dependence: share, cut: settings.cut / 100,
            start, duration: settings.days * day, forkAt: start, runTime,
            delayedShare: settings.delayed / 100, catchUp: settings.catchUpDays * day
        });
        supplied.samples[port.name] = plan.path;
        // TEU: the paths are TEU a day over seconds.
        volumes[port.name] = { keptOut: plan.keptOut / day, caughtUp: plan.caughtUp / day };
    }
    const name = chokepointById.get(settings.chokepoint).name;
    const reaching = `${name}: transits cut by ${settings.cut}% from day ${settings.startDay} for ${settings.days} days, reaching ${affected.map((item) => `${item.port.name} (${Math.round(item.share * 100)}% of its ships)`).join(', ')}`;
    const later = settings.delayed > 0 ? `; ${settings.delayed}% of the cargo kept out arrives over the ${settings.catchUpDays} days after` : '';
    const extra = { chokepoint: name, affected: affected.map((item) => ({ port: item.port.name, share: item.share, ...volumes[item.port.name] })), demandDuring: settings.demandDuring };
    // Every town's orders while the cut lasts: as before unless the user says people buy less (or more).
    const towns = state.built.towns ?? [];
    const baseDemand = settings.demandDuring
        ? demandPlan({ towns, change: settings.demandDuring / 100, start, duration: settings.days * day, forkAt: start, runTime }).supplied.baseDemand
        : { entities: towns.map((town) => town.name), samples: Object.fromEntries(towns.map((town) => [town.name, heldPath({ outside: town.demand, inside: town.demand, start, duration: settings.days * day, forkAt: start, runTime })])) };
    const demandNote = settings.demandDuring ? `; every town's orders ${settings.demandDuring < 0 ? 'fall' : 'rise'} ${Math.abs(settings.demandDuring)}% while it lasts` : '';
    const reached = affected.map((item) => ({ port: item.port.name, share: item.share }));
    if (!targets.length) {
        // The cargo kept out is lost (or arrives later): the warehouses stop ordering what will not come while the cut lasts.
        const orders = keptOutPlan({ lanes: state.built.lanes, affected: reached, cut: settings.cut / 100, start, duration: settings.days * day, forkAt: start, runTime });
        return { id: 'chokepointDisruption', supplied: { byParameter: { vesselArrivals: supplied, orderShare: orders.supplied.orderShare, baseDemand } }, lanes: [], describe: `${reaching}${later || '; the cargo kept out is lost'}${demandNote}.`, extra };
    }
    // Part of it lands at ports outside the chokepoint and is trucked inland from there.
    const diversion = diversionPlan({
        lanes: state.built.lanes, ports: state.built.ports, affected: reached,
        // The berths the user gives are in TEU a day, as a port counts them; the model may count pallets.
        targets: targets.map((target) => ({ to: target.to, diverted: target.diverted / 100, berths: target.berths ? target.berths * (state.built.perTeu ?? 1) : target.berths })),
        cut: settings.cut / 100, trucksFound: settings.trucksFound / 100,
        start, duration: settings.days * day, forkAt: start, runTime, ...state.built.trucking
    });
    const byParameter = { ...diversion.supplied, vesselArrivals: { entities: [...supplied.entities, ...diversion.supplied.vesselArrivals.entities], samples: { ...supplied.samples, ...diversion.supplied.vesselArrivals.samples } }, baseDemand };
    const port = (item) => `${item.to} (${number(item.teu)} ${goods()}), whose berths take ${number(item.berths)} ${goods()}/day`;
    const [first, second] = diversion.targets;
    const where = `${Math.round(first.diverted * 100)}% of it is diverted to ${port(first)}${second ? `, and ${Math.round(second.diverted * 100)}% to ${port(second)};` : ', and'}`;
    const unreachable = diversion.unreachable;
    return {
        id: 'chokepointDiversion', supplied: { byParameter }, lanes: diversion.lanes,
        describe: `${reaching}${later}; ${where} trucked inland over ${diversion.lanes.length} lane${diversion.lanes.length === 1 ? '' : 's'} with ${number(diversion.trucks)} trucks${settings.trucksFound < 100 ? ` (${settings.trucksFound}% of those needed)` : ''}${unreachable.length ? `; ${unreachable.join(', ')} ${unreachable.length === 1 ? 'has' : 'have'} no lane from ${diversion.targets.length > 1 ? 'one of them' : 'it'}, so ${unreachable.length === 1 ? 'its' : 'their'} share stays kept out` : ''}${demandNote}.`,
        extra: { ...extra, diversion: { to: diversion.targets.map((item) => item.to), teu: diversion.divertedTeu } }
    };
}

function scenarioRun(id, start, runTime, status) {
    const common = { start, duration: Number($('#durationInput').value) * day, forkAt: start, runTime };
    const days = `from day ${$('#startInput').value} for ${$('#durationInput').value} days`;
    const settings = scenarioSettings();
    if (id === 'chokepointDisruption') return chokepointRun(disruptionSettings(), start, runTime, status);
    if (id === 'roadClosure') {
        const { mode } = settings.closure;
        const open = settings.closure.open / 100;
        const plan = closurePlan({ lanes: state.built.lanes, closed: settings.closure.lane, mode, open, detourHours: settings.closure.detourHours, ...common });
        const lane = state.built.lanes.find((item) => item.name === settings.closure.lane);
        const what = mode === 'detour'
            ? `on a detour ${days}: ${number(plan.detour.hours, 1)} h and ${number(plan.detour.kilometres)} km more each way`
            : `${open > 0 ? `restricted to ${settings.closure.open}% of its loads` : 'closed'} ${days}: ${number(plan.teuPerDay, 1)} ${goods()} a day it no longer carries${plan.reroutedTo.length ? `, ordered from ${state.built.lanes.filter((item) => plan.reroutedTo.includes(item.name)).map((item) => item.from).join(' and ')} instead` : ', its orders waiting for the road to reopen'}`;
        return {
            supplied: { byParameter: plan.supplied }, lanes: plan.supplied.orderShare.entities, describe: `${laneEnds(lane)} ${what}.`,
            // For the map's X on the closed road.
            extra: { closure: { lane: lane.name, mode, open: settings.closure.open, startDay: Number($('#startInput').value), days: Number($('#durationInput').value) } }
        };
    }
    if (id === 'fleetChange') {
        const lanes = fleetLanes(settings.fleet.lanes);
        const plan = fleetPlan({ lanes, change: settings.fleet.change / 100, ...common });
        const type = settings.fleet.lanes?.startsWith('type:') ? (state.built.vehicles ?? []).find((item) => `type:${item.id}` === settings.fleet.lanes) : null;
        const which = settings.fleet.lanes === 'operator' ? `on the lanes ${state.built.operator.name} carries` : settings.fleet.lanes === 'all' ? 'on every lane' : type ? `on every lane with ${type.name.toLowerCase()}s` : `on ${laneEnds(lanes[0])}`;
        return {
            supplied: { byParameter: plan.supplied }, lanes: lanes.map((lane) => lane.name),
            describe: `${state.built.vehicles ? 'Vehicles' : 'Trucks'} ${which} changed by ${settings.fleet.change > 0 ? '+' : ''}${settings.fleet.change}% ${days}: ${number(plan.trucks.before)} to ${number(plan.trucks.after)}.`
        };
    }
    const towns = demandTowns(settings.demand.towns);
    const plan = demandPlan({ towns, change: settings.demand.change / 100, ...common });
    const servedBy = new Set(state.built.served.filter((item) => towns.some((town) => town.name === item.town)).map((item) => item.zone));
    return {
        // The lanes into the warehouses that serve them, and those to the stores themselves.
        supplied: { byParameter: plan.supplied }, lanes: state.built.lanes.filter((lane) => servedBy.has(lane.to) || towns.some((town) => town.name === lane.site)).map((lane) => lane.name),
        describe: `Demand ${settings.demand.change > 0 ? 'up' : 'down'} ${Math.abs(settings.demand.change)}% in ${settings.demand.towns === 'all' ? (state.built.stores ? 'every store, dark store and customer area' : 'every town') : towns[0].name} ${days}: ${number(Math.abs(plan.extraTeu))} ${goods()} ${settings.demand.change > 0 ? 'more' : 'fewer'} ordered.`
    };
}

$('#runScenarioButton').addEventListener('click', async () => {
    if (state.busy || !state.built) return;
    const id = state.scenarioTab;
    const runTime = state.built.days * day;
    const startDay = Number($('#startInput').value);
    const start = startDay * day;
    const status = $('#scenarioStatus');
    try {
        if (!(startDay >= 0 && start < runTime)) throw new Error(`Start the scenario from day 0 to day ${state.built.days - 1}.`);
        if (!(Number($('#durationInput').value) > 0)) throw new Error('The scenario must last at least a day.');
        // Cargo diverted to a port needs lanes from it to the warehouses that lose it: build them first, on standby. And a
        // session restored from a saved project has its tables but not yet a model in the host: build it again first.
        const diverting = id === 'chokepointDisruption' && Number($('#divertedInput').value) > 0;
        const divertTo = diverting ? [$('#divertToSelect').value, ...(Number($('#divertedInput2').value) > 0 ? [$('#divertToSelect2').value] : [])].filter(Boolean) : [];
        const needsStandby = divertTo.filter((port) => !state.built.standbyPorts?.includes(port));
        if (needsStandby.length || !state.imported) {
            for (const port of needsStandby) state.standby.add(port);
            status.innerHTML = notice('', needsStandby.length ? `Adding standby lanes from ${needsStandby.join(' and ')} to the model…` : 'Building the model from the session kept with this project…');
            // A build already under way (Keep the canvas in step, after the last change) would make this one wait its
            // turn and return at once, before the standby lanes exist: let it finish, then build, and once more if a
            // change queued another build in between.
            for (let attempt = 0; attempt < 3; attempt += 1) {
                while (state.busy) await new Promise((resolve) => setTimeout(resolve, 100));
                clearTimeout(state.rebuildTimer);
                await build();
                if (state.imported && !needsStandby.some((port) => !state.built?.standbyPorts?.includes(port))) break;
            }
            if (!state.imported || needsStandby.some((port) => !state.built?.standbyPorts?.includes(port))) throw new Error('The model could not be built; see Model above.');
        }
        const run = scenarioRun(id, start, runTime, status);
        if (!run) return;
        const scenarioId = run.id ?? id;
        setBusy(true);
        $('#runScenarioButton').disabled = true;
        status.innerHTML = notice('', 'Running the baseline and the scenario…');
        const answer = await call(api.runScenario(scenarioId, { supplied: run.supplied, forkAt: start, runTime, signals: summarySignals }));
        state.scenario = summariseRun(answer, scenarioId, run, start, Number($('#durationInput').value) * day);
        state.mapShows = 'scenario';
        // The host holds a value outside a parameter's range to it: say so, since the run is then not what was asked for.
        const clamped = (answer.interventions ?? []).filter((change) => change.clamped);
        state.scenario.clamped = clamped.map((change) => `${change.name}: ${change.clamped.count} of ${change.clamped.of} values held to ${number(change.clamped.minimum, 2)} to ${number(change.clamped.maximum, 2)}`);
        // Keep the session (with this result) with the project before showing it, so closing the window as soon as
        // the result appears loses nothing.
        await call(api.openInCanvas(scenarioId, { focus: false, silent: true, session: sessionState() }));
        status.innerHTML = '';
        renderScenarioResult();
        $('#showScenarioButton').disabled = false;
    } catch (error) {
        status.innerHTML = notice('error', error.message);
    } finally {
        setBusy(false);
        $('#runScenarioButton').disabled = false;
    }
});

document.querySelectorAll('#flowView [data-flows]').forEach((button) => button.addEventListener('click', () => {
    state.mapShows = button.dataset.flows;
    renderFlows();
}));

$('#showScenarioButton').addEventListener('click', async () => {
    try { await call(api.openInCanvas(state.scenario?.id ?? 'chokepointDisruption', { focus: true, silent: true, session: sessionState() })); } catch (error) { $('#scenarioStatus').innerHTML = notice('error', error.message); }
});

api?.onProgress?.((progress) => {
    if (state.busy && progress?.message && !$('#stepScenario').hidden && $('#scenarioStatus').textContent) $('#scenarioStatus').innerHTML = notice('', progress.message);
});

// ---- the scenarios: what a run showed --------------------------------------------------------------------------------

const summarySignals = ['arrived', 'queue', 'waitDays', 'stock', 'spaceUsed', 'backlog', 'delivered', 'ordered', 'arriving', 'utilisation', 'transportCost', 'fleetCost', 'holdingCost', 'backlogCost'];

// What the run showed, from the day the scenario starts to the end of the run, kept small enough to save with the
// session: the share of orders delivered, how long an order waited and the costs, per port the longest anchorage wait,
// per lane what it carried and how busy its trucks were, per warehouse the lowest stock and per town the highest
// backlog, each against the baseline; and for the map, what every lane carried while the scenario lasted.
function summariseRun(answer, id, run, start, duration) {
    const [baseline, scenario] = answer.branches.map((branch) => branch.series);
    const built = state.built;
    const from = (series) => series?.filter((point) => point[0] >= start - 1) ?? [];
    const at = (series, time) => (series?.length ? series.reduce((best, point) => (Math.abs(point[0] - time) < Math.abs(best[0] - time) ? point : best))[1] : 0);
    // How much a running total grew from the start of the scenario to the end of the run.
    const grew = (series) => (series?.length ? series.at(-1)[1] - at(series, start) : 0);
    const extreme = (series, pick) => {
        const points = from(series);
        return points.length ? points.reduce((best, point) => (pick(point[1], best[1]) ? point : best)) : [0, 0];
    };
    const mean = (series) => {
        const points = from(series);
        return points.length ? points.reduce((sum, point) => sum + point[1], 0) / points.length : 0;
    };
    // A level held over time (a backlog in TEU), summed from the start of the scenario: TEU-days.
    const area = (series) => {
        const points = from(series);
        let sum = 0;
        for (let index = 1; index < points.length; index += 1) sum += (points[index][0] - points[index - 1][0]) * (points[index][1] + points[index - 1][1]) / 2;
        return sum / day;
    };
    // The mean while the scenario lasts, not to the end of the run, where a two-week closure would be averaged away.
    const end = Math.min(start + duration, built.days * day);
    const during = (series) => {
        const points = series?.filter((point) => point[0] >= start && point[0] <= end) ?? [];
        return points.length ? points.reduce((sum, point) => sum + point[1], 0) / points.length : 0;
    };
    const both = (pick) => ({ baseline: pick(baseline), scenario: pick(scenario) });
    const total = (series, names, symbol) => names.reduce((sum, name) => sum + grew(series[name]?.[symbol]), 0);
    const townNames = [...new Set(built.served.map((item) => item.town))];
    const laneNames = built.lanes.map((lane) => lane.name);
    // Warehouses are where supply lanes end; a store's stock room is where its own lane ends.
    const warehouseNames = [...new Set(built.lanes.filter((lane) => lane.kind !== 'store').map((lane) => lane.to))];
    const stores = built.stores ?? [];
    const days = (built.days * day - start) / day;
    const sampleSpark = (series, startTime, count = 12) => {
        if (!series || !series.length) return [];
        const pts = series.filter((p) => p[0] >= startTime - 1);
        if (!pts.length) return [];
        if (pts.length <= count) return pts.map((p) => p[1]);
        const step = (pts.length - 1) / (count - 1);
        return Array.from({ length: count }, (_, i) => pts[Math.round(i * step)][1]);
    };
    return {
        id, describe: run.describe, start: start / day, days, until: end / day, ...run.extra,
        // Per lane, TEU a day while the scenario lasts: [baseline, scenario].
        flows: Object.fromEntries(laneNames.map((name) => [name, [during(baseline[name]?.arriving), during(scenario[name]?.arriving)]])),
        totals: {
            // Fill rate: of what was ordered since the scenario began, the share delivered.
            fill: both((series) => total(series, townNames, 'delivered') / Math.max(1e-9, total(series, townNames, 'ordered'))),
            // How long an order waited, on average: the TEU-days spent in backlog over what was ordered (Little's law).
            // A closure every order outlasts still delivers them all, so the fill rate alone hides it; this does not.
            wait: both((series) => townNames.reduce((sum, name) => sum + area(series[name]?.backlog), 0) / Math.max(1e-9, total(series, townNames, 'ordered'))),
            transport: both((series) => total(series, laneNames, 'transportCost')),
            fleet: both((series) => total(series, laneNames, 'fleetCost')),
            holding: both((series) => total(series, [...warehouseNames, ...stores.map((item) => item.stock)], 'holdingCost')),
            backlog: both((series) => total(series, townNames, 'backlogCost'))
        },
        ports: built.ports.map((port) => ({
            name: port.name, lost: grew(baseline[port.name]?.arrived) - grew(scenario[port.name]?.arrived),
            wait: { baseline: extreme(baseline[port.name]?.waitDays, (value, best) => value > best)[1], scenario: extreme(scenario[port.name]?.waitDays, (value, best) => value > best)[1] }
        })),
        // The lanes the scenario changed (or whose warehouses it reaches), else the busiest.
        lanes: (run.lanes.length ? run.lanes : [...laneNames].sort((a, b) => mean(scenario[b]?.utilisation) - mean(scenario[a]?.utilisation)).slice(0, 6)).map((name) => ({
            name, carried: { baseline: mean(baseline[name]?.arriving), scenario: mean(scenario[name]?.arriving) },
            busiest: { baseline: extreme(baseline[name]?.utilisation, (value, best) => value > best)[1], scenario: extreme(scenario[name]?.utilisation, (value, best) => value > best)[1] }
        })),
        warehouses: warehouseNames.map((name) => {
            const low = extreme(scenario[name]?.stock, (value, best) => value < best);
            return {
                name, baseline: extreme(baseline[name]?.stock, (value, best) => value < best)[1], low: low[1], day: low[0] / day,
                // Its fullest, as a share of its storage capacity (a model built before capacities has none).
                space: scenario[name]?.spaceUsed ? { baseline: extreme(baseline[name]?.spaceUsed, (value, best) => value > best)[1], scenario: extreme(scenario[name]?.spaceUsed, (value, best) => value > best)[1] } : null,
                scenPts: sampleSpark(scenario[name]?.stock, start), basePts: sampleSpark(baseline[name]?.stock, start)
            };
        }),
        // Each store's lowest stock, and how long it sold nothing for want of stock (under a tenth of a day's sales).
        stores: stores.map((item) => {
            const low = extreme(scenario[item.stock]?.stock, (value, best) => value < best);
            const empty = (series) => from(series).filter((point) => point[1] < 0.1 * item.demand * 0.1).length;
            const step = (series) => { const points = from(series); return points.length > 1 ? (points.at(-1)[0] - points[0][0]) / (points.length - 1) / day : 0; };
            return {
                name: item.name, baseline: extreme(baseline[item.stock]?.stock, (value, best) => value < best)[1], low: low[1], day: low[0] / day,
                emptyDays: { baseline: empty(baseline[item.stock]?.stock) * step(baseline[item.stock]?.stock), scenario: empty(scenario[item.stock]?.stock) * step(scenario[item.stock]?.stock) },
                scenPts: sampleSpark(scenario[item.stock]?.stock, start), basePts: sampleSpark(baseline[item.stock]?.stock, start)
            };
        }),
        towns: townNames.map((name) => {
            const peak = extreme(scenario[name]?.backlog, (value, best) => value > best);
            return {
                name, baseline: extreme(baseline[name]?.backlog, (value, best) => value > best)[1], peak: peak[1], day: peak[0] / day,
                scenPts: sampleSpark(scenario[name]?.backlog, start), basePts: sampleSpark(baseline[name]?.backlog, start)
            };
        })
    };
}

function renderScenarioResult() {
    const result = state.scenario;
    renderFlows();
    $('#showScenarioButton').disabled = !result;
    if (!result) { $('#scenarioResult').innerHTML = ''; return; }
    $('#stepScenario').classList.add('completed');
    updateStepSummaries();
    // A session saved before the other scenarios kept only the chokepoint disruption's summary.
    const id = result.id ?? 'chokepointDisruption';
    const describe = result.describe ?? `${result.chokepoint}: transits cut by ${result.settings.cut}% from day ${result.settings.startDay} for ${result.settings.days} days.`;
    // Worse when higher (cost, backlog, wait), or when lower (stock, fill rate).
    // Marked when it is worse by more than 1% of the baseline and more than `noise` (half a TEU, a hundredth of a day).
    const worse = (now, before, { lowerIsWorse = false, noise = 0.5 } = {}) => {
        const by = lowerIsWorse ? before - now : now - before;
        return by > Math.max(0.01 * Math.abs(before), noise) ? ' class="number worse"' : ' class="number"';
    };
    const percent = (value) => `${number(value * 100, 1)}%`;
    const drawSpark = (scenPts, basePts, { stroke = 'var(--accent)' } = {}) => {
        if (!scenPts?.length) return '';
        const all = [...scenPts, ...(basePts ?? [])];
        const min = Math.min(...all);
        const max = Math.max(...all);
        const range = max - min || 1;
        const w = 48;
        const h = 14;
        const toY = (v) => (h - 2 - ((v - min) / range) * (h - 4)).toFixed(1);
        const toPts = (pts) => pts.map((v, i) => `${((i / (pts.length - 1)) * w).toFixed(1)},${toY(v)}`).join(' ');
        const base = basePts?.length ? `<polyline points="${toPts(basePts)}" fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 2" opacity="0.5"/>` : '';
        const scen = `<polyline points="${toPts(scenPts)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`;
        return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" title="Trajectory over time">${base}${scen}</svg>`;
    };
    const totals = result.totals ? `
        <table><thead><tr><th>Since day ${number(result.start)}</th><th class="number">Scenario</th><th class="number">baseline</th></tr></thead>
            <tbody>
                <tr><td>Orders delivered</td><td${worse(result.totals.fill.scenario, result.totals.fill.baseline, { lowerIsWorse: true, noise: 0.001 })}>${percent(result.totals.fill.scenario)}</td><td class="number">${percent(result.totals.fill.baseline)}</td></tr>
                ${result.totals.wait ? `<tr><td title="The time an order spent waiting in a town's backlog, averaged over every order since the scenario started">Days an order waited</td><td${worse(result.totals.wait.scenario, result.totals.wait.baseline, { noise: 0.01 })}>${number(result.totals.wait.scenario, 2)}</td><td class="number">${number(result.totals.wait.baseline, 2)}</td></tr>` : ''}
                ${[['transport', 'Transport cost'], ['fleet', 'Fleet cost'], ['holding', 'Holding cost'], ['backlog', 'Backlog cost']].map(([key, label]) => `<tr><td>${label}</td><td${worse(result.totals[key].scenario, result.totals[key].baseline)}>${number(result.totals[key].scenario)}</td><td class="number">${number(result.totals[key].baseline)}</td></tr>`).join('')}
            </tbody></table>` : '';
    const ports = id.startsWith('chokepoint') ? `
        <table><thead><tr><th>Port</th><th class="number">Kept out (${goods()})</th><th class="number">arrived later</th><th class="number">never arrived</th>${result.diversion ? '<th class="number">diverted here</th>' : ''}</tr></thead>
            <tbody>${result.ports.map((port) => {
                const affected = result.affected.find((item) => item.port === port.name);
                // A port the cut does not reach keeps nothing out; one that gains (the port cargo is diverted to) shows it received.
                const keptOut = affected?.keptOut ?? Math.max(0, port.lost);
                const never = affected ? port.lost : Math.max(0, port.lost);
                const diverted = !affected && port.lost < -0.5 ? -port.lost : 0;
                return `<tr><td>${escape(port.name)}</td><td class="number">${number(keptOut)}</td><td class="number">${number(affected?.caughtUp ?? 0)}</td><td class="number">${number(never)}</td>${result.diversion ? `<td class="number">${number(diverted)}</td>` : ''}</tr>`;
            }).join('')}</tbody></table>` : '';
    const waits = result.ports.some((port) => port.wait) ? `
        <table><thead><tr><th>Port</th><th class="number">Longest wait (days)</th><th class="number">baseline</th></tr></thead>
            <tbody>${result.ports.map((port) => `<tr><td>${escape(port.name)}</td><td${worse(port.wait.scenario, port.wait.baseline, { noise: 0.01 })}>${number(port.wait.scenario, 2)}</td><td class="number">${number(port.wait.baseline, 2)}</td></tr>`).join('')}</tbody></table>` : '';
    const lanes = result.lanes?.length ? `
        <table><thead><tr><th>Lane</th><th class="number">${goods()}/day carried</th><th class="number">baseline</th><th class="number">${state.built?.vehicles ? 'vehicles' : 'trucks'} busy, peak</th></tr></thead>
            <tbody>${result.lanes.map((lane) => `<tr><td>${escape(lane.name.replace(/^Road /, ''))}</td><td class="number">${number(lane.carried.scenario, 1)}</td><td class="number">${number(lane.carried.baseline, 1)}</td><td${worse(lane.busiest.scenario, lane.busiest.baseline, { noise: 0.01 })}>${percent(lane.busiest.scenario)}</td></tr>`).join('')}</tbody></table>` : '';
    const towns = [...result.towns].sort((a, b) => (b.peak - b.baseline) - (a.peak - a.baseline)).slice(0, 8);
    // Warehouses with a storage capacity show how full they got; stores, those that ran lowest first.
    // (A warehouse with no limit has a capacity too large to count: its space used stays near nothing.)
    const spaceShown = result.warehouses.some((item) => item.space?.scenario > 0.001);
    const storeRows = [...(result.stores ?? [])].sort((a, b) => (b.emptyDays.scenario - a.emptyDays.scenario) || (a.low / Math.max(a.baseline, 1e-9) - b.low / Math.max(b.baseline, 1e-9))).slice(0, 8);
    $('#scenarioResult').innerHTML = `
        <p class="small">${escape(describe)}</p>
        ${result.clamped?.length ? notice('warning', `Some of the values this scenario supplied lie outside what the model allows, and were held to its limits, so the run differs from what was asked: ${result.clamped.join('; ')}.`) : ''}
        ${totals}${ports}${waits}${lanes}
        <table><thead><tr><th>Warehouse</th><th class="number">Lowest stock</th><th class="number">baseline</th><th class="number">day</th>${spaceShown ? '<th class="number" title="Its stock at its fullest, as a share of its storage capacity: above 100%, goods ordered before demand fell arrived with no room for them">fullest</th>' : ''}</tr></thead>
            <tbody>${result.warehouses.map((item) => `<tr><td><div class="nameWithSpark"><span>${escape(item.name)}</span>${drawSpark(item.scenPts, item.basePts, { stroke: 'var(--warn)' })}</div></td><td${worse(item.low, item.baseline, { lowerIsWorse: true })}>${number(item.low)}</td><td class="number">${number(item.baseline)}</td><td class="number">${number(item.day, 1)}</td>${spaceShown ? (item.space?.scenario > 0.001 ? `<td${item.space.scenario > 1.005 ? ' class="number worse"' : ' class="number"'}>${percent(item.space.scenario)}</td>` : '<td class="number muted">no limit</td>') : ''}</tr>`).join('')}</tbody></table>
        ${storeRows.length ? `<table><thead><tr><th>Store</th><th class="number">Lowest stock</th><th class="number">baseline</th><th class="number" title="Days its shelves were all but empty since the scenario began">days empty</th></tr></thead>
            <tbody>${storeRows.map((item) => `<tr><td><div class="nameWithSpark"><span>${escape(item.name)}</span>${drawSpark(item.scenPts, item.basePts, { stroke: 'var(--warn)' })}</div></td><td${worse(item.low, item.baseline, { lowerIsWorse: true, noise: 0.05 })}>${number(item.low, 1)}</td><td class="number">${number(item.baseline, 1)}</td><td${worse(item.emptyDays.scenario, item.emptyDays.baseline, { noise: 0.04 })}>${number(item.emptyDays.scenario, 1)}</td></tr>`).join('')}</tbody></table>` : ''}
        <table><thead><tr><th>${state.built?.stores ? 'Shoppers waiting' : 'Town'}</th><th class="number">Highest backlog</th><th class="number">baseline</th><th class="number">day</th></tr></thead>
            <tbody>${towns.map((item) => `<tr><td><div class="nameWithSpark"><span>${escape(item.name)}</span>${drawSpark(item.scenPts, item.basePts, { stroke: 'var(--danger)' })}</div></td><td${worse(item.peak, item.baseline)}>${number(item.peak)}</td><td class="number">${number(item.baseline)}</td><td class="number">${number(item.day, 1)}</td></tr>`).join('')}</tbody></table>
        <p class="muted small">Costs are in the model's cost units, counted from the day the scenario starts. The forked run is in the canvas beside the baseline; Show in Konjugate brings it forward.</p>`;
}

// ---- the period of history -----------------------------------------------------------------------------------------
// When a port's PortWatch history has a break, say so beside the date, and offer the days just before it (a period
// of normal traffic to start from) or across it (a month before it, to replay the break itself).
const modelDays = 90;
function renderHistoryHint() {
    const ports = [...state.pins.filter((pin) => pin.role === 'port' && pin.candidate?.activity).map((pin) => ({ name: pin.name, activity: pin.candidate.activity })),
        ...(state.suggestions.ports?.candidates.ports ?? []).filter((port) => port.activity)];
    const input = $('#historyFromInput');
    const hint = $('#historyFromHint');
    if (ports.length) {
        input.min = ports.map((port) => port.activity.from).sort()[0];
        input.max = ports.map((port) => port.activity.to).sort().at(-1);
    }
    const shifted = ports.find((port) => port.activity.shift);
    if (!shifted) { hint.textContent = 'empty: the latest days'; return; }
    const shift = shifted.activity.shift;
    const breakDate = `${shift.month}-01`;
    const before = new Date(Date.parse(`${breakDate}T00:00:00Z`) - modelDays * 86400000).toISOString().slice(0, 10);
    const usable = before >= input.min ? before : input.min;
    // Across the break: a month of normal traffic first, so the replay shows the fall and what follows it.
    const across = new Date(Date.parse(`${breakDate}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
    const month = new Date(`${breakDate}T00:00:00Z`).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    hint.innerHTML = `${escape(shifted.name)}'s imports ${shift.change < 0 ? 'fell' : 'rose'} ${Math.round(Math.abs(shift.change) * 100)}% from ${month}: `
        + `<button class="link" type="button" data-history-from="${usable}">before it</button> · <button class="link" type="button" data-history-from="${across}">across it</button> · <button class="link" type="button" data-history-from="">the latest days</button>`;
    hint.querySelectorAll('[data-history-from]').forEach((button) => button.addEventListener('click', () => {
        input.value = button.dataset.historyFrom;
        networkChanged();
    }));
}
