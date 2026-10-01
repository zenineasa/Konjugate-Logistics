<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Direction

Where the logistics toolbox is going, and what stands between here and a version worth showing to customers. The working answers at the end are best guesses, each with its reasoning; they change if what we learn says otherwise.

## The rule

Build it as if it were the final version; present it as if it were the first. Everything that can be made from public data and good modelling goes in before we approach anyone. When we do, we show it as an early version and ask what is wrong with it.

## Where we are

A modelling layer, without a product on top:

- **Engine features** the models needed: piecewise ("if") equations, simulation time `t`, parameters on node templates, and algebraic states that conserve across edges.
- **A component library:** Port (anchorage queue, berth capacity, outage window, waiting time), Road lane (a truck fleet that loads, travels and returns, hired towards a target size), Rail lane, Warehouse and Demand zone nodes, with transport, holding and backlog costs; Road shipment, Rail shipment and Delivery bundles, tested to conserve containers and trucks.
- **One generic example:** a port feeding two warehouses over two road lanes and three zones, forked for a berth outage and a demand surge that the fleet can't keep up with until it grows.

Nothing has a location yet, travel times are typed-in constants, trucks come in one size, and there is no live data.

## Who it is for

| | Infrastructure owners | Fleet operators | E-commerce |
|---|---|---|---|
| **Who** | Government bodies and large operators running ports, roads and railways | Companies running trucks of several sizes between factories, warehouses and shops, for themselves or on contract | Large online retailers and marketplaces |
| **Their question** | Where are the bottlenecks between the port and its hinterland, and what does a road, rail link, inland depot or gate policy change? | How many trucks, of what size, based where? How much empty running? Can we take this contract? | Where do fulfilment and sort centres go, and how do they cope with peak days? |
| **Horizon** | Years, with hourly congestion | Days to months, replanned daily | Months, with peak days |
| **Model detail** | Corridors, modes, congestion | Fleets as counts per depot and lane, loaded and empty | Many sites, high and uncertain volume |
| **Data they hold** | Traffic counts, port throughput, masterplans | GPS trackers, trip logs, orders | Everything, in-house |

**First audience: fleet operators.** Their pain is concrete and costed per kilometre, they can decide quickly, and they already hold the data a calibrated model needs. **Long-term: infrastructure owners,** where Konjugate's strength in network flow and congestion matters most, but sales cycles are long and a working reference helps. **E-commerce:** the large platforms build their own tools; their delivery and warehousing partners look like fleet operators and are reachable.

## The product: plan, calibrate, twin

One model grows through three layers, each built on the last.

1. **Plan.** Load a region, curate it, and run what-ifs on the map: sites, lanes, fleets and demand, compared on cost, service and resilience. Forks answer "what if the port slows, a road closes, demand jumps, we add five trucks, or move a depot".
2. **Calibrate.** Fit lead times, speeds and capacities to observed history (port activity, trip logs), so the model's numbers are the region's and the operator's, not guesses.
3. **Twin.** Stream vehicle and vessel positions into the calibrated model and keep its state in step with reality. A control-centre dashboard shows the network now, and forks it from now: where congestion, idle trucks or stock-outs will be in six hours, and what a reroute or an extra shift would change.

Later, a driver app, or apps preinstalled on vehicles, feeds the twin directly. Before that, the twin reads the GPS trackers many fleets already carry, and public ship positions (AIS).

## Region import

Nothing in the toolbox is written for a particular place. A user picks a region, the toolbox finds what logistics infrastructure it has, the user curates it, and the toolbox builds the model.

1. **Pick a region.** Search a place name or draw a box or polygon on the map.
2. **Discover.** Candidates come from OpenStreetMap, enriched from other public sources:

    | Kind | Found from | Enriched with |
    |---|---|---|
    | Ports and terminals | Port and harbour areas, container terminals | Daily port calls and volume estimates from IMF PortWatch; marinas and fishing harbours are filtered out, largely by the PortWatch match |
    | Anchorages | Sea-mark anchorage areas | Waiting vessels counted from AIS positions |
    | Warehouses and logistics zones | Warehouse buildings, industrial land, free zones | Floor area; access to major roads |
    | Rail | Lines, freight yards and terminals | Service frequency where published |
    | Roads | Motorway, trunk and primary roads | Speeds by road class; live speeds later |
    | Demand | Towns and cities | Population where available: the least certain input, labelled as an estimate |

