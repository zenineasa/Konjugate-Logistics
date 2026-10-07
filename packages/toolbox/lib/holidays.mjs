/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The network's calendar of holidays and peaks: dated events, each with what it does to demand (by category, or to
// all of it) while it lasts and in the days before it (people stock up) and after it (they have), and whether the
// suppliers dispatch while it lasts. The dates are days of the run (day 0 is a Monday), and every size is the user's
// figure: nothing published says how much a festival moves a chain's sales, so nothing is assumed.
//
// In the model an event is part of the calendar, known in advance, so it is in the baseline as well as in every
// scenario: each category's demand follows a held schedule (1 on an ordinary day), and a supplier that does not
// dispatch over a holiday loads nothing on those days.

let counter = 0;
export function createHoliday(others = []) {
    const used = new Set(others.map((event) => event.name));
    let name = 'Holiday 1';
    for (let index = 1; used.has(name); index += 1) name = `Holiday ${index + 1}`;
    return { id: `holiday:${Date.now().toString(36)}${(counter++).toString(36)}`, name, day: 14, days: 1, demand: {}, beforeDays: 0, beforePercent: 0, afterDays: 0, afterPercent: 0, suppliersClosed: false };
}

const whole = (value) => Number.isInteger(Number(value));
// What is wrong with an event, if anything.
export function holidayProblem(event, runDays = Infinity) {
    const name = String(event?.name ?? '').trim();
    if (!name) return 'A holiday or peak needs a name.';
    if (!(whole(event.day) && event.day >= 0)) return `${name}: it starts on a day of the run, 0 or later.`;
    if (!(whole(event.days) && event.days >= 1)) return `${name}: it lasts a day or more.`;
    if (event.day >= runDays) return `${name}: it starts on day ${event.day}, after the run's ${runDays} days.`;
    for (const [what, days, percent] of [['before', event.beforeDays, event.beforePercent], ['after', event.afterDays, event.afterPercent]]) {
        if (!(whole(days ?? 0) && (days ?? 0) >= 0)) return `${name}: the days ${what} it are a whole number, 0 or more.`;
        if (!((percent ?? 0) >= -100)) return `${name}: demand in the days ${what} it cannot fall by more than 100%.`;
    }
    if ((event.beforeDays ?? 0) > event.day) return `${name}: its ${event.beforeDays} days of stocking up would start before the run does. Start it later, or stock up for fewer days.`;
    for (const percent of Object.values(event.demand ?? {})) if (!(Number(percent) >= -100)) return `${name}: demand cannot fall by more than 100%.`;
    return null;
}

// The change in a category's demand while an event lasts, in percent: the category's own, else the one for all goods.
export const demandChange = (event, categoryId) => Number(event.demand?.[categoryId] ?? event.demand?.all ?? 0) || 0;

// A category's demand over `days` days as a held schedule: [[seconds, factor], ...], 1 on an ordinary day, each change
// one sample. Events that overlap multiply. Null when no event touches the category.
export function seasonSamples(events, categoryId, days) {
    const factor = Array(Math.ceil(days)).fill(1);
    const scale = (from, length, percent) => {
        for (let day = Math.max(0, from); day < Math.min(factor.length, from + length); day += 1) factor[day] *= Math.max(0, 1 + percent / 100);
    };
    for (const event of events ?? []) {
        scale(event.day - (event.beforeDays ?? 0), event.beforeDays ?? 0, event.beforePercent ?? 0);
        scale(event.day, event.days, demandChange(event, categoryId));
        scale(event.day + event.days, event.afterDays ?? 0, event.afterPercent ?? 0);
    }
    if (factor.every((value) => Math.abs(value - 1) < 1e-12)) return null;
    const samples = [];
    factor.forEach((value, day) => { if (!samples.length || Math.abs(samples.at(-1)[1] - value) > 1e-12) samples.push([day * 86400, Number(value.toFixed(9))]); });
    return samples;
}

// The days the suppliers do not dispatch: [{ from, to }] in seconds, merged where they touch.
export function supplierClosures(events, days) {
    const spans = (events ?? []).filter((event) => event.suppliersClosed).map((event) => ({ from: event.day * 86400, to: Math.min(days, event.day + event.days) * 86400 })).filter((span) => span.to > span.from).sort((a, b) => a.from - b.from);
    const merged = [];
    for (const span of spans) {
        if (merged.length && span.from <= merged.at(-1).to) merged.at(-1).to = Math.max(merged.at(-1).to, span.to);
        else merged.push({ ...span });
    }
    return merged;
}

// A held schedule with nothing in `spans`: what it would be, and 0 inside them. `samples` null is 1 throughout.
export function closeDuring(samples, spans) {
    const base = samples ?? [[0, 1]];
    if (!spans.length) return base;
    const valueAt = (time) => { let value = base[0][1]; for (const [at, held] of base) { if (at > time) break; value = held; } return value; };
    const times = [...new Set([...base.map(([time]) => time), ...spans.flatMap((span) => [span.from, span.to])])].sort((a, b) => a - b);
    const closed = (time) => spans.some((span) => time >= span.from && time < span.to);
    const out = [];
    for (const time of times) {
        const value = closed(time) ? 0 : valueAt(time);
        if (!out.length || out.at(-1)[1] !== value) out.push([time, value]);
    }
    return out;
}

// In words, for the provenance: "Eid (day 40 for 3 days): demand +60%; the 5 days before +30%; suppliers do not dispatch".
export function describeHoliday(event, categoryId = null, categoryName = null) {
    const signed = (percent) => `${percent > 0 ? '+' : ''}${Number(percent)}%`;
    const during = demandChange(event, categoryId);
    const parts = [
        ...(during ? [`${categoryName ? `${categoryName} ` : ''}demand ${signed(during)}`] : []),
        ...(event.beforeDays > 0 && event.beforePercent ? [`the ${event.beforeDays} days before ${signed(event.beforePercent)}`] : []),
        ...(event.afterDays > 0 && event.afterPercent ? [`the ${event.afterDays} days after ${signed(event.afterPercent)}`] : []),
        ...(event.suppliersClosed ? ['suppliers do not dispatch'] : [])
    ];
    return `${event.name} (day ${event.day} for ${event.days} day${event.days === 1 ? '' : 's'})${parts.length ? `: ${parts.join('; ')}` : ''}`;
}

// The calendar as the model builder reads it: whole numbers and percentages, the events with something wrong left to
// networkProblems to say.
export function holidaysForModel(events) {
    return (events ?? []).filter((event) => !holidayProblem(event)).map((event) => ({
        name: String(event.name).trim(), day: Number(event.day), days: Number(event.days),
        demand: Object.fromEntries(Object.entries(event.demand ?? {}).filter(([, percent]) => Number(percent)).map(([id, percent]) => [id, Number(percent)])),
        beforeDays: Number(event.beforeDays) || 0, beforePercent: Number(event.beforePercent) || 0, afterDays: Number(event.afterDays) || 0, afterPercent: Number(event.afterPercent) || 0,
        suppliersClosed: Boolean(event.suppliersClosed)
    }));
}
