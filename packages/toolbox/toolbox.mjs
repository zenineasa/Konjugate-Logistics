/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Logistics Toolbox window: pick a region, fetch what OpenStreetMap holds for it, see what the data
// can and can't show, keep the sites that matter, and build a model in Konjugate's canvas. The window
// only names declared things to the host (an importer, a file role, a listed host); the host fetches,
// reads files and runs the importer.

import { MapView } from './mapView.mjs';
import { maximumSplitDepth, overpassRequests, overpassUrl, retryDelaysSeconds, splitRequest } from './lib/overpass.mjs';
import { nominatimSearchUrl, rankPlaces } from './lib/places.mjs';

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
    portVolume: null, built: null, busy: false, pendingAdd: null, rebuildTimer: null
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
            ? places.map((place, index) => `<li><button type="button" data-index="${index}">${escape(place.display_name)} <span class="kind">${escape(place.type ?? '')}</span></button></li>`).join('')
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

$('#fetchButton').addEventListener('click', async () => {
    if (!state.bbox) return;
    setBusy(true);
    const requests = overpassRequests(state.bbox);
    const labels = { ports: 'Ports and anchorages', logistics: 'Warehouses and industrial land', roads: 'Major roads', rail: 'Rail', places: 'Towns and cities' };
    const kinds = [...new Set(requests.map((request) => request.kind))];
    const progress = $('#fetchProgress');
    progress.hidden = false;
    progress.innerHTML = kinds.map((kind) => `<li data-kind="${kind}"><span>${labels[kind]}</span><span class="state">waiting</span></li>`).join('');
    $('#regionStatus').innerHTML = '';
    try {
        // A new region replaces the last one's data (your own sites file stays).
        for (const kind of kinds) await call(api.clearFile(importerId, kind));
        const bytes = {};
        // One request at a time: the public server is shared.
        const queue = [...requests];
        while (queue.length) {
            const request = queue.shift();
            const row = progress.querySelector(`[data-kind="${request.kind}"]`);
            const label = request.parts > 1 || request.depth ? `part ${request.part} of ${request.parts}` : 'fetching';
            for (let attempt = 0; ; attempt += 1) {
                row.querySelector('.state').textContent = `${label}…`;
                try {
                    const answer = await call(api.fetchFile(importerId, request.kind, overpassUrl(request.query), `${request.kind}-${request.part}.json`));
                    bytes[request.kind] = (bytes[request.kind] ?? 0) + answer.bytes;
                    break;
                } catch (error) {
                    // Too large to accept: fetch the tile again as four quarters.
                    if (/larger than the size limit/.test(error.message) && request.depth < maximumSplitDepth) {
                        queue.unshift(...splitRequest(request));
                        break;
                    }
                    if (!busy(error.message) || attempt >= retryDelaysSeconds.length) {
                        row.classList.add('failed');
                        row.querySelector('.state').textContent = 'failed';
                        throw new Error(`${labels[request.kind]}: ${error.message}${/larger than the size limit/.test(error.message) ? ' Choose a smaller area.' : busy(error.message) ? ' The public map server is busy; try again in a few minutes, or choose a smaller area.' : ''}`);
                    }
                    for (let left = retryDelaysSeconds[attempt]; left > 0; left -= 1) {
                        row.querySelector('.state').textContent = `server busy, trying again in ${left} s`;
                        await wait(1);
                    }
                }
            }
            if (!queue.some((next) => next.kind === request.kind) && bytes[request.kind] !== undefined) {
                row.classList.add('done');
                row.querySelector('.state').textContent = `${number(bytes[request.kind] / 1024)} KB`;
            }
        }
        await discover();
    } catch (error) {
        $('#regionStatus').innerHTML = notice('error', error.message);
    } finally {
        setBusy(false);
    }
});

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
    for (const section of ['#stepCoverage', '#stepCurate', '#stepBuild']) $(section).hidden = false;
    renderCoverage();
    renderCandidates();
    changed({ rebuild: Boolean(state.built) });
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
    if (group === 'ports') return site.user ? `Your site (${site.source})` : `${number(site.areaSquareKilometres, 2)} km² of port land${site.commercial ? ', commercial' : ''}${site.anchorages ? `, ${site.anchorages} anchorage${site.anchorages === 1 ? '' : 's'}` : ''}`;
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
            ${group === 'ports' && site.kept ? `<span><input type="number" min="0" step="10" placeholder="${state.portVolume}" value="${site.teuPerDay ?? ''}" aria-label="TEU a day handed inland at ${escape(site.name)}"> <span class="muted small">TEU/day</span></span>` : '<span></span>'}
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
    const kept = groups.map((group) => allSites(group).filter((site) => site.kept).length);
    const missing = groups.filter((_group, index) => !kept[index]).map((group) => ({ ports: 'a port', zones: 'a logistics zone', towns: 'a town or customer' })[group]);
    $('#buildButton').disabled = state.busy || missing.length > 0;
    $('#buildStatus').innerHTML = missing.length ? notice('warning', `Keep at least ${missing.join(', ')} to build a model.`) : '';
    if (state.built) {
        $('#buildStatus').innerHTML += notice('warning', 'The model no longer matches the sites above.');
        if (rebuild && $('#keepInStep').checked && !missing.length) {
            clearTimeout(state.rebuildTimer);
            state.rebuildTimer = setTimeout(() => build({ focus: false }), 600);
        }
    }
}

