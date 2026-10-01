/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A made-up stretch of coast in the open South Atlantic, shaped like Overpass answers, so region
// import can be tested without committing OpenStreetMap data. Everything here is invented:
//
//   - Port Alder (two terminals and a container harbour mark) and Birch Harbour on the coast, a
//     marina and a fishing harbour that must be left out, and an anchorage off Port Alder
//   - a motorway along the coast and three trunk roads inland, joined by a primary road, plus a
//     short road fragment that joins nothing
//   - warehouses on two industrial estates, a large industrial estate with none mapped, and a
//     parcel too small to matter
//   - a city and a town with populations, and a town without one

let nextNode = 1;
const nodeIds = new Map();
const nodeId = (point) => {
    const key = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
    if (!nodeIds.has(key)) nodeIds.set(key, nextNode++);
    return nodeIds.get(key);
};
let nextWay = 1000;
const way = (points, tags) => ({ type: 'way', id: nextWay++, tags, nodes: points.map(nodeId), geometry: points.map(({ lat, lon }) => ({ lat, lon })) });
const line = (from, to, steps) => Array.from({ length: steps + 1 }, (_, index) => ({ lat: from.lat + (to.lat - from.lat) * index / steps, lon: from.lon + (to.lon - from.lon) * index / steps }));
// A closed rectangle `width` by `height` km around a centre.
const rectangle = (centre, width, height) => {
    const dLat = height / 2 / 111.32;
    const dLon = width / 2 / (111.32 * Math.cos(centre.lat * Math.PI / 180));
    const corners = [[-dLat, -dLon], [-dLat, dLon], [dLat, dLon], [dLat, -dLon], [-dLat, -dLon]];
    return corners.map(([a, b]) => ({ lat: centre.lat + a, lon: centre.lon + b }));
};
const area = (centre, width, height, tags) => ({ type: 'way', id: nextWay++, tags, geometry: rectangle(centre, width, height) });
const bounded = (centre, width, height, tags) => {
    const ring = rectangle(centre, width, height);
    return { type: 'way', id: nextWay++, tags, bounds: { minlat: ring[0].lat, minlon: ring[0].lon, maxlat: ring[2].lat, maxlon: ring[2].lon } };
};
let nextPoint = 5000;
const point = (lat, lon, tags) => ({ type: 'node', id: nextPoint++, lat, lon, tags });

export const syntheticBbox = { south: -30.1, west: -20.05, north: -29.55, east: -19.2 };

