/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Logistics Toolbox window: pick a region, fetch what OpenStreetMap holds for it, see what the data
// can and can't show, keep the sites that matter, and build a model in Konjugate's canvas. The window
// only names declared things to the host (an importer, a file role, a listed host); the host fetches,
// reads files and runs the importer.

import { MapView } from './mapView.mjs';
import { maximumSplitDepth, overpassRequests, overpassStatusUrl, overpassUrl, retryDelaysSeconds, retryPauseSeconds, splitRequest, statusWaitSeconds } from './lib/overpass.mjs';
import { nominatimSearchUrl, rankPlaces } from './lib/places.mjs';
import { chokepointById, chokepointDependence, chokepointRecentUrl, chokepoints, chokepointYearlyUrl, disruptionPlan, summariseTransits } from './lib/chokepoints.mjs';
import { portwatchActivityUrl, portwatchPortsUrl } from './lib/portwatch.mjs';
import { closurePlan, demandPlan, diversionPlan, fleetPlan, heldPath, keptOutPlan } from './lib/scenarios.mjs';

const api = window.konjugateLauncher;
const $ = (selector) => document.querySelector(selector);
const importerId = 'region';
const groups = ['ports', 'zones', 'towns'];
const kindOfGroup = { ports: 'port', zones: 'zone', towns: 'town' };
const groupOfKind = { port: 'ports', zone: 'zones', town: 'towns' };
const defaultKeep = { ports: 3, zones: 6, towns: 12 };
const maximumSpanKilometres = 250;

