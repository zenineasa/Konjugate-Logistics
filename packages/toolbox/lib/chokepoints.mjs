/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Chokepoints: the straits and canals much of the world's shipping passes through, as IMF PortWatch
// lists them (https://portwatch.imf.org, Source: International Monetary Fund), with their daily transits.
//
// PortWatch does not say which ports depend on which chokepoint, so dependence here comes from geography,
// and is an assumption the user can change: a port inside an enclosed sea depends on the strait that closes
// it. A port in the Persian Gulf receives all its ships through Hormuz; one in the Black Sea through the
// Bosporus; one in the Sea of Azov through Kerch and the Bosporus. A Red Sea port's ships come from the north
// through Suez or from the south through Bab el-Mandeb: half each, an even split for want of a better figure.
// Every other port starts with no dependence, which the user can set.
//
// A disruption cuts a chokepoint's transits by a share for a while; each dependent port's arrivals fall by its
// dependence times that share. disruptionPath() turns that into the path of values a scenario fork follows.

import { pointInRing } from './geo.mjs';
import { featuresOf, portwatchQueryUrl } from './portwatch.mjs';

export const chokepoints = [
    ['chokepoint1', 'Suez Canal', 30.5933, 32.4369], ['chokepoint2', 'Panama Canal', 9.1205, -79.7672],
    ['chokepoint3', 'Bosporus Strait', 41.1693, 29.0915], ['chokepoint4', 'Bab el-Mandeb Strait', 12.7886, 43.3495],
    ['chokepoint5', 'Malacca Strait', 1.5170, 102.6651], ['chokepoint6', 'Strait of Hormuz', 26.2969, 56.8598],
    ['chokepoint7', 'Cape of Good Hope', -34.9273, 20.8827], ['chokepoint8', 'Gibraltar Strait', 35.9423, -5.7549],
    ['chokepoint9', 'Dover Strait', 51.0302, 1.5058], ['chokepoint10', 'Oresund Strait', 55.5078, 12.8508],
    ['chokepoint11', 'Taiwan Strait', 24.7235, 119.8314], ['chokepoint12', 'Korea Strait', 34.1308, 129.2092],
    ['chokepoint13', 'Tsugaru Strait', 41.3280, 140.3533], ['chokepoint14', 'Luzon Strait', 20.4889, 121.3523],
    ['chokepoint15', 'Lombok Strait', -8.4191, 115.8014], ['chokepoint16', 'Ombai Strait', -8.3985, 125.0910],
    ['chokepoint17', 'Bohai Strait', 38.3730, 120.9000], ['chokepoint18', 'Torres Strait', -9.8625, 142.2475],
    ['chokepoint19', 'Sunda Strait', -5.9668, 105.7752], ['chokepoint20', 'Makassar Strait', 0.3523, 119.2571],
    ['chokepoint21', 'Magellan Strait', -52.6403, -69.5948], ['chokepoint22', 'Yucatan Channel', 21.8153, -85.6473],
    ['chokepoint23', 'Windward Passage', 19.9862, -73.6975], ['chokepoint24', 'Mona Passage', 18.4487, -67.7114],
    ['chokepoint25', 'Balabac Strait', 7.4136, 117.1146], ['chokepoint26', 'Bering Strait', 65.9665, -165.5498],
    ['chokepoint27', 'Mindoro Strait', 12.4683, 120.4034], ['chokepoint28', 'Kerch Strait', 45.2668, 36.5439]
].map(([id, name, lat, lon]) => ({ id, name, lat, lon }));
export const chokepointById = new Map(chokepoints.map((item) => [item.id, item]));

