/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { boundsWith } from '../../packages/toolbox/lib/geo.mjs';

test('the area a map fits holds every site placed, one beyond the region loaded too', () => {
    const city = { south: 12.8, west: 77.4, north: 13.2, east: 77.8 };
    assert.deepEqual(boundsWith(city, []), city);
    assert.deepEqual(boundsWith(city, [{ lat: 13.0, lon: 77.6 }]), city, 'a site within it changes nothing');
    // A distribution centre west of town and a dairy to the north-east.
    assert.deepEqual(boundsWith(city, [{ lat: 13.1, lon: 77.39 }, { lat: 13.29, lon: 77.9 }, { lat: undefined, lon: 5 }]), { south: 12.8, west: 77.39, north: 13.29, east: 77.9 });
});
