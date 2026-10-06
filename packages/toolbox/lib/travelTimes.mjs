/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Travel times the user knows better than the router: a link's time door to door (loading, the drive and unloading,
// as people observe it and as a map's directions show it), typed in, pasted from a spreadsheet, loaded from a CSV or
// read off Google Maps or OpenStreetMap by the user. A link with a time of the user's takes it in the model instead of
// its routed time plus the hours at its gates.
//
// From a few such times, a calibration: the typical ratio of the user's times to the model's own estimates (routed
// time plus gate hours), which the user may apply to every link they have not timed, labelled as estimated from their
// times. And flags on a time that looks wrong against the route: far faster or slower than it, or an impossible speed.
//
// A link's time is { hours, kilometres, when, note, checkedOn, how } on the link: `when` is the time of day it holds
// for (peak, midday, night or any), `how` where it was read (google, osm, yours: a figure the user had).

import { regionModelDefaults } from './regionModel.mjs';

export const whenLabels = { any: 'Any time', peak: 'Morning or evening peak', midday: 'Middle of the day', night: 'Night' };
export const howLabels = { yours: 'your figure', google: 'read off Google Maps', osm: 'read off OpenStreetMap' };
// A calibration needs at least this many times to be offered, and is worth more from five.
export const calibrationMinimum = 2;
export const calibrationAdvised = 5;
// A time is flagged when it is this many times faster or slower than the model's estimate, or its speed over the
// routed distance is outside these bounds (km/h).
export const suspectRatio = 2.5;
export const speedBounds = { slowest: 3, fastest: 110 };

// Hours from what people type or a map shows: "1:25", "85 min", "1 h 25 min", "1 hr 25 mins", "2 hours", "1.5" (hours).
// Null for anything else or nothing.
export function parseDuration(text) {
    const value = String(text ?? '').trim().toLowerCase().replace(/,/g, '.');
    if (!value) return null;
    let match = value.match(/^(\d+):([0-5]?\d)$/);
    if (match) return Number(match[1]) + Number(match[2]) / 60;
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value) > 0 ? Number(value) : null;
    match = value.match(/^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b\.?)?\s*(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b\.?)?$/);
    if (match && (match[1] || match[2])) {
        const hours = Number(match[1] ?? 0) + Number(match[2] ?? 0) / 60;
        return hours > 0 ? hours : null;
    }
    return null;
}

