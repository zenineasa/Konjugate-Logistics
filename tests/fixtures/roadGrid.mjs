/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Invented road networks for routing tests: a city grid of a given size, and a small random number
// generator so tests pick the same points on every run.

// A square grid of `size` by `size` road nodes `spacing` metres apart around `origin`, one road way per row
// and per column, as readOverpass returns them. Every fifth row and column is a trunk road, the rest primary.
export function gridRoads({ size = 20, spacing = 200, origin = { lat: 25, lon: 55 } } = {}) {
    const dLat = spacing / 111320;
    const dLon = dLat / Math.cos(origin.lat * Math.PI / 180);
    const at = (row, column) => ({ lat: origin.lat + row * dLat, lon: origin.lon + column * dLon });
    const id = (row, column) => row * size + column + 1;
    const features = [];
    for (let row = 0; row < size; row += 1) {
        const line = Array.from({ length: size }, (_, column) => at(row, column));
        features.push({ osmType: 'way', osmId: 10000 + row, tags: { highway: row % 5 === 0 ? 'trunk' : 'primary' }, nodes: line.map((_, column) => id(row, column)), line, point: line[0] });
    }
    for (let column = 0; column < size; column += 1) {
        const line = Array.from({ length: size }, (_, row) => at(row, column));
        features.push({ osmType: 'way', osmId: 20000 + column, tags: { highway: column % 5 === 0 ? 'trunk' : 'primary' }, nodes: line.map((_, row) => id(row, column)), line, point: line[0] });
    }
    return { features, at, bounds: { south: origin.lat, west: origin.lon, north: origin.lat + (size - 1) * dLat, east: origin.lon + (size - 1) * dLon } };
}

// Mulberry32: a small seeded generator of numbers in [0, 1).
export function seeded(seed = 1) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const randomPoint = (random, bounds) => ({ lat: bounds.south + random() * (bounds.north - bounds.south), lon: bounds.west + random() * (bounds.east - bounds.west) });
