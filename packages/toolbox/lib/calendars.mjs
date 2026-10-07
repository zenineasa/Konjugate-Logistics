/* Copyright © 2026 Zenin Easa Panthakkalakath */

// When a site works: the hours a store is open to shoppers, the hours a store or a warehouse receives deliveries, and
// the hours a warehouse or a supplier dispatches. Each is a calendar: from an hour to an hour, on some days of the
// week. A site with no calendar of a kind works round the clock, as every site did before.
//
// In the model a calendar is a pattern over time on one parameter (a held schedule, stored with the model), the same
// in the baseline and in every scenario:
//   open      a store's demand: nothing while it is closed and more while it is open, so a week's sales are what
//             they would be (its shoppers come when it is open, they do not go away)
//   receive   the lanes into the site: loaded vehicles wait at its door while it does not receive, and unload when it does
//   dispatch  the lanes out of the site: nothing is loaded while it does not dispatch
// Each pattern is 0 outside the hours and, within them, as much above 1 as the hours are short of the whole week: a
// week's sales are made in the hours a store is open, a day's orders are loaded in the hours a site dispatches, and
// what waited at a door is unloaded promptly when it opens.
// Day 0 of a run is a Monday, at midnight. Hours may run past midnight (22 to 6): the night belongs to the day it
// starts on. A vehicle type keeps hours the same way (small ones deliver by day; a large one with two drivers who take
// turns runs round the clock): a lane loads only while its origin dispatches and one of its vehicle types runs.

export const calendarKinds = {
    open: { label: 'Open', verb: 'is open', roles: ['store', 'darkStore'], detail: 'When shoppers can buy. Closed, it sells nothing; a week\'s sales are what they would be, made in the hours it is open.' },
    receive: { label: 'Receives', verb: 'receives', roles: ['warehouse', 'store', 'darkStore'], detail: 'When it takes deliveries. Outside these hours, loaded vehicles wait at its door.' },
    dispatch: { label: 'Dispatches', verb: 'dispatches', roles: ['supplier', 'warehouse'], detail: 'When it loads vehicles. Outside these hours, nothing leaves it.' }
};
export const kindsFor = (role) => Object.keys(calendarKinds).filter((kind) => calendarKinds[kind].roles.includes(role));
export const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const everyDay = () => Array(7).fill(true);

// A calendar made whole: { from, to, days }, or null for none (round the clock, every day).
export function wholeCalendar(given) {
    if (!given) return null;
    const days = Array.isArray(given.days) && given.days.length === 7 ? given.days.map(Boolean) : everyDay();
    const from = Number.isFinite(Number(given.from)) && given.from !== null && given.from !== '' ? Number(given.from) : 0;
    const to = Number.isFinite(Number(given.to)) && given.to !== null && given.to !== '' ? Number(given.to) : 24;
    if (from <= 0 && to >= 24 && days.every(Boolean)) return null;
    return { from, to, days };
}
// A site's calendar of a kind.
export const calendarOf = (pin, kind) => wholeCalendar(pin?.hours?.[kind]);

// A calendar with one figure set by the user ('from' or 'to', an hour of the day; empty: midnight), or a day ticked or
// not. Back to round the clock, every day, it is no calendar: null.
export function changeCalendar(current, change) {
    const base = wholeCalendar(current) ?? { from: 0, to: 24, days: everyDay() };
    const hour = (text, empty) => (text === '' || text === null || text === undefined || !Number.isFinite(Number(text)) ? empty : Math.min(24, Math.max(0, Number(text))));
    return wholeCalendar({
        from: 'from' in change ? hour(change.from, 0) : base.from,
        to: 'to' in change ? hour(change.to, 24) : base.to,
        days: 'day' in change ? base.days.map((on, index) => (index === change.day ? Boolean(change.on) : on)) : base.days
    }) ?? null;
}
export function setHours(pin, kind, change) {
    if (!calendarKinds[kind]?.roles.includes(pin.role)) return pin;
    const next = changeCalendar(pin.hours?.[kind], change);
    pin.hours = { ...(pin.hours ?? {}) };
    if (next) pin.hours[kind] = next; else delete pin.hours[kind];
    if (!Object.keys(pin.hours).length) delete pin.hours;
    return pin;
}

// What is wrong with a calendar, if anything. `what` says whose and of what: "Shop is open", "A mini-van runs".
export function calendarProblem(calendar, site, kind) {
    if (!calendar) return null;
    const what = `${site} ${calendarKinds[kind]?.verb ?? kind}`;
    if (calendar.to === calendar.from) return `${what} from ${clock(calendar.from)} to ${clock(calendar.to)}: give two different hours (22 to 6 runs through the night).`;
    if (!calendar.days.some(Boolean)) return `${what} on no day of the week: tick a day, or it never does.`;
    return null;
}

