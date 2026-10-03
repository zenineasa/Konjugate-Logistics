/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Port activity from IMF PortWatch (https://portwatch.imf.org): daily port calls and trade estimates
// for about 2,000 ports, from ships' satellite (AIS) signals, updated weekly. The data are free to reuse,
// commercially too, attributed as "Source: International Monetary Fund"
// (https://www.imf.org/external/terms.htm). It is served from the IMF's ArcGIS Online account; only
// addresses under that account are ever built here.
//
// Volumes are metric tonnes. A port's containers handed inland are its container imports, turned into
// TEU at an assumed weight per TEU. They include containers that only change ships there, so a
// transhipment hub hands inland less than this; the inland share says how much.

import { distance } from './geo.mjs';

export const portwatchHost = 'services9.arcgis.com';
const servicePath = '/weJ1QsnbMYJlCHdG/ArcGIS/rest/services';
export const portwatchAttribution = 'Port activity: IMF PortWatch (Source: International Monetary Fund)';
// Days of history fetched for a port: a year, so the average spans the seasons. Under the server's
// 1,000 records an answer.
export const historyDays = 365;
// Average weight of an imported TEU, in tonnes: an assumption (loaded boxes weigh more, empties less).
export const tonnesPerTeu = 10;
// A PortWatch port is the same as an OpenStreetMap port when its point lies within this distance of the
// port's centre, plus twice the port's radius (a large port's point may sit at one end of its land).
export const matchKilometres = 5;
const reachKilometres = (port) => matchKilometres + 2 * Math.sqrt((Number(port.areaSquareKilometres) || 0) / Math.PI);
// How far around the region PortWatch ports are looked for: a port's point may lie off its land.
export const marginKilometres = 20;

export const portwatchQueryUrl = (service, parameters) => `https://${portwatchHost}${servicePath}/${service}/FeatureServer/0/query?${new URLSearchParams({ ...parameters, f: 'json' })}`;

// The PortWatch ports in and around a region.
export function portwatchPortsUrl(bbox) {
    const dLat = marginKilometres / 111.32;
    const dLon = marginKilometres / (111.32 * Math.cos((bbox.south + bbox.north) / 2 * Math.PI / 180));
    const envelope = [bbox.west - dLon, bbox.south - dLat, bbox.east + dLon, bbox.north + dLat].map((value) => value.toFixed(4)).join(',');
    return portwatchQueryUrl('PortWatch_ports_database', {
        where: '1=1', geometry: envelope, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
        outFields: 'portid,portname,country,lat,lon,vessel_count_container,vessel_count_total', returnGeometry: 'false'
    });
}

// A port's daily activity, the latest `days` days.
export function portwatchActivityUrl(portid, days = historyDays) {
    if (!/^port\d+$/.test(portid)) throw new Error(`"${portid}" is not a PortWatch port id.`);
    return portwatchQueryUrl('Daily_Ports_Data', {
        where: `portid='${portid}'`, outFields: 'portid,portname,date,portcalls_container,portcalls,import_container,export_container',
        orderByFields: 'date DESC', resultRecordCount: String(days), returnGeometry: 'false'
    });
}

export function featuresOf(text, what) {
    const json = typeof text === 'string' ? JSON.parse(text) : text;
    if (json.error) throw new Error(`IMF PortWatch could not answer for ${what}: ${json.error.message ?? 'an error'}${json.error.details?.length ? ` (${json.error.details.join(' ')})` : ''}.`);
    if (!Array.isArray(json.features)) throw new Error(`The IMF PortWatch answer for ${what} has no records.`);
    return json.features.map((feature) => feature.attributes ?? {});
}

export function readPortwatchPorts(text) {
    return featuresOf(text, 'the ports').filter((item) => item.portid && Number.isFinite(item.lat) && Number.isFinite(item.lon)).map((item) => ({
        portid: item.portid, name: item.portname, country: item.country, lat: item.lat, lon: item.lon,
        containerVessels: item.vessel_count_container ?? 0, vessels: item.vessel_count_total ?? 0
    }));
}

// A date as the server gives it ('2026-09-01', or milliseconds for an older date field) as YYYY-MM-DD.
const isoDate = (value) => (typeof value === 'number' ? new Date(value).toISOString().slice(0, 10) : String(value).slice(0, 10));

// A port's days, oldest first: { portid, name, days: [{ date, containerCalls, calls, importTonnes, exportTonnes }] }.
export function readPortwatchActivity(text) {
    const records = featuresOf(text, 'a port’s activity');
    if (!records.length) return null;
    const days = records.map((item) => ({
        date: isoDate(item.date), containerCalls: item.portcalls_container ?? 0, calls: item.portcalls ?? 0,
        importTonnes: item.import_container ?? 0, exportTonnes: item.export_container ?? 0
    })).sort((a, b) => a.date.localeCompare(b.date));
    return { portid: records[0].portid, name: records[0].portname, days };
}

// The average day of a port's history.
export function summariseActivity(activity) {
    const days = activity.days;
    const mean = (key) => days.reduce((total, day) => total + day[key], 0) / days.length;
    const importTonnesPerDay = mean('importTonnes');
    return {
        portid: activity.portid, name: activity.name, from: days[0].date, to: days.at(-1).date, days: days.length,
        importTonnesPerDay, exportTonnesPerDay: mean('exportTonnes'), containerCallsPerDay: mean('containerCalls'),
        teuPerDay: importTonnesPerDay / tonnesPerTeu,
        // Each day's container imports, oldest first, for a model whose arrivals follow the history.
        daily: days.map((day) => [day.date, day.importTonnes]),
        shift: findShift(days)
    };
}

// A break in a port's history: the month from which its container imports, on average, are less than half or more
// than twice what they were before. Months are compared whole, and each side needs two months of data, so a single
// busy or quiet month is not a break. Returns { month, before, after, change } (tonnes a day; change is the
// fraction, -0.95 for a 95% fall), or null.
export const shiftThreshold = 2;
export function findShift(days) {
    const months = [...new Set(days.map((day) => day.date.slice(0, 7)))];
    let best = null;
    for (let index = 2; index <= months.length - 2; index += 1) {
        const month = months[index];
        const before = days.filter((day) => day.date.slice(0, 7) < month);
        const after = days.filter((day) => day.date.slice(0, 7) >= month);
        const average = (list) => list.reduce((total, day) => total + day.importTonnes, 0) / list.length;
        const [b, a] = [average(before), average(after)];
        if (!(b > 0 && a > 0)) continue;
        const ratio = a / b;
        if (Math.abs(Math.log(ratio)) >= Math.log(shiftThreshold) && (!best || Math.abs(Math.log(ratio)) > Math.abs(Math.log(best.after / best.before)))) {
            best = { month, before: b, after: a, change: ratio - 1 };
        }
    }
    return best;
}

// The days of a history a run uses: `days` days from `from` (YYYY-MM-DD), or the latest `days` days when `from` is
// not given. Returns the [date, tonnes] rows, oldest first (fewer when the history runs out).
export function historyWindow(daily, { from = null, days }) {
    if (!from) return daily.slice(-days);
    return daily.filter(([date]) => date >= from).slice(0, days);
}

// Pairs OpenStreetMap ports with PortWatch ports, each at most once, nearest pairs first, within reach.
// Returns a Map from the OpenStreetMap port's id to { port (the PortWatch one), kilometres }.
export function matchPorts(ports, portwatchPorts) {
    const pairs = [];
    for (const port of ports) {
        for (const listed of portwatchPorts) {
            const kilometres = distance(port, listed) / 1000;
            if (kilometres <= reachKilometres(port)) pairs.push({ port, listed, kilometres });
        }
    }
    pairs.sort((a, b) => a.kilometres - b.kilometres || b.listed.containerVessels - a.listed.containerVessels);
    const matches = new Map();
    const used = new Set();
    for (const { port, listed, kilometres } of pairs) {
        if (matches.has(port.id) || used.has(listed.portid)) continue;
        matches.set(port.id, { port: listed, kilometres });
        used.add(listed.portid);
    }
    return matches;
}
