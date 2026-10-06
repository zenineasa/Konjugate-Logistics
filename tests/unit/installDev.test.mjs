/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { currentArchives } from '../../scripts/installDev.mjs';

test('a dev install takes only this version\'s archives, not one an earlier version left in out/', () => {
    const names = ['konjugate.logistics.toolbox-0.1.0.kja', 'konjugate.logistics.toolbox-1.0.0.kja', 'konjugate.logistics.engine-0.1.0.kjp', 'konjugate.logistics.engine-1.0.0.kjp', 'regionCache', 'models'];
    assert.deepEqual(currentArchives(names, '1.0.0'), ['konjugate.logistics.toolbox-1.0.0.kja', 'konjugate.logistics.engine-1.0.0.kjp']);
    assert.deepEqual(currentArchives(['konjugate.logistics.toolbox-11.0.0.kja'], '1.0.0'), []);
});