const state = {
    place: null, bbox: null, discovered: null, group: 'ports',
    kept: { ports: new Set(), zones: new Set(), towns: new Set() },
    changes: new Map(), // id -> { lat, lon, name, teuPerDay }
    added: [], // sites placed on the map: { id, kind, name, lat, lon }
    portVolume: null, built: null, busy: false, pendingAdd: null, rebuildTimer: null,
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

const map = new MapView($('#map'), {
    onToggle: (id) => toggle(id),
    onMove: (id, lat, lon) => {
        const added = state.added.find((site) => site.id === id);
        if (added) Object.assign(added, { lat, lon });
        else state.changes.set(id, { ...state.changes.get(id), lat, lon });
        changed();
    },
    onAdd: (kind, point) => {
        state.pendingAdd = { kind, ...point };
        $('#addSiteForm').hidden = false;
        $('#addSiteName').value = '';
        $('#addSiteName').placeholder = `Name of the new ${kind === 'zone' ? 'warehouse' : kind === 'town' ? 'customer' : 'port'}`;
        $('#addSiteName').focus();
    }
});

// ---- layout, accordion & splitter ---------------------------------------------------------------------

document.querySelectorAll('.stepHeader').forEach((header) => {
    header.addEventListener('click', (event) => {
        // Prevent toggle if clicking on an interactive element inside header
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
        const step = header.closest('.step');
        if (step) step.classList.toggle('collapsed');
    });
});

function updateStepSummaries() {
    const regSummary = $('#stepRegionSummary');
    if (regSummary) {
        if (state.place) regSummary.textContent = `${state.place.display_name.split(',')[0]} · ${$('#marginSelect').value} km`;
        else if (state.discovered) regSummary.textContent = 'Sample region';
        else regSummary.textContent = '';
    }
    const covSummary = $('#stepCoverageSummary');
    if (covSummary && state.discovered?.coverage) {
        const c = state.discovered.coverage;
        covSummary.textContent = `${c.ports.found} ports · ${c.towns.found} towns`;
    }
    const curSummary = $('#stepCurateSummary');
    if (curSummary && state.discovered) {
        const kp = state.kept.ports.size;
        const kz = state.kept.zones.size;
        const kt = state.kept.towns.size;
        curSummary.textContent = `${kp} ports · ${kz} zones · ${kt} towns`;
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

// ---- region -------------------------------------------------------------------------------------------

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
    const tooLarge = Math.max(width, height) > maximumSpanKilometres;
    $('#areaSize').innerHTML = tooLarge
        ? `<span style="color:var(--danger)">${number(width)} × ${number(height)} km: too large. Public map servers answer areas up to ${maximumSpanKilometres} km across; choose a smaller place or area.</span>`
        : `${number(width)} × ${number(height)} km${Math.max(width, height) > 120 ? '. A large area: fetching may take a minute.' : ''}`;
    $('#fetchButton').disabled = tooLarge || state.busy;
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

$('#fetchButton').addEventListener('click', async () => {
    if (!state.bbox) return;
    setBusy(true);
    const requests = overpassRequests(state.bbox);
    const labels = { ports: 'Ports and anchorages', logistics: 'Warehouses and industrial land', roads: 'Major roads', rail: 'Rail', places: 'Towns and cities' };
    const kinds = [...new Set(requests.map((request) => request.kind))];
    const progress = $('#fetchProgress');
    progress.hidden = false;
    progress.innerHTML = [...kinds.map((kind) => `<li data-kind="${kind}"><span>${labels[kind]}</span><span class="state">waiting</span></li>`),
        '<li data-kind="portwatch"><span>Port activity (IMF PortWatch)</span><span class="state">waiting</span></li>'].join('');
    $('#regionStatus').innerHTML = '';
    try {
        // A new region replaces the last one's data (your own sites file stays).
        for (const kind of [...kinds, 'portwatchPorts', 'portwatchActivity']) await call(api.clearFile(importerId, kind));
        const bytes = {};
        // One request at a time: the public server is shared.
        const queue = [...requests];
        while (queue.length) {
            const request = queue.shift();
            const row = progress.querySelector(`[data-kind="${request.kind}"]`);
            const label = request.parts > 1 || request.depth ? `part ${request.part} of ${request.parts}` : 'fetching';
            for (let attempt = 0; ; attempt += 1) {
                const before = await serverWait();
                if (before > 0) await countdown(row, before + 1, 'waiting for a free slot');
                row.querySelector('.state').textContent = `${label}…`;
                try {
                    const answer = await call(api.fetchFile(importerId, request.kind, overpassUrl(request.query), `${request.kind}-${request.part}.json`));
                    bytes[request.kind] = (bytes[request.kind] ?? 0) + answer.bytes;
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
                row.querySelector('.state').textContent = `${number(bytes[request.kind] / 1024)} KB`;
            }
        }
        const portwatchProblem = await fetchPortActivity(progress.querySelector('[data-kind="portwatch"]'));
        await discover();
        if (portwatchProblem) $('#regionStatus').insertAdjacentHTML('beforeend', notice('warning', `Port activity could not be fetched from IMF PortWatch (${portwatchProblem}), so every port starts with an assumed volume. Fetch again later to match it.`));
    } catch (error) {
        $('#regionStatus').innerHTML = notice('error', error.message);
    } finally {
        setBusy(false);
    }
});

// IMF PortWatch: the ports around the region, then a year of history for each that matches a port found.
// Optional: if it fails, the region still loads with assumed port volumes, and the problem is returned.
async function fetchPortActivity(row) {
    const show = (text) => { row.querySelector('.state').textContent = text; };
    const fetchWithRetry = async (role, url, name) => {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await call(api.fetchFile(importerId, role, url, name));
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
        const first = await call(api.runImport(importerId, { bbox: state.bbox }));
        const portids = [...new Set((first.data?.candidates.ports ?? []).map((port) => port.portwatch?.portid).filter(Boolean))];
        for (const [index, portid] of portids.entries()) {
            show(`history ${index + 1} of ${portids.length}…`);
            bytes += (await fetchWithRetry('portwatchActivity', portwatchActivityUrl(portid), `portwatch-${portid}.json`)).bytes;
        }
        row.classList.add('done');
        show(`${portids.length} port${portids.length === 1 ? '' : 's'} matched, ${number(bytes / 1024)} KB`);
        return null;
    } catch (error) {
        row.classList.add('failed');
        show('not available');
        // Without the ports list, a partial set of histories would only confuse: clear both.
        for (const role of ['portwatchPorts', 'portwatchActivity']) await call(api.clearFile(importerId, role)).catch(() => {});
        return error.message;
    }
}

$('#sampleButton').addEventListener('click', async () => {
    setBusy(true);
    try {
        await call(api.useSample(importerId));
        state.place = null;
        state.bbox = null;
        $('#chosenRegion').hidden = true;
        $('#fetchProgress').hidden = true;
        $('#regionStatus').innerHTML = notice('ok', 'The sample region: a made-up stretch of coast, for trying the toolbox without a network.');
        resetCuration();
        await discover();
    } catch (error) {
        $('#regionStatus').innerHTML = notice('error', error.message);
    } finally {
        setBusy(false);
    }
});

$('#sitesButton').addEventListener('click', async () => {
    try {
        const chosen = await call(api.chooseFile(importerId, 'sites'));
        if (!chosen.chosen) return;
        setBusy(true);
        await discover({ keepSites: true });
    } catch (error) {
        $('#regionStatus').innerHTML = notice('error', error.message);
    } finally {
        setBusy(false);
    }
});

// ---- discovery ----------------------------------------------------------------------------------------

function resetCuration() {
    for (const group of groups) state.kept[group].clear();
    state.changes.clear();
    state.added = [];
    state.built = null;
    map.setFlows(null);
}

async function discover({ keepSites = false, keepCuration = false } = {}) {
    const answer = await call(api.runImport(importerId, state.bbox ? { bbox: state.bbox } : {}));
    if (answer.report?.errors?.length) throw new Error(answer.report.errors.join(' '));
    const previous = state.discovered;
    state.discovered = answer.data;
    const { candidates, sites } = state.discovered;
    // A new region starts with the most significant of each kind kept; the user's own sites are always kept.
    const sameRegion = (keepSites && previous) || keepCuration;
    for (const group of groups) {
        // A restored session keeps exactly what was kept.
        if (keepCuration) continue;
        if (!sameRegion) {
            state.kept[group].clear();
            candidates[group].slice(0, defaultKeep[group]).forEach((site) => state.kept[group].add(site.id));
        }
        sites[group].forEach((site) => state.kept[group].add(site.id));
    }
    if (!sameRegion) { state.changes.clear(); state.added = []; }
    state.portVolume ??= state.discovered.defaults.portTeuPerDay;
    $('#portVolume').value = state.portVolume;
    $('#mapEmpty').hidden = true;
    $('#attribution').textContent = state.discovered.map.attribution;
    map.setMap(state.discovered.map);
    const borders = state.discovered.map.geography?.borders ?? [];
    $('#legendBorder').hidden = !borders.some((border) => border.settled);
    $('#legendUnsettled').hidden = !borders.some((border) => !border.settled);
    for (const section of ['#stepCoverage', '#stepCurate', '#stepBuild']) $(section).hidden = false;
    renderCoverage();
    renderHistoryHint();
    renderCandidates();
    changed({ rebuild: Boolean(state.built) });
    $('#stepRegion').classList.add('completed');
    $('#stepCoverage').classList.add('completed');
    updateStepSummaries();
    const warnings = answer.report?.warnings ?? [];
    if (warnings.length) $('#regionStatus').insertAdjacentHTML('beforeend', warnings.map((text) => notice('warning', text)).join(''));
}

function renderCoverage() {
    const { coverage, notices } = state.discovered;
    const level = (value) => (value ? `<span class="level ${value}">${value}</span>` : '');
    $('#coverageSummary').innerHTML = [
        ['Ports', `${coverage.ports.found} found${coverage.ports.marinasExcluded ? `, ${coverage.ports.marinasExcluded} marinas left out` : ''}; ${coverage.ports.anchorages} anchorages`, null],
        ['Warehouses', `${number(coverage.warehouses.buildings)} buildings on ${number(coverage.warehouses.industrialLandSquareKilometres, 1)} km² of industrial land`, coverage.warehouses.level],
        ['Major roads', `${number(coverage.roads.kilometres)} km`, coverage.roads.level],
        ['Towns', `${coverage.towns.found} found, ${coverage.towns.withPopulation} with population`, coverage.towns.level],
        ['Rail', `${number(coverage.rail.lineKilometres)} km of line, ${coverage.rail.yards} yards (not yet modelled)`, null]
    ].map(([title, text, value]) => `<div class="item"><b>${title}${level(value)}</b><span>${escape(text)}</span></div>`).join('');
    $('#notices').innerHTML = notices.map((item) => notice(item.level, item.text)).join('');
}

// Every site the map and lists show: candidates, the user's CSV sites and sites added on the map, with changes applied.
function allSites(group) {
    const { candidates, sites } = state.discovered;
    const listed = [...sites[group], ...candidates[group]].map((site) => ({ ...site, ...state.changes.get(site.id), kept: state.kept[group].has(site.id), moved: state.changes.has(site.id) && 'lat' in state.changes.get(site.id) }));
    const added = state.added.filter((site) => groupOfKind[site.kind] === group).map((site) => ({ ...site, kept: true, user: true, source: 'added on the map' }));
    return [...added, ...listed];
}

function describe(site, group) {
    if (group === 'ports') {
        if (site.user) return `Your site (${site.source})`;
        const land = `${number(site.areaSquareKilometres, 2)} km² of port land${site.commercial ? ', commercial' : ''}${site.anchorages ? `, ${site.anchorages} anchorage${site.anchorages === 1 ? '' : 's'}` : ''}`;
        if (site.activity) return `${land} · IMF PortWatch (${site.portwatch.name}): about ${number(site.activity.importTonnesPerDay / conversion().tonnesPerTeu * conversion().inlandShare)} TEU/day inland, ${number(site.activity.containerCallsPerDay, 1)} container ships a day, ${site.activity.from} to ${site.activity.to}`;
        return site.portwatch ? `${land} · IMF PortWatch (${site.portwatch.name}): no recent activity` : land;
    }
    if (group === 'zones') {
        if (site.user) return `Your site (${site.source})${site.floorAreaSquareMetres ? `, ${number(site.floorAreaSquareMetres)} m²` : ''}`;
        const basis = { mapped: 'mapped', approximate: 'from building outlines', estimated: 'estimated from industrial land' }[site.floorAreaBasis] ?? site.floorAreaBasis;
        return `${number(site.floorAreaSquareMetres / 1000)}k m² floor area (${basis})${site.buildings ? `, ${site.buildings} buildings` : ''}${site.roadKilometres !== null && site.roadKilometres !== undefined ? `, ${number(site.roadKilometres, 1)} km to a major road` : ''}`;
    }
    if (site.user) return `Your site (${site.source})${site.teuPerDay ? `, ${site.teuPerDay} TEU/day` : ''}`;
    const basis = { assumed: ' (assumed)', shared: ` (an even share of ${site.city}'s population)` }[site.populationBasis] ?? '';
    return `Population ${number(site.population)}${basis}${site.suburbs?.length ? ` · ${site.suburbs.length} suburb${site.suburbs.length === 1 ? '' : 's'}: ${site.suburbs.slice(0, 4).join(', ')}${site.suburbs.length > 4 ? '…' : ''}` : ''}`;
}

function renderCandidates() {
    const group = state.group;
    document.querySelectorAll('#kindTabs button').forEach((button) => button.classList.toggle('active', button.dataset.group === group));
    for (const each of groups) document.querySelector(`[data-count="${each}"]`).textContent = `${allSites(each).filter((site) => site.kept).length}/${allSites(each).length}`;
    $('#topN').value = allSites(group).filter((site) => site.kept).length;
    $('#portVolumeRow').hidden = group !== 'ports';
    $('#candidateList').innerHTML = allSites(group).map((site) => `
        <li data-id="${escape(site.id)}">
            <input type="checkbox" ${site.kept ? 'checked' : ''} aria-label="Keep ${escape(site.name)}">
            <span class="name" title="${escape(site.name)}">${escape(site.name)}${site.moved ? '<span class="tag">moved</span>' : ''}</span>
            ${group === 'ports' && site.kept ? `<span><input type="number" min="0" step="10" placeholder="${site.activity ? Math.round(site.activity.importTonnesPerDay / conversion().tonnesPerTeu * conversion().inlandShare) : state.portVolume}" value="${site.teuPerDay ?? ''}" aria-label="TEU a day handed inland at ${escape(site.name)}"> <span class="muted small">TEU/day</span></span>` : '<span></span>'}
            <span class="detail">${escape(describe(site, group))}</span>
        </li>`).join('');
    $('#candidateList').querySelectorAll('li').forEach((row) => {
        const id = row.dataset.id;
        row.querySelector('input[type="checkbox"]').addEventListener('change', () => toggle(id));
        const volume = row.querySelector('input[type="number"]');
        // Recorded as it is typed, so a Build clicked straight after uses it; the list redraws once the field is left.
        const record = () => {
            const value = Number(volume.value);
            const added = state.added.find((site) => site.id === id);
            if (added) added.teuPerDay = value > 0 ? value : undefined;
            else state.changes.set(id, { ...state.changes.get(id), teuPerDay: value > 0 ? value : undefined });
        };
        volume?.addEventListener('input', record);
        volume?.addEventListener('change', () => { record(); changed(); });
        row.addEventListener('mouseenter', () => map.setHighlight(id));
        row.addEventListener('mouseleave', () => map.setHighlight(null));
    });
    map.setSites(groups.flatMap((each) => allSites(each).map((site) => ({ ...site, kind: kindOfGroup[each] }))));
}

function toggle(id) {
    const addedIndex = state.added.findIndex((site) => site.id === id);
    if (addedIndex >= 0) {
        state.added.splice(addedIndex, 1);
    } else {
        for (const group of groups) {
            if (!allSites(group).some((site) => site.id === id)) continue;
            if (state.kept[group].has(id)) state.kept[group].delete(id); else state.kept[group].add(id);
            state.group = group;
        }
    }
    changed();
}

document.querySelectorAll('#kindTabs button').forEach((button) => button.addEventListener('click', () => {
    state.group = button.dataset.group;
    renderCandidates();
}));
$('#applyTop').addEventListener('click', () => {
    const count = Math.max(0, Math.round(Number($('#topN').value) || 0));
    const group = state.group;
    const { candidates, sites } = state.discovered;
    state.kept[group] = new Set([...sites[group].map((site) => site.id), ...candidates[group].slice(0, count).map((site) => site.id)]);
    changed();
});
$('#portVolume').addEventListener('input', () => {
    const value = Number($('#portVolume').value);
    if (value > 0) state.portVolume = value;
});
$('#portVolume').addEventListener('change', () => {
    const value = Number($('#portVolume').value);
    if (value > 0) state.portVolume = value;
    changed();
});
$('#arrivalsSelect').addEventListener('change', () => changed());
$('#historyFromInput').addEventListener('change', () => changed());
// How PortWatch's tonnes become TEU handed inland: the weight of a TEU, and the share not transhipped.
function conversion() {
    const tonnes = Number($('#tonnesPerTeuInput').value);
    const share = Number($('#inlandShareInput').value);
    return {
        tonnesPerTeu: tonnes >= 1 && tonnes <= 40 ? tonnes : 10,
        inlandShare: share > 0 && share <= 100 ? share / 100 : 1
    };
}
for (const selector of ['#tonnesPerTeuInput', '#inlandShareInput']) $(selector).addEventListener('change', () => { renderCandidates(); changed(); });

// A fleet operator: none, an invented one made for the model's lanes, or the user's own from a JSON file.
function showOperatorChoice() {
    $('#operatorFileButton').hidden = $('#operatorSelect').value !== 'file';
}
$('#operatorSelect').addEventListener('change', () => {
    showOperatorChoice();
    // Your own needs its file first; the build asks for it if it is missing.
    if ($('#operatorSelect').value !== 'file' || state.operatorFile) changed();
    else $('#operatorFileButton').click();
});
$('#operatorFileButton').addEventListener('click', async () => {
    try {
        const chosen = await call(api.chooseFile(importerId, 'operator'));
        if (!chosen.chosen) return;
        state.operatorFile = true;
        $('#operatorFileButton').textContent = 'Choose another file';
        changed();
    } catch (error) {
        $('#buildStatus').innerHTML = notice('error', error.message);
    }
});

document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
    const kind = map.addKind === button.dataset.add ? null : button.dataset.add;
    map.setAddKind(kind);
    document.querySelectorAll('[data-add]').forEach((each) => each.classList.toggle('active', each.dataset.add === kind));
}));
$('#addSiteForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('#addSiteName').value.trim();
    if (!name || !state.pendingAdd) return;
    const { kind, lat, lon } = state.pendingAdd;
    state.added.push({ id: `added:${Date.now()}:${state.added.length}`, kind, name, lat, lon });
    state.pendingAdd = null;
    $('#addSiteForm').hidden = true;
    state.group = groupOfKind[kind];
    changed();
});
$('#addSiteCancel').addEventListener('click', () => { state.pendingAdd = null; $('#addSiteForm').hidden = true; });
$('#fitButton').addEventListener('click', () => map.fit());

