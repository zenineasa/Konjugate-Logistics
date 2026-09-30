# Port and warehouse network

## Overview

A container port feeds two warehouses by road, and the warehouses serve three groups of customers. Ships bring 100 TEU a day and wait at anchorage until the berths unload them into the yard. Each warehouse orders from the port; trucks on its road lane carry the containers there and return empty. Warehouse A serves Zones 1 and 2, and Warehouse B serves Zone 3. Stocks are in TEU (twenty-foot equivalent units) and fleets in trucks of 2 TEU. Simulation time is in seconds, so day 10 on the timeline is 864,000 s and 120 days is 10,368,000 s. Costs are in unnamed cost units. The parameters are illustrative, not calibrated to any real port.

## What it shows

Containers and trucks are conserved by construction. The edges that move containers are bidirectional, so what leaves the yard enters a lane and what leaves a lane enters a warehouse. Trucks leave loaded, return empty and wait at the port, and always add up to the fleet. Several things limit the flow:

- The berths unload at most 150 TEU a day, or their outage capacity from day 20 to 50. The anchorage wait is the waiting cargo divided by that capacity.
- A road lane can only ship as fast as its idle trucks allow. A fleet carries at most trucks × 2 TEU per round trip, and lane A's round trip takes about 4.25 days, so its 170 trucks carry at most 80 TEU a day.
- Each warehouse orders by an order-up-to rule, counting what is on order across its lanes.
- Warehouse A serves Zone 2 only while it holds more than 60 TEU, so Zone 1 is served first when stock runs short.
- Demand steps up by a multiplier from day 20.

Every lane, warehouse and zone keeps a running cost: transport per truck-km, holding per TEU-day in stock, and backlog per TEU-day waiting. In the baseline nothing switches and nothing moves.

## What to try

1. Run it for 120 days. Nothing moves: 25 TEU wait at anchorage, the yard holds 300 TEU, Warehouse A holds 210 TEU, and every zone is fully served.
2. Scrub the timeline to day 10 and choose Fork here. Lower Berth capacity during outage to 30 and run to day 120:
    - Ships queue at anchorage: 2,125 TEU are waiting by day 50, and a newly arriving ship would wait about 68 days.
    - The yard runs almost dry by day 33. Over days 20 to 60, Zone 1 receives 80% of its orders, but Zone 2 only 41%.
    - The anchorage clears by day 92. But lane A's trucks can carry at most 80 TEU a day, so Zone 2 is still 632 TEU behind at day 120: the trucks, not the port, set the pace of recovery.
3. Fork the baseline again at day 10. Raise Demand step multiplier to 1.3 and Vessel arrivals to 130, so demand rises from 100 to 130 TEU a day at day 20 and ships keep pace:
    - The port copes: the anchorage wait stays under a day.
    - The trucks don't. Lane A needs 91 TEU a day but its 170 trucks carry 80, so Zone 2 receives only 79% of its orders after day 60, and its backlog reaches 1,004 TEU by day 120. Zone 3, served by lane B, falls behind too.
    - The port's dispatches jump to 127 TEU a day at day 23 while the warehouses rebuild stock, then settle at what the fleets can carry. That overshoot is the bullwhip effect.
4. Fork as in step 3, and also raise Fleet size to 210. Lane A hires 40 trucks over a few days and carries the full 91 TEU a day. Zone 2 receives over 99% of its orders again. Over the whole run, lane A's transport cost rises by 12% and Zone 2's backlog cost falls by 94%. Zone 3 is still short: only lane A's fleet changed.
5. Open the Parameters table. Each lane has its own travel time, distance and fleet size; truck capacity, costs and the stock cover target are shared by every component.

## Assumptions and limits

- Flows are continuous rates, not discrete vessel calls, truckloads or containers.
- Each road lane has its own fleet; trucks don't move between lanes.
- Travel times are fixed per lane. Road congestion and route choice are not modelled.
- Costs are illustrative unit rates, not market prices.
- This is a synthetic model for exploring the mechanism. It is not a forecast and has not been validated against real data or reviewed by a practitioner.
