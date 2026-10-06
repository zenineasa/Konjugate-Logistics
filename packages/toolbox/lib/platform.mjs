/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The keys of the platform the window runs on, so shortcuts behave and read as its users expect: ⌘ and ⌫ on a Mac,
// where Control-click opens a menu; Ctrl and Delete on Windows and Linux.

export function platformKeys(platform = globalThis.navigator?.platform ?? '') {
    const mac = /Mac|iPhone|iPad/.test(platform);
    return mac ? {
        mac, modifier: '⌘', undo: '⌘Z', redo: '⇧⌘Z', selectAll: '⌘A', duplicate: '⌘D', delete: '⌫',
        deleteKeys: '⌫ (delete) or ⌦', addClick: 'Shift-click or ⌘-click', menu: 'Right-click or Control-click'
    } : {
        mac, modifier: 'Ctrl', undo: 'Ctrl+Z', redo: 'Ctrl+Y or Ctrl+Shift+Z', selectAll: 'Ctrl+A', duplicate: 'Ctrl+D', delete: 'Delete',
        deleteKeys: 'Delete or Backspace', addClick: 'Shift-click or Ctrl-click', menu: 'Right-click'
    };
}

// The platform's command modifier held: ⌘ on a Mac, Ctrl elsewhere.
export const commandHeld = (event, { mac }) => (mac ? event.metaKey : event.ctrlKey);

// A click that adds to the selection: Shift, or the command modifier.
export const addsToSelection = (event, keys) => event.shiftKey || commandHeld(event, keys);

// On a Mac, Control-click is a right click: it opens the menu, and selects nothing on its own.
export const isMenuClick = (event, { mac }) => event.button === 2 || (mac && event.ctrlKey && !event.metaKey);
