<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Map first: the plan for milestones A and B

The first slice of the general supply network ([direction](direction.md), milestones A and B). The user loads the roads of a city or region, places pins from a palette (supplier, port, warehouse, store, dark store, customer area), sees links suggested between them, edits those links by dragging, and builds a model from the pins and links. Nothing is discovered unless the user asks: today's discovery of ports, warehouses and industrial land becomes an import the user starts, whose results appear as suggestions to adopt one by one.

What this slice does not do: stock held at stores, categories, the vehicle catalogue and calendars (milestones C and F). Until then every pin maps onto today's templates, and the window says so (see "Roles on today's templates").

## The workflow

1. **Load roads.** Search a place, choose the area, press *Load roads*. One light fetch: roads and place names, nothing else. The map shows the roads and town labels and an empty palette. The road level is a choice: *Major roads* (as today, for a region) or *City streets* (adds secondary and tertiary roads, for a city, with a smaller maximum area).
2. **Place pins.** Pick a role in the palette and click the map. The pin snaps to the nearest road (the snap distance shows on its card; a pin more than 2 km from a road is drawn with a warning ring). A card opens with a name and the role's fields, each prefilled with a default labelled *assumed*. Changing a field labels it *yours*. Pins drag to move; the card has *Delete*.
3. **Links appear.** As pins are placed, links are suggested: each store, dark store and customer area from its nearest warehouse by road time; each warehouse from its nearest supplier or port. Suggested links are drawn dashed and routed along the roads. Drag from a pin's edge to another pin to add a link; drag a link's end to another pin to move it; select a link and press Delete to remove it. A link the user has touched is solid and is never re-suggested.
4. **Import suggestions (optional).** A section *Suggestions from public data*, closed by default, with one button per source: *Ports* (OpenStreetMap and IMF PortWatch), *Warehouses and industrial land*, *Towns as customer areas*. Each fetches only when pressed, for the area already loaded, and shows what it found as hollow pins with a list beside them. Nothing is adopted until the user clicks a hollow pin (or ticks it in the list, or presses *Adopt the top N*). An adopted pin keeps its source (*sourced*: its port activity, floor area or population) and behaves like any other pin.
5. **Build.** *Build model* turns pins and links into the canvas model, as today. Scenarios run on it unchanged.
6. **Save.** Pins, links, the road level and fetched data are saved in the project session, so a network reopens offline. A CSV of pins (role, name, lat, lon, fields) loads and saves the same network.

## Data the window holds

```js
pin  = { id, role, name, lat, lon, basis: 'user' | 'sourced', source, fields: { [key]: { value, basis } }, snap: { vertex, metres } }
link = { id, from, to, mode: 'road', basis: 'suggested' | 'user', leg: { kilometres, hours, basis, path } }
```

Roles: `supplier`, `port`, `warehouse`, `store`, `darkStore`, `customerArea`. A link goes from a source (supplier, port) to a warehouse, or from a warehouse to a demand pin (store, dark store, customer area). A supplier straight to a store is allowed when the user draws it. The window refuses a link that runs backwards (a store to a warehouse) and says why.

## Roles on today's templates

