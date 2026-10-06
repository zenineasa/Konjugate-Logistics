<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Interaction

How the toolbox window should feel to three kinds of user, and what that means for every action in it. Keep this current when an action is added or changed.

## Three users

- **A newcomer** reads the screen. Every action has a visible, labelled button, a field or a menu item; nothing depends on knowing a gesture or a key. The window says what to do next (the Network step's checklist), why a button is unavailable (its tooltip) and why something was refused (a message on the map and in the step). Nothing they do is lost: every change can be undone.
- **A regular user** works on the map. Click to select, drag to move or link, right-click for the menu of what is under the pointer, click twice to rename. The card in the panel and the bar beside the selection follow what they do.
- **A power user** keeps their hands on the keyboard and works on many things at once: shortcuts for every frequent action, several sites selected at a time (Shift-click, a box, select all) and acted on together, and undo and redo for everything.

## Rules

1. **Every action three ways**: a button or menu item (newcomer), a direct gesture on the map (regular), a key (power). A key is never the only way.
2. **Shortcuts are taught where they are used**: in tooltips, beside menu items, in the hint over the map, and all of them under `?`.
3. **Act on the selection.** Delete, duplicate, move and fit act on everything selected, with one undo step.
4. **Undo everything**, not only deletions; say what was undone. Steps of one kind in quick succession (a pin nudged with the arrows, a figure typed) are one step.
5. **Refuse with a reason, where the user is looking**: on the map, and in the Network step.
6. **Escape always backs out** one level: a menu, the shortcuts, a link being drawn, placing, then the selection.
7. **No surprises on keys**: keys act only when the user is not typing in a field.
8. **Every platform as its own users expect** (see below): Windows and Linux are not an afterthought to the Mac, nor the other way round.
9. **Tests cover each way**: the window test (`tests/window/networkWindow.mjs`) does each action by button or menu, by gesture and by key.

## Platforms

Konjugate runs on Windows, Linux and macOS, and so does the window. `lib/platform.mjs` decides, from the platform, which keys mean what and how they are written; nothing else in the window names a key of one platform.

| | Windows and Linux | macOS |
|---|---|---|
| Command key | Ctrl (the Windows key belongs to the system) | ⌘ (Control is for menus) |
| Undo, redo | Ctrl+Z; Ctrl+Y or Ctrl+Shift+Z | ⌘Z; ⇧⌘Z |
| Select all, duplicate | Ctrl+A, Ctrl+D | ⌘A, ⌘D |
| Delete | Delete or Backspace | ⌫ (the key marked delete) or ⌦ |
| Add to the selection | Shift-click or Ctrl-click | Shift-click or ⌘-click |
| Menu | Right-click | Right-click, two-finger click or Control-click |
| Rename | F2 or Enter | Enter (or F2) |

The window test runs the whole workflow as a Windows or Linux user would, then checks the keys, labels and clicks as a Mac user would (`tests/window/networkWindow.mjs`, step 14); `tests/unit/platform.test.mjs` checks the table above.

## Actions

The command key is Ctrl on Windows and Linux and ⌘ on a Mac (see Platforms).

| Action | Newcomer | Regular | Power |
|---|---|---|---|
| Place a site | Palette above the map, then click the map; map menu "Place a … here" | Right-click the map | `1` to `6`, then click; the same key again to stop |
| Stop placing | Click the role again | | `Escape` |
| Select | Click it, or its row in the list | Click it on the map | Shift-click or command-click to add; Shift-drag a box (with the command key: add); select all |
| Rename | The name on its card, or in the bar beside it | Click it twice | `Enter` or `F2` |
| Change its role | The role on its card | Its menu, "Make it a …" | |
| Change a figure | Its card | | |
| Move | | Drag it (dragging one of several selected moves them all) | Arrow keys (Shift: further) |
| Duplicate | Its card, or the selection's card | Its menu | Command+D |
| Delete | Delete on its card, or in the bar beside it | Its menu | The delete key |
| Link two sites | "Supplied from" or "Supplies" on its card: add a site | Drag from its handle, Shift-drag from it, or "Link it to another site…" in its menu then click the other | `L`, then click the other |
| Remove a link | ✕ beside it on the card, or Delete on the link's card | Click it, then Delete in the bar; its menu | Click it, then `Delete` |
| Move a link's end | | Drag the end of a selected link | |
| Keep a suggested link | "Make it mine" on the link's card | Its menu | |
| Undo, redo | ↶ ↷ above the map; Undo in the message after a change | | Command+Z; Command+Shift+Z (or Ctrl+Y) |
| Fit the map | Fit above the map | Map menu | `F` (the selection, or the network), `0` (the region) |
| Zoom | + and − above the map | Wheel | `+`, `-` |
| Adopt a suggestion | Adopt in the list, or Adopt the top N | Click it on the map; its menu | |
| See the shortcuts | ? above the map | | `?` |
| Load an area again fresh | Load fresh beside Load roads, or beside the date the roads were fetched | | |
| Clear the maps kept on this computer | Clear at the foot of the Map step | | |

## Not yet

- Copy and paste between sessions, and a search to jump to a site by name.
- Keyboard focus moving through the sites on the map (Tab), for users who do not use a pointer at all.
- Touch: a long press for the menu.
