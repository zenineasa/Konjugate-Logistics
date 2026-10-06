/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shortcuts as each platform's users read and press them.

import assert from 'node:assert/strict';
import test from 'node:test';
import { addsToSelection, commandHeld, isMenuClick, platformKeys } from '../../packages/toolbox/lib/platform.mjs';

const click = (keys = {}) => ({ button: 0, shiftKey: false, metaKey: false, ctrlKey: false, ...keys });

test('a Mac reads ⌘ and ⌫; Windows and Linux read Ctrl and Delete', () => {
    const mac = platformKeys('MacIntel');
    assert.deepEqual([mac.undo, mac.redo, mac.selectAll, mac.duplicate, mac.delete], ['⌘Z', '⇧⌘Z', '⌘A', '⌘D', '⌫']);
    for (const platform of ['Win32', 'Linux x86_64', '']) {
        const keys = platformKeys(platform);
        assert.deepEqual([keys.undo, keys.redo, keys.selectAll, keys.duplicate, keys.delete], ['Ctrl+Z', 'Ctrl+Y or Ctrl+Shift+Z', 'Ctrl+A', 'Ctrl+D', 'Delete'], platform);
        assert.ok(!/[⌘⌫⇧]/.test(Object.values(keys).join(' ')), `no Mac symbols on ${platform || 'an unknown platform'}`);
    }
});

test('the command key is ⌘ on a Mac and Ctrl elsewhere, and Control-click on a Mac opens the menu', () => {
    const mac = platformKeys('MacIntel');
    const windows = platformKeys('Win32');
    assert.equal(commandHeld(click({ metaKey: true }), mac), true);
    assert.equal(commandHeld(click({ ctrlKey: true }), mac), false);
    assert.equal(commandHeld(click({ ctrlKey: true }), windows), true);
    assert.equal(commandHeld(click({ metaKey: true }), windows), false, 'the Windows key is not a command');
    assert.equal(addsToSelection(click({ shiftKey: true }), windows), true);
    assert.equal(addsToSelection(click({ ctrlKey: true }), windows), true);
    assert.equal(addsToSelection(click({ ctrlKey: true }), mac), false);
    assert.equal(isMenuClick(click({ ctrlKey: true }), mac), true);
    assert.equal(isMenuClick(click({ ctrlKey: true }), windows), false, 'Ctrl-click on Windows adds to the selection');
    assert.equal(isMenuClick(click({ button: 2 }), windows), true);
});