3. **Rank and cluster.** Warehouse buildings close together are grouped into one logistics zone, with their combined floor area, so models stay at a readable size (tens to low hundreds of nodes). Every candidate gets a significance score: ports by throughput, zones by floor area and road access, towns by population.
4. **Curate.** An import step shows the candidates on the map and in a list grouped by kind, most significant first. Removing what matters less is quick: a threshold per kind ("ports above 10,000 TEU a month"), "keep the top N", ticking and unticking on the map or in the list, and merging two by selecting them. Users add their own warehouses, depots, factories or shops by clicking on the map, or by importing a CSV of their sites, and move or delete any of them at any time.
5. **Build.** Each kept entity becomes a node from the component templates. Lanes are generated only between plausible pairs (port to zone, zone to zone, zone to demand), with travel times and costs from routing over the road and rail graph. Every value says whether it is sourced, assumed or the user's own, and stays editable. The map and the Konjugate canvas stay in step, as the fintech toolbox keeps its window and the canvas in step, with Decouple for hand edits.
6. **Save a session.** The region snapshot (with its date and OpenStreetMap attribution), the curation and the user's additions are saved with the project, so it opens offline and reproduces exactly.

**External drivers.** What drives a region often lies outside it: a closed chokepoint, a shipping line's rerouting. Each port gets a sea approach driven by its PortWatch history, and chokepoint scenarios are generic: "reduce transits through this chokepoint by X%" applies to whichever ports depend on it.

### Telling users what the data can't see

Public map data is uneven. Ports and main roads are usually well mapped; warehouses often are not, and coverage varies between countries and within them. The toolbox measures coverage for each region at import and says so plainly, rather than presenting a sparse picture as complete:

- **A coverage report per kind,** shown in the import step and saved with the session: how many of each were found, and indicators of completeness, such as the share of industrial land with any warehouse mapped, or how many ports matched PortWatch.
- **A plain-language notice when coverage is thin,** for example: *"Few warehouses are mapped in this region: 12 across 40 km² of industrial land. The model groups industrial areas into logistics zones instead. Add your own sites for a more accurate model."*
- **Consequences stated:** what the model does about the gap (clusters, defaults) and what the user can do (add sites, import a CSV).
- **Visible afterwards:** the notice travels with the session and the model's provenance, so a result shown later still says what its inputs could not see.

Measured per region rather than stated per country, because coverage differs within a country and improves over time.

## The showcase

A showcase is a saved region session plus a set of scenarios, nothing more. The first one is chosen for timeliness: a region whose ports are living through a major disruption, where every question is one Konjugate answers by forking a run. Where should new port capacity go and how big should it be? How much does rail relieve the roads? How many trucks do the corridors need? What happens if the disruption partly ends?

Built before approaching anyone, from public data plus clearly labelled synthetic parts:

- **The region**, imported and curated as above.
- **Real volumes where they are published**: port activity from PortWatch and dated operator and press figures.
- **A synthetic fleet operator:** depots, trucks of several capacities, contracts, costs per kilometre and per day. Plausible, and labelled invented.
- **A synthetic live feed:** a trip generator that drives the synthetic fleet along real routes and emits GPS positions, so the twin runs end to end without a customer's data. The same input path later takes a real tracker feed.
- **A control-centre view:** the map with flows, stock and trucks, the live state, and forks from now.
- **Scripted scenarios** for the walkthrough.

Every number says whether it is sourced, assumed or synthetic, and every sourced figure carries its date. A showcase is a set of scenarios, never a forecast. Where a region's situation involves conflict, the showcase stays about trade and logistics. And because any region is one search away, the next one can be loaded live in the room.

## What fits Konjugate's equation form