// ---- model --------------------------------------------------------------------------------------------

function selection() {
    const result = {};
    for (const group of groups) {
        result[group] = allSites(group).filter((site) => site.kept).map((site) => {
            const change = state.changes.get(site.id) ?? {};
            if (state.added.some((added) => added.id === site.id)) return { id: site.id, name: site.name, lat: site.lat, lon: site.lon, ...(site.teuPerDay ? { teuPerDay: site.teuPerDay } : {}) };
            return { id: site.id, ...change };
        });
    }
    return result;
}

function changed({ rebuild = true } = {}) {
    renderCandidates();
    updateStepSummaries();
    const kept = groups.map((group) => allSites(group).filter((site) => site.kept).length);
    const missing = groups.filter((_group, index) => !kept[index]).map((group) => ({ ports: 'a port', zones: 'a logistics zone', towns: 'a town or customer' })[group]);
    $('#buildButton').disabled = state.busy || missing.length > 0;
    $('#buildStatus').innerHTML = missing.length ? notice('warning', `Keep at least ${missing.join(', ')} to build a model.`) : '';
    if (state.built) {
        $('#buildStatus').innerHTML += notice('warning', 'The model no longer matches the sites above.');
        // Counted, so a rebuild queued behind other work runs only if something changed after the last build began.
        state.edits = (state.edits ?? 0) + 1;
        if (rebuild && $('#keepInStep').checked && !missing.length) {
            clearTimeout(state.rebuildTimer);
            state.rebuildTimer = setTimeout(() => build({ focus: false }), 600);
        }
    }
}

