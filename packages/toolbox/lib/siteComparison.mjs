/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Candidate sites compared: the network as it is, and the same network with each candidate open, each run for the
// same days in normal weeks and, when one is chosen, under the same disruption. From what each run cost, this works
// out what a candidate changes a month and whether it earns its keep, in the user's own figures for fixed costs and
// the cost to open (neither is in the model: a site's rent does not depend on what it handles).
//
// A comparison of designs over the days run, not a forecast: the monthly figures are the run's, scaled to 30 days.

const month = 30;

// `rows`: one per network compared, the first the network as it is. Each: { name, candidate (its name, or null), days,
// running (transport, fleet and holding cost over the days, in normal weeks), fixedMonthly (the fixed costs of its open
// sites), openingCost (the candidate's, or null), lostNormal (value of sales lost in normal weeks), stress (null, or
// { lostValue, storesOut, longest, running } under the disruption), error (why it could not be run, or null) }.
// Returns the rows with their monthly cost and, for each candidate, what it changes against the first and a verdict.
export function compareSites(rows) {
    const monthly = (row) => row.running / row.days * month + (row.fixedMonthly ?? 0);
    const [asIs] = rows;
    return rows.map((row, index) => {
        if (row.error) return { ...row, verdict: `Could not be compared: ${row.error}` };
        const cost = monthly(row);
        if (!index) return { ...row, monthlyCost: cost, verdict: 'The network as it is.' };
        // What it costs more a month to run (less, when negative), and what one disruption costs less with it.
        const extra = cost - monthly(asIs);
        const saved = row.stress && asIs.stress ? asIs.stress.lostValue - row.stress.lostValue : null;
        return { ...row, monthlyCost: cost, extraMonthly: extra, savedPerDisruption: saved, verdict: verdictOf({ extra, saved, opening: row.openingCost ?? null }) };
    });
}

const round = (value) => Number(value).toLocaleString('en', { maximumFractionDigits: value < 10 ? 1 : 0 });
// Under this, a difference is no difference: a thousandth of a cost unit a month.
const noise = 1e-3;

function verdictOf({ extra, saved, opening }) {
    const dearer = extra > noise;
    const cheaper = extra < -noise;
    const helps = saved !== null && saved > noise;
    const hurts = saved !== null && saved < -noise;
    const openingBack = (per, what) => (opening > 0 ? ` Its cost to open, ${round(opening)}, is back after ${round(opening / per)} ${what}.` : ' Give its cost to open to see how long that takes to earn back.');
    if (cheaper) {
        return `Cheaper to run by ${round(-extra)} a month.${openingBack(-extra, 'months')}${helps ? ` And one such disruption costs ${round(saved)} less with it.` : hurts ? ` But one such disruption costs ${round(-saved)} more with it.` : ''}`;
    }
    if (helps) {
        const running = dearer ? `Dearer to run by ${round(extra)} a month, and one such disruption costs ${round(saved)} less with it: it pays for its running if one comes more often than once every ${round(saved / extra)} months.` : `As dear to run, and one such disruption costs ${round(saved)} less with it.`;
        return `${running}${openingBack(saved, 'such disruptions')}`;
    }
    if (dearer) return `Dearer to run by ${round(extra)} a month${saved === null ? ' in normal weeks: choose a disruption to see what it saves then' : hurts ? `, and one such disruption costs ${round(-saved)} more with it` : ', and it saves nothing in this disruption'}.`;
    return saved === null ? 'As dear to run in normal weeks: choose a disruption to see what it saves then.' : hurts ? `As dear to run, but one such disruption costs ${round(-saved)} more with it.` : 'It changes neither the running cost nor what this disruption costs.';
}