| Need | Fits? | How |
|---|---|---|
| Goods stocks and flows between sites | Yes | Existing templates; bidirectional edges conserve by construction. |
| Lead times from travel times | Yes | In-transit stages per lane; the lead time comes from routing. |
| Fleets as a resource | Yes, new | Trucks as conserved counts per depot and lane: loaded out, empty back; goods move only as fast as trucks times capacity allow. One stock per truck size. |
| Lanes as their own component | Yes, new | A lane bundle carrying its lead time, cost per TEU-km and truck use, so a site can take several lanes. |
| Rail as a second mode | Yes, new | A rail lane with a timetable-like capacity (trains per day times boxes per train) beside the road lanes; the split between them follows capacity and cost. |
| Ships queueing for berths | Yes, new | Anchorage as a stock of waiting vessels (in TEU) at each port, served at the berths' handling rate; waiting time follows from queue over rate. |
| Costs and service KPIs | Yes, new | Accumulator states: transport, holding, idle trucks, late or lost orders; fill rate. |
| Congestion on shared roads | Partly | Mesoscopic road cells, as in Konjugate's OpenStreetMap traffic proposal; travel time rises with flow. |
| Traffic by time of day | Partly | Piecewise rates on `t`; meaningful with sub-hourly steps. |
| Keeping the model in step with live data | No, engine work | State estimation: pull model states towards observations as they arrive. |
| Individual vehicles in the twin | Partly | Positions are aggregated into lane stages for the model; the dashboard shows each vehicle from the feed. |
| Choosing the best sites or fleet mix | No | Konjugate simulates; it doesn't search. Guided searches over many runs (see working answers), or an external optimiser proposing designs that Konjugate stress-tests. |
| Running as a service | Partly | A control centre wants a server and a browser dashboard; Konjugate's web edition is a starting point. |

## Roadmap to the showcase

Each milestone ends with something that can be shown.

