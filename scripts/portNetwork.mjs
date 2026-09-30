/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A port feeding two warehouses and three demand zones, built only from this plugin's templates:
//
//   Port --dispatch--> Warehouse A --delivery--> Zone 1, Zone 2 (served only above safety stock)
//        --dispatch--> Warehouse B --delivery--> Zone 3
//
// The same network as Konjugate's tests/engine/fixtures/logisticsPortNetwork.mjs, which builds it
// by hand; tests/engine/portNetwork.mjs checks the two agree.

import { loadTemplates, ModelBuilder } from './templatePlacement.mjs';

export const portNetworkDefaults = {
    vesselArrivals: 100, gateCapacity: 150, outageCapacity: 150, outageStart: 20, outageEnd: 50,
    stepDay: 20, stepMultiplier: 1, days: 120
};

export async function buildPortNetwork(options = {}) {
    const settings = { ...portNetworkDefaults, ...options };
    return (await buildPortNetworkModel(settings)).document({ days: settings.days });
}

// The same network, as a ModelBuilder that can still be changed before its document is taken.
export async function buildPortNetworkModel(options = {}) {
    const settings = { ...portNetworkDefaults, ...options };
    const model = new ModelBuilder(await loadTemplates());

    const port = model.placeNode('port', { position: [-8, 0, 0], shared: { vesselArrivals: settings.vesselArrivals } });
    const warehouse = (name, position, demand, leadTime, expeditedLeadTime, expediteBelow) => model.placeNode('warehouse', {
        name, position,
        initialValues: { onHand: demand * 3, lane1: demand * leadTime / 3, lane2: demand * leadTime / 3, lane3: demand * leadTime / 3, forecast: demand, orderRate: demand },
        shared: { leadTime, expeditedLeadTime, expediteBelow }
    });
    const warehouseA = warehouse('Warehouse A', [0, 3, 0], 70, 2, 1, 80);
    const warehouseB = warehouse('Warehouse B', [0, -3, 0], 30, 3, 1.5, 30);
    model.applyBundle('portDispatch', { port, warehouse: warehouseA }, {
        shared: {
            gateShare: 0.7, gateCapacity: settings.gateCapacity, outageCapacity: settings.outageCapacity,
            outageStart: settings.outageStart, outageEnd: settings.outageEnd
        }
    });
    model.applyBundle('portDispatch', { port, warehouse: warehouseB }, { shared: { gateShare: 0.3 } });

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
