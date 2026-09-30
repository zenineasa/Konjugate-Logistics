# Konjugate Logistics Toolbox

A logistics extension for [Konjugate](https://github.com/zenineasa/Konjugate), the open-source, graph-native simulation engine. It models how containers move from a port through warehouses to customers, as stocks and flows that Konjugate integrates over time.

## Status

Early development. What exists today is a component library plugin, `konjugate.logistics.engine`, with one example model, verified end to end against a real Konjugate build.

## What's in the component library

| Component | Kind | What it models |
|---|---|---|
| Port | node | A container yard fed by vessel arrivals. |
| Warehouse | node | On-hand stock, an inbound lane with an Erlang-3 lead time that is expedited while stock is low, a demand forecast by exponential smoothing, and an order rate set by an order-up-to rule. |
| Demand zone | node | Customers ordering at a steady rate, with an optional demand step. Tracks the backlog and running totals of what was ordered and delivered. |
| Port dispatch | bundle | Releases containers from a port's yard into a warehouse's inbound lane at the warehouse's order rate, limited by the lane's share of the gate capacity and by an optional outage window. |
| Delivery | bundle | Ships from a warehouse to a demand zone and clears the same amount from the zone's backlog, optionally serving the zone only while the warehouse holds more than a set level. Also feeds the zone's demand back to the warehouse's forecast. |

Place nodes by clicking them in Konjugate's component library. To apply a bundle, select its endpoint nodes (a port and a warehouse, or a warehouse and a demand zone), then click the bundle.

Every edge that moves containers (dispatch and delivery) is bidirectional, so what leaves one node enters the next, and containers are conserved by construction. The backlog clearing and the demand signal are directed edges: they update the zone's order book and the warehouse's forecast, not its stock. The warehouse's order rate and the zone's demand rate are algebraic states: set from the node's other states rather than integrated.

**Units.** Stocks are in TEU (twenty-foot equivalent units). Simulation time `t` is in seconds, as everywhere in Konjugate. Rates are entered per day and divided by one shared `secondsPerDay` parameter, so a 120-day run has a target time of 120 × 86400 s.

**Shared parameters.** Quantities that belong to one node or lane are created per placement, so each warehouse has its own lead time and each lane its own share. You can change them in the parameters table, and in a fork once you make them live. Model-wide constants, such as the stock cover target, the demand smoothing time and the gate capacity, are one definition shared by every component that uses them.

## Example

**Port and warehouse network** appears in Konjugate's Examples dialog once the plugin is installed. A port feeds two warehouses serving three customer zones. The baseline is balanced and holds still; the guide that comes with it forks the run at day 10 to close the port gate for a month, or to step up demand and show the bullwhip effect at the port. The model is generated from the templates by `scripts/buildModels.mjs`, and its guide is `guides/portWarehouseNetwork.md`.

## Development

This repository sits next to a Konjugate checkout (`../konjugate`, or set `KONJUGATE_DIR`). It needs a Konjugate recent enough to support node-template parameters and the algebraic-state fixes, with its engine built (`npm run build:engine` there). The scripts use Konjugate's own package, validation and project-file code, so what passes here is what the app accepts.

- `npm run build` builds the plugin into `out/konjugate.logistics.engine-<version>.kjp`, with the example model, its guide and its thumbnail. The version comes from `package.json`.
- `npm run build:models` writes the example models to `models/`, so a model's structure is reviewable in git.
- `npm run generate:example-thumbnails` opens each example in the real app and saves its preview to `thumbnails/`. Run it when an example's layout changes.
- `npm run install:dev` builds, then installs into your local Konjugate's `userData/packages` (override with `KONJUGATE_USER_DATA`).
- `npm test` runs the unit tests: every template passes Konjugate's template validator, every per-day rate goes through `secondsPerDay`, and shared constants agree across templates.
- `npm run test:engine` builds a port network from the templates (`scripts/portNetwork.mjs`) and runs it through the engine CLI in three scenarios: baseline, gate outage and demand step. Each must conserve containers and match Konjugate's own logistics test model state for state.
- `npm run test:interaction` launches the real Konjugate app with a scratch user-data directory (never yours), installs the built plugin, and builds a network through the UI: placing nodes, applying bundles and editing shared parameters. It checks the saved project against the same network built by script, and the app's run against the engine CLI. It then opens the example from the Examples dialog, forks it as the guide describes, and checks the guide's claims. It uses Playwright from the Konjugate checkout.

`scripts/templatePlacement.mjs` places templates the way the app does, so tests and models built by script run exactly what the templates say.

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPLv3). You may use, modify and share this toolbox, including commercially, provided that modified versions, including ones only run as a network service, are made available under AGPLv3 too.

The license is AGPLv3 only, not any later version (SPDX identifier `AGPL-3.0-only`).

---

Copyright © 2026 Zenin Easa Panthakkalakath