1. **Lanes, fleets, ports and costs.** (Mostly done: one truck size so far, and fill rate is worked out from the zones' running totals rather than kept as a state.) Road and rail lane bundles, fleet stocks by truck size, anchorage queues with berth capacity, cost and KPI accumulators. *Done when* the example reports vessel waiting time, cost, fill rate and truck utilisation, and adding berths, trains or trucks changes them.
2. **Region import.** (Mostly done: the Logistics Toolbox window searches a place, fetches its OpenStreetMap data, reports coverage, lets the user curate on a map and in lists (tick, top N, drag, add, CSV), and builds a steady model into the canvas. Tried on a real region (the Gulf coast around Jebel Ali): tiled and retried fetches, English names, filtering of passenger harbours and non-logistics industry, port volumes shared by port land, towns served by several zones, cities split into demand areas by their suburbs, and the session saved with the project. Still to do: merging two candidates, rail lanes, and a threshold per kind.) Region search, discovery from OpenStreetMap, clustering, significance ranking, the curation step with the coverage report, and model generation with in-process routing. A CSV of the user's own sites as an alternative input. *Done when* a region is loaded, curated, reported on and turned into a runnable model, and moving a site changes its lead times and costs.
3. **Port activity and external drivers.** (Mostly done: ports are matched to IMF PortWatch by position; a matched port's container imports set its volume, and its arrivals can follow the daily history through a stored parameter schedule, a Konjugate core feature added for this. A chokepoint disruption forks the model on the day it starts and cuts each dependent port's arrivals by its share through the chokepoint; the shares come from geography, since PortWatch publishes no port-to-chokepoint links, and the chokepoint's recent drop in transits can set the cut. Still to do: sea approaches with their own transit times.) A PortWatch importer on the fintech importer pattern (fetch, cache, CSV), sea approaches per port, and generic chokepoint scenarios. *Done when* a port's modelled arrivals follow its PortWatch history and a chokepoint fork changes them.
4. **The first showcase session.** A curated region, dated volumes, the synthetic fleet operator and the scripted scenarios. *Done when* it runs for a month under each scenario and every input is labelled sourced, assumed, synthetic or the user's.
5. **Searches.** Breaking points, rankings and sensitivity, as in the fintech toolbox. *Done when* the showcase answers "the fewest trucks that keep the anchorage wait under two days" and "which link, if it fails, hurts most".
6. **Congestion.** Shared road segments whose travel time rises with flow. *Done when* a port surge visibly slows trucks on the approach roads.
7. **Live feed and state estimation.** The trip generator, AIS anchorage counts, an ingestion path, and an engine mechanism that keeps model states in step with observations. *Done when* the model tracks the synthetic fleet and recovers after a feed gap.
8. **Control centre.** Dashboard with the live network, KPIs and fork-from-now. *Done when* the walkthrough scenarios run from the dashboard.
9. **Calibration.** Fit lead times and speeds from trip history, starting with the synthetic history. *Done when* a deliberately wrong model is corrected from the feed's history.

Milestones 1 to 5 make the planning showcase. Milestones 6 to 9 make the twin.

## Public data

| Source | What it gives | Terms and limits |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | Roads, rail, ports, anchorages, industrial land, warehouses, places | ODbL: attribution; derived databases shared alike. Queried through Overpass or regional extracts; public Overpass servers are fair-use, so imports are cached. |
| Nominatim | Place search for picking a region | Public service: about one request a second, no bulk use. |
| [IMF PortWatch](https://portwatch.imf.org/pages/data-and-methodology) | Daily port calls and trade volume estimates for 2,065 ports; daily transits through 28 chokepoints | Free, with an API; updated weekly. Volumes are modelled estimates from satellite AIS and are labelled so. |
| [aisstream.io](https://aisstream.io/) | Live ship positions (AIS) | Free with an API key; a few connections per account; must run through our own server. Coverage thins where ships switch their transponders off. |
| [TomTom Traffic](https://docs.tomtom.com/pricing) | Live road-segment speeds, incidents, routing | Free tier: 20,000 segment-speed requests a month; terms to check before paid use. |
| [OSRM](https://github.com/Project-OSRM/osrm-backend) | Street-level road routing | Optional; self-hosted only. The [public demo server](https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy) may withdraw access without notice and rules out paywalled use. |
| Port operator releases and press | Monthly throughput and dated events | Secondary and fast-changing: each figure goes in with its date and link, and is refreshed before every showing. The split between transshipment and cargo that goes inland is rarely given, so it is a forkable assumption. |
| Official fuel prices | Monthly diesel price per country, where published | Enter or fetch monthly; otherwise an assumption. |
| Population statistics | Demand proxies by town | Check vintage and licence per source. |

## Out of scope for now

- **Solving vehicle routing** (which truck visits which customers in what order). A separate combinatorial problem with good existing solvers; the twin can take a routing plan as input rather than compute one.
- **Transport management features:** bookings, billing, documents, driver payroll. That is operational software around the twin, not the twin.
- **Guaranteed-optimal designs.** Konjugate compares, searches over runs and stress-tests; an external optimiser can be added if customers need one.

## Working answers

Best guesses from what the fintech toolbox showed works, each with what would change it.

- **Where data lives.** The toolbox, importers and generic example are public under AGPLv3. Imported data is fetched at runtime and cached, never committed, as fintech does with market data. Showcase sessions and their scenarios stay private until they have been shown, then can be published as reference models, as fintech's were. *Changes if* an investor or partner wants a showcase public from the start.
- **Compare or optimise.** Compare, plus guided searches over many runs: breaking points, rankings and sensitivity, as the fintech toolbox already does for bank failures. No optimisation solver for now. *Changes if* customers ask for automatically proposed designs.
- **Where the twin runs.** Desktop Konjugate with the toolbox add-on for the showcase, as fintech runs; a small relay server only for the live feeds that need one (AIS). A web control centre after the first feedback, with the design kept server-ready (Konjugate's web edition runs the engine outside the desktop app). *Changes if* the first real customer is a control centre.
- **Routing.** In-process on a simplified graph of major roads and rail from OpenStreetMap: small enough to route instantly in the add-on, so moving a site needs no server and a demo machine needs nothing installed. Speeds by road class, refined with live speeds later. Self-hosted OSRM if street-level detail ever matters. *Changes if* regions get large enough that in-process routing is slow.
- **Time step.** Hourly outputs with a 15-minute global step, the same everywhere (bidirectional edges between nodes with different substep counts do not conserve exactly yet). Trucks make several trips a day, so daily steps would blur fleet use and congestion; 90 days is about 8,600 steps, which the engine handles easily; the twin needs sub-hour steps anyway. *Changes if* runs of a year or more become the norm.
- **Licensing.** AGPLv3 only (`AGPL-3.0-only`), with no commercial licence. Anyone may use, modify and host the toolbox, provided modified versions, including ones run as a service, are released under AGPLv3 too. Revenue comes from services around it: the hosted control centre, setting up and calibrating models for a customer's network, and support.