async function build({ focus = false } = {}) {
    // Asked while something else runs (another build, a fetch, a scenario): build once that ends, if anything changed
    // after the last build began, so no change is lost and nothing is rebuilt for nothing.
    if (state.busy) { state.buildAgain = true; return; }
    const editsAtStart = state.edits ?? 0;
    setBusy(true);
    $('#buildStatus').innerHTML = notice('', 'Building the model: routing every lane…');
    try {
        const answer = await call(api.runImport(importerId, { step: 'build', bbox: state.bbox, selection: selection(), settings: { portTeuPerDay: state.portVolume, arrivals: $('#arrivalsSelect').value, historyFrom: $('#historyFromInput').value || null, ...conversion(), operator: $('#operatorSelect').value || null, standbyPorts: [...state.standby] } }));
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
            + state.built.warnings.map((text) => notice('warning', text)).join('');
        renderBuilt();
        $('#stepCurate').classList.add('completed');
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
    if (!built) { map.setFlows(null); return; }
    const positions = new Map(groups.flatMap((group) => allSites(group).map((site) => [site.name, site])));
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
        lanes: built.lanes.filter((lane) => positions.has(lane.from) && positions.has(lane.to)).map((lane) => ({
            from: positions.get(lane.from), to: positions.get(lane.to), rate: lane.rate,
            title: `${lane.name}: ${number(lane.rate, 1)} TEU/day, ${number(lane.kilometres, 1)} km, ${number(lane.leadTime * 24, 1)} h, ${trucksOf(lane)} trucks${lane.operator ? ` (${built.operator.name})` : ''}`
        })),
        serves: built.served.filter((item) => positions.has(item.town) && positions.has(item.zone)).map((item) => ({ from: positions.get(item.zone), to: positions.get(item.town) }))
    });
}