// Rough outlines of the enclosed seas, drawn wide over land (which has no ports) and tight at their mouths.
// [lat, lon] pairs.
const ring = (pairs) => pairs.map(([lat, lon]) => ({ lat, lon }));
export const enclosedSeas = [
    {
        name: 'Persian Gulf', shares: { chokepoint6: 1 },
        // Closed at Hormuz, leaving out the Gulf of Oman coast (Fujairah, Khor Fakkan, Sohar).
        ring: ring([[24.0, 51.0], [23.5, 54.0], [24.2, 56.0], [26.0, 56.45], [26.4, 56.5], [27.0, 57.0], [27.6, 56.8], [30.6, 50.0], [30.5, 47.3], [28.6, 47.6], [26.0, 49.6]])
    },
    {
        name: 'Red Sea', shares: { chokepoint1: 0.5, chokepoint4: 0.5 },
        // From Suez and Aqaba down to Bab el-Mandeb, leaving out the Gulf of Aden (Djibouti, Aden) and Port Said.
        ring: ring([[29.9, 32.0], [30.0, 35.5], [27.0, 37.0], [22.0, 40.0], [16.0, 44.0], [12.7, 43.6], [12.6, 43.1], [15.0, 38.5], [20.0, 36.0], [25.0, 33.0]])
    },
    {
        name: 'Sea of Azov', shares: { chokepoint28: 1, chokepoint3: 1 },
        ring: ring([[45.4, 34.6], [47.4, 34.6], [47.4, 39.5], [45.0, 39.5], [45.0, 36.8], [45.25, 36.3]])
    },
    {
        name: 'Black Sea', shares: { chokepoint3: 1 },
        // North of the Bosporus, leaving out the Sea of Marmara.
        ring: ring([[41.15, 27.4], [46.8, 27.4], [46.8, 34.6], [45.25, 36.3], [45.0, 36.8], [45.0, 42.0], [40.9, 42.0], [40.9, 30.0], [41.15, 30.0]])
    }
];

// Which enclosed sea a port lies in, and its share of ships through each chokepoint: { sea, shares }.
export function chokepointDependence(point) {
    const sea = enclosedSeas.find((item) => pointInRing(point, item.ring));
    return sea ? { sea: sea.name, shares: { ...sea.shares } } : { sea: null, shares: {} };
}

// ---- transits ----------------------------------------------------------------------------------------------
// Two small queries per chokepoint: the average container ships a day in each year since PortWatch began, and
// the latest `recentDays` days. Together they say how far traffic now is from its usual level.
export const recentDays = 30;

export function chokepointYearlyUrl(chokepointId) {
    if (!chokepointById.has(chokepointId)) throw new Error(`"${chokepointId}" is not a PortWatch chokepoint.`);
    return portwatchQueryUrl('Daily_Chokepoints_Data', {
        where: `portid='${chokepointId}'`, groupByFieldsForStatistics: 'year', orderByFields: 'year',
        outStatistics: JSON.stringify([
            { statisticType: 'avg', onStatisticField: 'n_container', outStatisticFieldName: 'containerShips' },
            { statisticType: 'count', onStatisticField: 'n_container', outStatisticFieldName: 'days' }
        ])
    });
}

export function chokepointRecentUrl(chokepointId) {
    if (!chokepointById.has(chokepointId)) throw new Error(`"${chokepointId}" is not a PortWatch chokepoint.`);
    return portwatchQueryUrl('Daily_Chokepoints_Data', {
        where: `portid='${chokepointId}'`, outFields: 'date,n_container,n_total', orderByFields: 'date DESC',
        resultRecordCount: String(recentDays), returnGeometry: 'false'
    });
}

// { years: [{ year, containerShips, days }], recent: { from, to, containerShips }, usual: { year, containerShips },
//   drop } -- drop is how far below its busiest full year the latest days are (0 when at or above it), the cut a
// disruption scenario can start from.
export function summariseTransits(yearlyText, recentText) {
    const years = featuresOf(yearlyText, 'a chokepoint’s yearly transits')
        .map((item) => ({ year: Number(item.year), containerShips: Number(item.containerShips), days: Number(item.days) }))
        .filter((item) => Number.isFinite(item.year) && Number.isFinite(item.containerShips))
        .sort((a, b) => a.year - b.year);
    const days = featuresOf(recentText, 'a chokepoint’s latest transits')
        .map((item) => ({ date: typeof item.date === 'number' ? new Date(item.date).toISOString().slice(0, 10) : String(item.date).slice(0, 10), containerShips: Number(item.n_container) || 0 }))
        .sort((a, b) => a.date.localeCompare(b.date));
    if (!days.length || !years.length) return null;
    const recent = { from: days[0].date, to: days.at(-1).date, containerShips: days.reduce((total, day) => total + day.containerShips, 0) / days.length };
    // A full year: at least 300 days of data, so a part-year (this one, or PortWatch's first) does not set the usual level.
    const full = years.filter((item) => item.days >= 300);
    const usual = (full.length ? full : years).reduce((best, item) => (item.containerShips > best.containerShips ? item : best));
    const drop = usual.containerShips > 0 ? Math.max(0, 1 - recent.containerShips / usual.containerShips) : 0;
    return { years, recent, usual: { year: usual.year, containerShips: usual.containerShips }, drop };
}

