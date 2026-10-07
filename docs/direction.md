<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Direction

Where the logistics toolbox is going, and what stands between here and a version worth showing to customers. The working answers at the end are best guesses, each with its reasoning; they change if what we learn says otherwise.

## The rule

Build it as if it were the final version; present it as if it were the first. Everything that can be made from public data and good modelling goes in before we approach anyone. When we do, we show it as an early version and ask what is wrong with it.

## Where we are

A port-to-hinterland planning tool, shown on a real region (October 2026):

- **A component library:** Port (anchorage queue, berths, yard), Road lane (two truck sizes that load, travel and return), Rail lane, Warehouse and Demand zone, with transport, fleet, holding and backlog costs; bundles that conserve containers and trucks.
- **The Logistics Toolbox window:** a region from one search (OpenStreetMap and IMF PortWatch, with a coverage report), curation on a map, a model built over the real roads, and scenarios forked from the baseline: a chokepoint (cargo lost, delayed, or diverted to one or two other ports), a road closure, a fleet change and a demand change, with results on the map and in a summary. Every input says where it came from.
- **A showcase and a video** on Dubai during the 2026 closure of the Strait of Hormuz.

Its shape was fixed: supply starts at ports, flows through warehouses and ends at towns. That fits a port authority's question. It does not fit most supply chains, which is where the toolbox is going: milestones A and B below are built, and most of C (stock at stores, storage capacities, vehicle types, product categories and suppliers that make to order).

## Next: a general supply network (proposal)

A supply chain manager at a regional retail chain watched the showcase video and said: *"I didn't understand anything. It's boring. In the first minute, tell me why I should spend 30 minutes. I gathered it configures a logistics network, mostly about ports and ships. Why I should use it, I don't understand."* The video was too long and dense, but the deeper point is about the toolbox: it speaks a port's language (TEU, berths, chokepoints) to people whose network is suppliers, warehouses and stores, and it can't hold the network they actually run.

The toolbox becomes a general supply network modeller. A redesign is acceptable where the current one gets in the way.

### What a user does

