/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The roads the model's lanes run on, as corridors for the map: each stretch of road carries the lanes that use it, and
// its flow is the sum of theirs, so a road several lanes share is drawn once, as thick as what it carries. A lane that
// was not routed over the roads (local streets between close sites, or a straight-line estimate) is its own straight
// corridor, marked with its basis, so the map does not draw a road the model did not use.
//
// `lanes`: [{ name, rate, standby, basis, origin: { lat, lon }, destination: { lat, lon }, path: { ids, points } | null }],
// path being the road nodes the router followed. A path with no ids (the window's router, whose points are the road
// graph's own geometry) is matched by position instead: two legs over the same road pass through the same points.
// Returns [{ points: [[lat, lon]], rate, lanes: [names], basis, standby }].

import { simplify } from './mapData.mjs';

const round = (value) => Math.round(value * 1e5) / 1e5;
const pack = (points) => points.map((point) => [round(point.lat), round(point.lon)]);

// A path's points (as { lat, lon } or [lat, lon]) named by their position, to about a metre.
function byPosition(given) {
    const points = given.map((point) => (Array.isArray(point) ? { lat: point[0], lon: point[1] } : point));
    return { points, ids: points.map((point) => `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`) };
}

export function laneCorridors(lanes, { tolerance = 30 } = {}) {
    const points = new Map();
    const sequences = lanes.map((lane) => {
        if (lane.basis !== 'routed' || !lane.path?.points?.length) return null;
        const path = lane.path.ids?.length ? lane.path : byPosition(lane.path.points);
        // From the site, along its access leg, over the roads, to the other site.
        const origin = `site:${lane.origin.lat},${lane.origin.lon}`;
        const destination = `site:${lane.destination.lat},${lane.destination.lon}`;
        points.set(origin, lane.origin);
        points.set(destination, lane.destination);
        path.ids.forEach((id, index) => points.set(id, path.points[index]));
        return [origin, ...path.ids, destination];
    });
    // Which lanes use each stretch of road (in either direction).
    const edge = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);
    const users = new Map();
    sequences.forEach((sequence, lane) => {
        if (!sequence) return;
        for (let index = 1; index < sequence.length; index += 1) {
            const key = edge(sequence[index - 1], sequence[index]);
            if (!users.has(key)) users.set(key, new Set());
            users.get(key).add(lane);
        }
    });
    // Runs of road with the same lanes on them; a run several lanes share is found once.
    const runs = new Map();
    sequences.forEach((sequence) => {
        if (!sequence) return;
        let run = null;
        let signature = null;
        const close = () => {
            if (!run || run.length < 2) return;
            const ends = [String(run[0]), String(run[run.length - 1])].sort().join('|');
            const key = `${signature}#${ends}`;
            if (!runs.has(key)) runs.set(key, { signature, nodes: run });
        };
        for (let index = 1; index < sequence.length; index += 1) {
            const current = [...users.get(edge(sequence[index - 1], sequence[index]))].sort((a, b) => a - b).join(',');
            if (current !== signature) {
                close();
                signature = current;
                run = [sequence[index - 1]];
            }
            run.push(sequence[index]);
        }
        close();
    });
    const corridors = [...runs.values()].map(({ signature, nodes }) => {
        const members = signature.split(',').map(Number).map((index) => lanes[index]);
        return {
            points: pack(simplify(nodes.map((node) => points.get(node)), tolerance)),
            rate: members.reduce((total, lane) => total + lane.rate, 0),
            lanes: members.map((lane) => lane.name), basis: 'routed', standby: members.every((lane) => lane.standby)
        };
    });
    // Lanes the roads did not route: straight, with their basis.
    lanes.forEach((lane, index) => {
        if (sequences[index]) return;
        corridors.push({ points: pack([lane.origin, lane.destination]), rate: lane.rate, lanes: [lane.name], basis: lane.basis, standby: Boolean(lane.standby) });
    });
    return corridors;
}
