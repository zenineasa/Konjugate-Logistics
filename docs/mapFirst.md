<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Map first: milestones A and B

The first slice of the general supply network ([direction](direction.md), milestones A and B), as built. The user loads the roads of a city or region, places pins from a palette (supplier, port, warehouse, store, dark store, customer area), sees links suggested between them, edits those links by dragging and builds a model from the pins and links. Nothing is discovered unless the user asks: the earlier discovery of ports, warehouses and industrial land is an import the user starts, one source at a time, whose results appear as suggestions to adopt.

What this slice does not do: stock held at stores, categories, the vehicle catalogue and calendars (milestones C and F). Until then every pin maps onto the port-era templates, and the window says so (see "Roles on today's templates").

## The workflow

1. **Load roads.** Search a place, choose the area, choose the road level and press *Load roads*. One light fetch: roads and place names, nothing else. *Major roads* (motorways, trunk and primary roads) suits a region up to 250 km across; *City streets too* adds secondary and tertiary roads, for an area up to 40 km across, in 10 km tiles. The map shows the roads and as many place names as stay readable: cities always, towns, suburbs and quarters as the map is zoomed in, the larger first, none over another (`lib/labels.mjs`).
2. **Place pins.** Pick a role in the palette and click the map; keep clicking to place more, Escape to stop. A pin is named by its role and number ("Store 4") and its card opens: name, role and the role's figures, each prefilled with a default labelled *assumed*, labelled *yours* once changed and back to assumed when cleared. The card says how far the pin is from the nearest road loaded; a pin more than 2 km away is ringed on the map, since its legs start with a long access leg. A selected pin also shows its name and Delete beside it on the map; a double click puts its name up for renaming. Pins drag to move; the card, the button beside the pin and the Delete key remove them, and Undo brings a deleted pin back with its links for a few seconds.
3. **Links appear.** As pins are placed, links are suggested: each store, dark store and customer area from its nearest warehouse by road, and each warehouse from every source while the network is small (up to 24 supply links), else from its nearest four sources with each source to its nearest two warehouses. Suggested links are dashed and drawn along the roads they were routed over, with an arrow half way. Drag from a selected pin's handle (or Shift-drag from any pin) to another pin to add a link; select a link and drag either end to another pin to move it; select a link and press Delete to remove it. A link the user drew is solid and never suggested away; drawing a link into a pin makes the suggested links into it the user's too; a suggested link the user deleted is not suggested again.
4. **Suggestions from public data (optional).** A section *Suggestions from public data*, closed by default, with one button per source: *Ports* (OpenStreetMap and IMF PortWatch), *Warehouses* (warehouses and industrial land), *Towns as customer areas* (from the place names already loaded). Each fetches only when pressed, for the area already loaded (the sample region holds the data and fetches nothing), and shows what it found as hollow pins with a list beside them. Nothing is adopted until the user clicks a hollow pin, presses *Adopt* in the list, or presses *Adopt the top N*. An adopted pin keeps what was found there (*sourced*: its port activity, floor area or population) and behaves like any other pin.
5. **Build.** *Build model* turns pins and links into the canvas model. Scenarios run on it unchanged; a network with no port has no chokepoint tab.
6. **Save.** Pins, links, the road level, the suggestions asked for and the fetched data are kept in the project session, so a network reopens offline. A CSV of pins (name, kind, latitude, longitude, the figures the user set, and `from`, the pins each is supplied from) loads and saves the same network.

## Data the window holds

```js
pin  = { id, role, name, lat, lon, basis: 'user' | 'sourced', source, fields: { [key]: { value, basis } }, candidate }
link = { id, from, to, basis: 'suggested' | 'user', leg: { kilometres, hours, basis, path: { points } }, ends }
```

`candidate` is what a pin adopted from a suggestion keeps of it (its id, position, port activity, floor area, population). `ends` records where the link's pins were when it was routed, so only a link whose pins moved is routed again. A link runs from a source (supplier, port) to a warehouse, or from a warehouse to a demand pin (store, dark store, customer area). The window refuses any other link and says why: a store supplying anything, a source supplied, a supplier straight to a store (through a warehouse in this version), a warehouse supplying a warehouse (a later version).

## Roles on today's templates

