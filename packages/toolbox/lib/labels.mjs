/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Which place names the map writes at a zoom: the larger places first (cities, then towns, then suburbs and quarters,
// and within each the more populous), each kind only once the map is zoomed in far enough for it, and a name left out
// where it would overlap one already written. Zoomed out over a city of hundreds of suburbs, the map names the city
// and its towns; zoomed in, its suburbs, then its quarters.

export const placeRank = { city: 0, town: 1, suburb: 2, quarter: 3 };
// The most kilometres a screen pixel may cover for a kind to be named: a town once the map is about 300 km across (at
// a thousand pixels), a suburb at about 60 km, a quarter at about 20 km. A city is always named.
export const kilometresPerPixel = { city: Infinity, town: 0.3, suburb: 0.06, quarter: 0.02 };
// At most this many names at once, so a dense view stays readable.
export const maximumNames = 60;

// `places`: [{ name, place, lat, lon, population }]; `unit`: kilometres per pixel; `toScreen(place)`: its position in
// pixels, or null when off the map; `size(place)`: its font size in pixels. Returns the places to write, in order, with
// their position: [{ place, x, y }].
export function choosePlaceLabels(places, { unit, toScreen, size, gap = 4 }) {
    const ranked = places
        .filter((place) => unit <= (kilometresPerPixel[place.place] ?? kilometresPerPixel.quarter))
        .sort((a, b) => ((placeRank[a.place] ?? 4) - (placeRank[b.place] ?? 4)) || ((b.population ?? 0) - (a.population ?? 0)) || a.name.localeCompare(b.name));
    const written = [];
    const boxes = [];
    for (const place of ranked) {
        if (written.length >= maximumNames) break;
        const at = toScreen(place);
        if (!at) continue;
        const height = size(place);
        const width = place.name.length * height * 0.58;
        const box = { left: at.x - width / 2 - gap, right: at.x + width / 2 + gap, top: at.y - height - gap, bottom: at.y + gap };
        if (boxes.some((other) => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom)) continue;
        boxes.push(box);
        written.push({ place, x: at.x, y: at.y });
    }
    return written;
}
