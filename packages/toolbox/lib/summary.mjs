/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a scenario's run comes to, in words: whether it differs from its baseline at all, how long a store ran short,
// and the sentence on the stores that heads a result.

import { listed, lostSalesOf } from './categories.mjs';

const day = 86400;
const number = (value, digits = 0) => Number(value).toLocaleString('en', { maximumFractionDigits: digits, minimumFractionDigits: digits });
// Days out or short under this are the baseline's own noise.
export const outNoise = 0.04;

// Whether two runs' series ({ [node]: { [signal]: [[seconds, value], ...] } }) are the same to the last digit. A
// scenario that changes anything that moves differs from its baseline somewhere; one that is the same in every figure
// either touched nothing that moves or was never applied, and is not to be read as "nothing was lost".
export function sameSeries(first, second) {
    const nodes = new Set([...Object.keys(first ?? {}), ...Object.keys(second ?? {})]);
    if (!nodes.size) return false;
    for (const node of nodes) {
        const signals = new Set([...Object.keys(first?.[node] ?? {}), ...Object.keys(second?.[node] ?? {})]);
        for (const signal of signals) {
            const [a, b] = [first?.[node]?.[signal] ?? [], second?.[node]?.[signal] ?? []];
            if (a.length !== b.length) return false;
            for (let index = 0; index < a.length; index += 1) if (a[index][0] !== b[index][0] || a[index][1] !== b[index][1]) return false;
        }
    }
    return true;
}

// How many days, from `start` (seconds), a store sold less than was asked of it for want of stock: the days on which
// its sales lost grew by more than `share` of its demand. `lost` is its running total of sales lost, `demand` what is
// asked of it a day. A store runs short before it runs out, and loses sales all the while.
export function shortDays(lost, demand, start = 0, share = 0.02) {
    const points = (lost ?? []).filter((point) => point[0] >= start - 1);
    let days = 0;
    for (let index = 1; index < points.length; index += 1) {
        const span = (points[index][0] - points[index - 1][0]) / day;
        if (span > 0 && (points[index][1] - points[index - 1][1]) / span > share * demand) days += span;
    }
    return days;
}

// The sentence's parts on the stores: which ran out and for how long or, when none did, which ran short, and the sales
// lost with what they were worth. `stores` are a result's (emptyDays, shortDays and categories, each a baseline and a
// scenario), `totals` its lost and lostValue, `byCategory` its categories, `unit` the goods' ("pallets").
export function storesParts({ stores, totals, byCategory, unit }) {
    const parts = [];
    const beyond = (pair) => (pair ? pair.scenario - pair.baseline : 0);
    // Of what, when it sells several categories: those it ran out of.
    const ofWhat = (item) => listed((item.categories ?? []).filter((each) => beyond(each.emptyDays) > outNoise).map((each) => each.name));
    const out = stores.map((item) => ({ name: item.name, days: beyond(item.emptyDays), of: ofWhat(item) })).filter((item) => item.days > outNoise).sort((a, b) => b.days - a.days);
    const short = stores.map((item) => ({ name: item.name, days: beyond(item.shortDays) })).filter((item) => item.days > outNoise).sort((a, b) => b.days - a.days);
    const lost = beyond(totals.lost);
    const value = beyond(totals.lostValue);
    // Of what, when the sales lost were of some categories and not of all.
    const lostOf = lostSalesOf(byCategory);
    const amount = (of) => `${number(lost, lost < 10 ? 1 : 0)} ${unit} of ${of ? `${of} ` : ''}sales`;
    const worth = value > 0.5 ? `, worth ${number(value)}` : '';
    if (out.length === 1) parts.push(`${out[0].name} ran out${out[0].of ? ` of ${out[0].of}` : ''} for ${number(out[0].days, 1)} days`);
    else if (out.length) parts.push(`${out.length} stores ran out, ${out[0].name} longest at ${number(out[0].days, 1)} days${out[0].of ? ` (of ${out[0].of})` : ''}`);
    else if (lost > 0.05 && short.length) {
        // None was empty, and yet sales were lost: the stores that ran short, which a manager would otherwise read as a contradiction.
        const of = lostOf ? ` of ${lostOf}` : '';
        parts.push(`No store ran out, but ${short.length === 1 ? `${short[0].name} ran short${of} for ${number(short[0].days, 1)} days` : `${short.length} stores ran short${of}, ${short[0].name} longest at ${number(short[0].days, 1)} days`}`);
        parts.push(`losing ${amount('')}${worth}`);
        return parts;
    } else parts.push('No store ran out');
    if (lost > 0.05) parts.push(out.length ? `losing ${amount(lostOf)}${worth}` : `but ${amount(lostOf)} were lost${worth}`);
    else if (totals.lost) parts.push(out.length ? 'but shoppers waited and no sales were lost' : 'and no sales were lost');
    return parts;
}

// What heads a result whose run is its baseline's to the last digit.
export const unchangedText = 'This run is the baseline\'s in every figure, to the last digit: the scenario changed nothing that moves, or its changes were never applied (Konjugate up to 1.1.10 ignores a scenario\'s changes on some models; update it). Do not read this as "nothing was lost".';

// Whether a figure of one run differs from another's by more than noise: by more than `noise`, and by more than
// `relative` of the other's (half a percent, for amounts). A share is compared by `noise` alone: 0.4 points of demand
// met is a difference, though it is under half a percent of 99%.
export const differs = (now, then, noise, relative = 0.005) => Math.abs(now - then) > Math.max(noise, relative * Math.abs(then));
