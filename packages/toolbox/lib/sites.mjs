/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A CSV of the user's own sites, the network they place on the map saved as a table, or one made in a spreadsheet:
//
//   name,kind,latitude,longitude,teuPerDay,floorArea,population,from
//   Harbour terminal,port,24.81,54.65,420,,,
//   Our depot,warehouse,24.95,55.02,,18000,,Harbour terminal
//   Mall store,store,25.27,55.30,35,,,Our depot
//
// `kind` is a site's role: supplier, port, warehouse, store, dark store or customer area (customer, town and depot
// are read too). teuPerDay is a supplier's or port's volume, or a store's or customer area's demand; floorArea (m²)
// sizes a warehouse; population weights a customer area without a fixed demand. `from` names the sites it is supplied
// from, separated by |, so a saved network keeps its links. Only name, kind, latitude and longitude are required.
// Headers are matched loosely (lat, lng, ...).

const roles = {
    supplier: 'supplier', factory: 'supplier', vendor: 'supplier', manufacturer: 'supplier',
    port: 'port', terminal: 'port',
    warehouse: 'warehouse', depot: 'warehouse', 'distribution centre': 'warehouse', 'distribution center': 'warehouse', dc: 'warehouse',
    store: 'store', shop: 'store', 'dark store': 'darkStore', darkstore: 'darkStore',
    customer: 'customerArea', 'customer area': 'customerArea', customers: 'customerArea', town: 'customerArea', city: 'customerArea'
};
// The model's groups: sources (ports and suppliers), warehouses (zones) and demand (towns).
export const groupOfRole = { supplier: 'ports', port: 'ports', warehouse: 'zones', store: 'towns', darkStore: 'towns', customerArea: 'towns' };
const kindOfGroup = { ports: 'port', zones: 'zone', towns: 'town' };
export const roleNames = { supplier: 'supplier', port: 'port', warehouse: 'warehouse', store: 'store', darkStore: 'dark store', customerArea: 'customer area' };

const aliases = {
    name: ['name', 'site', 'label'], kind: ['kind', 'type', 'category'],
    latitude: ['latitude', 'lat', 'y'], longitude: ['longitude', 'lon', 'lng', 'long', 'x'],
    teuPerDay: ['teuperday', 'teu/day', 'teu', 'volume', 'demand'], floorArea: ['floorarea', 'floor area', 'area', 'm2', 'sqm'],
    population: ['population', 'pop', 'weight'], from: ['from', 'supplied from', 'served from', 'sources']
};

function splitLine(line, delimiter) {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quoted) {
            if (character === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
            else if (character === '"') quoted = false;
            else current += character;
        } else if (character === '"') quoted = true;
        else if (character === delimiter) { cells.push(current.trim()); current = ''; }
        else current += character;
    }
    cells.push(current.trim());
    return cells;
}

const number = (text) => {
    if (text === undefined || text === '') return null;
    const value = Number(String(text).replace(/[\s,](?=\d{3}\b)/g, ''));
    return Number.isFinite(value) ? value : NaN;
};