function renderBuilt() {
    renderFlows();
    const built = state.built;
    const basisLabel = { routed: 'routed', local: 'local streets', 'straight-line': 'straight line' };
    const count = (basis) => built.provenance.filter((entry) => entry.basis === basis).length;
    const bases = ['assumed', 'synthetic', 'user'].filter((basis) => count(basis)).map((basis) => `${count(basis)} ${basis === 'user' ? 'yours' : basis}`);
    $('#buildResult').innerHTML = `
        <table>
            <thead><tr><th>Road lane</th><th class="number">TEU/day</th><th class="number">km</th><th class="number">hours</th><th class="number" title="${built.operator ? `${escape(built.operator.trucks.map((truck) => truck.label).join(' + '))}` : 'Trucks of the first size'}">trucks</th></tr></thead>
            <tbody>${built.lanes.map((lane) => `<tr><td>${escape(lane.from)} → ${escape(lane.to)} <span class="basis ${lane.basis === 'routed' ? '' : 'assumed'}">${basisLabel[lane.basis]}</span>${lane.operator ? ` <span class="basis ${built.operator.synthetic ? 'synthetic' : 'user'}">operator</span>` : ''}${lane.standby ? ' <span class="basis" title="Carries nothing until cargo is diverted to its port">standby</span>' : ''}</td><td class="number">${number(lane.rate, 1)}</td><td class="number">${number(lane.kilometres, 1)}</td><td class="number">${number(lane.leadTime * 24, 1)}</td><td class="number">${trucksOf(lane)}</td></tr>`).join('')}</tbody>
        </table>
        ${renderOperator(built.operator)}
        <table>
            <thead><tr><th>Town</th><th>Served from</th><th class="number">TEU/day</th></tr></thead>
            <tbody>${built.served.map((item) => `<tr><td>${escape(item.town)}</td><td>${escape(item.zone)}</td><td class="number">${number(item.demand, 1)}</td></tr>`).join('')}</tbody>
        </table>
        <details><summary>Where every value comes from (${built.provenance.length}${bases.length ? `; ${bases.join(', ')}` : ''})</summary>
            <table><thead><tr><th>Site</th><th>Value</th><th>Basis</th></tr></thead>
            <tbody>${built.provenance.map((entry) => `<tr><td>${escape(entry.entity)}</td><td>${escape(entry.parameter)}: ${number(entry.value, entry.unit === 'day' ? 3 : 1)} ${escape(entry.unit)}<div class="basis">${escape(entry.detail ?? '')}</div></td><td><span class="basis ${['assumed', 'synthetic', 'user'].includes(entry.basis) ? entry.basis : ''}">${escape(entry.basis === 'user' ? 'yours' : entry.basis)}</span></td></tr>`).join('')}</tbody></table>
        </details>`;
}

