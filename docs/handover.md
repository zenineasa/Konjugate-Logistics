<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Handover

For whoever picks the toolbox up next, person or agent. Read [direction.md](direction.md) first: it says where the toolbox is going and why. This file says how to work in it, what state it is in, and what is easy to get wrong. Last updated October 2026.

## Where things stand

- **Working today:** a port-to-hinterland planner. A region from one search (OpenStreetMap, IMF PortWatch), a coverage report, curation on a map, a model built over the real roads, and four scenarios forked from the baseline (chokepoint with cargo lost, delayed or diverted to one or two ports; road closure; fleet change; demand change, including demand while a cut lasts), with results on the map and in a summary. Every input is labelled with where it came from. A showcase on Dubai during the 2026 Hormuz closure was built and filmed with it.
- **Decided next:** a general supply network modeller ([direction.md](direction.md), "Next: a general supply network", milestones A to H): sites placed on a map with roles (supplier, port, warehouse, store, dark store, customer area), suggested links the user edits, stock by product category, vehicle types with fleets at sites, calendars and shifts with a holiday calendar, results in business terms, network what-ifs, dark stores with the last mile. **None of A to H is built.** A redesign is acceptable where the current shape gets in the way.
- **Before building:** the practitioner questions at the end of that section are meant to be asked first. The direction came from one retail supply chain manager's reaction to the showcase video; more answers should shape milestone A.

## Setup

- A checkout of the public Konjugate repository beside this one (`../konjugate`), or `KONJUGATE_DIR` pointing at it (`scripts/konjugatePaths.mjs`). The engine tests need Konjugate's built engine (`out/engine/konjugateEngine` in that checkout); the interaction tests run Konjugate's Electron app from source.
- `npm test`: unit tests (fast). `npm run test:engine`: the engine CLI on generated models, checking conservation. `npm run test:interaction`: builds the packages and drives the real app with Playwright (several minutes; under heavy machine load a step can time out, so rerun once before suspecting a bug). `npm run build` writes the packages to `out/`; `npm run install:dev` installs them into a local Konjugate.
- `node scripts/liveRegionCheck.mjs --place "Rotterdam" --pick 2 --margin 10 [--run --scenarios]` fetches a real region exactly as the window would (`--margin` boxes the place's bounds as the window does), caches it, prints coverage, candidates and the model, and with `--run` runs it. The public Overpass server is fair-use and often overloaded: fetch one region at a time, never in parallel.

## Code map

- `packages/engine/components/*.json`: the component templates (Port, Road lane, Rail lane, Warehouse, Demand zone, and the shipment and delivery bundles), with their equations. Konjugate states are scalars and edges are bidirectional, which is how goods and trucks are conserved.
- `packages/toolbox/addon.json`: the add-on manifest: the importer, the scenarios (each declares the parameters it changes, as `supplied` interventions) and the Konjugate features it `requires`.
- `packages/toolbox/importers/region.mjs`: the importer Konjugate runs in a worker: `step: 'discover'` (candidates, coverage, notices, map layers) and `step: 'build'` (the model).
- `packages/toolbox/toolbox.mjs`: the window: state, the five steps, scenario settings, running a scenario (`scenarioRun`, `chokepointRun`), the summary (`summariseRun`, `renderScenarioResult`) and the map's flows (`renderFlows`). `mapView.mjs` draws the map; `index.html` and `styles.css`.
- `packages/toolbox/lib/`: `discovery.mjs` (OpenStreetMap to candidates: ports, logistics zones, towns, coverage, notices), `portwatch.mjs` (IMF PortWatch fetch, matching ports, history, breaks), `regionModel.mjs` (curated candidates to a model: flows, lanes, fleets, provenance; it assumes ports to zones to towns, which the redesign replaces), `modelBuilder.mjs` (placing templates), `roadGraph.mjs` and `corridors.mjs` (routing, and lanes merged into corridors for the map), `scenarios.mjs` (the scenario plans: paths supplied per parameter), `chokepoints.mjs`, `operator.mjs` (fleet operators), `geography.mjs` with `geography/` (Natural Earth tiles), `overpass.mjs`, `places.mjs`, `sites.mjs` (the user's CSV), `geo.mjs`, `mapData.mjs`.
- `scripts/`: `liveRegionCheck.mjs` (above), `templatePlacement.mjs` (the `ModelBuilder` the tests use outside Konjugate), `buildGeography.mjs`, `build.mjs`, `installDev.mjs`, signing scripts.
- `tests/`: `unit/` (node:test), `engine/` (runs the engine CLI and checks invariants), `interaction/` (the real app), `fixtures/syntheticRegion.mjs` (a made-up coast every test uses).

## How a scenario runs

The window computes, for each parameter a scenario changes, a held path of values over time (`scenarios.mjs`), and calls `api.runScenario(id, { supplied: { byParameter }, forkAt, runTime, signals })`. Konjugate runs the baseline, forks it at `forkAt` and follows the supplied paths as stored schedules; the window summarises both branches. A parameter can only be scheduled if it is live and indexed (`built.parameterIndex`); a value outside its slider is held to the slider and reported back as `clamped`, which the window shows. Every parameter a scenario declares in `addon.json` must be supplied, with at least one entity, or the run is refused.

## Things that are easy to get wrong

- **Orders that cannot be delivered.** The warehouse orders up to a target counting what is on order. An order placed on a lane or port that cannot deliver (a closed road, cargo that will never come) counts as on its way and cuts the warehouse's orders on its other lanes while its stock runs out. Scale the order shares instead (`chokepointOrders`, `closurePlan` in `scenarios.mjs`). Any new disruption must respect this.
- **Conservation.** The engine tests check that containers, trucks and the on-order books are conserved in every run. Keep them passing; they caught real bugs.
- **One time step everywhere** (15 minutes, hourly outputs): edges between nodes with different substeps do not conserve exactly yet.
- **Build time.** Routing every lane over a city's roads takes tens of seconds; a Dubai build with standby lanes passed 30 seconds under load. Konjugate gives an importer 120 seconds (it was 30). Incremental routing is milestone B.
- **The window's Run after a change.** With "Keep the canvas in step" on, a rebuild can be under way when Run needs its own build; Run waits for it (fixed). Keep that in mind when adding steps that build.
- **Caches live in `out/`,** which is git-ignored and cleared by a clean. Region caches (`out/regionCache/`) must be fetched again after one.
- **Region boxes.** A city's search result can stop short of its port (Rotterdam); the window warns when a busy PortWatch port lies just outside. Town populations in OpenStreetMap can be a district's (set aside above 250,000 for a town).

## Known open items

- Two ports splitting a diversion deliver 1.7 points less than one port taking it all, with the same cargo carried: not traced.
- Demand changes only by the figure the user gives; roads never congest; goods arriving overland from outside the region are not modelled.
- The interaction test's reopen step (session restored after closing the window) can time out under heavy load.

## How the owner works

- **The owner commits.** Propose a commit message: one sentence on the change in behaviour, in the style of `git log`, no prefixes.
- **Prose** (docs, UI text, comments): plain words, no em dashes, no Oxford commas.
- **Honesty is a feature.** Every input says whether it is sourced, routed, assumed, synthetic or the user's; results compare choices and are never presented as forecasts; scenarios are never tuned to look better; limits and bugs are stated plainly.
- **Every fix gets a test** that would have caught it. Keep `ReadMe.md` and `docs/direction.md` current as things change.
