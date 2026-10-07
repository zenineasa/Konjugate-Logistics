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
// Day 0 of a run is a Monday, at midnight.

export const calendarKinds = {
    open: { label: 'Open', verb: 'is open', roles: ['store', 'darkStore'], detail: 'When shoppers can buy. Closed, it sells nothing; a week\'s sales are what they would be, made in the hours it is open.' },
    receive: { label: 'Receives', verb: 'receives', roles: ['warehouse', 'store', 'darkStore'], detail: 'When it takes deliveries. Outside these hours, loaded vehicles wait at its door.' },
    dispatch: { label: 'Dispatches', verb: 'dispatches', roles: ['supplier', 'warehouse'], detail: 'When it loads vehicles. Outside these hours, nothing leaves it.' }
};
export const kindsFor = (role) => Object.keys(calendarKinds).filter((kind) => calendarKinds[kind].roles.includes(role));
export const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const everyDay = () => Array(7).fill(true);

// A site's calendar of a kind, whole: { from, to, days }, or null when it has none (round the clock, every day).
export function calendarOf(pin, kind) {
    const given = pin?.hours?.[kind];
    if (!given) return null;
    const days = Array.isArray(given.days) && given.days.length === 7 ? given.days.map(Boolean) : everyDay();
    const from = Number.isFinite(Number(given.from)) && given.from !== null && given.from !== '' ? Number(given.from) : 0;
    const to = Number.isFinite(Number(given.to)) && given.to !== null && given.to !== '' ? Number(given.to) : 24;
    if (from <= 0 && to >= 24 && days.every(Boolean)) return null;
    return { from, to, days };
}

// One figure of a calendar set by the user ('from' or 'to', an hour of the day; empty: midnight), or a day ticked or
// not. A calendar back to round the clock, every day, is no calendar.
export function setHours(pin, kind, change) {
    if (!calendarKinds[kind]?.roles.includes(pin.role)) return pin;
    const current = calendarOf(pin, kind) ?? { from: 0, to: 24, days: everyDay() };
    const hour = (text, empty) => (text === '' || text === null || text === undefined || !Number.isFinite(Number(text)) ? empty : Math.min(24, Math.max(0, Number(text))));
    const next = {
        from: 'from' in change ? hour(change.from, 0) : current.from,
        to: 'to' in change ? hour(change.to, 24) : current.to,
        days: 'day' in change ? current.days.map((on, index) => (index === change.day ? Boolean(change.on) : on)) : current.days
    };
    pin.hours = { ...(pin.hours ?? {}), [kind]: next };
    if (!calendarOf(pin, kind)) delete pin.hours[kind];
    if (!Object.keys(pin.hours).length) delete pin.hours;
    return pin;
}

// What is wrong with a calendar, if anything.
export function calendarProblem(calendar, site, kind) {
    if (!calendar) return null;
    const what = calendarKinds[kind].verb;
    if (!(calendar.to > calendar.from)) return `${site} ${what} from ${clock(calendar.from)} to ${clock(calendar.to)}: the second hour must be later than the first (hours past midnight are not kept yet).`;
    if (!calendar.days.some(Boolean)) return `${site} ${what} on no day of the week: tick a day, or it never does.`;
    return null;
}

export const clock = (hours) => { const minutes = Math.round(hours * 60); return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`; };
// The hours a week a calendar covers (168 for none).
export const weeklyHours = (calendar) => (calendar ? (calendar.to - calendar.from) * calendar.days.filter(Boolean).length : 168);
// In words: "8:00 to 22:00, Monday to Saturday".
export function describeCalendar(calendar) {
    if (!calendar) return 'round the clock, every day';
    const on = calendar.days.map((day, index) => (day ? index : -1)).filter((index) => index >= 0);
    const run = on.length > 1 && on.at(-1) - on[0] === on.length - 1;
    const days = on.length === 7 ? 'every day' : run ? `${dayNames[on[0]]} to ${dayNames[on.at(-1)]}` : on.map((index) => dayNames[index]).join(', ');
    return `${calendar.from <= 0 && calendar.to >= 24 ? 'all day' : `${clock(calendar.from)} to ${clock(calendar.to)}`}, ${days}`;
}

// A calendar as a held schedule over `days` days: [[seconds, value], ...], the value `on` while it works and 0 while it
// does not, each change one sample (the value holds until the next). `average: true` makes a week's mean 1: a store's
// demand comes in the hours it is open. Null for no calendar.
export function calendarSamples(calendar, days, { average = false } = {}) {
    if (!calendar) return null;
    const on = average ? 168 / weeklyHours(calendar) : 1;
    const samples = [];
    const put = (hours, value) => {
        const seconds = Math.round(hours * 3600);
        // One sample for each change: a second value at the same moment takes the first's place, and a value that is
        // the one already held is no change (a day that ends at midnight and the next that starts there run on).
        if (samples.length && samples.at(-1)[0] === seconds) samples.pop();
        if (!samples.length || samples.at(-1)[1] !== value) samples.push([seconds, value]);
    };
    put(0, 0);
    for (let dayIndex = 0; dayIndex < Math.ceil(days); dayIndex += 1) {
        if (!calendar.days[dayIndex % 7]) continue;
        put(dayIndex * 24 + calendar.from, on);
        put(dayIndex * 24 + calendar.to, 0);
    }
    return samples;
}

// What a calendar asks of the vehicles on a lane: `peak`, how many times the day's flow is loaded while the origin
// dispatches (24 hours of orders in the hours it works), and `waitDays`, how long a loaded vehicle waits on average at
// the door of a destination that receives only part of the day.
export function laneGates(dispatch, receive) {
    const share = (calendar) => weeklyHours(calendar) / 168;
    const closed = receive ? 1 - share(receive) : 0;
    return { peak: dispatch ? 1 / share(dispatch) : 1, waitDays: closed * closed / 2 * (receive ? 7 / receive.days.filter(Boolean).length : 1) };
}

// The calendars of a pin as the model builder reads them: { open, receive, dispatch }, each whole or left out.
export function hoursForModel(pin) {
    const hours = Object.fromEntries(kindsFor(pin.role).map((kind) => [kind, calendarOf(pin, kind)]).filter(([, calendar]) => calendar));
    return Object.keys(hours).length ? { hours } : {};
}
