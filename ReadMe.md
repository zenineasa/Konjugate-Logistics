# Konjugate Logistics Toolbox

A logistics extension for [Konjugate](https://github.com/zenineasa/Konjugate), the open-source, graph-native simulation engine. It models how containers move from a port through warehouses to customers, as stocks and flows that Konjugate integrates over time.

## Status

Early development. What exists today is a component library plugin, `konjugate.logistics.engine`, with one example model, verified end to end against a real Konjugate build, and the first half of region import: the code that turns OpenStreetMap data for any region into a runnable model. The window that drives it is next.

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
| Delivery | bundle | Ships from a warehouse to a demand zone and clears the same amount from the zone's backlog, optionally serving the zone only while the warehouse holds more than a set level. Also feeds the zone's demand back to the warehouse's forecast. |

Place nodes by clicking them in Konjugate's component library. To apply a bundle, select its endpoint nodes (a port and a warehouse, or a warehouse and a demand zone), then click the bundle. A shipment bundle takes three: the origin, the lane and the destination.

Every edge that moves containers (dispatch, arrival and delivery) is bidirectional, so what leaves one node enters the next, and containers are conserved by construction. So are trucks: each road lane's idle, loaded and returning trucks always add up to its fleet. Order signals, backlog clearing and the demand signal are directed edges: they update order books and forecasts, not stock. States such as the order rate, what a lane can load, and a ship's waiting time are algebraic: set from the node's other states rather than integrated.

**Units.** Stocks are in TEU (twenty-foot equivalent units). Simulation time `t` is in seconds, as everywhere in Konjugate. Rates are entered per day and divided by one shared `secondsPerDay` parameter, so a 120-day run has a target time of 120 × 86400 s.

**Shared parameters.** Quantities that belong to one node or lane are created per placement, so each warehouse has its own lead time and each lane its own share. You can change them in the parameters table, and in a fork once you make them live. Model-wide constants, such as a truck's capacity, the cost per kilometre, the berthing time and the outage window, are one definition shared by every component that uses them.

## Example

**Port and warehouse network** appears in Konjugate's Examples dialog once the plugin is installed. A port feeds two warehouses over two road lanes, serving three customer zones. The baseline is balanced and holds still. The guide that comes with it forks the run at day 10 to take most of the berths out for a month, so ships queue at anchorage, and to step up demand, so the trucks become the bottleneck until the fleet grows. The model is generated from the templates by `scripts/buildModels.mjs`, and its guide is `guides/portWarehouseNetwork.md`.

## Region import (in progress)

Nothing in the toolbox is written for a particular place. For any region, `packages/toolbox/lib/` does the following:

1. **Asks OpenStreetMap** (through the Overpass API) for ports, logistics sites, major roads, rail and towns. Each kind is a separate query, which keeps every answer small (`overpass.mjs`).
2. **Finds candidates** (`discovery.mjs`):
    - **Ports:** terminals close together are grouped into one port, and marinas and fishing harbours are left out.
    - **Logistics zones:** warehouses are grouped into zones and named after their estate. Where warehouses are poorly mapped, industrial land stands in for them.
    - **Towns:** population comes from OpenStreetMap where it is mapped.

   Every candidate is ranked by significance. A coverage report measures how well each kind is mapped in this region and says in plain words what the data can't see.
3. **Routes** over the major roads in-process (`roadGraph.mjs`). Nearby sites use local streets, and a site far from any road gets a straight-line estimate, labelled as such.
4. **Builds the model** from the templates (`regionModel.mjs`):
    - Each town is served from its nearest zone.
    - Each zone is supplied by nearby ports over road lanes whose travel times and distances come from routing.
    - Flows are balanced so every port ships what arrives, and every initial value is the steady state, so the baseline holds still.
    - Every value records whether it was routed, assumed or the user's own.
5. **Takes the user's own sites** from a CSV of ports, warehouses and customers (`sites.mjs`).

Until port activity is matched (Milestone 3), each port starts with an assumed 100 TEU/day, which the user can change.

## Development

This repository sits next to a Konjugate checkout (`../konjugate`, or set `KONJUGATE_DIR`). It needs a Konjugate recent enough to support node-template parameters and to settle algebraic states before the first step, with its engine built (`npm run build:engine` there). The scripts use Konjugate's own package, validation and project-file code, so what passes here is what the app accepts.

- `npm run build` builds the plugin into `out/konjugate.logistics.engine-<version>.kjp`, with the example model, its guide and its thumbnail. The version comes from `package.json`.
- `npm run build:models` writes the example models to `models/`, so a model's structure is reviewable in git.
- `npm run generate:example-thumbnails` opens each example in the real app and saves its preview to `thumbnails/`. Run it when an example's layout changes.
- `npm run install:dev` builds, then installs into your local Konjugate's `userData/packages` (override with `KONJUGATE_USER_DATA`).
- `npm test` runs the unit tests: every template passes Konjugate's template validator, every per-day rate goes through `secondsPerDay`, and shared constants agree across templates.
- `npm run test:engine` runs two models through the engine CLI:
    - a port network built from the templates (`scripts/portNetwork.mjs`), in five scenarios: a steady baseline, a berth outage, a truck shortage, rail relief and fleet hiring;
    - a model built by region import from a made-up region (`tests/fixtures/syntheticRegion.mjs`), in its baseline and a berth outage.

  Each run must conserve containers and trucks, keep every warehouse's on-order count equal to what its lanes hold, and match the figures worked out by hand.
- `node scripts/liveRegionCheck.mjs --place "<place>" [--radius 40] [--run]` (or `--bbox south,west,north,east`) runs region import on real OpenStreetMap data. It fetches from the public Overpass server, caches the answers in `out/regionCache/`, and prints the coverage report, the candidates and the model. With `--run`, it also checks that the model's baseline holds still.
- `npm run test:interaction` launches the real Konjugate app with a scratch user-data directory (never yours), installs the built plugin, and builds a network through the UI: placing nodes, applying bundles and editing shared parameters. It checks the saved project against the same network built by script, and the app's run against the engine CLI. It then opens the example from the Examples dialog, forks it as the guide describes, and checks the guide's claims. It uses Playwright from the Konjugate checkout.

`scripts/templatePlacement.mjs` places templates the way the app does, so tests and models built by script run exactly what the templates say.

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPLv3). You may use, modify and share this toolbox, including commercially, provided that modified versions, including ones only run as a network service, are made available under AGPLv3 too.

The license is AGPLv3 only, not any later version (SPDX identifier `AGPL-3.0-only`).

---

Copyright © 2026 Zenin Easa Panthakkalakath
