# Konjugate Logistics Toolbox

A logistics extension for [Konjugate](https://github.com/zenineasa/Konjugate), the open-source, graph-native simulation engine. It models how containers move from a port through warehouses to customers, as stocks and flows that Konjugate integrates over time.

## Status

Early development. What exists today:

- a component library plugin, `konjugate.logistics.engine`, with one example model, verified end to end against a real Konjugate build;
- the **Logistics Toolbox** add-on (`konjugate.logistics.toolbox`), whose window turns any region's OpenStreetMap data into a runnable model.

## What's in the component library

| Component | Kind | What it models |
|---|---|---|
| Port | node | Ships waiting at anchorage and a container yard. Vessels arrive at a steady rate; the berths handle them up to their capacity, which can drop during an outage window. Reports how long a ship waits. |
| Road lane | node | A trucking lane between two sites: containers on the road (an Erlang-3 travel time), and a fleet of trucks that are idle, loaded or returning empty. Loading is limited by idle trucks, and the fleet is hired towards a target size. Tracks utilisation and transport cost per kilometre. |
| Rail lane | node | A rail link with a fixed number of trains a day. Containers on the line travel with an Erlang-3 travel time; tracks transport cost per TEU. |
| Warehouse | node | On-hand stock, what is on order across its lanes, a demand forecast by exponential smoothing, and an order rate set by an order-up-to rule. Tracks holding cost. |
| Demand zone | node | Customers ordering at a steady rate, with an optional demand step. Tracks the backlog, its cost, and running totals of what was ordered and delivered. |
| Road shipment | bundle | Connects an origin (a port or a warehouse), a road lane and a destination warehouse. Orders go to the lane; the origin ships what the lane's idle trucks can carry and its stock allows; loaded trucks arrive at the destination and return empty. |
| Rail shipment | bundle | The same for a rail lane, limited by the trains' capacity instead of trucks. |
| Delivery | bundle | Ships from a warehouse to a demand zone and clears the same amount from the zone's backlog, optionally serving the zone only while the warehouse holds more than a set level. Also feeds the zone's demand back to the warehouse's forecast. When several warehouses serve one zone, each takes its share of the zone's demand. |

Place nodes by clicking them in Konjugate's component library. To apply a bundle, select its endpoint nodes (a port and a warehouse, or a warehouse and a demand zone), then click the bundle. A shipment bundle takes three: the origin, the lane and the destination.

Every edge that moves containers (dispatch, arrival and delivery) is bidirectional, so what leaves one node enters the next, and containers are conserved by construction. So are trucks: each road lane's idle, loaded and returning trucks always add up to its fleet. Order signals, backlog clearing and the demand signal are directed edges: they update order books and forecasts, not stock. States such as the order rate, what a lane can load, and a ship's waiting time are algebraic: set from the node's other states rather than integrated.

**Units.** Stocks are in TEU (twenty-foot equivalent units). Simulation time `t` is in seconds, as everywhere in Konjugate. Rates are entered per day and divided by one shared `secondsPerDay` parameter, so a 120-day run has a target time of 120 × 86400 s.

**Shared parameters.** Quantities that belong to one node or lane are created per placement, so each warehouse has its own lead time and each lane its own share. You can change them in the parameters table, and in a fork once you make them live. Model-wide constants, such as a truck's capacity, the cost per kilometre, the berthing time and the outage window, are one definition shared by every component that uses them.

## Example

**Port and warehouse network** appears in Konjugate's Examples dialog once the plugin is installed. A port feeds two warehouses over two road lanes, serving three customer zones. The baseline is balanced and holds still. The guide that comes with it forks the run at day 10 to take most of the berths out for a month, so ships queue at anchorage, and to step up demand, so the trucks become the bottleneck until the fleet grows. The model is generated from the templates by `scripts/buildModels.mjs`, and its guide is `guides/portWarehouseNetwork.md`.

## The Logistics Toolbox window

Open it from the **Logistics** button on Konjugate's toolstrip. Nothing in it is written for a particular place.

1. **Pick a region.** Search a place name (OpenStreetMap's Nominatim) and choose how far around it to include, up to 250 km across. **Fetch map data** asks OpenStreetMap's Overpass API for ports, logistics sites, major roads, rail and towns, one request at a time. Roads and logistics land come in tiles no wider than 40 km, a tile too large or too slow is fetched again in quarters, and a busy public server is retried after a pause, waiting longer when its status page says no slot is free (up to about ten minutes per request). **Use the sample region** loads a made-up stretch of coast instead, with no network needed. **Add your own sites** reads a CSV of ports, warehouses and customers.
2. **See what the data shows.** A coverage report per kind, measured for this region, with plain-language notices where the data is thin. For example: few warehouses mapped, so industrial land stands in for them; or populations missing, so sizes are assumed.
3. **Keep what matters.** Ports, logistics zones and towns are listed most significant first. Tick them in the list or click them on the map, keep the top N of a kind, drag a kept site to move it, and click the map to add a port, warehouse or customer of your own. Each port's volume can be set. Otherwise it comes from [IMF PortWatch](https://portwatch.imf.org): after the map data, the window fetches the PortWatch ports around the region, matches them to the ports found by position, and fetches a year of daily history for each match. A port hands inland its average container imports, converted at an assumed 10 t a TEU. PortWatch counts containers that only change ships there too, so the model's `inlandShare` (1 by default) is the place to reduce a transhipment hub. Ports with no PortWatch match share an assumed 100 TEU/day each on average, in proportion to their port land. If PortWatch can't be reached, the region still loads with assumed volumes. Port activity data: Source: International Monetary Fund, free to reuse with that attribution.
4. **Towns and demand areas.** Cities and towns come from OpenStreetMap with their populations. A city with mapped suburbs becomes several demand areas across it, each a cluster of nearby suburbs no more than 10 km across. A suburb belongs to the nearest city or town that reaches it (a city of millions reaches further), and a town with no population mapped inside a city, such as Deira in Dubai, counts as one of the city's suburbs. An area takes its suburbs' own populations where they are mapped, and an even share of the rest of the city's population otherwise, labelled as an assumption.
5. **Build the model.** Each town draws on up to four nearby zones, in proportion to their size, road access and nearness, and each zone is supplied by its nearest ports over road lanes routed on the major roads. Flows are balanced so every port ships what arrives, lanes too small to matter are dropped, and every initial value is the steady state. **Port arrivals** chooses how a port matched to IMF PortWatch receives ships: **Follow PortWatch history** (the default) has each day's arrivals be the port's container imports on the matching day, over the latest days of its history (model day 0 is the first of them; the window says which dates), stored as a held schedule on the port's arrivals parameter, so ships queue at anchorage on the busy days; **Steady average** keeps them at the average, so the baseline holds still. Either way the average is taken over the days the run covers, so arrivals and demand balance. The window lists every lane with its distance, hours and fleet, which town each zone serves, and where every value comes from: routed, assumed or yours. The model opens in the canvas and, while **Keep the canvas in step** is ticked, follows every change made in the window.

**Sessions are kept with the project.** Each build stores the window's session in the project it opens in the canvas: the place, everything kept, moved or added, port volumes, the last build's tables, and the map data it was fetched from, with each file's address and date. Saving the project saves the session. Opening the project and then the toolbox carries on where it was, with no network needed. Fetch the region again for newer data. This needs a Konjugate that supports `projectSession` and `parameterSchedules` (stored parameter schedules).

The map is drawn from the fetched data itself (an add-on window shows no map tiles). Map data © OpenStreetMap contributors, ODbL.

How it works: `packages/toolbox/lib/` holds the pipeline:

- `overpass.mjs`: the queries;
- `discovery.mjs`: candidates, clustering, ranking and coverage;
- `roadGraph.mjs`: routing;
- `regionModel.mjs`: the model;
- `sites.mjs`: the CSV;
- `mapData.mjs`: what the map draws.

`importers/region.mjs` runs the pipeline for the window in two steps, discover and build.

## Development

This repository sits next to a Konjugate checkout (`../konjugate`, or set `KONJUGATE_DIR`). It needs a Konjugate recent enough to support node-template parameters and to settle algebraic states before the first step, with its engine built (`npm run build:engine` there). The scripts use Konjugate's own package, validation and project-file code, so what passes here is what the app accepts.

- `npm run build` builds the plugin into `out/konjugate.logistics.engine-<version>.kjp`, with the example model, its guide and its thumbnail, and the toolbox add-on into `out/konjugate.logistics.toolbox-<version>.kja`, with its own copy of the templates and the sample region. The version comes from `package.json`.
- `npm run build:models` writes the example models to `models/`, so a model's structure is reviewable in git.
- `npm run generate:example-thumbnails` opens each example in the real app and saves its preview to `thumbnails/`. Run it when an example's layout changes.
- `npm run install:dev` builds, then installs into your local Konjugate's `userData/packages` (override with `KONJUGATE_USER_DATA`).
- `npm test` runs the unit tests: every template passes Konjugate's template validator, every per-day rate goes through `secondsPerDay`, and shared constants agree across templates.
- `npm run test:engine` runs two models through the engine CLI:
    - a port network built from the templates (`scripts/portNetwork.mjs`), in five scenarios: a steady baseline, a berth outage, a truck shortage, rail relief and fleet hiring;
    - a model built by region import from a made-up region (`tests/fixtures/syntheticRegion.mjs`), in its baseline and a berth outage.

  Each run must conserve containers and trucks, keep every warehouse's on-order count equal to what its lanes hold, and match the figures worked out by hand.
- `node scripts/liveRegionCheck.mjs --place "<place>" [--radius 40] [--run]` (or `--bbox south,west,north,east`) runs region import on real OpenStreetMap data. It fetches from the public Overpass server, caches the answers in `out/regionCache/`, and prints the coverage report, the candidates and the model. With `--run`, it also checks that the model's baseline holds still, or with `--arrivals history`, that each matched port's arrivals follow its PortWatch history. Parts already fetched are kept, so a run stopped by an overloaded server continues where it left off; `--overpass <host>` uses another public Overpass server, such as `overpass.private.coffee`.
- `npm run test:interaction` launches the real Konjugate app with a scratch user-data directory (never yours) and installs the built packages. It uses Playwright from the Konjugate checkout. It runs two tests:
    - **`tests/interaction/run.mjs`** builds a network through the UI: placing nodes, applying bundles and editing shared parameters. It checks the saved project against the same network built by script, and the app's run against the engine CLI. It then opens the example from the Examples dialog, forks it as the guide describes, and checks the guide's claims.
    - **`tests/interaction/regionWindow.mjs`** drives the toolbox window offline, with the network answered from the synthetic region: the sample region, a place search and fetch, discovery, a port's volume, Build (checked against the canvas), dragging a site (its lanes are rerouted) and adding a customer on the map (it is served).

  On Linux without a GPU, pass Electron flags through `KONJUGATE_ELECTRON_ARGS`, for example `--no-sandbox --use-gl=angle --use-angle=swiftshader`.

`scripts/templatePlacement.mjs` places templates the way the app does, so tests and models built by script run exactly what the templates say.

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPLv3). You may use, modify and share this toolbox, including commercially, provided that modified versions, including ones only run as a network service, are made available under AGPLv3 too.

The license is AGPLv3 only, not any later version (SPDX identifier `AGPL-3.0-only`).

---

Copyright © 2026 Zenin Easa Panthakkalakath
