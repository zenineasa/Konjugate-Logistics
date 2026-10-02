/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Land, coastlines and country borders from Natural Earth, bundled with the add-on in 10-degree tiles
// (scripts/buildGeography.mjs writes them): which tiles a region needs, and cutting rings and lines to a box. Points are
// { lat, lon }; a tile is named by its south-west corner, as N20E050 or S30W020.

export const tileSize = 10;

export function tileName(lat, lon) {
    const south = Math.floor(lat / tileSize) * tileSize;
    const west = Math.floor(lon / tileSize) * tileSize;
    return `${south < 0 ? 'S' : 'N'}${String(Math.abs(south)).padStart(2, '0')}${west < 0 ? 'W' : 'E'}${String(Math.abs(west)).padStart(3, '0')}`;
}

// The tiles a box touches.
export function tilesFor(bbox) {
    const names = [];
    for (let lat = Math.floor(bbox.south / tileSize) * tileSize; lat < bbox.north; lat += tileSize) {
        for (let lon = Math.floor(bbox.west / tileSize) * tileSize; lon < bbox.east; lon += tileSize) names.push(tileName(lat, lon));
    }
    return names;
}

const expand = (box, margin) => ({ south: box.south - margin, north: box.north + margin, west: box.west - margin, east: box.east + margin });

// A ring cut to a box (Sutherland-Hodgman, edge by edge): what lies inside, closed along the box's edges. Good for a fill;
// the box edges it adds are not coastline, so the fill is drawn without a stroke.
export function clipRing(ring, box, margin = 0) {
    const edges = expand(box, margin);
    const sides = [
        [(p) => p.lat >= edges.south, (a, b) => at(a, b, 'lat', edges.south)],
        [(p) => p.lat <= edges.north, (a, b) => at(a, b, 'lat', edges.north)],
        [(p) => p.lon >= edges.west, (a, b) => at(a, b, 'lon', edges.west)],
        [(p) => p.lon <= edges.east, (a, b) => at(a, b, 'lon', edges.east)]
    ];
    let output = ring;
    for (const [inside, cross] of sides) {
        const input = output;
        output = [];
        for (let index = 0; index < input.length; index += 1) {
            const current = input[index];
            const previous = input[(index + input.length - 1) % input.length];
            if (inside(current)) {
                if (!inside(previous)) output.push(cross(previous, current));
                output.push(current);
            } else if (inside(previous)) {
                output.push(cross(previous, current));
            }
        }
        if (!output.length) return [];
    }
    return output;
}

// Where segment a-b crosses a line of constant lat (or lon).
function at(a, b, key, value) {
    const t = (value - a[key]) / (b[key] - a[key]);
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

// A line cut to a box: the runs of it that touch the box, each kept one point beyond, so lines meet across tile edges.
export function clipLine(line, box, margin = 0) {
    const edges = expand(box, margin);
    const inside = (p) => p.lat >= edges.south && p.lat <= edges.north && p.lon >= edges.west && p.lon <= edges.east;
    const runs = [];
    let run = null;
    for (let index = 0; index < line.length; index += 1) {
        const keep = inside(line[index]) || (index > 0 && inside(line[index - 1])) || (index + 1 < line.length && inside(line[index + 1]));
        if (keep) {
            if (!run) runs.push(run = []);
            run.push(line[index]);
        } else {
            run = null;
        }
    }
    return runs.filter((item) => item.length >= 2);
}

// A tile's points back from [lat0, lon0, dlat, dlon, ...] in thousandths of a degree.
export function decode(encoded) {
    const out = [];
    let lat = 0;
    let lon = 0;
    for (let index = 0; index + 1 < encoded.length; index += 2) {
        lat += encoded[index];
        lon += encoded[index + 1];
        out.push({ lat: lat / 1000, lon: lon / 1000 });
    }
    return out;
}