// Returns { sites: { ports, zones, towns }, errors, warnings }; errors name the line. Each site has its `role`, and `from`
// (names) when the file links it.
export function parseSites(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
    const errors = [];
    const warnings = [];
    const sites = { ports: [], zones: [], towns: [] };
    if (!lines.length) return { sites, errors: ['The file is empty.'], warnings };
    const delimiter = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
    const header = splitLine(lines[0], delimiter).map((cell) => cell.toLowerCase().replace(/[_\-()]/g, ' ').replace(/\s+/g, ' ').trim());
    const column = {};
    for (const [field, names] of Object.entries(aliases)) {
        const index = header.findIndex((cell) => names.includes(cell) || names.includes(cell.replace(/ /g, '')));
        if (index >= 0) column[field] = index;
    }
    for (const required of ['name', 'kind', 'latitude', 'longitude']) {
        if (column[required] === undefined) errors.push(`The header has no ${required} column.`);
    }
    if (errors.length) return { sites, errors, warnings };
    lines.slice(1).forEach((line, index) => {
        const lineNumber = index + 2;
        const cells = splitLine(line, delimiter);
        const cell = (field) => (column[field] === undefined ? undefined : cells[column[field]]);
        const name = cell('name');
        const role = roles[String(cell('kind') ?? '').toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim()];
        const kind = kindOfGroup[groupOfRole[role]];
        const lat = number(cell('latitude'));
        const lon = number(cell('longitude'));
        if (!name) return errors.push(`Line ${lineNumber}: the site has no name.`);
        if (!kind) return errors.push(`Line ${lineNumber}: "${cell('kind')}" is not a kind of site. Use supplier, port, warehouse, store, dark store or customer area.`);
        if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) return errors.push(`Line ${lineNumber}: ${name} needs a latitude between -90 and 90 and a longitude between -180 and 180.`);
        const teuPerDay = number(cell('teuPerDay'));
        const floorArea = number(cell('floorArea'));
        const population = number(cell('population'));
        for (const [label, value] of [['teuPerDay', teuPerDay], ['floorArea', floorArea], ['population', population]]) {
            if (Number.isNaN(value) || (value !== null && value < 0)) errors.push(`Line ${lineNumber}: ${label} for ${name} is not a number of zero or more.`);
        }
        const from = String(cell('from') ?? '').split(delimiter === ';' ? /\|/ : /[|;]/).map((item) => item.trim()).filter(Boolean);
        const site = { id: `user:${kind}:${lineNumber}`, kind, role, name, lat, lon, source: 'your sites', user: true, ...(from.length ? { from } : {}) };
        if (kind === 'port') sites.ports.push({ ...site, ...(role === 'supplier' ? { supplier: true } : {}), ...(teuPerDay > 0 ? { teuPerDay, teuPerDayBasis: 'user' } : {}), significance: Infinity });
        if (kind === 'zone') {
            if (teuPerDay) warnings.push(`Line ${lineNumber}: a warehouse's teuPerDay is not used; its flow follows the customers it serves.`);
            sites.zones.push({ ...site, floorAreaSquareMetres: floorArea ?? null, floorAreaBasis: floorArea ? 'user' : null, significance: Infinity });
        }
        if (kind === 'town') sites.towns.push({ ...site, ...(teuPerDay > 0 ? { teuPerDay, teuPerDayBasis: 'user' } : {}), population: population ?? null, populationBasis: population ? 'user' : null, significance: Infinity });
    });
    return { sites, errors, warnings };
}

// The network as a CSV parseSites reads back: every pin, with the figures the user set (assumed ones are left out, to be
// assumed again), and the sites each is supplied from. `pins` are the window's ({ role, name, lat, lon, fields });
// `links` ({ from, to } by pin id).
const quote = (value) => (/[",\n|]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
export function writeSites(pins, links = []) {
    const byId = new Map(pins.map((pin) => [pin.id, pin]));
    const own = (pin, key) => (pin.fields?.[key]?.basis === 'user' && Number(pin.fields[key].value) > 0 ? Number(pin.fields[key].value) : '');
    const rows = pins.map((pin) => {
        const volume = own(pin, pin.role === 'supplier' ? 'supply' : pin.role === 'port' ? 'teuPerDay' : 'demand');
        const from = links.filter((link) => link.to === pin.id && byId.has(link.from)).map((link) => byId.get(link.from).name);
        return [pin.name, roleNames[pin.role], Number(pin.lat.toFixed(6)), Number(pin.lon.toFixed(6)), volume, own(pin, 'floorArea'), own(pin, 'population'), from.join('|')].map(quote).join(',');
    });
    return `name,kind,latitude,longitude,teuPerDay,floorArea,population,from\n${rows.join('\n')}\n`;
}