// A lane's trucks: of the first size, plus the second when it has any.
const trucksOf = (lane) => (lane.fleet2 ? `${lane.fleet} + ${lane.fleet2}` : `${lane.fleet}`);

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
// Everything the window needs to carry on where it was: the place, the curation and the last build's tables. The
// host keeps the fetched map data beside it, so a saved project reopens its region offline.
function sessionState() {
    return {
        version: 1, place: state.place ? { display_name: state.place.display_name, boundingbox: state.place.boundingbox } : null,
        margin: $('#marginSelect').value, bbox: state.bbox, group: state.group, portVolume: state.portVolume,
        kept: Object.fromEntries(groups.map((group) => [group, [...state.kept[group]]])),
        changes: [...state.changes], added: state.added, built: state.built, keepInStep: $('#keepInStep').checked,
        arrivals: $('#arrivalsSelect').value, historyFrom: $('#historyFromInput').value || null, ...conversion(),
        operator: $('#operatorSelect').value || null, operatorFile: Boolean(state.operatorFile), standby: [...state.standby],
        disruption: { ...disruptionSettings(), dependence: [...state.dependence], transits: [...state.transits].filter(([, value]) => value && !value.error) },
        scenarioTab: state.scenarioTab, scenarioSettings: scenarioSettings(), scenario: state.scenario
    };
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
    if (!saved || saved.version !== 1) return;
    setBusy(true);
    try {
        state.place = saved.place;
        state.bbox = saved.bbox;
        if (saved.margin) $('#marginSelect').value = saved.margin;
        if (state.place) {
            $('#chosenRegion').hidden = false;
            $('#chosenName').textContent = state.place.display_name;
        }
        for (const group of groups) state.kept[group] = new Set(saved.kept?.[group] ?? []);
        state.changes = new Map(saved.changes ?? []);
        state.added = saved.added ?? [];
        state.portVolume = saved.portVolume ?? null;
        state.group = saved.group ?? 'ports';
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
        await discover({ keepCuration: true });
        if (saved.built) {
            state.built = saved.built;
            renderBuilt();
            $('#showButton').disabled = false;
            state.scenario = saved.scenario ?? null;
            renderScenario();
        }
        const when = answer.savedAt ? new Date(answer.savedAt).toLocaleString() : 'earlier';
        const fetched = answer.inputs.filter((input) => input.retrievedAt).map((input) => input.retrievedAt).sort()[0];
        $('#regionStatus').innerHTML = notice('ok', `Restored the session kept with this project (saved ${when}).${fetched ? ` Its map data was fetched on ${new Date(fetched).toLocaleDateString()}; fetch again for newer data.` : ''}`);
        $('#buildStatus').innerHTML = saved.built ? notice('ok', `The model in the canvas is the one this session built: ${saved.built.nodes} nodes and ${saved.built.edges} relationships.`) : '';
    } catch (error) {
        $('#regionStatus').innerHTML = notice('error', `The session kept with this project could not be restored: ${error.message}`);
    } finally {
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
    for (const selector of ['#fetchButton', '#sampleButton', '#sitesButton', '#searchButton', '#runScenarioButton']) $(selector).disabled = busy;
    if (!busy) showArea();
    if (state.discovered) {
        const missing = groups.some((group) => !allSites(group).some((site) => site.kept));
        $('#buildButton').disabled = busy || missing;
    }
}

if (!api) $('#regionStatus').innerHTML = notice('error', 'This window must be opened from Konjugate.');
else restoreSession();

// ---- the scenarios: a chokepoint disruption --------------------------------------------------------------------------
// Fewer ships through a chokepoint for a while: each kept port's arrivals fall by its share of ships through it times
// the cut. The shares start from geography (a port in an enclosed sea depends on the strait that closes it) and are
// the user's to change. The scenario forks the model on the day the disruption starts.
const day = 86400;

// A port's shares through each chokepoint: the user's own, else the sea it lies in.
function sharesOf(port) {
    if (state.dependence.has(port.name)) return state.dependence.get(port.name);
    const site = allSites('ports').find((candidate) => candidate.name === port.name);
    return (site?.chokepoints ?? (site ? chokepointDependence(site) : { shares: {} })).shares;
}
const seaOf = (port) => {
    const site = allSites('ports').find((candidate) => candidate.name === port.name);
    return (site?.chokepoints ?? (site ? chokepointDependence(site) : { sea: null })).sea;
};

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
    renderDependence();
    // After a fresh build, fetch the chokepoint's transits; when restoring a session (perhaps offline), show only what was kept.
    renderTransits({ fetch: fetchTransits });
    renderScenarioChoices();
    renderScenarioResult();
}