export function syntheticRegion({ warehouses = true } = {}) {
    // The same ids on every call, as a real region fetched twice has.
    nextNode = 1;
    nodeIds.clear();
    nextWay = 1000;
    nextPoint = 5000;
    const coast = -29.98;
    const roads = [
        way(line({ lat: coast, lon: -20.0 }, { lat: coast, lon: -19.4 }, 12), { highway: 'motorway', ref: 'M1' }),
        way(line({ lat: coast, lon: -19.9 }, { lat: -29.7, lon: -19.9 }, 28), { highway: 'trunk' }),
        way(line({ lat: coast, lon: -19.7 }, { lat: -29.7, lon: -19.7 }, 28), { highway: 'trunk' }),
        way(line({ lat: coast, lon: -19.5 }, { lat: -29.7, lon: -19.5 }, 28), { highway: 'trunk', maxspeed: '80' }),
        way(line({ lat: -29.75, lon: -19.9 }, { lat: -29.75, lon: -19.5 }, 8), { highway: 'primary' }),
        way([{ lat: -29.992, lon: -19.905 }, { lat: coast, lon: -19.9 }], { highway: 'trunk_link' }),
        way([{ lat: -29.992, lon: -19.505 }, { lat: coast, lon: -19.5 }], { highway: 'trunk_link' }),
        way(line({ lat: -29.6, lon: -19.3 }, { lat: -29.6, lon: -19.25 }, 2), { highway: 'primary' })
    ];
    const ports = [
        area({ lat: -29.995, lon: -19.905 }, 1.5, 1.0, { landuse: 'port', name: 'Port Alder' }),
        area({ lat: -29.995, lon: -19.89 }, 0.8, 0.6, { industrial: 'port', name: 'Alder East Terminal' }),
        point(-29.996, -19.904, { 'seamark:type': 'harbour', 'seamark:harbour:category': 'container' }),
        area({ lat: -29.995, lon: -19.505 }, 0.8, 0.5, { landuse: 'port', name: 'Birch Harbour' }),
        area({ lat: -29.995, lon: -19.7 }, 0.4, 0.3, { leisure: 'marina', name: 'Yacht Haven' }),
        point(-29.995, -19.6, { 'seamark:type': 'harbour', 'seamark:harbour:category': 'fishing' }),
        point(-30.05, -19.9, { 'seamark:type': 'anchorage', 'seamark:name': 'Alder Roads' })
    ];
    const logistics = [
        area({ lat: -29.95, lon: -19.88 }, 2.0, 1.5, { landuse: 'industrial', name: 'Alder Industrial Park' }),
        area({ lat: -29.77, lon: -19.68 }, 1.2, 1.0, { landuse: 'industrial' }),
        area({ lat: -29.72, lon: -19.52 }, 1.2, 1.0, { landuse: 'industrial', name: 'Northfield Estate' }),
        area({ lat: -29.85, lon: -19.3 }, 0.15, 0.15, { landuse: 'industrial' })
    ];
    if (warehouses) {
        for (const [index, offset] of [[0, -0.004], [1, -0.002], [2, 0], [3, 0.002], [4, 0.004]]) {
            logistics.push(bounded({ lat: -29.95 + (index % 2) * 0.002, lon: -19.88 + offset }, 0.15, 0.08, { building: 'warehouse' }));
        }
        for (const offset of [-0.002, 0, 0.002]) logistics.push(bounded({ lat: -29.77, lon: -19.68 + offset }, 0.12, 0.08, { building: 'warehouse' }));
    }
    const rail = [
        way(line({ lat: -29.97, lon: -19.95 }, { lat: -29.97, lon: -19.45 }, 10), { railway: 'rail' }),
        { type: 'node', id: nextPoint++, lat: -29.965, lon: -19.88, tags: { railway: 'yard' } }
    ];
    const places = [
        point(-29.74, -19.7, { place: 'city', name: 'Cedarton', population: '250000' }),
        point(-29.9, -19.45, { place: 'town', name: 'Dunmore', population: '40 000' }),
        point(-29.72, -19.92, { place: 'town', name: 'Elmwick' })
    ];
    const answer = (elements) => ({ version: 0.6, generator: 'synthetic', elements });
    return { ports: answer(ports), logistics: answer(logistics), roads: answer(roads), rail: answer(rail), places: answer(places) };
}

// IMF PortWatch answers for the same made-up coast, shaped as its ArcGIS service returns them: Port
// Alder is listed (its point 1 km off the port land), Birch Harbour is not, and a ferry pier inside the
// region and a port well outside it are. Port Alder's history is `days` days: 1,200 t of container
// imports a day, with every seventh day at 2,400 t.
// With `fallFrom` (a date), imports from that day on are a tenth of what they were: a break in the history.
export function syntheticPortwatch({ days = 28, lastDate = '2026-09-27', fallFrom = null } = {}) {
    const listed = (portid, portname, lat, lon, containers) => ({ attributes: { portid, portname, country: 'Synthetica', lat, lon, vessel_count_container: containers, vessel_count_total: containers + 10 } });
    const ports = { features: [
        listed('port9001', 'Alder', -29.99, -19.915, 420),
        listed('port9002', 'Dunmore Ferry Pier', -29.92, -19.42, 3),
        listed('port9003', 'Far Away Port', -31.5, -21.5, 900)
    ] };
    const end = new Date(`${lastDate}T00:00:00Z`).getTime();
    // Newest first, as the service is asked for them.
    const history = Array.from({ length: days }, (_, index) => {
        const date = new Date(end - index * 86400000).toISOString().slice(0, 10);
        const heavy = index % 7 === 0;
        const scale = fallFrom && date >= fallFrom ? 0.1 : 1;
        return { attributes: { portid: 'port9001', portname: 'Alder', date, portcalls_container: heavy ? 2 : 1, portcalls: heavy ? 3 : 2, import_container: (heavy ? 2400 : 1200) * scale, export_container: 900 } };
    });
    return { portwatchPorts: ports, portwatchActivity: { features: history } };
}
