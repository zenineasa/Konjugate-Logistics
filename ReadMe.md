# Konjugate Logistics Toolbox

A logistics extension for [Konjugate](https://github.com/zenineasa/Konjugate), the open-source, graph-native simulation engine. It models how containers move from a port through warehouses to customers, as stocks and flows that Konjugate integrates over time.

## Status

Early development. What exists today is a component library plugin, `konjugate.logistics.engine`, with one example model, verified end to end against a real Konjugate build.

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

## Development

This repository sits next to a Konjugate checkout (`../konjugate`, or set `KONJUGATE_DIR`). It needs a Konjugate recent enough to support node-template parameters and to settle algebraic states before the first step, with its engine built (`npm run build:engine` there). The scripts use Konjugate's own package, validation and project-file code, so what passes here is what the app accepts.

- `npm run build` builds the plugin into `out/konjugate.logistics.engine-<version>.kjp`, with the example model, its guide and its thumbnail. The version comes from `package.json`.
- `npm run build:models` writes the example models to `models/`, so a model's structure is reviewable in git.
- `npm run generate:example-thumbnails` opens each example in the real app and saves its preview to `thumbnails/`. Run it when an example's layout changes.
- `npm run install:dev` builds, then installs into your local Konjugate's `userData/packages` (override with `KONJUGATE_USER_DATA`).
- `npm test` runs the unit tests: every template passes Konjugate's template validator, every per-day rate goes through `secondsPerDay`, and shared constants agree across templates.
- `npm run test:engine` builds a port network from the templates (`scripts/portNetwork.mjs`) and runs it through the engine CLI: a steady baseline, a berth outage, a truck shortage, rail relief and fleet hiring. Each must conserve containers and trucks, keep every warehouse's on-order count equal to what its lanes hold, and match the figures worked out by hand.
- `npm run test:interaction` launches the real Konjugate app with a scratch user-data directory (never yours), installs the built plugin, and builds a network through the UI: placing nodes, applying bundles and editing shared parameters. It checks the saved project against the same network built by script, and the app's run against the engine CLI. It then opens the example from the Examples dialog, forks it as the guide describes, and checks the guide's claims. It uses Playwright from the Konjugate checkout.

`scripts/templatePlacement.mjs` places templates the way the app does, so tests and models built by script run exactly what the templates say.

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPLv3). You may use, modify and share this toolbox, including commercially, provided that modified versions, including ones only run as a network service, are made available under AGPLv3 too.

The license is AGPLv3 only, not any later version (SPDX identifier `AGPL-3.0-only`).

---

Copyright © 2026 Zenin Easa Panthakkalakath