// ---- the disruption path -----------------------------------------------------------------------------------
// A port's arrivals during a run with a disrupted chokepoint, as the path of [time from the fork, value] pairs a
// scenario fork follows (linearly between pairs; each step here is held, so every change comes as two pairs a
// second apart, and the engine, which reads parameters at step starts, sees a clean step).
//   base: the port's arrivals without the disruption: a number, or a held schedule [[seconds, value], ...]
//   cut: the share of the chokepoint's transits lost (0..1); dependence: the port's share through it (0..1)
//   start, duration, forkAt, runTime: seconds (the fork at or before the start)
//   delayedShare (0..1): the part of the cargo kept out that is delayed rather than lost: it arrives after the
//     disruption ends, at an even extra rate over catchUp seconds (what would arrive after the run is lost to it)
// Returns the path, and how much cargo (value x seconds, TEU when the values are TEU a day and divided by a day) was
// kept out and later delivered within the run, as { path, keptOut, caughtUp }; disruptionPath() alone gives the path.
export function disruptionPlan({ base, dependence, cut, start, duration, forkAt, runTime, delayedShare = 0, catchUp = 0 }) {
    if (!(forkAt <= start && start < runTime && duration > 0)) throw new Error('A disruption must start at or after the fork and before the end of the run, and last a while.');
    const schedule = Array.isArray(base) ? base : [[0, base]];
    const baseAt = (time) => {
        let value = schedule[0][1];
        for (const [sampleTime, sampleValue] of schedule) {
            if (sampleTime > time) break;
            value = sampleValue;
        }
        return value;
    };
    const end = Math.min(start + duration, runTime);
    const share = Math.min(1, Math.max(0, dependence)) * Math.min(1, Math.max(0, cut));
    const factor = 1 - share;
    // The cargo kept out, integrated over the held base: each stretch between the base's own samples.
    const inside = [...new Set([start, end, ...schedule.map(([time]) => time).filter((time) => time > start && time < end)])].sort((a, b) => a - b);
    let keptOut = 0;
    for (let index = 0; index + 1 < inside.length; index += 1) keptOut += baseAt(inside[index]) * share * (inside[index + 1] - inside[index]);
    const delayed = Math.min(1, Math.max(0, delayedShare)) * keptOut;
    const catchUpEnd = catchUp > 0 ? Math.min(end + catchUp, runTime) : end;
    const catchUpRate = catchUp > 0 && delayed > 0 ? delayed / catchUp : 0;
    const valueAt = (time) => baseAt(time) * (time >= start && time < end ? factor : 1) + (time >= end && time < catchUpEnd ? catchUpRate : 0);
    const breaks = [...new Set([forkAt, start, end, catchUpEnd, runTime, ...schedule.map(([time]) => time).filter((time) => time > forkAt && time < runTime)])].sort((a, b) => a - b);
    const path = [];
    for (let index = 0; index + 1 < breaks.length; index += 1) {
        const from = breaks[index];
        const to = breaks[index + 1];
        const value = valueAt(from);
        if (path.length && path.at(-1)[1] === value) {
            path[path.length - 1] = [to - forkAt - Math.min(1, (to - from) / 2), value];
            continue;
        }
        path.push([from - forkAt, value], [to - forkAt - Math.min(1, (to - from) / 2), value]);
    }
    return { path, keptOut, caughtUp: catchUpRate * (catchUpEnd - end) };
}

export function disruptionPath(options) {
    return disruptionPlan(options).path;
}