1. **Load a map.** A city or region from a search, as today, but as a light fetch (roads and towns) when the user brings their own sites. Today's discovery (ports, industrial land, warehouses) becomes optional suggestions on the map, not the starting point: it runs only when the user asks for it, one source at a time, and nothing it finds is kept until the user adopts it.
2. **Place sites, each with a role.** Pick a role from a palette, click the map, name it:

    | Role | Behaviour |
    |---|---|
    | Supplier or factory | A source: what it supplies, its capacity, lead time and reliability |
    | Port | A supplier whose arrivals follow ships (today's port, kept) |
    | Warehouse or distribution centre | Holds stock, orders by a rule, has a capacity and a fixed cost |
    | Store | Holds stock and sells to walk-in demand; runs out |
    | Dark store | Holds stock and delivers online orders within a radius |
    | Customer area | Demand only (today's town) |

    A small form per site, with defaults labelled assumed until the user changes them. A spreadsheet of sites loads and saves the same network.
3. **Links, suggested then edited.** Each store from its nearest warehouse, each warehouse from the suppliers of each category (until categories come: from every source in a small network, so what the sources ship always has somewhere to go, and from its nearest few in a larger one); drag from one site to another to add or change a link. Every link is routed over the roads.
4. **Choose the vehicles.** A small catalogue of vehicle types (four or five), each with its capacity in the units the categories use (cases or pallets), cost per kilometre and per day, speed and loading time, what it can carry (refrigerated or ambient) and where it may go (road classes, city-centre bans). Fleets are based at sites, and each link draws on the types allowed on it: heavy trucks from supplier to warehouse, small trucks or vans to stores, riders or vans from a dark store. Vehicles stay counted and conserved per type, as the two truck sizes are today.
5. **Set the calendars.** When each site works: a store's opening hours and its receiving window (often early morning only), a warehouse's shifts and receiving hours, a dark store's late or round-the-clock hours, a supplier's dispatch days and cut-off. How many drivers are on shift at each site, and their daily driving limit. Vehicle time rules (daytime bans on heavy trucks, night-only city deliveries). Weekly patterns. A **holiday calendar**: public and regional holidays, festivals and seasonal peaks, each a dated event with its effects: demand by category before, during and after it (the stock-up ramp, the peak, the dip after), sites closed or on short hours, fewer drivers, suppliers dispatching less or not at all. Dates move from year to year and differ by region and religion, so the calendar is the region's, loaded from a public holiday source where one covers it and completed by the user; the size of each effect is the user's figure or a range to test, labelled as such. Each calendar is an on or off pattern by hour and day, applied to the flows it governs: deliveries only within a receiving window, dispatch only during shifts, sales only while open. Drivers are counted and conserved per site, like vehicles, and a link moves no faster than its vehicles and the drivers on shift allow; a daily limit caps trips per driver. Individual duty rosters stay out (see Out of scope).
6. **Simulate and compare.** Disruptions and peaks as scenarios, and network changes (open, close or move a site, change the fleet mix) as scenarios too, compared side by side in business terms.

### What it answers

In the user's words, not ours:

- If this supplier is late, or this road closes, which stores run out of what, and when?
- What is the cheapest fix: buffer stock, moving stock between warehouses, another supplier, more trucks?
- How much to hold before a festival or peak?
- Which supplier, site or route is the weakest link?
- Would a new warehouse or dark store here help, overall, and when does it pay back? Under normal weeks and under stress.

### Results in business terms

Days out of stock per store and category, sales lost, service level, delivery time, and cost (transport, holding, fixed), each against the baseline, two options side by side. TEU and anchorage waits stay available for port users, not in front of everyone.

### Network what-ifs

A candidate site sits on the map on standby (routed, no stock, no orders, no trucks), as standby lanes do for diverted cargo today. Opening it is a scenario: from a chosen day, chosen stores order from it and it gets stock and trucks. The fork and comparison machinery is reused, and a site can open in the middle of a peak or a disruption. Several candidates run one after another and are ranked in one table: net cost, stock-out days and months to pay back, under normal and stressed weeks. Fixed costs (rent, staff) are the user's figures. A dark store's extra customers are a guess, so they are a range the user sets, with a check on whether the decision holds across it.

### What to keep, what to rebuild

- **Keep:** the engine templates (Warehouse becomes Store and Distribution centre; Port becomes one kind of Supplier), the road graph and routing, the map view (corridors, geography, scenario colours), provenance labelling, the coverage report, scenarios as forks with supplied schedules, standby sites, sessions saved with the project and working offline.
- **Rebuild:** the model builder (`regionModel.mjs` assumes port to zone to town; it becomes a builder from placed sites with roles and links), the window's steps (Map, Sites, Links, Model, Scenarios, Compare), the summary (business terms), and discovery (from the source of the network to a layer of suggestions).
- **New:** a Supplier source; stock at stores; product categories; a vehicle catalogue with fleets based at sites (generalising today's two truck sizes per lane); links the user edits; fixed costs; a last-mile delivery block for dark stores; incremental routing (moving one site re-routes only its links), since building a 30-site region already takes over 30 seconds.

### Questions for the people it is for

Asked of two or three supply chain practitioners before building, because everything above depends on the answers:

1. What does your network look like: how many suppliers, warehouses and stores; where do ports come in, if at all?
2. Which decisions do you lose sleep over, and how often do you make them?
3. What went wrong in your worst week last year, and what would you have wanted to know a week before?
4. What data do you have (sales by store and product, purchase orders and receipts, transport bills, site lists), and in what form?
5. Do you think in products, categories or total volume?
6. Is a new warehouse or dark store something you are weighing now?
7. Would your data be allowed to leave your laptop?
8. Which holidays and festivals move your demand, by how much and in which categories, and how early do you start stocking up?

## Who it is for

| | Infrastructure owners | Fleet operators | E-commerce |
|---|---|---|---|
| **Who** | Government bodies and large operators running ports, roads and railways | Companies running trucks of several sizes between factories, warehouses and shops, for themselves or on contract | Large online retailers and marketplaces |
| **Their question** | Where are the bottlenecks between the port and its hinterland, and what does a road, rail link, inland depot or gate policy change? | How many trucks, of what size, based where? How much empty running? Can we take this contract? | Where do fulfilment and sort centres go, and how do they cope with peak days? |
| **Horizon** | Years, with hourly congestion | Days to months, replanned daily | Months, with peak days |
| **Model detail** | Corridors, modes, congestion | Fleets as counts per depot and lane, loaded and empty | Many sites, high and uncertain volume |
| **Data they hold** | Traffic counts, port throughput, masterplans | GPS trackers, trip logs, orders | Everything, in-house |

**Retail and distribution chains** (added October 2026): regional grocers and retailers with suppliers, a few distribution centres and tens of stores. Their question is which stores run out when something breaks, what the cheapest fix is, and whether a new warehouse or dark store pays. They decide over weeks to months, think in categories and stores, and hold sales and purchasing data in spreadsheets and their point-of-sale system. The general supply network is built for them first.

**Fleet operators** (the first audience until October 2026). Their pain is concrete and costed per kilometre, they can decide quickly, and they already hold the data a calibrated model needs. **Long-term: infrastructure owners,** where Konjugate's strength in network flow and congestion matters most, but sales cycles are long and a working reference helps. **E-commerce:** the large platforms build their own tools; their delivery and warehousing partners look like fleet operators and are reachable.

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
| Product categories | Yes, new | Each category its own copy of the network (states are scalars), its goods conserved on their own; vehicles and room are shared among a link's or a site's categories when the model is built, not as it runs. |
| Suppliers that make to order | Yes, new | An order book, a three-stage lead time and a ready stock per supplier; what waits on its lanes is what it has to make or has ready. |
| Lanes as their own component | Yes, new | A lane bundle carrying its lead time, cost per TEU-km and truck use, so a site can take several lanes. |
| Rail as a second mode | Yes, new | A rail lane with a timetable-like capacity (trains per day times boxes per train) beside the road lanes; the split between them follows capacity and cost. |
| Ships queueing for berths | Yes, new | Anchorage as a stock of waiting vessels (in TEU) at each port, served at the berths' handling rate; waiting time follows from queue over rate. |
| Costs and service KPIs | Yes, new | Accumulator states: transport, holding, idle trucks, late or lost orders; fill rate. |
| Congestion on shared roads | Partly | Mesoscopic road cells, as in Konjugate's OpenStreetMap traffic proposal; travel time rises with flow. |
| Traffic by time of day | Partly | Piecewise rates on `t`; meaningful with sub-hourly steps. |
| Calendars and shifts | Yes, new | On or off patterns by hour and day (stored schedules or piecewise rates on `t`) multiplying the flows they govern; drivers as conserved counts per site beside vehicles. Fits the 15-minute step. |
| Keeping the model in step with live data | No, engine work | State estimation: pull model states towards observations as they arrive. |
| Individual vehicles in the twin | Partly | Positions are aggregated into lane stages for the model; the dashboard shows each vehicle from the feed. |
| Choosing the best sites or fleet mix | No | Konjugate simulates; it doesn't search. Guided searches over many runs (see working answers), or an external optimiser proposing designs that Konjugate stress-tests. |
| Running as a service | Partly | A control centre wants a server and a browser dashboard; Konjugate's web edition is a starting point. |

## Roadmap

Each milestone ends with something that can be shown. Milestones A to H make the general supply network and come first; the numbered milestones after them are the original roadmap, kept for port and infrastructure users and for the twin.

- **A. Sites with roles on a map.** (Done, as [Map first](mapFirst.md) describes: a road-only load at two levels, the palette and a card per site with its figures labelled assumed, yours or sourced, sites snapped to the roads, suggestions from public data only when asked for, a CSV in and out, the session kept with the project. Every role maps onto today's templates until C.) The role palette, placing and moving sites with their forms, a light map fetch, a spreadsheet in and out, discovery as suggestions. *Done when* a user builds a network of three suppliers, two warehouses and twenty stores on a city map in ten minutes, saves it, and reopens it offline.
- **B. Links and fast routing.** (Done, and since then travel times of the user's own on any link, typed, pasted, loaded or read off Google Maps or OpenStreetMap, with a calibration from them for the rest: links suggested, drawn, moved and deleted by dragging on the map; the road graph compacted and routed in the window with A*, a moved site re-routing only its own links in milliseconds on a whole emirate's roads; the model built from the links.) Suggested links, links edited by dragging, incremental routing. *Done when* moving one site re-routes only its links in under a second, and every link says how it was routed. The plan for A and B, file by file, is in [Map first](mapFirst.md).
- **C. Stock where it is held, by category and vehicle.** (Partly done: counted in pallets; a storage capacity and a stock cover at warehouses, stores and dark stores, a warehouse never ordering past its room; stores and dark stores that hold stock and run out, restocked by road; a catalogue of vehicle types (heavy, medium and small trucks and mini-vans by default, with capacity, costs, top speed, loading time and whether they may deliver to stores), each link on one or two of them with a fleet the user sets or the toolbox sizes, each type one set of parameters for every lane it runs on, goods and vehicles conserved; of the sales a store cannot make for want of stock, a share lost (80% at a store, 50% at a dark store by default) and the rest waiting; product categories (ambient, chilled and frozen by default, up to six), each its own copy of the network in the model, so a store runs out of one while another stays in stock, with a site's mix of them, its vehicles and its room shared among them; suppliers that make what is ordered from them, each order taking the lead time of its category or the supplier's own, up to what they can make a day, late when short and never dropping an order; refrigerated vehicles, the only ones chilled and frozen goods go by; a shelf life for goods that keep only so long (chilled goods, ten days by default), with what a site holds beyond what it can sell in time wasted and counted. Links between warehouses: a standing link, one warehouse restocking another with its share of what that one needs, and a backup, which carries nothing until a scenario has the warehouse order elsewhere and then takes those orders first. Still to do: a shelf life that follows the goods from site to site (today each site is judged on its own); vehicles shared between a link's categories as they run and a site's room shared between them (today each category has its own), which belong with fleets based at sites and shared among their links; city bans by road class; a supplier's reliability; a category's own stock cover.) Suppliers as sources, stores that hold stock and run out, a handful of product categories with their own suppliers and lead times, and the vehicle catalogue with fleets at sites. *Done when* a store runs out of one category while another stays in stock, a chilled category runs short on a link with too few refrigerated vehicles, and the model still conserves goods and vehicles.
- **D. Results in business terms.** (Mostly done: a scenario's result opens with one sentence on which stores ran out and for how long, the sales lost in pallets and in money (at each store's value of a pallet sold) and running costs against the baseline; then demand met, sales lost, transport, fleet and holding costs, and the stores it touched; waits, backlog cost, ports, lanes and stock under Details. Every run is kept, and the latest is set beside an earlier one, on the same build or another, with each difference marked better or worse. By category: a store is out while any category it sells is, the categories it ran out of are named in the sentence and under its name, and a table gives for each category the stores that ran out of it, the longest and the sales of it lost; the sales lost of each category are set side by side between runs. Still to do: delivery time to customer areas.) Stock-out days per store and category, sales lost, service level, delivery time and cost, two runs side by side. *Done when* a supply chain manager reads the comparison without help.
- **E. Scenarios for a supply network.** (Partly done: a supplier short, late or both, in everything it supplies or one category, its warehouses waiting or ordering what it cannot make from their other suppliers; a road closed, vehicles short and a demand peak run on a network with categories and report by category, a warehouse down or a store closed, the stores it restocks waiting or ordering from their other warehouses; and each tab speaks of the network it is on (vehicles, stores, warehouses and suppliers, or trucks, towns and ports). And the failures ranked: each supplier, warehouse and road failed in turn for the same days, worst first by the sales lost, which answers "which supplier, site or route is the weakest link" as a comparison of what each costs, not of which is likely. Still to do: a holiday from the calendar in F; and a customer area served by two warehouses still takes only its usual share from the one left when the other is down.) A supplier late or short, a site down, a demand peak (one-off, or a holiday from the calendar in F), a road closed, trucks short; most exist and are generalised. *Done when* each runs on a network built in A to C and reports in D's terms.
- **F. Calendars and shifts.** (Partly done: a site's hours on its card, from an hour to a later one on the days ticked: when a store is open, when a store or a warehouse receives, when a warehouse or a supplier dispatches (its dispatch days too). They are stored schedules in the model, the same in the baseline and every scenario: a store that receives only from 6 to 9 loses sales when its warehouse dispatches by day and none when it dispatches at night. A holiday calendar: dated events with their effect on demand by category while they last and in the days before and after, and suppliers that do not dispatch over them, in the baseline as in every scenario; and a run of the network as planned, with no disruption, whose losses are its own, so that a festival shows which stores run out of which categories and a second run with more stock cover shows what holding more saves. Still to do: hours past midnight, holidays loaded from a public source and with dates, not days of the run, sites closed or on short hours over a holiday, drivers on shift with a daily limit, vehicle time rules, and the hours and holidays in the CSV of sites.) Opening hours, receiving windows, warehouse shifts, supplier dispatch days, drivers on shift with a daily limit, vehicle time rules (daytime bans, night-only delivery), weekly patterns, and the holiday calendar (dated holidays, festivals and peaks with their effects on demand, sites, drivers and suppliers). *Done when* a store that can receive only before 9 am runs out when its delivery reaches it at noon, and a second warehouse shift fixes it; and a festival in the holiday calendar shows which stores run out of which categories unless stock is built up the weeks before.
- **G. Network what-ifs.** (Partly done: a warehouse placed as a candidate, with a fixed cost a month and a cost to open, is left out of the model; the network as it is and the network with each candidate open are built and run over the same days, in normal weeks and under a chosen disruption, and set side by side with a sentence on whether each earns its keep: months to pay back when it is cheaper to run, or how often the disruption must come when it is dearer. Closing a site is the Site down scenario; a change of fleet the Fleet scenario. Still to do: opening a site part way through a run, as the direction first had it (a new site starts with no stock, and the model cannot create any); candidate stores and dark stores, whose extra customers are a guess to be given as a range; several candidates open together; moving a site; shifts, with F.) Opening, closing or moving a site as a scenario, changing the fleet mix (more vans and fewer trucks, more refrigerated capacity) or the shifts, fixed costs, payback, candidates ranked. Judged with the calendars in place, since a site's value depends on when it works. *Done when* three candidate warehouse sites are ranked on net cost and stock-out days under a normal and a peak week, and a change of fleet mix is compared the same way.
- **H. Dark stores and the last mile.** Online orders within a radius, delivered by riders or vans (vehicle types from C) against a time promise, beside walk-in sales, within the dark store's hours (F). *Done when* adding a dark store changes delivery times and stock-outs for the areas it serves.

A short video (three to five minutes, one question in the viewer's terms, answered in the first minute) follows D; a longer tutorial follows G.

The original roadmap:

1. **Lanes, fleets, ports and costs.** (Done: two truck sizes per lane, each with its cost per kilometre and per day; fill rate is worked out from the zones' running totals rather than kept as a state.) Road and rail lane bundles, fleet stocks by truck size, anchorage queues with berth capacity, cost and KPI accumulators. *Done when* the example reports vessel waiting time, cost, fill rate and truck utilisation, and adding berths, trains or trucks changes them.
2. **Region import.** (Mostly done: the Logistics Toolbox window searches a place, fetches its OpenStreetMap data, reports coverage, lets the user curate on a map and in lists (tick, top N, drag, add, CSV), and builds a steady model into the canvas. Tried on a real region (the Gulf coast around Jebel Ali): tiled and retried fetches, English names, filtering of passenger harbours and non-logistics industry, port volumes shared by port land, towns served by several zones, cities split into demand areas by their suburbs, and the session saved with the project. Still to do: merging two candidates, rail lanes, and a threshold per kind.) Region search, discovery from OpenStreetMap, clustering, significance ranking, the curation step with the coverage report, and model generation with in-process routing. A CSV of the user's own sites as an alternative input. *Done when* a region is loaded, curated, reported on and turned into a runnable model, and moving a site changes its lead times and costs.
3. **Port activity and external drivers.** (Mostly done: ports are matched to IMF PortWatch by position; a matched port's container imports set its volume, and its arrivals can follow the daily history through a stored parameter schedule, a Konjugate core feature added for this. A chokepoint disruption forks the model on the day it starts and cuts each dependent port's arrivals by its share through the chokepoint; the shares come from geography, since PortWatch publishes no port-to-chokepoint links, and the chokepoint's recent drop in transits can set the cut. Still to do: sea approaches with their own transit times.) A PortWatch importer on the fintech importer pattern (fetch, cache, CSV), sea approaches per port, and generic chokepoint scenarios. *Done when* a port's modelled arrivals follow its PortWatch history and a chokepoint fork changes them.
4. **The first showcase session.** (Mostly done: a fleet operator, the user's own from a JSON file or an invented one labelled synthetic, runs its lanes with two truck sizes; the window has four scenarios, a chokepoint disruption (its cargo lost, delayed, or diverted to a port outside the chokepoint and trucked inland over standby lanes), a road closure (trucks wait, detour, or the warehouse orders from other ports), a fleet change and a demand surge, each summarised against the baseline in deliveries, costs, waits, stock and backlog; every input, the model-wide constants included, is labelled sourced, routed, assumed, synthetic or the user's; `liveRegionCheck.mjs --scenarios` runs a real region for a month under each. Still to do: the curated showcase region itself, saved as a private session, and its walkthrough script.) A curated region, dated volumes, the synthetic fleet operator and the scripted scenarios. *Done when* it runs for a month under each scenario and every input is labelled sourced, assumed, synthetic or the user's.
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
| Public holiday calendars | National and some regional public holidays by date | Several free sources and APIs exist; coverage varies by country and few include regional or religious festivals, so the user completes the calendar. Check coverage and terms per country. |

## Out of scope for now

- **Solving vehicle routing and crew rostering** (which truck visits which customers in what order, which driver works which hours). Drivers are modelled as counts on shift with a daily limit, not as named people. A separate combinatorial problem with good existing solvers; the twin can take a routing plan as input rather than compute one.
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