| Role | Template | Fields on the card | Limit stated in the window |
|---|---|---|---|
| Supplier | `port`, its berths its loading bays | Supplies, units a day (50 assumed) | Ships at a steady rate whatever is ordered; ordering from suppliers comes in C |
| Port | `port` | Handed inland, TEU a day (PortWatch, else the assumed volume a port) | None new |
| Warehouse | `warehouse` | Floor area, m² (weights a demand pin's share between warehouses) | None new |
| Store | `demandZone` + `delivery` | Sells, units a day (5 assumed) | Holds no stock of its own yet: that comes in C |
| Dark store | `demandZone` + `delivery` | Delivers, units a day (3 assumed) | Works as a store until H |
| Customer area | `demandZone` + `delivery` | Orders, units a day; population (20,000 assumed) | None new |

Every unit counts as one TEU in the model until categories come in C, and the Network step says so. Where the sources' total and the demand pins' own figures differ, the builder scales the demand together to match, and its warning says by how much.

## What was built, by file

### `packages/toolbox/lib/overpass.mjs`

- `overpassQueries(bbox, { roadLevel })`: the roads query takes the level (`major`, or `city` with `secondary|tertiary` and their links).
- `overpassRequests(bbox, { kinds, roadLevel })`: only the kinds asked for, city streets in 10 km tiles (`cityTileKilometres`), the road level kept when a tile is split into quarters. The window caps city streets at 40 km across (`maximumCityKilometres`).

### `packages/toolbox/lib/routing.mjs` (new)

The routing for live editing (see "Incremental routing"): `compactRoadGraph`, and `createNetworkRouter` with `snap`, `route`, `routeOnRoads` and `nearestSources`. `roadGraph.mjs` still builds the graph, and its `createRouter` still routes the earlier workflow.

### `packages/toolbox/lib/network.mjs` (new)

Roles with their fields and defaults; `createPin`, `setField` and `defaultName`; `linkProblem`; `suggestLinks(pins, links, router, dismissed)`; `routeLinks`, which routes only links whose ends moved; `networkProblems` (no source, no warehouse or no demand; a demand pin with no warehouse; a warehouse with no source, or serving no one; a source supplying no one; two pins of one name; a link that cannot be); `networkSelection` (what the importer builds from: pins by group, an adopted one by its candidate's id, and the links with their legs, a supply link with its road as `[lat, lon]` pairs); `pinFromCandidate`; `networkFromSites`.

### `packages/toolbox/lib/sites.mjs`

`parseSites` reads every role (and the earlier kinds: customer, town, depot) and a `from` column; `writeSites` writes the network back, with only the figures the user set.

### `packages/toolbox/lib/regionModel.mjs`

Rather than a new builder, `buildRegionModel` takes the network's links (`links: { supply: [{ port, zone, leg, user }], serve: [{ zone, town, leg }] }`) beside the gravity it used before, so the scenarios, the operator, PortWatch histories and standby lanes work unchanged on a placed network. With links, each demand pin draws on the warehouses linked to it, weighted by their size and nearness; the lanes are the supply links, balanced so every source ships what it supplies; a suggested supply link that would carry next to nothing is left out and returned in `unusedLinks` with why, while a link the user drew is built as drawn. A supplier is a source with its own figure, labelled *Supplied* and *Dispatch capacity* in the provenance. Errors name the site: a store with no warehouse, a source with nowhere to send its supply, links that cannot balance, two sites of one name. Built the gravity way's own links, a network gives the gravity model exactly (a unit test).

### `packages/toolbox/lib/corridors.mjs`

A lane's road without node ids (the window's router) is matched by position, so lanes over the same road still share one corridor on the map.

### `packages/toolbox/importers/region.mjs`

- `roads`: reads the roads and place names alone and returns the map (roads, place names, land and borders) and the compacted road graph, refusing an area whose roads would be more than the window may receive.
- `discover` with `sources`: the suggestions asked for, from the answers fetched for them, with their coverage, notices and the map layers that show them (port land, anchorages, industrial land).
- `sites`: a CSV of sites, for the window to place.
- `buildNetwork`: resolves each pin (an adopted one from its candidate, read again from the map data, so its sourced figures stay sourced; the user's figures where set), builds with the links and the legs the window routed (routing here only a link that comes without one), and warns when a pin was adopted from data no longer loaded.
- The earlier `discover` and `build` stay, for `liveRegionCheck.mjs` and the engine tests.

### `packages/toolbox/mapView.mjs`

A shape per role (port square, supplier triangle, warehouse diamond, store circle, dark store ringed circle, customer area soft disc), hollow for a suggestion, a ring for a pin far from the roads; place names; an overlay layer for the suggestions' port and industrial land; a links layer (dashed suggested, solid the user's, faint when left out of the model, straight while a pin is dragged); a link handle on the selected pin and end handles on the selected link; `onSelect`, `onToggle` (adopt), `onAdd`, `onMove` (once, on pointer up), `onDrag`, `onLink` and `onRelink`.

### `packages/toolbox/toolbox.mjs`, `index.html`, `styles.css`

Four steps: Map (search, area, road level, *Load roads*, sample, CSV in and out, roads coverage), Network (instructions, problems, the card, the pins by role, suggestions), Model (as before, the port settings showing once there is a port) and Scenarios. `networkChanged` suggests links, routes what moved, redraws and marks the model out of date (and rebuilds when kept in step). The session is version 2; a version 1 session reopens with its kept and added sites as pins.

## Incremental routing

The earlier router found the nearest road node by scanning every node and ran a full Dijkstra from each origin: fine for a build of twenty legs, too slow to follow a dragged pin. Milestone B asks for under a second per move.

1. **The graph goes to the window once.** The roads step compacts the graph's main network: chains of road nodes with no junction become one edge carrying its geometry, simplified to within 8 m of the road (its length and time stay the road's own), as plain arrays. On the roads of the region around Dubai (185,000 road nodes) that is 13,000 junctions and 17,000 edges, 1.7 MB, ready in the window in about 100 ms.
2. **Snap with a grid.** A grid of 1 km cells over the edges' segments; a snap searches outwards from the pin's cell until no nearer segment can be left, and snaps onto the nearest point of the nearest segment, not the nearest node.
3. **Route one leg with A\*.** Straight-line distance at the fastest road speed is an admissible bound, so A\* stops once the destination is settled. Two pins on one edge are routed along it. Legs are cached by their end points, and a link remembers where its pins were, so moving one pin routes only its links.
4. **Suggestions in one pass.** A multi-source Dijkstra from every warehouse labels each junction with its nearest warehouse and the time to it; a demand pin's suggestion is read from the two ends of the edge it snaps to (or a warehouse on the same edge, or one close enough by local streets).
5. **During a drag** the pin's links are drawn straight; routing runs once, on pointer up.
6. **The importer trusts the window's legs,** so a build does not route.