export const clock = (hours) => { const minutes = Math.round(hours * 60); return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`; };
// Whether a calendar works at an hour of a day of the run (day 0 a Monday). Past midnight, the night belongs to the
// day it starts on: 22 to 6 on a Monday runs into Tuesday morning.
export function worksAt(calendar, day, hour) {
    if (!calendar) return true;
    const on = (index) => calendar.days[((index % 7) + 7) % 7];
    if (calendar.to > calendar.from) return on(day) && hour >= calendar.from && hour < calendar.to;
    return (on(day) && hour >= calendar.from) || (on(day - 1) && hour < calendar.to);
}
// The hours a week a calendar covers (168 for none).
export const weeklyHours = (calendar) => (calendar ? (calendar.to > calendar.from ? calendar.to - calendar.from : 24 - calendar.from + calendar.to) * calendar.days.filter(Boolean).length : 168);
// In words: "8:00 to 22:00, Monday to Saturday"; "22:00 to 6:00 the next morning, every day".
export function describeCalendar(calendar) {
    if (!calendar) return 'round the clock, every day';
    const on = calendar.days.map((day, index) => (day ? index : -1)).filter((index) => index >= 0);
    const run = on.length > 1 && on.at(-1) - on[0] === on.length - 1;
    const days = on.length === 7 ? 'every day' : run ? `${dayNames[on[0]]} to ${dayNames[on.at(-1)]}` : on.map((index) => dayNames[index]).join(', ');
    const hours = calendar.from <= 0 && calendar.to >= 24 ? 'all day' : `${clock(calendar.from)} to ${clock(calendar.to)}${calendar.to < calendar.from ? ' the next morning' : ''}`;
    return `${hours}, ${days}`;
}

// A pattern of work: when every calendar of `all` works and, when `any` is given, at least one of those does (a lane
// loads while its origin dispatches and one of its vehicle types runs). Calendars that are null work always.
const quarter = 0.25;
const patternWorks = ({ all = [], any = null }, day, hour) => all.every((calendar) => worksAt(calendar, day, hour)) && (!any || any.some((calendar) => worksAt(calendar, day, hour)));
// The share of a week a pattern works, to the quarter hour.
export function openShare(pattern) {
    let open = 0;
    for (let slot = 0; slot < 7 * 24 / quarter; slot += 1) if (patternWorks(pattern, Math.floor(slot * quarter / 24), (slot * quarter) % 24)) open += 1;
    return open / (7 * 24 / quarter);
}
// A pattern as a held schedule over `days` days: [[seconds, value], ...], the value `on` while it works and 0 while it
// does not, each change one sample (the value holds until the next), to the quarter hour. `average: true` makes a
// week's mean 1: a store's week of demand in the hours it is open, a day's orders loaded in the hours a site dispatches.
export function patternSamples(pattern, days, { average = false } = {}) {
    const share = openShare(pattern);
    const on = average ? (share > 0 ? Number((1 / share).toFixed(9)) : 0) : 1;
    const samples = [];
    for (let slot = 0; slot < Math.ceil(days) * 24 / quarter; slot += 1) {
        const value = patternWorks(pattern, Math.floor(slot * quarter / 24), (slot * quarter) % 24) ? on : 0;
        if (!samples.length || samples.at(-1)[1] !== value) samples.push([Math.round(slot * quarter * 3600), value]);
    }
    return samples;
}
// One calendar's; null for no calendar.
export const calendarSamples = (calendar, days, options = {}) => (calendar ? patternSamples({ all: [calendar] }, days, options) : null);

// What hours ask of the vehicles on a lane: `peak`, how many times the day's flow is loaded while it can be (24 hours
// of orders in the hours its origin dispatches and its vehicles run), and `waitDays`, how long a loaded vehicle waits on
// average at the door of a destination that receives only part of the day. `dispatch` is a pattern or a calendar.
export function laneGates(dispatch, receive) {
    const pattern = dispatch && (dispatch.all || dispatch.any) ? dispatch : dispatch ? { all: [dispatch] } : null;
    const share = pattern ? openShare(pattern) : 1;
    const closed = receive ? 1 - weeklyHours(receive) / 168 : 0;
    return { peak: share > 0 ? 1 / share : Infinity, waitDays: closed * closed / 2 * (receive ? 7 / receive.days.filter(Boolean).length : 1) };
}

// The calendars of a pin as the model builder reads them: { open, receive, dispatch }, each whole or left out.
export function hoursForModel(pin) {
    const hours = Object.fromEntries(kindsFor(pin.role).map((kind) => [kind, calendarOf(pin, kind)]).filter(([, calendar]) => calendar));
    return Object.keys(hours).length ? { hours } : {};
}