| Role | Template in this slice | Fields on the card | Limit stated in the window |
|---|---|---|---|
| Supplier | `port`, berth capacity set far above its supply | Units a day it supplies | Ships at a steady rate whatever is ordered; ordering from suppliers comes in C |
| Port | `port` (today's) | TEU a day, berths, PortWatch match | None new |
| Warehouse | `warehouse` (today's) | Cover target, replenishment time | None new |
| Store | `demandZone` + `delivery` | Demand a day | Holds no stock of its own; that comes in C |
| Dark store | `demandZone` + `delivery` | Demand a day | Same as a store until H |
| Customer area | `demandZone` + `delivery` | Population or demand a day | None new |

Units stay TEU a day inside the model in this slice; the card says "units a day" for suppliers and stores, and the model's units become per category in C. Where a supplier's total and the stores' total differ, the builder balances them as today (`balanceFlows`) and the provenance says by how much.

## Changes by file

### `packages/toolbox/lib/overpass.mjs`

- `overpassQueries(bbox, { roadLevel })`: the roads query takes the level (`major` as today, `city` adds `secondary|tertiary` and their links).
- `overpassRequests(bbox, kinds)`: takes the kinds to fetch, so *Load roads* asks for `roads` and `places` only and each import asks for its own kind.
- City streets are heavier: `maximumTileKilometres` stays 40 for major roads and is 10 for city streets; the window caps the area at 40 km across for city streets.

### `packages/toolbox/lib/roadGraph.mjs`

The routing needed for live editing (see "Incremental routing"): `compactGraph`, `createGrid`, `routeLeg` with A*, and `nearestSources` (one multi-source Dijkstra). `createRouter` stays for the region builder until that is retired.

### `packages/toolbox/importers/region.mjs`

- A new step `roads`: reads `roads` and `places` only and returns the map layers, the compact road graph and the coverage of roads. No candidates.
- The step `discover` runs only when an import asks for it, and only over the kinds fetched. It returns candidates as today; nothing is kept by default (`defaultKeep` goes).
- A new step `buildNetwork`: takes pins and links (with their legs, routed in the window) and calls the new builder. The window and the importer use the same routing code, so the importer checks each leg's end points against the graph and routes again only a leg whose pins moved since; a leg it routes itself is noted in the report.
- `templateIds` unchanged in this slice.

### `packages/toolbox/lib/networkModel.mjs` (new, about 300 lines)

`buildNetworkModel({ builder, pins, links, options })`: places a node per pin by the table above, a `roadLane` and `roadShipment` bundle per source to warehouse link, and a `delivery` bundle per warehouse to demand link. It reuses from `regionModel.mjs` (moved to a shared `lanes.mjs`): `roadLaneState`, `balanceFlows`, the provenance notes, the operator and the corridor output, so scenarios and the results panel work without change. Order shares come from the links instead of from the gravity rule; a demand pin with two links splits by road time unless the user set shares on the link. It returns the same shape as `buildRegionModel` (`document`, `lanes`, `served`, `provenance`, `corridors`, `towns`, `ports` and so on), with `towns` holding every demand pin.

`regionModel.mjs` stays until the network builder covers the port showcase; then the region workflow becomes an import followed by *Adopt the top N* and the network build, and `regionModel.mjs` goes.

### `packages/toolbox/lib/links.mjs` (new, about 120 lines)

`suggestLinks(pins, links, router)`: the suggestion rule above, using `nearestSources` so one pass labels every road vertex with its nearest warehouse (and one with its nearest source). Keeps every `user` link, replaces `suggested` ones. `validateLinks(pins, links)`: backwards links, demand pins with no supply, warehouses with no source, each as a message the window shows.

### `packages/toolbox/lib/sites.mjs`

`parseSites` and a new `writeSites` accept the role column (`supplier`, `port`, `warehouse`, `store`, `dark store`, `customer area`) and an optional `from` column naming linked pins. Today's `port`, `zone`, `town` still read, as port, warehouse and customer area.

### `packages/toolbox/mapView.mjs`

- `setSites` becomes `setPins(pins)`: a shape per role (port square, supplier triangle, warehouse diamond, store circle, dark store circle with a dot, customer area soft disc), hollow for an unadopted suggestion, a warning ring for a far snap, labels as today.
- `setLinks(links)`: dashed for suggested, solid for the user's, drawn along `leg.path` when routed and straight while a pin is being dragged.
- Link editing: pointer down on a pin's edge starts a new link (`onLink(from, to)`), on a link's end moves it (`onRelink(id, end, to)`), a click on a link selects it (`onSelectLink(id)`), and Delete removes it (`onDeleteLink`).
- `onMove` fires on pointer up only, with `onDrag` for the straight preview while dragging, so routing runs once per move.
- `setAddKind` takes a role. `onToggle` stays for adopting suggestions.

### `packages/toolbox/toolbox.mjs`

- State: `pins`, `links`, `graph`, `roadLevel` and `suggestions` (by source) replace `kept`, `changes` and `added` for the new workflow.
- *Load roads* replaces *Fetch*: fetches `roads` and `places`, runs the `roads` step, builds the compact graph and grid once.
- The palette, the pin card and the link card (from, to, how routed, kilometres and hours, delete).
- After each pin added, moved or deleted: re-snap that pin, re-route its links, re-run `suggestLinks`, redraw. Each step timed in development so the B target can be checked.
- *Suggestions from public data*: one button per source; each fetches its kinds, runs `discover`, draws hollow pins. PortWatch is fetched with *Ports* only.
- `sessionState` and `restoreSession` save pins, links, road level and which suggestions were fetched.
- `updateStepSummaries` for the new steps.

### `packages/toolbox/index.html` and `styles.css`

Steps become: 1 Map (search, area, road level, *Load roads*), 2 Network (palette, pin and link cards, suggestions section, list of pins), 3 Model (build settings, today's arrivals and operator controls when a port is present), 4 Scenarios, 5 Compare. The coverage step folds into Map (roads) and into each suggestion source.

## Incremental routing

Today `createRouter` finds the nearest road vertex by scanning every vertex, and runs a full Dijkstra from each origin. That is fine for a build of twenty legs but not for re-routing as a pin moves. Milestone B asks for under a second per move; the aim is under 100 ms for a city.

1. **The graph goes to the window once.** The `roads` step returns the graph compacted: chains of road nodes with no junction become one edge carrying its geometry, which cuts vertices by around ten times. Sent as flat arrays (vertex coordinates, edge from, to, metres, hours, geometry offsets), cached in `out/` with the roads answer.
2. **Snap with a grid.** A grid of 1 km cells over the vertices and the edge segments; a snap checks the pin's cell and its neighbours, and snaps onto the nearest point of the nearest segment rather than the nearest vertex, so a pin on a long road snaps where it is.
3. **Route one leg with A\*.** Straight-line distance at the fastest road speed is an admissible bound, so A\* stops once the destination is settled instead of settling the whole region. Legs are cached by snapped end points; a pin move invalidates only the legs that touch it.
4. **Suggestions in one pass.** A multi-source Dijkstra from every warehouse labels each vertex with its nearest warehouse and the time to it; a store's suggested warehouse is the label at its snap. It runs again only when a warehouse is added, moved or deleted. The same for sources feeding warehouses.
5. **During a drag** the link is drawn straight; routing runs on pointer up.
6. **The builder trusts the window's legs** (see the importer), so a build does not route again.

Tests (`node --test`): a compacted graph routes the same times as the full one on the sample region; A\* and Dijkstra agree on a hundred random pairs; moving one pin changes only its links' legs; the multi-source labels match a brute force; a suggested link is replaced and a user link is kept.

## Order of work

1. Road-only load and the compact graph, grid and A\* (with tests). Shows: a road map loads in a third of today's time, and a pin snaps onto it.
2. Pins with roles and cards in `mapView.mjs` and `toolbox.mjs`, session save and CSV. Shows: milestone A without links.
3. Suggested links, link editing and incremental re-routing. Shows: milestone B.
4. `networkModel.mjs` and the `buildNetwork` step. Shows: three suppliers, two warehouses and twenty stores built and run under today's scenarios.
5. Discovery as suggestions: the per-source buttons, hollow pins, adopt. Shows: the Dubai showcase rebuilt from an import and *Adopt the top N*, with its results unchanged to within rounding (a test).
6. Retire the old curation steps and `regionModel.mjs` once 5 passes.

## Open questions

- Demand for a store in this slice: one number a day, or from a customer area it is linked to? (Proposed: a number, default by role, labelled assumed.)
- Suggestion rule for warehouses: nearest source only, or every source in proportion to supply? (Proposed: nearest, since it is easy to see and to change.)
- City streets from Overpass for a city of 40 km may be several megabytes; if too slow, a vector tile source is the next step.