async function build({ focus = false } = {}) {
    if (state.busy) return;
    setBusy(true);
    $('#buildStatus').innerHTML = notice('', 'Building the model: routing every lane…');
    try {
        const answer = await call(api.runImport(importerId, { step: 'build', bbox: state.bbox, selection: selection(), settings: { portTeuPerDay: state.portVolume } }));
        if (!answer.imported) throw new Error((answer.report?.errors ?? ['The model could not be built.']).join(' '));
        state.built = answer.data;
        await call(api.openInCanvas(null, { focus, silent: true, session: sessionState() }));
        $('#showButton').disabled = false;
        $('#buildStatus').innerHTML = notice('ok', `${answer.report.summary}: ${state.built.nodes} nodes and ${state.built.edges} relationships, now in the canvas.`)
            + state.built.warnings.map((text) => notice('warning', text)).join('');
        renderBuilt();
    } catch (error) {
        $('#buildStatus').innerHTML = notice('error', error.message);
    } finally {
        setBusy(false);
    }
}

function renderBuilt() {
    const built = state.built;
    const positions = new Map(groups.flatMap((group) => allSites(group).map((site) => [site.name, site])));
    map.setFlows({
        lanes: built.lanes.filter((lane) => positions.has(lane.from) && positions.has(lane.to)).map((lane) => ({
            from: positions.get(lane.from), to: positions.get(lane.to), rate: lane.rate,
            title: `${lane.name}: ${number(lane.rate, 1)} TEU/day, ${number(lane.kilometres, 1)} km, ${number(lane.leadTime * 24, 1)} h, ${lane.fleet} trucks`
        })),
        serves: built.served.filter((item) => positions.has(item.town) && positions.has(item.zone)).map((item) => ({ from: positions.get(item.zone), to: positions.get(item.town) }))
    });
    const basisLabel = { routed: 'routed', local: 'local streets', 'straight-line': 'straight line' };
    const assumed = built.provenance.filter((entry) => entry.basis === 'assumed');
    $('#buildResult').innerHTML = `
        <table>
            <thead><tr><th>Road lane</th><th class="number">TEU/day</th><th class="number">km</th><th class="number">hours</th><th class="number">trucks</th></tr></thead>
            <tbody>${built.lanes.map((lane) => `<tr><td>${escape(lane.from)} → ${escape(lane.to)} <span class="basis ${lane.basis === 'routed' ? '' : 'assumed'}">${basisLabel[lane.basis]}</span></td><td class="number">${number(lane.rate, 1)}</td><td class="number">${number(lane.kilometres, 1)}</td><td class="number">${number(lane.leadTime * 24, 1)}</td><td class="number">${lane.fleet}</td></tr>`).join('')}</tbody>
        </table>
        <table>
            <thead><tr><th>Town</th><th>Served from</th><th class="number">TEU/day</th></tr></thead>
            <tbody>${built.served.map((item) => `<tr><td>${escape(item.town)}</td><td>${escape(item.zone)}</td><td class="number">${number(item.demand, 1)}</td></tr>`).join('')}</tbody>
        </table>
        <details><summary>Where every value comes from (${built.provenance.length}; ${assumed.length} assumed)</summary>
            <table><thead><tr><th>Site</th><th>Value</th><th>Basis</th></tr></thead>
            <tbody>${built.provenance.map((entry) => `<tr><td>${escape(entry.entity)}</td><td>${escape(entry.parameter)}: ${number(entry.value, entry.unit === 'day' ? 3 : 1)} ${escape(entry.unit)}<div class="basis">${escape(entry.detail ?? '')}</div></td><td><span class="basis ${entry.basis === 'assumed' ? 'assumed' : ''}">${escape(entry.basis)}</span></td></tr>`).join('')}</tbody></table>
        </details>`;
}

$('#buildButton').addEventListener('click', () => build({ focus: false }));
$('#showButton').addEventListener('click', async () => {
    try { await call(api.openInCanvas(null, { focus: true, silent: true })); } catch (error) { $('#buildStatus').innerHTML = notice('error', error.message); }
});

// ---- the session kept with the project ------------------------------------------------------------------
// Everything the window needs to carry on where it was: the place, the curation and the last build's tables. The
// host keeps the fetched map data beside it, so a saved project reopens its region offline.
function sessionState() {
    return {
        version: 1, place: state.place ? { display_name: state.place.display_name, boundingbox: state.place.boundingbox } : null,
        margin: $('#marginSelect').value, bbox: state.bbox, group: state.group, portVolume: state.portVolume,
        kept: Object.fromEntries(groups.map((group) => [group, [...state.kept[group]]])),
        changes: [...state.changes], added: state.added, built: state.built, keepInStep: $('#keepInStep').checked
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
        state.built = null;
        await discover({ keepCuration: true });
        if (saved.built) {
            state.built = saved.built;
            renderBuilt();
            $('#showButton').disabled = false;
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
    for (const selector of ['#fetchButton', '#sampleButton', '#sitesButton', '#searchButton']) $(selector).disabled = busy;
    if (!busy) showArea();
    if (state.discovered) {
        const missing = groups.some((group) => !allSites(group).some((site) => site.kept));
        $('#buildButton').disabled = busy || missing;
    }
}

if (!api) $('#regionStatus').innerHTML = notice('error', 'This window must be opened from Konjugate.');
else restoreSession();
