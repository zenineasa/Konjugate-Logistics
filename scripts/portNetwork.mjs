/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A port feeding two warehouses by road, and three demand zones, built only from this plugin's
// templates:
//
//   Port --road lane A--> Warehouse A --delivery--> Zone 1, Zone 2 (served only above safety stock)
//        --road lane B--> Warehouse B --delivery--> Zone 3
//        --rail lane-->   Warehouse A                (optional)
//
// Every initial value is the steady state, so with the defaults nothing moves. Options change one
// thing at a time: vessel arrivals, berth capacity (and during the outage window), the demand
// step, lane A's fleet, and an optional rail lane taking a share of Warehouse A's orders.

import { roadLaneState as laneSteadyState } from '../packages/toolbox/lib/regionModel.mjs';
import { loadTemplates, ModelBuilder } from './templatePlacement.mjs';

export const portNetworkDefaults = {
    vesselArrivals: 100, berthCapacity: 150, outageCapacity: 150, outageStart: 20, outageEnd: 50,
    stepDay: 20, stepMultiplier: 1, days: 120,
    // Lane A's fleet: 70 loaded + 70 returning + 30 idle at the port in steady state. laneAFleetSize
    // is what it hires or releases towards; it defaults to the fleet it starts with.
    laneAFleet: 170, laneAFleetSize: undefined,
    // Trucks of the second size (1 TEU each) on lane A; none in the example.
    laneAFleet2: 0,
    // Share of Warehouse A's orders sent by rail; 0 leaves the rail lane out.
    railShare: 0
};

// The templates' own truck capacity, loading time and order response time.
const roadLaneState = (rate, leadTime, fleet, fleet2 = 0) => laneSteadyState(rate, leadTime, fleet, { truckCapacity: 2, loadDays: 0.25, responseDays: 0.5, fleet2, truckCapacity2: 1 });

export async function buildPortNetwork(options = {}) {
    const settings = { ...portNetworkDefaults, ...options };
    return (await buildPortNetworkModel(settings)).document({ days: settings.days });
}

// The same network, as a ModelBuilder that can still be changed before its document is taken.
export async function buildPortNetworkModel(options = {}) {
    const settings = { ...portNetworkDefaults, ...options };
    const model = new ModelBuilder(await loadTemplates());
    const berthingDays = 0.25;
    const port = model.placeNode('port', {
        position: [-10, 0, 0],
        initialValues: { queue: settings.vesselArrivals * berthingDays, waitDays: settings.vesselArrivals * berthingDays / settings.berthCapacity },
        shared: {
            vesselArrivals: settings.vesselArrivals, berthCapacity: settings.berthCapacity, outageCapacity: settings.outageCapacity,
            outageStart: settings.outageStart, outageEnd: settings.outageEnd
        }
    });

    const railShare = settings.railShare;
    const railLead = 1;
    // In steady state a warehouse's on-order count is what waits on its lanes (half a day's flow)
    // plus what is in transit; its stock is whatever makes stock + on order equal its target
    // position, forecast x (planned replenishment time + stock cover).
    const warehouse = (name, position, demand, planningLeadTime, lanes) => {
        const onOrder = lanes.reduce((total, { rate, leadTime }) => total + rate * (0.5 + leadTime), 0);
        return model.placeNode('warehouse', {
            name, position,
            initialValues: { stock: demand * (planningLeadTime + 3) - onOrder, onOrder, forecast: demand, orderRate: demand },
            shared: { planningLeadTime }
        });
    };
    const warehouseA = warehouse('Warehouse A', [0, 3, 0], 70, 2.5,
        [{ rate: 70 * (1 - railShare), leadTime: 2 }, ...(railShare > 0 ? [{ rate: 70 * railShare, leadTime: railLead }] : [])]);
    const warehouseB = warehouse('Warehouse B', [0, -3, 0], 30, 3.5, [{ rate: 30, leadTime: 3 }]);

    const roadRateA = 70 * (1 - railShare);
    const laneA = model.placeNode('roadLane', {
        name: 'Road lane A', position: [-5, 3, 0],
        initialValues: roadLaneState(roadRateA, 2, settings.laneAFleet, settings.laneAFleet2),
        shared: { leadTime: 2, distance: 120, fleetSize: settings.laneAFleetSize ?? settings.laneAFleet, fleetSize2: settings.laneAFleet2 }
    });
    const laneB = model.placeNode('roadLane', {
        name: 'Road lane B', position: [-5, -3, 0],
        initialValues: roadLaneState(30, 3, 105), shared: { leadTime: 3, distance: 180, fleetSize: 105 }
    });
    model.applyBundle('roadShipment', { origin: port, lane: laneA, destination: warehouseA }, { shared: { orderShare: 1 - railShare } });
    model.applyBundle('roadShipment', { origin: port, lane: laneB, destination: warehouseB });
    if (railShare > 0) {
        const railRate = 70 * railShare;
        const rail = model.placeNode('railLane', {
            name: 'Rail lane', position: [-5, 6, 0], shared: { leadTime: railLead },
            initialValues: { loaded1: railRate * railLead / 3, loaded2: railRate * railLead / 3, loaded3: railRate * railLead / 3, requested: railRate * 0.5, arriving: railRate }
        });
        model.applyBundle('railShipment', { origin: port, lane: rail, destination: warehouseA }, { shared: { orderShare: railShare } });
    }

    const zone = (name, position, demand) => model.placeNode('demandZone', {
        name, position, initialValues: { backlog: demand * 0.5, demandRate: demand },
        shared: { baseDemand: demand, stepMultiplier: settings.stepMultiplier, stepDay: settings.stepDay }
    });
    const zone1 = zone('Zone 1', [8, 5, 0], 30);
    const zone2 = zone('Zone 2', [8, 1, 0], 40);
    const zone3 = zone('Zone 3', [8, -3, 0], 30);
    model.applyBundle('delivery', { warehouse: warehouseA, zone: zone1 }, { shared: { share: 0.5 } });
    model.applyBundle('delivery', { warehouse: warehouseA, zone: zone2 }, { shared: { share: 0.5, safetyStock: 60 } });
    model.applyBundle('delivery', { warehouse: warehouseB, zone: zone3 }, { shared: { share: 1 } });
    return model;
}
