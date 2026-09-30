# Port and warehouse network

## Overview

A container port feeds two warehouses, which serve three groups of customers. Vessels discharge 100 TEU a day into the port's yard, and each warehouse orders from the port to keep its stock and inbound pipeline on target. Warehouse A serves Zones 1 and 2, and Warehouse B serves Zone 3. Stocks are in TEU (twenty-foot equivalent units). Simulation time is in seconds, so day 10 on the timeline is 864,000 s and 120 days is 10,368,000 s. The parameters are illustrative, not calibrated to any real port.

## What it shows

Containers are conserved by construction: the edges that move them are bidirectional, so what leaves the yard enters a warehouse's inbound lane, and what leaves a warehouse is delivered to a zone. Each warehouse's inbound lane has three in-transit stages, which spread its lead time the way real transit times spread. It orders by an order-up-to rule: the demand forecast plus a correction towards its stock and pipeline targets. The rules that switch on and off are piecewise equations:

- The port gate runs at a reduced capacity during an outage window, days 20 to 50.
- A warehouse expedites its inbound lane, halving the lead time, while its stock is below a threshold.
- Warehouse A serves Zone 2 only while it holds more than 60 TEU, so Zone 1 is served first when stock runs short.
- Demand steps up by a multiplier from day 20.

In the baseline, the outage capacity equals the normal gate capacity and the demand multiplier is 1, so nothing switches.

## What to try

1. Run it for 120 days. The network is balanced, so nothing moves: the yard holds 300 TEU, Warehouse A 210 TEU, and every zone is fully served.
2. Scrub the timeline to day 10 and choose Fork here. Lower Gate capacity during outage to 30 and run to day 120. For 30 days the gate releases 30 TEU a day against 100 arriving, so the yard grows from 300 to 2,400 TEU by day 50. Warehouse A expedites and its pipeline falls from 140 to 21 TEU. Zone 1 still receives 92% of its orders over days 20 to 60, but Zone 2 gets only 36% and its backlog peaks above 1,000 TEU. After the gate reopens, the zones catch up, but by day 120 the yard still holds 560 TEU and Zone 2 has not fully recovered.
3. Fork the baseline again at day 10. Raise Demand step multiplier to 1.3 and Vessel arrivals to 130, so demand rises from 100 to 130 TEU a day at day 20 and supply keeps pace. The customers barely notice: every zone receives over 99% of its orders. Upstream, the warehouses rebuild stock and pipeline for the higher demand, and the port's dispatches peak at 144 TEU a day around day 27, before settling at 130. That overshoot is the bullwhip effect: a 30 TEU a day step in demand becomes a 44 TEU a day swing at the port.
4. Open the Parameters table. Each warehouse has its own lead times and each lane its own share, while constants such as the stock cover target and the demand smoothing time are shared by every component.

## Assumptions and limits

- Flows are continuous rates, not discrete vessel calls, truckloads or containers.
- Lead times are fixed per warehouse, apart from expediting. Road traffic and route choice are not modelled.
- Each warehouse's inbound lane belongs to that warehouse, so a warehouse is supplied by one port.
- This is a synthetic model for exploring the mechanism. It is not a forecast and has not been validated against real data or reviewed by a practitioner.
