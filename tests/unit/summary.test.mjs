/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A run's summary in words: a run that is its baseline's is told apart from one that lost nothing, a store that ran
// short is counted though it never ran out, and the sentence on the stores says which.

import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanCurrency, differs, money, moneyIn, sameSeries, shortDays, storesParts, unchangedText } from '../../packages/toolbox/lib/summary.mjs';

const day = 86400;

test('a run that is its baseline\'s to the last digit is told apart from one that differs anywhere', () => {
    const run = (made) => ({ Dairy: { made: [[0, 0], [day, made]] }, Shop: { stock: [[0, 5], [day, 5]] } });
    assert.equal(sameSeries(run(20), run(20)), true);
    assert.equal(sameSeries(run(20), run(20.000001)), false, 'the smallest difference is a difference');
    assert.equal(sameSeries(run(20), { ...run(20), Depot: { stock: [[0, 1]] } }), false);
    assert.equal(sameSeries(run(20), { Dairy: { made: [[0, 0]] }, Shop: run(20).Shop }), false);
    // Nothing to compare is not "the same".
    assert.equal(sameSeries({}, {}), false);
    assert.match(unchangedText, /Do not read this as "nothing was lost"/);
});

test('a store is short on the days its lost sales grow by more than a fiftieth of what is asked of it', () => {
    // 10 pallets a day asked; from day 2 to day 5 it loses 3 a day, then nothing; before the start does not count.
    const lost = [0, 0, 0, 3, 6, 9, 9, 9].map((value, index) => [index * day, value]);
    assert.equal(shortDays(lost, 10), 3);
    assert.equal(shortDays(lost, 10, 4 * day), 1);
    // A trickle under the share is the baseline's own, not a shortage.
    assert.equal(shortDays([[0, 0], [day, 0.1], [2 * day, 0.2]], 10), 0);
    assert.equal(shortDays(undefined, 10), 0);
});

test('the sentence on the stores: which ran out, which ran short when none did, and what was lost of what', () => {
    const pair = (scenario, baseline = 0) => ({ baseline, scenario });
    const store = (name, out, short) => ({ name, emptyDays: pair(out), shortDays: pair(short) });
    const byCategory = (...lost) => ['Ambient', 'Chilled', 'Frozen'].map((name, index) => ({ name, lost: pair(lost[index]) }));
    const say = (stores, lost, categories) => storesParts({ stores, totals: { lost: pair(lost), lostValue: pair(lost * 1000) }, byCategory: categories, unit: 'pallets' }).join(', ');
    // None empty and sales lost: the stores that ran short are named, so the two do not contradict each other.
    assert.equal(say([store('A', 0, 6.5), store('B', 0, 4), store('C', 0, 0)], 36, byCategory(0, 36, 0)),
        'No store ran out, but 2 stores ran short of Chilled, A longest at 6.5 days, losing 36 pallets of sales, worth 36,000');
    assert.equal(say([store('A', 0, 6.5), store('C', 0, 0)], 4, byCategory(0, 4, 0)), 'No store ran out, but A ran short of Chilled for 6.5 days, losing 4.0 pallets of sales, worth 4,000');
    // One that ran out is said as before, and nothing lost as before.
    assert.equal(say([{ ...store('A', 5, 6), categories: byCategory(1, 1, 1).map((each) => ({ ...each, emptyDays: pair(5) })) }], 30, byCategory(10, 10, 10)),
        'A ran out of Ambient, Chilled and Frozen for 5.0 days, losing 30 pallets of sales, worth 30,000');
    assert.equal(say([store('A', 0, 0)], 0, byCategory(0, 0, 0)), 'No store ran out, and no sales were lost');
    // Sales lost with no store short by the measure (spread thin over many): said as lost, of what.
    assert.equal(say([store('A', 0, 0)], 2, byCategory(0, 2, 0)), 'No store ran out, but 2.0 pallets of Chilled sales were lost, worth 2,000');
});

test('two runs\' figures differ beyond noise: an amount by half a percent, a share by what shows at a decimal of a point', () => {
    // 99.3% of demand met against 98.9%: 0.4 points, under half a percent of either, and a difference all the same.
    assert.equal(differs(0.989, 0.993, 0.0005, 0), true);
    assert.equal(differs(0.9930, 0.9933, 0.0005, 0), false);
    // Amounts: 1,000,000 against 1,004,000 is the same run to a manager; against 1,010,000 it is not.
    assert.equal(differs(1004000, 1000000, 0.5), false);
    assert.equal(differs(1010000, 1000000, 0.5), true);
    assert.equal(differs(0.3, 0, 0.5), false);
});

test('money is written with what the user says it is in, and a sum priced at an assumed value of a pallet says so', () => {
    assert.deepEqual([money(35781.4), money(35781.4, 'INR'), money(0, '₹')], ['35,781', '35,781 INR', '0 ₹']);
    assert.deepEqual([cleanCurrency('  INR '), cleanCurrency(undefined), cleanCurrency('a currency with a long name')], ['INR', '', 'a currency w']);
    assert.equal(moneyIn('INR'), 'INR');
    assert.match(moneyIn(''), /^no currency/);
    const pair = (scenario, baseline = 0) => ({ baseline, scenario });
    const result = { stores: [{ name: 'A', emptyDays: pair(5), shortDays: pair(6) }], totals: { lost: pair(30), lostValue: pair(30000) }, byCategory: null, unit: 'pallets' };
    assert.equal(storesParts(result).join(', '), 'A ran out for 5.0 days, losing 30 pallets of sales, worth 30,000');
    assert.equal(storesParts({ ...result, currency: 'INR', assumedValue: true }).join(', '), 'A ran out for 5.0 days, losing 30 pallets of sales, worth 30,000 INR at an assumed value of a pallet');
});
