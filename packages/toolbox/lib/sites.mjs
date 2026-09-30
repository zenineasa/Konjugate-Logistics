/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A CSV of the user's own sites, added to (or used instead of) what the map shows:
//
//   name,kind,latitude,longitude,teuPerDay,floorArea,population
//   Harbour terminal,port,24.81,54.65,420,,
//   Our depot,warehouse,24.95,55.02,,18000,
//   Northern customers,customer,25.27,55.30,35,,
//
// `kind` is port, warehouse or customer. teuPerDay is a port's volume handed inland or a customer's
// demand; floorArea (m²) sizes a warehouse; population weights a customer without a fixed demand.
// Only name, kind, latitude and longitude are required. Headers are matched loosely (lat, lng, ...).

const kinds = { port: 'port', terminal: 'port', warehouse: 'zone', depot: 'zone', 'distribution centre': 'zone', 'distribution center': 'zone', dc: 'zone', customer: 'town', town: 'town', city: 'town', shop: 'town', store: 'town' };
const aliases = {
    name: ['name', 'site', 'label'], kind: ['kind', 'type', 'category'],
    latitude: ['latitude', 'lat', 'y'], longitude: ['longitude', 'lon', 'lng', 'long', 'x'],
    teuPerDay: ['teuperday', 'teu/day', 'teu', 'volume', 'demand'], floorArea: ['floorarea', 'floor area', 'area', 'm2', 'sqm'],
    population: ['population', 'pop', 'weight']
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

// Returns { sites: { ports, zones, towns }, errors, warnings }; errors name the line.
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
        const kind = kinds[String(cell('kind') ?? '').toLowerCase()];
        const lat = number(cell('latitude'));
        const lon = number(cell('longitude'));
        if (!name) return errors.push(`Line ${lineNumber}: the site has no name.`);
        if (!kind) return errors.push(`Line ${lineNumber}: "${cell('kind')}" is not a kind of site. Use port, warehouse or customer.`);
        if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) return errors.push(`Line ${lineNumber}: ${name} needs a latitude between -90 and 90 and a longitude between -180 and 180.`);
        const teuPerDay = number(cell('teuPerDay'));
        const floorArea = number(cell('floorArea'));
        const population = number(cell('population'));
        for (const [label, value] of [['teuPerDay', teuPerDay], ['floorArea', floorArea], ['population', population]]) {
            if (Number.isNaN(value) || (value !== null && value < 0)) errors.push(`Line ${lineNumber}: ${label} for ${name} is not a number of zero or more.`);
        }
        const site = { id: `user:${kind}:${lineNumber}`, kind, name, lat, lon, source: 'your sites', user: true };
        if (kind === 'port') sites.ports.push({ ...site, ...(teuPerDay > 0 ? { teuPerDay, teuPerDayBasis: 'user' } : {}), significance: Infinity });
        if (kind === 'zone') {
            if (teuPerDay) warnings.push(`Line ${lineNumber}: a warehouse's teuPerDay is not used; its flow follows the customers it serves.`);
            sites.zones.push({ ...site, floorAreaSquareMetres: floorArea ?? null, floorAreaBasis: floorArea ? 'user' : null, significance: Infinity });
        }
        if (kind === 'town') sites.towns.push({ ...site, ...(teuPerDay > 0 ? { teuPerDay } : {}), population: population ?? null, populationBasis: population ? 'user' : null, significance: Infinity });
    });
    return { sites, errors, warnings };
}