// The ports cargo can be diverted to: kept ports the chokepoint doesn't reach.
function renderDiversion() {
    const chokepoint = $('#chokepointSelect').value;
    const previous = $('#divertToSelect').value || state.savedDivertTo;
    state.savedDivertTo = null;
    const outside = state.built.ports.filter((port) => !((sharesOf(port)[chokepoint] ?? 0) > 0));
    $('#divertToSelect').innerHTML = outside.length
        ? outside.map((port) => `<option value="${escape(port.name)}">${escape(port.name)} (berths for ${number(port.berths ?? port.arrivals * 1.5)} TEU/day)</option>`).join('')
        : '<option value="">no kept port outside it</option>';
    if (previous && outside.some((port) => port.name === previous)) $('#divertToSelect').value = previous;
    // A second port: any other kept port outside the chokepoint.
    const previous2 = $('#divertToSelect2').value || state.savedDivertTo2;
    state.savedDivertTo2 = null;
    const others = outside.filter((port) => port.name !== $('#divertToSelect').value);
    $('#divertToSelect2').innerHTML = others.map((port) => `<option value="${escape(port.name)}">${escape(port.name)} (berths for ${number(port.berths ?? port.arrivals * 1.5)} TEU/day)</option>`).join('');
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
        state.built.ports.map((port) => `<tr data-port="${escape(port.name)}"><td>${escape(port.name)}</td><td class="sea">${escape(seaOf(port) ?? 'open sea')}</td>`
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
}
document.querySelectorAll('#scenarioTabs button').forEach((button) => button.addEventListener('click', () => {
    state.scenarioTab = button.dataset.scenario;
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
        .map((lane) => `<option value="${escape(lane.name)}">${escape(lane.from)} → ${escape(lane.to)} (${number(lane.rate)} TEU/day)</option>`).join('');
    keep('#closureLaneSelect', previous.lane);
    $('#fleetLanesSelect').innerHTML = (built.operator ? `<option value="operator">every lane ${escape(built.operator.name)} carries</option>` : '')
        + '<option value="all">every lane</option>'
        + built.lanes.map((lane) => `<option value="lane:${escape(lane.name)}">${escape(lane.from)} → ${escape(lane.to)}</option>`).join('');
    keep('#fleetLanesSelect', previous.fleet);
    $('#demandTownsSelect').innerHTML = '<option value="all">every town</option>'
        + [...(built.towns ?? [])].sort((a, b) => b.demand - a.demand).map((town) => `<option value="town:${escape(town.name)}">${escape(town.name)} (${number(town.demand, 1)} TEU/day)</option>`).join('');
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
            wait: `${number(lane.leadTime * 24, 1)} h a trip today. ${lane.to}'s orders over it queue until it reopens.`,
            detour: `${number(lane.leadTime * 24, 1)} h a trip today, over ${number(lane.kilometres)} km: the detour adds as many kilometres in proportion.`,
            otherPorts: others.length
                ? `${lane.to} also orders over ${others.map((item) => `${item.from} (${number(item.rate)} TEU/day)`).join(', ')}, which ship${others.length === 1 ? 's' : ''} only what ${others.length === 1 ? 'its port holds' : 'their ports hold'}.`
                : `${lane.to} has no other lane: its orders wait for the road to reopen.`
        }[mode];
    }
    const lanes = fleetLanes(settings.fleet.lanes);
    const trucks = lanes.reduce((sum, item) => sum + item.fleet + (item.fleet2 ?? 0), 0);
    $('#fleetHint').textContent = `${lanes.length} lane${lanes.length === 1 ? '' : 's'} with ${number(trucks)} trucks.`;
    const towns = demandTowns(settings.demand.towns);
    $('#demandHint').textContent = `${towns.length} town${towns.length === 1 ? '' : 's'} ordering ${number(towns.reduce((sum, town) => sum + town.demand, 0), 1)} TEU/day.`;
}
for (const selector of ['#closureLaneSelect', '#closureModeSelect', '#fleetLanesSelect', '#demandTownsSelect']) $(selector).addEventListener('change', renderScenarioHints);

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
        targets: targets.map((target) => ({ to: target.to, diverted: target.diverted / 100, berths: target.berths })),
        cut: settings.cut / 100, trucksFound: settings.trucksFound / 100,
        start, duration: settings.days * day, forkAt: start, runTime, ...state.built.trucking
    });
    const byParameter = { ...diversion.supplied, vesselArrivals: { entities: [...supplied.entities, ...diversion.supplied.vesselArrivals.entities], samples: { ...supplied.samples, ...diversion.supplied.vesselArrivals.samples } }, baseDemand };
    const port = (item) => `${item.to} (${number(item.teu)} TEU), whose berths take ${number(item.berths)} TEU/day`;
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
            : `${open > 0 ? `restricted to ${settings.closure.open}% of its loads` : 'closed'} ${days}: ${number(plan.teuPerDay)} TEU a day it no longer carries${plan.reroutedTo.length ? `, ordered from ${state.built.lanes.filter((item) => plan.reroutedTo.includes(item.name)).map((item) => item.from).join(' and ')} instead` : ', its orders waiting for the road to reopen'}`;
        return { supplied: { byParameter: plan.supplied }, lanes: plan.supplied.orderShare.entities, describe: `${lane.from} → ${lane.to} ${what}.` };
    }
    if (id === 'fleetChange') {
        const lanes = fleetLanes(settings.fleet.lanes);
        const plan = fleetPlan({ lanes, change: settings.fleet.change / 100, ...common });
        const which = settings.fleet.lanes === 'operator' ? `on the lanes ${state.built.operator.name} carries` : settings.fleet.lanes === 'all' ? 'on every lane' : `on ${lanes[0].from} → ${lanes[0].to}`;
        return {
            supplied: { byParameter: plan.supplied }, lanes: lanes.map((lane) => lane.name),
            describe: `Trucks ${which} changed by ${settings.fleet.change > 0 ? '+' : ''}${settings.fleet.change}% ${days}: ${number(plan.trucks.before)} to ${number(plan.trucks.after)}.`
        };
    }
    const towns = demandTowns(settings.demand.towns);
    const plan = demandPlan({ towns, change: settings.demand.change / 100, ...common });
    const servedBy = new Set(state.built.served.filter((item) => towns.some((town) => town.name === item.town)).map((item) => item.zone));
    return {
        supplied: { byParameter: plan.supplied }, lanes: state.built.lanes.filter((lane) => servedBy.has(lane.to)).map((lane) => lane.name),
        describe: `Demand ${settings.demand.change > 0 ? 'up' : 'down'} ${Math.abs(settings.demand.change)}% in ${settings.demand.towns === 'all' ? 'every town' : towns[0].name} ${days}: ${number(Math.abs(plan.extraTeu))} TEU ${settings.demand.change > 0 ? 'more' : 'fewer'} ordered.`
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

const summarySignals = ['arrived', 'queue', 'waitDays', 'stock', 'backlog', 'delivered', 'ordered', 'arriving', 'utilisation', 'transportCost', 'fleetCost', 'holdingCost', 'backlogCost'];

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
    const warehouseNames = [...new Set(built.lanes.map((lane) => lane.to))];
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
            holding: both((series) => total(series, warehouseNames, 'holdingCost')),
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
                scenPts: sampleSpark(scenario[name]?.stock, start), basePts: sampleSpark(baseline[name]?.stock, start)
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
        <table><thead><tr><th>Port</th><th class="number">Kept out (TEU)</th><th class="number">arrived later</th><th class="number">never arrived</th>${result.diversion ? '<th class="number">diverted here</th>' : ''}</tr></thead>
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
        <table><thead><tr><th>Lane</th><th class="number">TEU/day carried</th><th class="number">baseline</th><th class="number">trucks busy, peak</th></tr></thead>
            <tbody>${result.lanes.map((lane) => `<tr><td>${escape(lane.name.replace(/^Road /, ''))}</td><td class="number">${number(lane.carried.scenario, 1)}</td><td class="number">${number(lane.carried.baseline, 1)}</td><td${worse(lane.busiest.scenario, lane.busiest.baseline, { noise: 0.01 })}>${percent(lane.busiest.scenario)}</td></tr>`).join('')}</tbody></table>` : '';
    const towns = [...result.towns].sort((a, b) => (b.peak - b.baseline) - (a.peak - a.baseline)).slice(0, 8);
    $('#scenarioResult').innerHTML = `
        <p class="small">${escape(describe)}</p>
        ${result.clamped?.length ? notice('warning', `Some of the values this scenario supplied lie outside what the model allows, and were held to its limits, so the run differs from what was asked: ${result.clamped.join('; ')}.`) : ''}
        ${totals}${ports}${waits}${lanes}
        <table><thead><tr><th>Warehouse</th><th class="number">Lowest stock</th><th class="number">baseline</th><th class="number">day</th></tr></thead>
            <tbody>${result.warehouses.map((item) => `<tr><td><div class="nameWithSpark"><span>${escape(item.name)}</span>${drawSpark(item.scenPts, item.basePts, { stroke: 'var(--warn)' })}</div></td><td${worse(item.low, item.baseline, { lowerIsWorse: true })}>${number(item.low)}</td><td class="number">${number(item.baseline)}</td><td class="number">${number(item.day, 1)}</td></tr>`).join('')}</tbody></table>
        <table><thead><tr><th>Town</th><th class="number">Highest backlog</th><th class="number">baseline</th><th class="number">day</th></tr></thead>
            <tbody>${towns.map((item) => `<tr><td><div class="nameWithSpark"><span>${escape(item.name)}</span>${drawSpark(item.scenPts, item.basePts, { stroke: 'var(--danger)' })}</div></td><td${worse(item.peak, item.baseline)}>${number(item.peak)}</td><td class="number">${number(item.baseline)}</td><td class="number">${number(item.day, 1)}</td></tr>`).join('')}</tbody></table>
        <p class="muted small">Costs are in the model's cost units, counted from the day the scenario starts. The forked run is in the canvas beside the baseline; Show in Konjugate brings it forward.</p>`;
}

// ---- the period of history -----------------------------------------------------------------------------------------
// When a port's PortWatch history has a break, say so beside the date, and offer the days just before it (a period
// of normal traffic to start from) or across it (a month before it, to replay the break itself).
const modelDays = 90;
function renderHistoryHint() {
    const ports = state.discovered?.candidates.ports.filter((port) => port.activity) ?? [];
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
        changed();
    }));
}
