/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes a small OpenStreetMap extract (.osm.pbf) from nodes and ways, as the tools that publish extracts write them:
// a header block, then blocks of dense nodes, then blocks of ways, each zlib-compressed. For tests of the reader.

import { deflateSync } from 'node:zlib';

const varint = (value) => { const out = []; let rest = value; while (rest >= 128) { out.push((rest % 128) | 0x80); rest = Math.floor(rest / 128); } out.push(rest); return out; };
const zigzag = (value) => varint(value < 0 ? -value * 2 - 1 : value * 2);
const field = (number, wire, bytes) => [...varint(number * 8 + wire), ...bytes];
const delimited = (number, bytes) => field(number, 2, [...varint(bytes.length), ...bytes]);
const text = (value) => [...new TextEncoder().encode(value)];
const deltas = (values) => values.flatMap((value, index) => zigzag(value - (index ? values[index - 1] : 0)));

function blob(type, content, { compress = true } = {}) {
    const body = compress ? [...delimited(3, [...deflateSync(Uint8Array.from(content))]), ...field(2, 0, varint(content.length))] : delimited(1, content);
    const header = [...delimited(1, text(type)), ...field(3, 0, varint(body.length))];
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, header.length);
    return [...length, ...header, ...body];
}

// A block of nodes or ways with its own table of strings. Coordinates are in units of 100 nanodegrees, the usual.
function primitiveBlock(group, strings) {
    const table = strings.flatMap((value) => delimited(1, text(value)));
    return [...delimited(1, table), ...delimited(2, group)];
}
class Strings {
    constructor() { this.list = ['']; }
    of(value) { let at = this.list.indexOf(value); if (at < 0) { at = this.list.length; this.list.push(value); } return at; }
}

// `nodes`: [{ id, lat, lon, tags }]; `ways`: [{ id, nodes: [id], tags }]; `bounds`: { south, west, north, east } or
// null to leave the header without one. `perBlock`: how many of each go in a block.
export function writeOsmPbf({ nodes, ways, bounds = null, perBlock = 4, compress = true }) {
    const nano = (degrees) => zigzag(Math.round(degrees * 1e9));
    const header = [
        ...(bounds ? delimited(1, [...field(1, 0, nano(bounds.west)), ...field(2, 0, nano(bounds.east)), ...field(3, 0, nano(bounds.north)), ...field(4, 0, nano(bounds.south))]) : []),
        ...delimited(4, text('OsmSchema-V0.6')), ...delimited(4, text('DenseNodes'))
    ];
    const out = [...blob('OSMHeader', header, { compress })];
    for (let start = 0; start < nodes.length; start += perBlock) {
        const part = nodes.slice(start, start + perBlock);
        const strings = new Strings();
        const keysValues = part.flatMap((node) => [...Object.entries(node.tags ?? {}).flatMap(([key, value]) => [...varint(strings.of(key)), ...varint(strings.of(value))]), 0]);
        const dense = [
            ...delimited(1, deltas(part.map((node) => node.id))),
            ...delimited(8, deltas(part.map((node) => Math.round(node.lat * 1e7)))),
            ...delimited(9, deltas(part.map((node) => Math.round(node.lon * 1e7)))),
            ...(part.some((node) => Object.keys(node.tags ?? {}).length) ? delimited(10, keysValues) : [])
        ];
        out.push(...blob('OSMData', primitiveBlock(delimited(2, dense), strings.list), { compress }));
    }
    for (let start = 0; start < ways.length; start += perBlock) {
        const strings = new Strings();
        const group = ways.slice(start, start + perBlock).flatMap((way) => delimited(3, [
            ...field(1, 0, varint(way.id)),
            ...delimited(2, Object.keys(way.tags ?? {}).flatMap((key) => varint(strings.of(key)))),
            ...delimited(3, Object.values(way.tags ?? {}).flatMap((value) => varint(strings.of(value)))),
            ...delimited(8, deltas(way.nodes))
        ]));
        out.push(...blob('OSMData', primitiveBlock(group, strings.list), { compress }));
    }
    return Uint8Array.from(out);
}