On the Dubai region (`scripts/routingCheck.mjs`): a snap takes 0.1 ms, a leg about 4 ms, the nearest of five warehouses for every junction about 25 ms, and a moved store re-routed about 2 ms.

## Tests

- `tests/unit/routing.test.mjs`: compacting keeps every kilometre and joins chains; a ring road with no junction; the compacted router finds the full graph's times between road nodes; grid snapping matches a search of every segment; A\* and Dijkstra agree on a hundred random legs, and a leg's road is as long as the leg; two pins on one road; local streets between close pins; the nearest source matches routing to every source; straight-line estimates with no roads; a city of 40,000 road nodes routed in milliseconds.
- `tests/unit/network.test.mjs`: pins and their figures; names; which links may be; suggestions in a small and a larger network; links the user drew kept, suggested ones deleted not suggested again, a link suggested again keeping its leg; moving one pin re-routing only its links, moving a warehouse handing its stores to another; three suppliers, two warehouses and twenty stores suggested and routed in well under a second; what stops a build; what the importer gets; the CSV round trip; a file's bad links reported; every role read from a file.
- `tests/unit/networkImport.test.mjs`: the importer's roads step, suggestions only from the sources asked for, the sites step, a network built with one lane per supply link routed as the window routed it (and drawn along shared roads), a PortWatch port adopted keeping its sourced volume, small suggested lanes left out and drawn ones kept, errors naming the site and a network linked as gravity links giving the gravity model.
- `tests/engine/networkModel.mjs`: a placed network through the engine CLI, conserving goods, trucks and orders in its baseline, a demand surge and a closed lane.
- `tests/window/networkWindow.mjs` (`npm run test:window`): the window in a plain browser with a stand-in host, through the whole workflow.
- `tests/interaction/regionWindow.mjs`: the real app, rewritten for the map-first workflow, through to the scenarios and the session saved and restored offline.

## Open questions

- Demand for a store is one figure a day, labelled assumed until set; from a customer area it lies in, or from sales data, once categories come?
- Suggested supply links: every source to every warehouse keeps a small network buildable, but a larger one can still fail to balance with its nearest few; a builder that adds suggested links until it balances (as gravity does) may be better.
- City streets for a large city may come close to the 8 MB the window may receive; untried on real data. If too large, simplify the map's roads more, or load the city's centre in more detail than its edges.