// "1 h 25 min", "45 min", "3 h".
export function formatDuration(hours) {
    if (!(hours > 0)) return '';
    const minutes = Math.round(hours * 60);
    const [h, m] = [Math.floor(minutes / 60), minutes % 60];
    return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

// What the model would take for a link of this kind (supply or store) with no time of the user's: its routed time
// plus the hours at its gates, door to door.
export function modelHours(leg, kind, settings = regionModelDefaults) {
    if (!leg) return null;
    return leg.hours + (kind === 'supply' ? settings.gateHours : settings.storeGateHours);
}

// Directions between two sites, for the user to read: Google Maps' public directions link (no key, nothing fetched by
// the window), and OpenStreetMap's.
const point = (site) => `${Number(site.lat).toFixed(6)},${Number(site.lon).toFixed(6)}`;
export const googleMapsUrl = (from, to) => `https://www.google.com/maps/dir/?api=1&origin=${point(from)}&destination=${point(to)}&travelmode=driving`;
export const openStreetMapUrl = (from, to) => `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${encodeURIComponent(`${point(from)};${point(to)}`)}`;
export const linkHosts = ['www.google.com', 'www.openstreetmap.org'];

// Why a time looks wrong, or null: against the model's estimate, or by its speed over the routed distance.
export function suspectTime(time, leg, kind, settings = regionModelDefaults) {
    if (!(time?.hours > 0) || !leg) return null;
    const estimate = modelHours(leg, kind, settings);
    const kilometres = time.kilometres > 0 ? time.kilometres : leg.kilometres;
    const speed = kilometres / time.hours;
    if (kilometres > 1 && speed > speedBounds.fastest) return `${formatDuration(time.hours)} for ${Math.round(kilometres)} km is ${Math.round(speed)} km/h door to door: too fast for a road. Is it right?`;
    if (time.hours > suspectRatio * estimate) return `${formatDuration(time.hours)} is more than ${suspectRatio} times the ${formatDuration(estimate)} the route suggests. Is it right?`;
    if (time.hours * suspectRatio < estimate) return `${formatDuration(time.hours)} is under ${Math.round(100 / suspectRatio)}% of the ${formatDuration(estimate)} the route suggests. Is it right?`;
    if (kilometres > 1 && speed < speedBounds.slowest) return `${formatDuration(time.hours)} for ${Math.round(kilometres)} km is under ${speedBounds.slowest} km/h. Is it right?`;
    return null;
}

// The typical ratio of the user's times to the model's own estimates, over the links that have both: the median, so one
// odd time does not swing it. Null with fewer than `calibrationMinimum` times.
export function calibration(entries, settings = regionModelDefaults) {
    const ratios = entries.filter((entry) => entry.time?.hours > 0 && entry.leg?.hours >= 0).map((entry) => entry.time.hours / modelHours(entry.leg, entry.kind, settings))
        .filter((ratio) => Number.isFinite(ratio) && ratio > 0).sort((a, b) => a - b);
    if (ratios.length < calibrationMinimum) return null;
    const middle = Math.floor(ratios.length / 2);
    const factor = ratios.length % 2 ? ratios[middle] : (ratios[middle - 1] + ratios[middle]) / 2;
    return { factor: Number(factor.toFixed(3)), count: ratios.length, low: ratios[0], high: ratios.at(-1) };
}

// A time typed or pasted, checked: { hours, ... } or an error to show.
export function timeFrom(text, { when = 'any', how = 'yours', kilometres = null, note = '', checkedOn = null } = {}) {
    const hours = parseDuration(text);
    if (hours === null) return { error: `"${text}" is not a time: type it as 1:25, 85 min or 1 h 25 min.` };
    if (hours > 72) return { error: `${formatDuration(hours)} is more than three days for one trip.` };
    return { time: { hours, ...(kilometres > 0 ? { kilometres } : {}), when: whenLabels[when] ? when : 'any', how: howLabels[how] ? how : 'yours', ...(note ? { note } : {}), ...(checkedOn ? { checkedOn } : {}) } };
}

// ---- a CSV of times -------------------------------------------------------------------------------------------------
//
//   from,to,time,kilometres,when,note
//   Our depot,Mall store,1:10,32,peak,Google Maps on a Tuesday at 8
//
// `from` and `to` are site names; `time` door to door in any of parseDuration's forms; the rest optional. `when` is
// any, peak, midday or night.

const quote = (value) => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
const hoursText = (hours) => `${Math.floor(Math.round(hours * 60) / 60)}:${String(Math.round(hours * 60) % 60).padStart(2, '0')}`;

export function writeTravelTimes(rows) {
    const lines = rows.filter((row) => row.time?.hours > 0)
        .map((row) => [row.from, row.to, hoursText(row.time.hours), row.time.kilometres ?? '', row.time.when ?? 'any', row.time.note ?? ''].map(quote).join(','));
    return `from,to,time,kilometres,when,note\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

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

const whenOf = (text) => {
    const value = String(text ?? '').trim().toLowerCase();
    if (!value) return 'any';
    if (/peak|rush|morning|evening/.test(value)) return 'peak';
    if (/mid|noon|day/.test(value)) return 'midday';
    if (/night/.test(value)) return 'night';
    return 'any';
};

// Rows of times from a CSV or from cells pasted from a spreadsheet (tab-separated, with or without a header): each
// { from, to, time } by site name, with what could not be read. A header is recognised by its names; without one the
// columns are from, to, time, kilometres, when, note.
export function parseTravelTimes(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
    const errors = [];
    const rows = [];
    if (!lines.length) return { rows, errors: ['There are no times in it.'] };
    const delimiter = ['\t', ',', ';'].find((candidate) => lines[0].includes(candidate)) ?? ',';
    const first = splitLine(lines[0], delimiter).map((cell) => cell.toLowerCase());
    const header = first.some((cell) => ['from', 'origin'].includes(cell)) && first.some((cell) => ['to', 'destination'].includes(cell));
    const index = (names, fallback) => {
        if (!header) return fallback;
        const found = first.findIndex((cell) => names.includes(cell));
        return found >= 0 ? found : null;
    };
    const columns = {
        from: index(['from', 'origin'], 0), to: index(['to', 'destination'], 1), time: index(['time', 'hours', 'duration', 'travel time'], 2),
        kilometres: index(['kilometres', 'kilometers', 'km', 'distance'], 3), when: index(['when', 'time of day'], 4), note: index(['note', 'notes', 'source'], 5)
    };
    if (columns.time === null) return { rows, errors: ['The header has no time column.'] };
    lines.slice(header ? 1 : 0).forEach((line, offset) => {
        const lineNumber = offset + (header ? 2 : 1);
        const cells = splitLine(line, delimiter);
        const cell = (key) => (columns[key] === null || columns[key] === undefined ? '' : cells[columns[key]] ?? '');
        if (!cell('from') || !cell('to')) { errors.push(`Line ${lineNumber}: it needs the sites it runs from and to.`); return; }
        const kilometres = Number(String(cell('kilometres')).replace(/[^\d.]/g, ''));
        const read = timeFrom(cell('time'), { when: whenOf(cell('when')), kilometres: kilometres > 0 ? kilometres : null, note: cell('note') });
        if (read.error) { errors.push(`Line ${lineNumber}: ${read.error}`); return; }
        rows.push({ from: cell('from'), to: cell('to'), time: read.time });
    });
    return { rows, errors };
}
