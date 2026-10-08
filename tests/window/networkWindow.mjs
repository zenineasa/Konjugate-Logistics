/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The map-first workflow in the toolbox window, in a plain browser with a stand-in for Konjugate's host
// (tests/window/host.mjs): the importer runs as the host runs it, the network is answered from the synthetic
// region, and no engine runs. Through the window:
//   - the sample region loads its roads and place names, and nothing else is suggested
//   - pins of every role placed from the palette snap to the roads, and links are suggested and routed
//   - a pin's card changes its name and figures; moving a pin re-routes only its own links, quickly
//   - a link drawn from a selected pin's handle, a link refused with its reason, a link deleted and not suggested again
//   - a warehouse given its storage capacity; the vehicle catalogue edited; a link's vehicles chosen on its card, from
//     its menu and with V, and a type kept off stores refused on a link to one
//   - travel times of the user's own: typed in the list and on a link's card (T), when they hold, read off Google Maps
//     and OpenStreetMap opened through the host, a column pasted, a wrong time refused or flagged, a calibration from
//     them, a CSV saved and loaded; the model built with them
//   - the model is built from the pins and links, its stores holding stock; with an engine, a store whose road closes
//     runs out
//   - suggestions appear only when asked for, as hollow pins, and are adopted by a click or from the list
//   - the network saves as a CSV and loads back from one
//   - the session is kept, and restored on reopening; a session of the earlier workflow is migrated
//   - a searched region loads its roads and place names alone, and fetches ports only when they are asked for
//
// Usage: node tests/window/networkWindow.mjs   (Playwright from the Konjugate checkout beside this one)

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSites } from '../../packages/toolbox/lib/sites.mjs';
import { createHost, loadPlaywright, openWindow } from './host.mjs';

const { chromium } = loadPlaywright();
const scratch = await mkdtemp(join(tmpdir(), 'konjugate-logistics-window-'));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const log = [];

try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    const page = await context.newPage();
    // The main pass is a Windows or Linux user's, whatever this machine is (step 14 is a Mac user's): Chromium on a Mac
    // reports MacIntel, and the window would then take ⌘, not Ctrl.
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Linux x86_64' }));
    page.on('console', (message) => log.push(`${message.type()}: ${message.text().slice(0, 300)}`));
    page.on('pageerror', (error) => log.push(`pageerror: ${error.message}`));
    const host = await createHost();
    const fail = (error) => { throw new Error(`${error.message}\nWindow log:\n${log.join('\n')}`); };
    const noErrors = () => assert.deepEqual(log.filter((line) => /^(pageerror|error)/.test(line)), [], log.join('\n'));
    const stateOf = (pick) => page.evaluate(pick);
    // A point on the map, on screen: the map's own projection, then the SVG's transform.
    const screenOf = (point) => page.evaluate(({ lat, lon }) => {
        const bbox = window.logisticsToolboxState.roads.map.bbox;
        const origin = { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };
        const svg = document.querySelector('#map');
        const p = svg.createSVGPoint();
        p.x = (lon - origin.lon) * Math.cos(origin.lat * Math.PI / 180) * 111.32;
        p.y = -(lat - origin.lat) * 111.32;
        const s = p.matrixTransform(svg.getScreenCTM());
        return { x: s.x, y: s.y };
    }, point);
    const clickAt = async (point, modifiers = []) => {
        const { x, y } = await screenOf(point);
        for (const key of modifiers) await page.keyboard.down(key);
        await page.mouse.click(x, y);
        for (const key of modifiers) await page.keyboard.up(key);
    };
    const dragBetween = async (from, to, { shift = false } = {}) => {
        if (shift) await page.keyboard.down('Shift');
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.mouse.up();
        if (shift) await page.keyboard.up('Shift');
    };
    const pins = () => stateOf(() => window.logisticsToolboxState.pins.map((pin) => ({ id: pin.id, role: pin.role, name: pin.name, lat: pin.lat, lon: pin.lon })));
    const links = () => stateOf(() => window.logisticsToolboxState.links.map((link) => ({ id: link.id, from: link.from, to: link.to, basis: link.basis, routed: Boolean(link.leg) })));
    const linkPaths = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#map path.link')].map((path) => [path.dataset.link, path.getAttribute('d')])));
    const settled = () => page.waitForFunction(() => !window.logisticsToolboxState.busy, null, { timeout: 30000 });

    // 1. The sample region: its roads and place names, and no suggestions until asked for.
    await openWindow(page, host);
    await page.click('#sampleButton');
    await page.waitForSelector('#stepNetwork:not([hidden])', { timeout: 30000 }).catch(fail);
    await settled();
    assert.ok(await page.locator('#map path.road').count() >= 7, 'the roads are drawn');
    assert.deepEqual((await page.locator('#map text.place').allTextContents()).sort(), ['Cedarton', 'Dunmore', 'Elmwick']);
    assert.equal(await page.locator('#map .site').count(), 0, 'nothing is suggested until asked for');
    assert.match(await page.textContent('#coverageSummary'), /Roads.*km/);
    assert.equal(await page.isDisabled('#buildButton'), true);
    // A newcomer sees the steps to take, not errors for what they have not had the chance to do yet.
    assert.equal(await page.locator('#networkStatus .checklist li').count(), 3);
    assert.equal(await page.locator('#networkStatus .notice.error').count(), 0);
    assert.match(await page.getAttribute('#buildButton', 'title'), /^Not yet: Place a supplier or a port/);

    // 2. A network placed from the palette: two suppliers, two warehouses, four stores, a dark store and a customer area.
    const placements = [
        ['supplier', { lat: -29.72, lon: -19.88 }], ['supplier', { lat: -29.72, lon: -19.52 }],
        ['warehouse', { lat: -29.9, lon: -19.7 }], ['warehouse', { lat: -29.76, lon: -19.5 }],
        ['store', { lat: -29.95, lon: -19.72 }], ['store', { lat: -29.85, lon: -19.69 }], ['store', { lat: -29.82, lon: -19.88 }], ['store', { lat: -29.9, lon: -19.53 }],
        ['darkStore', { lat: -29.8, lon: -19.56 }], ['customerArea', { lat: -29.75, lon: -19.62 }]
    ];
    for (const [role, point] of placements) {
        if (!(await page.locator(`[data-add="${role}"].active`).count())) await page.click(`[data-add="${role}"]`);
        await clickAt(point);
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#mapHint'), true, 'Escape leaves add mode');
    const placed = await pins();
    assert.deepEqual(placed.map((pin) => pin.role), placements.map(([role]) => role));
    assert.deepEqual(placed.map((pin) => pin.name).slice(0, 5), ['Supplier 1', 'Supplier 2', 'Warehouse 1', 'Warehouse 2', 'Store 1']);
    for (const [index, pin] of placed.entries()) assert.ok(Math.abs(pin.lat - placements[index][1].lat) < 0.002 && Math.abs(pin.lon - placements[index][1].lon) < 0.002, `${pin.name} is where it was placed`);
    assert.equal(await page.locator('#map .site.pin').count(), placements.length);
    let suggested = await links();
    const demand = placed.filter((pin) => ['store', 'darkStore', 'customerArea'].includes(pin.role));
    for (const pin of demand) assert.equal(suggested.filter((link) => link.to === pin.id).length, 1, `${pin.name} has one warehouse`);
    assert.equal(suggested.length, demand.length + 4, 'every supplier to every warehouse in a small network');
    assert.ok(suggested.every((link) => link.basis === 'suggested' && link.routed));
    assert.equal(await page.locator('#map path.link.suggested').count(), suggested.length);
    assert.equal(await page.textContent('#networkStatus'), '', 'nothing stops a build');
    assert.equal(await page.isDisabled('#buildButton'), false);
    assert.match(await page.textContent('#stepNetworkSummary'), /2 sources · 2 warehouses · 6 demand · 10 links/);
    // Kept with the project already, though nothing is built: closing the window now would lose nothing.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(host.session?.version, 2);
    assert.equal(host.session.pins.length, placements.length, 'the network placed, kept before any build');
    assert.equal(host.session.built, null);
    noErrors();

    // 3. A pin's card: a store renamed and given its own demand.
    await clickAt(placements[4][1]);
    await page.waitForSelector('#selectionCard:not([hidden]) #pinName');
    await page.fill('#pinName', 'Harbour shop');
    await page.dispatchEvent('#pinName', 'change');
    await page.fill('#field-demand', '20');
    await page.dispatchEvent('#field-demand', 'change');
    assert.equal((await pins())[4].name, 'Harbour shop');
    assert.equal(await page.textContent('#selectionCard .field .basis'), 'yours');
    assert.match(await page.textContent('#pinList'), /Harbour shop.*20 pallets a day/s);
    assert.match(await page.textContent('#selectionCard .road'), /On the roads/);

    // 3b. Beside the selected site on the map: its name, to rename it there, and Delete, which can be undone.
    await clickAt(placements[9][1]);
    await page.waitForSelector('#pinPopover:not([hidden])');
    // Beside the site, not somewhere else on the map.
    const popoverBox = await page.locator('#pinPopover').boundingBox();
    const sitePoint = await screenOf(placements[9][1]);
    // Within 40 pixels of the site, not over it.
    const gap = (box, point) => Math.hypot(Math.max(box.x - point.x, 0, point.x - box.x - box.width), Math.max(box.y - point.y, 0, point.y - box.y - box.height));
    assert.ok(gap(popoverBox, sitePoint) > 5 && gap(popoverBox, sitePoint) < 40, `the popover at ${JSON.stringify(popoverBox)} is beside the site at ${JSON.stringify(sitePoint)}`);
    // Nor over another site: beside each pin in turn, it covers none of the others.
    for (const [index, [, point]] of placements.entries()) {
        await clickAt(point);
        await page.waitForSelector('#pinPopover:not([hidden])');
        const box = await page.locator('#pinPopover').boundingBox();
        for (const [other, [, otherPoint]] of placements.entries()) {
            if (other === index) continue;
            const at = await screenOf(otherPoint);
            assert.ok(gap(box, at) > 0, `beside pin ${index + 1}, the popover at ${JSON.stringify(box)} covers pin ${other + 1} at ${JSON.stringify(at)}`);
        }
    }
    await clickAt(placements[9][1]);
    await page.waitForSelector('#pinPopover:not([hidden])');
    assert.equal(await page.inputValue('#popoverName'), 'Customer area 1');
    assert.equal(await page.textContent('#popoverRole'), 'Customer area');
    await page.fill('#popoverName', 'Hill suburbs');
    await page.press('#popoverName', 'Enter');
    assert.equal((await pins())[9].name, 'Hill suburbs');
    assert.equal(await page.inputValue('#pinName'), 'Hill suburbs', 'the card follows');
    const linksBefore = await links();
    await page.click('#popoverDelete');
    assert.equal((await pins()).length, placements.length - 1);
    assert.equal(await page.isHidden('#pinPopover'), true);
    assert.match(await page.textContent('#undoText'), /^Deleted Hill suburbs\.$/);
    await page.click('#undoButton');
    assert.deepEqual((await pins()).map((pin) => pin.name), placed.map((pin, index) => (index === 4 ? 'Harbour shop' : index === 9 ? 'Hill suburbs' : pin.name)));
    assert.deepEqual(await links(), linksBefore, 'its links come back too');
    // A double click on a site puts its name up for renaming; the Delete key deletes it too.
    const { x: dx, y: dy } = await screenOf(placements[8][1]);
    await page.mouse.dblclick(dx, dy);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'popoverName');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Delete');
    assert.equal((await pins()).length, placements.length - 1);
    await page.click('#undoButton');
    assert.equal((await pins()).length, placements.length);
    noErrors();

    // 3c. The same things three ways: a button or menu for a newcomer, a drag or a right click, and the keyboard.
    const count = async () => (await pins()).length;
    // Keys 1 to 6 choose a role to place, as the palette's buttons do, and say so.
    await page.keyboard.press('4');
    assert.equal(await page.locator('[data-add="store"].active').count(), 1);
    assert.match(await page.textContent('#mapHint'), /place a store, as many as you like/);
    await clickAt({ lat: -29.93, lon: -19.6 });
    await page.keyboard.press('4');
    assert.equal(await page.locator('[data-add].active').count(), 0, 'the same key again stops');
    assert.equal(await count(), placements.length + 1);
    // Undo and redo from the keyboard and from the buttons above the map, each saying what it undid.
    await page.keyboard.press('Control+z');
    assert.equal(await count(), placements.length);
    assert.match(await page.textContent('#undoText'), /^Undone: placing a store\.$/);
    assert.equal(await page.isDisabled('#redoButtonTool'), false);
    await page.click('#redoButtonTool');
    assert.equal(await count(), placements.length + 1);
    await page.click('#undoButtonTool');
    assert.equal(await count(), placements.length);
    // Shift-click to select several sites, then Delete removes them all, as one step to undo.
    const before3c = await pins();
    await clickAt(placements[6][1]);
    await clickAt(placements[7][1], ['Shift']);
    assert.match(await page.textContent('#selectionCard h3'), /^2 sites selected$/);
    await page.keyboard.press('Delete');
    assert.equal(await count(), placements.length - 2);
    assert.match(await page.textContent('#undoText'), /^Deleted 2 sites\.$/);
    await page.keyboard.press('Control+z');
    assert.deepEqual(await pins(), before3c);
    // A box drawn with Shift selects the sites in it; the arrow keys move them together, as one step.
    const corner = await screenOf({ lat: -29.80, lon: -19.92 });
    const opposite = await screenOf({ lat: -29.97, lon: -19.695 });
    await dragBetween(corner, opposite, { shift: true });
    const boxed = await stateOf(() => window.logisticsToolboxState.selection.map((item) => item.id));
    const inBox = before3c.filter((pin) => pin.lat <= -29.80 && pin.lat >= -29.97 && pin.lon >= -19.92 && pin.lon <= -19.695).map((pin) => pin.id);
    assert.ok(inBox.length >= 3 && inBox.includes(placed[2].id) && inBox.includes(placed[6].id));
    assert.deepEqual(boxed.sort(), inBox.sort(), 'the sites in the box, and no others');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    const nudged = await pins();
    for (const id of boxed) assert.ok(nudged.find((pin) => pin.id === id).lat > before3c.find((pin) => pin.id === id).lat, 'moved north');
    await page.keyboard.press('Control+z');
    assert.deepEqual(await pins(), before3c, 'two nudges, one step');
    // Duplicate: copies with the user's own figures, named apart, selected to be moved.
    await clickAt(placements[4][1]);
    await page.keyboard.press('Control+d');
    const copy = (await pins()).at(-1);
    assert.equal(copy.name, 'Harbour shop (2)');
    assert.equal(await stateOf(() => window.logisticsToolboxState.pins.at(-1).fields.demand.value), 20);
    await page.keyboard.press('Control+z');
    // The right-click menu: on the map, place a site there; on a site, change what it is, link it, delete it.
    await page.keyboard.press('Escape');
    const spot = { lat: -29.93, lon: -19.6 };
    const at = await screenOf(spot);
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.waitForSelector('#contextMenu:not([hidden])');
    assert.match(await page.textContent('#contextMenu'), /Place a supplier here1.*Place a customer area here6.*Fit the map to the networkF/s);
    await page.click('#contextMenu button:has-text("Place a dark store here")');
    const placedByMenu = (await pins()).at(-1);
    assert.equal(placedByMenu.role, 'darkStore');
    assert.ok(Math.abs(placedByMenu.lat - spot.lat) < 0.002);
    const menuAt = await screenOf(placedByMenu);
    await page.mouse.click(menuAt.x, menuAt.y, { button: 'right' });
    assert.match(await page.textContent('#contextMenu'), /RenameEnter.*Link it to another site…L.*Make it a store.*Duplicate.*DeleteDelete/s);
    await page.click('#contextMenu button:has-text("Make it a store")');
    assert.equal((await pins()).at(-1).role, 'store');
    // Link it to another site...: the next site clicked. (Warehouse 2 to this store, from the warehouse's menu.)
    const w2 = await screenOf(placements[3][1]);
    await page.mouse.click(w2.x, w2.y, { button: 'right' });
    await page.click('#contextMenu button:has-text("Link it to another site")');
    assert.match(await page.textContent('#mapHint'), /Click the site to link Warehouse 2 to/);
    await page.mouse.click(menuAt.x, menuAt.y);
    assert.ok((await links()).some((link) => link.from === placed[3].id && link.to === placedByMenu.id && link.basis === 'user'));
    // A link that cannot be is refused on the map, where the user is looking.
    await page.mouse.click(menuAt.x, menuAt.y);
    await page.keyboard.press('l');
    await page.mouse.click(w2.x, w2.y);
    assert.match(await page.textContent('#undoText'), /supplies nothing: a store is at the end of the network/);
    // The card: what supplies a site, to add to and take from, for those who prefer a list to a drag.
    await page.mouse.click(menuAt.x, menuAt.y);
    assert.match(await page.textContent('#selectionCard .links'), /Supplied from.*Warehouse 2/s);
    await page.click(`#selectionCard [data-remove-link="${placed[3].id}>${placedByMenu.id}"]`);
    assert.ok(!(await links()).some((link) => link.from === placed[3].id && link.to === placedByMenu.id));
    await page.selectOption('#selectionCard [data-add-link="in"]', placed[3].id);
    assert.ok((await links()).some((link) => link.from === placed[3].id && link.to === placedByMenu.id && link.basis === 'user'));
    // Delete from the menu; then everything since the menu's first placing undone, step by step.
    await page.mouse.click(menuAt.x, menuAt.y, { button: 'right' });
    await page.click('#contextMenu button.danger');
    // Placed, made a store, linked, a link removed and added, deleted: six steps.
    for (let step = 0; step < 6; step += 1) await page.keyboard.press('Control+z');
    assert.deepEqual(await pins(), before3c);
    // The shortcuts, listed under ?, and closed with Escape.
    await page.keyboard.press('?');
    assert.equal(await page.isVisible('#shortcuts'), true);
    assert.match(await page.textContent('#shortcutList'), /Delete or Backspace.*Delete what is selected/s);
    // On Windows and Linux (this browser), Ctrl, and no Mac symbols anywhere.
    assert.match(await page.textContent('#shortcutList'), /Ctrl\+Z.*Ctrl\+Y or Ctrl\+Shift\+Z/s);
    assert.ok(!/[⌘⌫⇧]/.test(await page.textContent('#shortcutList')));
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#shortcuts'), false);
    await page.keyboard.press('Escape');
    noErrors();

    // 4. Moving a store re-routes its own link and no other, in well under a second.
    const before = await linkPaths();
    const store = await screenOf(placements[5][1]);
    await dragBetween(store, { x: store.x + 25, y: store.y - 20 });
    const after = await linkPaths();
    const moved = (await pins())[5];
    const changed = Object.keys(after).filter((id) => after[id] !== before[id]);
    assert.deepEqual(changed, suggested.filter((link) => link.to === moved.id).map((link) => link.id), 'only the moved store\'s link');
    const routing = await stateOf(() => window.logisticsToolboxState.lastRouted);
    assert.equal(routing.legs, 1);
    assert.ok(routing.milliseconds < 1000, `re-routing took ${routing.milliseconds} ms`);

    // 5. A link drawn from the second warehouse's handle to Store 1 (served from the first): both are the user's now.
    const [warehouse1, warehouse2] = placed.filter((pin) => pin.role === 'warehouse');
    const store1 = placed[6];
    await clickAt(placements[3][1]);
    await page.waitForSelector('#map .linkHandle');
    const handle = await page.locator('#map .linkHandle').boundingBox();
    await dragBetween({ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, await screenOf(placements[6][1]));
    const into = (await links()).filter((link) => link.to === store1.id);
    assert.deepEqual(into.map((link) => link.from).sort(), [warehouse1.id, warehouse2.id].sort());
    assert.ok(into.every((link) => link.basis === 'user'));
    assert.equal(await page.locator('#map path.link.drawn').count(), 2);
    // A store cannot supply a warehouse: the link is refused, and the window says why.
    await dragBetween(await screenOf(placements[7][1]), await screenOf(placements[2][1]), { shift: true });
    assert.match(await page.textContent('#networkStatus'), /supplies nothing: a store is at the end of the network/);
    assert.ok(!(await links()).some((link) => link.from === placed[7].id), 'no link from a store');

    // 6. A suggested link deleted: not suggested again, and the store it served says it has no warehouse.
    const darkStore = placed[8];
    const darkLink = (await links()).find((link) => link.to === darkStore.id);
    await page.evaluate((id) => {
        const hit = document.querySelector(`#map path.linkHit[data-link="${CSS.escape(id)}"]`);
        const box = hit.getBBox();
        const point = document.querySelector('#map').createSVGPoint();
        // The middle of the link, on screen.
        const length = hit.getTotalLength();
        const middle = hit.getPointAtLength(length / 2);
        point.x = middle.x;
        point.y = middle.y;
        const screen = point.matrixTransform(document.querySelector('#map').getScreenCTM());
        window.linkMiddle = { x: screen.x, y: screen.y, box };
    }, darkLink.id);
    const middle = await page.evaluate(() => window.linkMiddle);
    await page.mouse.click(middle.x, middle.y);
    await page.waitForSelector('#selectionCard:not([hidden]) #deleteLink');
    assert.match(await page.textContent('#selectionCard h3'), /→ Dark store 1/);
    await page.click('#deleteLink');
    assert.ok(!(await links()).some((link) => link.to === darkStore.id), 'not suggested again');
    assert.match(await page.textContent('#networkStatus'), /Dark store 1 has no warehouse linked to it/);
    assert.equal(await page.isDisabled('#buildButton'), true);
    // Drawn again by the user, from the second warehouse.
    await clickAt(placements[3][1]);
    const handle2 = await page.locator('#map .linkHandle').boundingBox();
    await dragBetween({ x: handle2.x + handle2.width / 2, y: handle2.y + handle2.height / 2 }, await screenOf(placements[8][1]));
    assert.equal(await page.textContent('#networkStatus'), '');
    noErrors();

    // 6b. Stock and vehicles: a warehouse's room on its card; the vehicle catalogue; a link's vehicles chosen on its card,
    // from its menu and with V, each undone as one step; a type kept off stores refused on a link to one.
    await clickAt(placements[2][1]);
    await page.waitForSelector('#selectionCard:not([hidden]) #field-capacity');
    assert.equal(await page.getAttribute('#field-capacity', 'placeholder'), 'no limit');
    await page.fill('#field-capacity', '400');
    await page.dispatchEvent('#field-capacity', 'change');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.pins[2].fields.capacity), { value: 400, basis: 'user' });
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.pins[2].fields.cover), { value: 3, basis: 'assumed' });
    await page.click('#vehicles summary');
    assert.deepEqual(await page.$$eval('#vehicleList [data-vehicle-name]', (inputs) => inputs.map((input) => input.value)), ['Heavy truck', 'Medium truck', 'Small truck', 'Mini-van', 'Refrigerated truck']);
    const vanCapacity = '#vehicleList [data-type="miniVan"] [data-vehicle-field="capacity"]';
    await page.fill(vanCapacity, '2.5');
    await page.dispatchEvent(vanCapacity, 'change');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.vehicles.find((type) => type.id === 'miniVan').fields.capacity), { value: 2.5, basis: 'user' });
    assert.equal(await page.textContent('#vehicleList [data-type="miniVan"] .field .basis'), 'yours');
    await page.click('#addVehicleButton');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.vehicles.map((type) => type.name)), ['Heavy truck', 'Medium truck', 'Small truck', 'Mini-van', 'Refrigerated truck', 'Vehicle 1']);
    await page.click('#undoButtonTool');
    assert.equal(await stateOf(() => window.logisticsToolboxState.vehicles.length), 5, 'adding a type undone');
    // Harbour shop's link, from its card: medium trucks until another is chosen; heavy trucks may not go to a store.
    const harbourLink = (await links()).find((link) => link.to === placed[4].id);
    await clickAt(placements[4][1]);
    await page.click(`#selectionCard [data-select-link="${harbourLink.id}"]`);
    await page.waitForSelector('#selectionCard [data-link-vehicle="0"]');
    assert.equal(await page.inputValue('#selectionCard [data-link-vehicle="0"]'), 'mediumTruck');
    assert.equal(await page.isDisabled('#selectionCard [data-link-vehicle="0"] option[value="heavyTruck"]'), true);
    await page.selectOption('#selectionCard [data-link-vehicle="0"]', 'smallTruck');
    const harbourVehicles = () => page.evaluate((id) => window.logisticsToolboxState.links.find((link) => link.id === id).vehicles, harbourLink.id);
    assert.deepEqual(await harbourVehicles(), [{ type: 'smallTruck', fleet: null }]);
    await page.click('#selectionCard #addLinkVehicle');
    await page.fill('#selectionCard [data-link-fleet="1"]', '3');
    await page.dispatchEvent('#selectionCard [data-link-fleet="1"]', 'change');
    assert.deepEqual(await harbourVehicles(), [{ type: 'smallTruck', fleet: null }, { type: 'mediumTruck', fleet: 3 }]);
    await page.click('#selectionCard [data-link-vehicle-remove]');
    assert.deepEqual(await harbourVehicles(), [{ type: 'smallTruck', fleet: null }]);
    // From its menu on the map: every type that may deliver to a store, and not the one it has.
    const linkPoint = (id) => page.evaluate((linkId) => {
        const path = document.querySelector(`#map path.link[data-link="${CSS.escape(linkId)}"]`);
        const point = path.getPointAtLength(path.getTotalLength() * 0.4).matrixTransform(path.getScreenCTM());
        return { x: point.x, y: point.y };
    }, id);
    // (Nothing selected first, so the popover beside the selection is not over the link.)
    await page.keyboard.press('Escape');
    const onLink = await linkPoint(harbourLink.id);
    await page.mouse.click(onLink.x, onLink.y, { button: 'right' });
    await page.waitForSelector('#contextMenu:not([hidden])');
    const linkMenu = await page.textContent('#contextMenu');
    assert.match(linkMenu, /Carry it by medium truckV.*Carry it by mini-vanV/s);
    assert.ok(!/heavy truck|small truck/.test(linkMenu), linkMenu);
    await page.click('#contextMenu button:has-text("Carry it by mini-van")');
    assert.deepEqual(await harbourVehicles(), [{ type: 'miniVan', fleet: null }]);
    // With V: the next type that may take it, round the catalogue.
    await page.keyboard.press('v');
    assert.deepEqual(await harbourVehicles(), [{ type: 'refrigeratedTruck', fleet: null }]);
    assert.match(await page.textContent('#undoText'), /carried by refrigerated trucks/);
    await page.keyboard.press('v');
    assert.deepEqual(await harbourVehicles(), [{ type: 'mediumTruck', fleet: null }]);
    assert.match(await page.textContent('#undoText'), /carried by medium trucks/);
    // Medium trucks kept off stores: the link to Harbour shop cannot be built, and says why.
    await page.uncheck('#vehicleList [data-type="mediumTruck"] [data-vehicle-stores]');
    assert.match(await page.textContent('#networkStatus'), /Medium truck may not deliver to stores: choose another vehicle for Warehouse 1 → Harbour shop\./);
    assert.equal(await page.isDisabled('#buildButton'), true);
    await page.click('#undoButtonTool');
    assert.ok(!/may not deliver/.test(await page.textContent('#networkStatus')));
    // Undo, step by step: V twice, the menu, the type taken off, the fleet, the type added, the type chosen.
    for (let step = 0; step < 7; step += 1) await page.click('#undoButtonTool');
    assert.equal(await harbourVehicles(), undefined, 'back to its kind\'s vehicles');
    await page.click('#redoButtonTool');
    assert.deepEqual(await harbourVehicles(), [{ type: 'smallTruck', fleet: null }]);
    await page.keyboard.press('Escape');
    noErrors();

    // 6b2. Product categories: the three a network starts with, in the list and on a site's card. A store given a mix of
    // its own and back to the usual shares, a supplier a lead time for one category, a category's figure changed and a
    // category added, each undone as a step; and with no refrigerated vehicle type, the chilled goods cannot go, said so.
    await page.click('#categories summary');
    assert.deepEqual(await page.$$eval('#categoryList [data-category-name]', (inputs) => inputs.map((input) => input.value)), ['Ambient', 'Chilled', 'Frozen']);
    assert.equal(await page.textContent('#categoriesSummary'), 'Ambient, Chilled, Frozen');
    assert.deepEqual(await page.$$eval('#categoryList [data-category-chilled]', (boxes) => boxes.map((box) => box.checked)), [false, true, true]);
    const change = async (selector, value) => { await page.fill(selector, value); await page.dispatchEvent(selector, 'change'); };
    const mixOfPin = (index) => page.evaluate((at) => window.logisticsToolboxState.pins[at].mix ?? null, index);
    await clickAt(placements[4][1]);
    await page.waitForSelector('#selectionCard:not([hidden]) .mix');
    assert.match(await page.textContent('#selectionCard .mix'), /Of what it sells\s+usual shares, assumed/);
    assert.deepEqual([await page.inputValue('#mix-ambient'), await page.inputValue('#mix-chilled'), await page.inputValue('#mix-frozen')], ['60', '25', '15']);
    assert.equal(await page.locator('#selectionCard [data-lead]').count(), 0, 'a store has no lead times');
    await change('#mix-frozen', '0');
    assert.deepEqual(await mixOfPin(4), { ambient: 60, chilled: 25, frozen: 0 });
    assert.match(await page.textContent('#selectionCard .mix'), /your mix/);
    await page.click('#selectionCard #clearMix');
    assert.equal(await mixOfPin(4), null, 'back to the usual shares');
    await page.click('#undoButtonTool');
    assert.deepEqual(await mixOfPin(4), { ambient: 60, chilled: 25, frozen: 0 }, 'the usual shares undone');
    await page.click('#undoButtonTool');
    assert.equal(await mixOfPin(4), null, 'the mix undone');
    // A site carries at least one category: the last one cannot be taken off.
    await clickAt(placements[4][1]);
    await page.waitForSelector('#selectionCard:not([hidden]) #mix-ambient');
    await change('#mix-ambient', '0');
    await change('#mix-chilled', '0');
    await change('#mix-frozen', '0');
    assert.deepEqual(await mixOfPin(4), { ambient: 0, chilled: 0, frozen: 15 }, 'the last category stays');
    for (let step = 0; step < 3 && await mixOfPin(4); step += 1) await page.click('#undoButtonTool');
    assert.equal(await mixOfPin(4), null);
    // A supplier's lead time for one category: its own; the others take their category's.
    await clickAt(placements[0][1]);
    await page.waitForSelector('#selectionCard:not([hidden]) [data-lead="chilled"]');
    assert.equal(await page.getAttribute('#selectionCard [data-lead="chilled"]', 'placeholder'), '1');
    await change('#selectionCard [data-lead="chilled"]', '0.5');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.pins[0].leadDays), { chilled: 0.5 });
    await page.click('#undoButtonTool');
    assert.equal(await stateOf(() => window.logisticsToolboxState.pins[0].leadDays ?? null), null, 'the lead time undone');
    await page.keyboard.press('Escape');
    // In the list: a figure changed is yours; a category added, and undone.
    await change('#categoryList [data-category="frozen"] [data-category-field="leadDays"]', '7');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.categories[2].fields.leadDays), { value: 7, basis: 'user' });
    // How long its goods keep: ten days for chilled goods, assumed; the others keep until a figure is given, and undone.
    const shelf = (id) => `#categoryList [data-category="${id}"] [data-category-field="shelfDays"]`;
    assert.deepEqual([await page.inputValue(shelf('ambient')), await page.inputValue(shelf('chilled')), await page.getAttribute(shelf('ambient'), 'placeholder')], ['', '10', 'they keep']);
    await change(shelf('frozen'), '90');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.categories[2].fields.shelfDays), { value: 90, basis: 'user' });
    await page.click('#undoButtonTool');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.categories[2].fields.shelfDays), { value: null, basis: null }, 'the shelf life undone');
    // What a pallet of it is worth: chilled goods 2,500, kept for the build; the others each store's own.
    const worth = (id) => `#categoryList [data-category="${id}"] [data-category-field="saleValue"]`;
    assert.equal(await page.inputValue(worth('chilled')), '');
    await change(worth('chilled'), '2500');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.categories[1].fields.saleValue), { value: 2500, basis: 'user' });
    // What money is in: the user's word, written beside every sum, undone as any change is, and kept with the session.
    assert.equal(await page.textContent('#moneySummary'), 'no currency given');
    await page.evaluate(() => { document.querySelector('#money').open = true; });
    await change('#currencyInput', ' INR ');
    assert.deepEqual([await stateOf(() => window.logisticsToolboxState.currency), await page.textContent('#moneySummary')], ['INR', 'in INR']);
    await page.click('#undoButtonTool');
    assert.deepEqual([await stateOf(() => window.logisticsToolboxState.currency), await page.inputValue('#currencyInput'), await page.textContent('#moneySummary')], ['', '', 'no currency given']);
    await page.click('#redoButtonTool');
    assert.equal(await stateOf(() => window.logisticsToolboxState.currency), 'INR');
    for (let waited = 0; waited < 50 && host.session?.currency !== 'INR'; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(host.session.currency, 'INR');
    await page.click('#addCategoryButton');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.categories.map((category) => category.name)), ['Ambient', 'Chilled', 'Frozen', 'Category 1']);
    await page.click('#undoButtonTool');
    assert.equal(await stateOf(() => window.logisticsToolboxState.categories.length), 3, 'adding a category undone');
    // No refrigerated vehicle: the chilled and frozen goods have nothing to go by.
    await page.uncheck('#vehicleList [data-type="refrigeratedTruck"] [data-vehicle-cold]');
    assert.match(await page.textContent('#networkStatus'), /Chilled and Frozen need a refrigerated vehicle, and no vehicle type is one\. Tick Refrigerated on a vehicle type, or add one\./);
    assert.equal(await page.isDisabled('#buildButton'), true);
    await page.click('#undoButtonTool');
    assert.ok(!/refrigerated/.test(await page.textContent('#networkStatus')));
    noErrors();

    // 6b3. A link between two warehouses, from the first's card: a standing link at first, with a share to give; a
    // backup from its card or its menu; kept with the session; and undone, the network is as it was.
    const linksBeforeTransfer = (await links()).length;
    await clickAt(placements[2][1]);
    await page.waitForSelector('#selectionCard:not([hidden]) [data-add-link="out"]');
    await page.selectOption('#selectionCard [data-add-link="out"]', placed[3].id);
    const between = (await links()).find((link) => link.from === placed[2].id && link.to === placed[3].id);
    assert.ok(between && between.basis === 'user', 'one warehouse may restock another');
    assert.ok(!/later version/.test(await page.textContent('#networkStatus')));
    await page.click(`#selectionCard [data-select-link="${between.id}"]`);
    await page.waitForSelector('#selectionCard #linkBackup');
    assert.equal(await page.isChecked('#linkBackup'), false);
    assert.equal(await page.getAttribute('#linkShare', 'placeholder'), 'an even share');
    assert.equal(await page.inputValue('#selectionCard [data-link-vehicle="0"]'), 'heavyTruck', 'between warehouses, heavy trucks');
    const betweenNow = () => page.evaluate((id) => { const link = window.logisticsToolboxState.links.find((item) => item.id === id); return link ? { backup: link.backup ?? false, share: link.share ?? null } : null; }, between.id);
    await change('#linkShare', '40');
    assert.deepEqual(await betweenNow(), { backup: false, share: 40 });
    await page.check('#linkBackup');
    assert.deepEqual(await betweenNow(), { backup: true, share: null }, 'a backup has no share: it carries nothing');
    assert.equal(await page.locator('#linkShare').count(), 0);
    // From its menu: a standing link again, and back. In this small region it shares every road it runs along with
    // other links, drawn over it: selected (as it is, from the card), the menu under the pointer is still its own.
    const onBetween = await linkPoint(between.id);
    await page.mouse.click(onBetween.x, onBetween.y, { button: 'right' });
    await page.waitForSelector('#contextMenu:not([hidden])');
    await page.click('#contextMenu button:has-text("Make it a standing link")');
    assert.deepEqual(await betweenNow(), { backup: false, share: null });
    await page.click('#undoButtonTool');
    assert.deepEqual(await betweenNow(), { backup: true, share: null });
    for (let waited = 0; waited < 50 && !host.session?.links?.some((link) => link.id === between.id && link.backup); waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(host.session.links.some((link) => link.id === between.id && link.backup), 'the backup is kept with the session');
    // Undone, step by step: the backup, the share, the link.
    for (let step = 0; step < 3; step += 1) await page.click('#undoButtonTool');
    assert.equal((await links()).length, linksBeforeTransfer, 'the link undone');
    await page.keyboard.press('Escape');
    noErrors();

    // 6b4. The hours a site keeps, on its card: a store's opening hours and the hours it receives (it dispatches
    // nothing), a figure and a day at a time; hours that cannot be kept stop the build with the reason; and undone.
    await clickAt(placements[4][1]);
    await page.waitForSelector('#selectionCard:not([hidden]) .hours');
    assert.deepEqual(await page.$$eval('#selectionCard .hours .hoursKind', (items) => items.map((item) => item.textContent)), ['Open', 'Receives']);
    assert.deepEqual(await page.$$eval('#selectionCard .hours .basis', (items) => items.map((item) => item.textContent)), ['round the clock', 'round the clock']);
    const hoursOf = () => stateOf(() => window.logisticsToolboxState.pins[4].hours ?? null);
    await change('#selectionCard [data-hours="open"][data-end="from"]', '8');
    await change('#selectionCard [data-hours="open"][data-end="to"]', '22');
    await page.uncheck('#selectionCard [data-hours-day="open"][data-day="6"]');
    assert.deepEqual(await hoursOf(), { open: { from: 8, to: 22, days: [true, true, true, true, true, true, false] } });
    assert.equal(await page.textContent('#selectionCard .hours .basis'), '8:00 to 22:00, Monday to Saturday');
    await change('#selectionCard [data-hours="receive"][data-end="to"]', '9');
    assert.deepEqual((await hoursOf()).receive, { from: 0, to: 9, days: Array(7).fill(true) });
    assert.ok(!/second hour/.test(await page.textContent('#networkStatus')));
    // Past midnight is a night's hours; the same hour twice is none, and stops the build with the reason.
    await change('#selectionCard [data-hours="open"][data-end="to"]', '6');
    assert.equal(await page.textContent('#selectionCard .hours .basis'), '8:00 to 6:00 the next morning, Monday to Saturday');
    assert.ok(!/two different hours/.test(await page.textContent('#networkStatus')));
    await change('#selectionCard [data-hours="open"][data-end="to"]', '8');
    assert.match(await page.textContent('#networkStatus'), /Harbour shop is open from 8:00 to 8:00: give two different hours/);
    assert.equal(await page.isDisabled('#buildButton'), true);
    for (let step = 0; step < 8 && await hoursOf(); step += 1) await page.click('#undoButtonTool');
    assert.equal(await hoursOf(), null, 'the hours undone');
    assert.ok(!/two different hours/.test(await page.textContent('#networkStatus')));
    // A vehicle type keeps hours too, in the Vehicles list: mini-vans by day, undone.
    const vanHours = () => stateOf(() => window.logisticsToolboxState.vehicles.find((type) => type.id === 'miniVan').hours ?? null);
    assert.equal(await page.textContent('#vehicleList [data-type="miniVan"] .vehicleHours .basis'), 'round the clock');
    await change('#vehicleList [data-type="miniVan"] [data-vehicle-hours="from"]', '8');
    await change('#vehicleList [data-type="miniVan"] [data-vehicle-hours="to"]', '20');
    await page.uncheck('#vehicleList [data-type="miniVan"] [data-vehicle-day="6"]');
    assert.deepEqual(await vanHours(), { from: 8, to: 20, days: [true, true, true, true, true, true, false] });
    assert.equal(await page.textContent('#vehicleList [data-type="miniVan"] .vehicleHours .basis'), '8:00 to 20:00, Monday to Saturday');
    for (let step = 0; step < 6 && await vanHours(); step += 1) await page.click('#undoButtonTool');
    assert.equal(await vanHours(), null, 'the vehicle\'s hours undone');
    // A warehouse receives and dispatches; a supplier dispatches; a customer area keeps no hours.
    await clickAt(placements[2][1]);
    await page.waitForSelector('#selectionCard:not([hidden]) .hours');
    assert.deepEqual(await page.$$eval('#selectionCard .hours .hoursKind', (items) => items.map((item) => item.textContent)), ['Receives', 'Dispatches']);
    await page.keyboard.press('Escape');
    noErrors();

    // 6b5. Holidays and peaks, in their list: an event added, named, dated and given its effect on a category's demand,
    // its suppliers closed; one that cannot be stops the build with the reason; and undone, the calendar is empty.
    await page.click('#holidays summary');
    assert.equal(await page.textContent('#holidaysSummary'), 'none');
    await page.click('#addHolidayButton');
    const event = () => stateOf(() => window.logisticsToolboxState.holidays[0] ?? null);
    assert.deepEqual([(await event()).name, (await event()).day, (await event()).days], ['Holiday 1', 14, 1]);
    await change('#holidayList [data-holiday-field="day"]', '20');
    await change('#holidayList [data-holiday-field="days"]', '3');
    await change('#holidayList [data-holiday-demand="chilled"]', '100');
    await change('#holidayList [data-holiday-field="beforeDays"]', '2');
    await change('#holidayList [data-holiday-field="beforePercent"]', '30');
    await page.check('#holidayList [data-holiday-suppliers]');
    const made = await event();
    assert.deepEqual([made.day, made.days, made.demand, made.beforeDays, made.beforePercent, made.suppliersClosed], [20, 3, { chilled: 100 }, 2, 30, true]);
    assert.equal(await page.textContent('#holidayList .detail'), 'Holiday 1 (day 20 for 3 days): Chilled demand +100%; the 2 days before +30%; suppliers do not dispatch');
    assert.equal(await page.textContent('#holidaysSummary'), 'Holiday 1');
    await change('#holidayList [data-holiday-field="days"]', '0');
    assert.match(await page.textContent('#networkStatus'), /Holiday 1: it lasts a day or more\./);
    assert.match(await page.textContent('#holidayList .notice.error'), /it lasts a day or more/);
    assert.equal(await page.isDisabled('#buildButton'), true);
    for (let step = 0; step < 10 && await event(); step += 1) await page.click('#undoButtonTool');
    assert.equal(await event(), null, 'the holiday undone');
    assert.ok(!/Holiday/.test(await page.textContent('#networkStatus')));
    noErrors();

    // 6c. Travel times of the user's own: typed in the list (Enter to the next row), when it holds, read off Google Maps
    // (opened in the browser through the host), on the link's card with T, from its menu, a column pasted from a
    // spreadsheet, a time that looks wrong flagged, a calibration from them, and a file saved and loaded.
    await page.click('#travelTimes summary');
    const timeOf = (id) => page.evaluate((linkId) => window.logisticsToolboxState.links.find((link) => link.id === linkId).time ?? null, id);
    const rowIds = () => page.$$eval('#travelTable [data-time-input]', (inputs) => inputs.map((input) => input.dataset.timeInput));
    const timedIds = await rowIds();
    const vehicleLinks = await stateOf(() => window.logisticsToolboxState.links.filter((link) => {
        const role = (id) => window.logisticsToolboxState.pins.find((pin) => pin.id === id).role;
        return role(link.from) === 'warehouse' ? role(link.to) !== 'customerArea' : true;
    }).length);
    assert.equal(timedIds.length, vehicleLinks, 'a row for every link that runs on vehicles, none for a customer area');
    const timeInput = (id) => `#travelTable [data-time-input="${id}"]`;
    await page.fill(timeInput(harbourLink.id), '2:00');
    await page.press(timeInput(harbourLink.id), 'Enter');
    assert.deepEqual(await timeOf(harbourLink.id), { hours: 2, when: 'any', how: 'yours' });
    const nextRow = timedIds[timedIds.indexOf(harbourLink.id) + 1];
    if (nextRow) assert.equal(await page.evaluate(() => document.activeElement?.dataset.timeInput), nextRow, 'Enter goes to the next row');
    await page.selectOption(`#travelTable [data-time-when="${harbourLink.id}"]`, 'peak');
    assert.equal((await timeOf(harbourLink.id)).when, 'peak');
    assert.match(await page.textContent('#travelSummary'), /^1 of \d+ yours$/);
    // Read off Google Maps: the host opens its directions, checked against the hosts the add-on declares.
    const supplyLink = (await links()).find((link) => link.from === placed[0].id);
    await page.click(`#travelTable [data-directions="google"][data-for="${supplyLink.id}"]`);
    const google = new URL(host.opened.at(-1));
    assert.equal(google.hostname, 'www.google.com');
    assert.equal(google.searchParams.get('origin'), `${placed[0].lat.toFixed(6)},${placed[0].lon.toFixed(6)}`);
    assert.equal(google.searchParams.get('travelmode'), 'driving');
    await page.fill(timeInput(supplyLink.id), '1 hr 40 min');
    await page.dispatchEvent(timeInput(supplyLink.id), 'change');
    const read = await timeOf(supplyLink.id);
    assert.deepEqual([Number(read.hours.toFixed(4)), read.how, read.checkedOn], [1.6667, 'google', new Date().toISOString().slice(0, 10)], 'read off Google Maps today');
    // A time that cannot be is refused; one that looks wrong is flagged, with why.
    await page.fill(timeInput(supplyLink.id), 'soon');
    await page.dispatchEvent(timeInput(supplyLink.id), 'change');
    assert.match(await page.textContent('#undoText'), /"soon" is not a time/);
    assert.equal(Number((await timeOf(supplyLink.id)).hours.toFixed(4)), 1.6667, 'kept as it was');
    const other = timedIds.find((id) => id !== harbourLink.id && id !== supplyLink.id);
    await page.fill(timeInput(other), '0:01');
    await page.dispatchEvent(timeInput(other), 'change');
    assert.match(await page.getAttribute(`#travelTable li[data-link="${other}"] .flag`, 'title'), /too fast for a road|under 40% of/);
    await page.click('#undoButtonTool');
    assert.equal(await timeOf(other), null);
    // A column of times pasted from a spreadsheet fills the row and those below it, as one step.
    const pasteAt = timedIds.indexOf(other);
    await page.evaluate(({ id, text }) => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        document.querySelector(`#travelTable [data-time-input="${id}"]`).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, { id: other, text: '1:30\n45 min\n' });
    assert.equal((await timeOf(other)).hours, 1.5);
    const below = timedIds[pasteAt + 1];
    if (below) assert.equal((await timeOf(below)).hours, 0.75);
    assert.match(await page.textContent('#undoText'), /^2 travel times pasted\.$|^\d travel times? pasted/);
    // From the card: T on a selected link puts the cursor in its time, and its menu offers the maps.
    await page.click(`#travelTable [data-select-link="${harbourLink.id}"]`);
    await page.keyboard.press('Escape');
    await page.click(`#travelTable [data-select-link="${harbourLink.id}"]`);
    await page.locator('#map').focus().catch(() => {});
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('t');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'linkTime', 'T puts the cursor in the link\'s time');
    assert.equal(await page.inputValue("#linkTime"), "2:00");
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Escape');
    const onHarbour = await linkPoint(harbourLink.id);
    await page.mouse.click(onHarbour.x, onHarbour.y, { button: 'right' });
    assert.match(await page.textContent('#contextMenu'), /Type its travel time…T.*Check its time in Google Maps.*Check its time on OpenStreetMap/s);
    await page.click('#contextMenu button:has-text("Check its time on OpenStreetMap")');
    assert.equal(new URL(host.opened.at(-1)).hostname, 'www.openstreetmap.org');
    await page.keyboard.press('Escape');
    // The calibration: from the times given, offered for the links without one, and sent with the build.
    assert.match(await page.textContent('#calibrationRow'), /Your \d+ times take [\d.]+ × the route's estimate/);
    await page.check('#useCalibration');
    assert.equal(await stateOf(() => window.logisticsToolboxState.useCalibration), true);
    // Saved as a CSV, cleared, and loaded back.
    const timesDownload = page.waitForEvent('download');
    await page.click('#saveTimesButton');
    const timesCsv = await readFile(await (await timesDownload).path(), 'utf8');
    assert.match(timesCsv, /^from,to,time,kilometres,when,note$/m);
    assert.match(timesCsv, /^Warehouse 1,Harbour shop,2:00,,peak,$/m);
    await page.fill(timeInput(harbourLink.id), '');
    await page.dispatchEvent(timeInput(harbourLink.id), 'change');
    assert.equal(await timeOf(harbourLink.id), null);
    host.chosen.times = timesCsv;
    await page.click('#loadTimesButton');
    await page.waitForFunction(() => /times? from your file/.test(document.querySelector('#travelStatus').textContent), null, { timeout: 10000 }).catch(fail);
    assert.deepEqual(await timeOf(harbourLink.id), { hours: 2, when: 'peak', how: 'yours' });
    noErrors();

    // 7. The model, built from the pins and links.
    await page.click('#buildButton');
    await page.waitForSelector('#buildStatus .notice.ok, #buildStatus .notice.error', { timeout: 60000 }).catch(fail);
    const built = await page.textContent('#buildStatus');
    assert.match(built, /^2 suppliers, \d+ road lanes?, 6 stores and customer areas served, each in 3 categories \(Ambient, Chilled, Frozen\): \d+ nodes and \d+ relationships, now in the canvas\./, built);
    const lanes = await page.evaluate(() => document.querySelector('#buildResult table').tBodies[0].rows.length);
    // A link is a lane in the model for each category it carries, and one row in the table.
    const linksOf = (kind) => page.evaluate((wanted) => [...new Set(window.logisticsToolboxState.built.lanes.filter((lane) => lane.kind === wanted).map((lane) => lane.link))].length, kind);
    const supplyLanes = await linksOf('supply');
    const unusedLinks = await stateOf(() => window.logisticsToolboxState.built.unusedLinks.length);
    assert.equal(supplyLanes + unusedLinks, 4, 'a lane for each supply link, or the link said to be left out');
    // And one to each store and dark store from each of its warehouses: they hold stock, restocked by road.
    const stocked = placements.filter(([role]) => role === 'store' || role === 'darkStore').length;
    const storeLanes = await stateOf(() => window.logisticsToolboxState.built.lanes.filter((lane) => lane.kind === 'store'));
    assert.equal(new Set(storeLanes.map((lane) => lane.site)).size, stocked, 'a lane to every store and dark store');
    assert.equal(lanes, supplyLanes + await linksOf('store'), 'every link in the table');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.built.categories.map((category) => category.name)), ['Ambient', 'Chilled', 'Frozen']);
    assert.equal(storeLanes.filter((lane) => lane.site === 'Harbour shop').length, 3, 'Harbour shop\'s link is a lane for each category');
    assert.match(await page.textContent('#buildResult'), /Harbour shop/);
    assert.ok(host.session?.version === 2 && host.session.pins.length === placements.length, 'the session went with the model');
    assert.match(await page.textContent('#buildResult'), /pallets\/day.*vehicles/s);
    assert.ok(storeLanes.some((lane) => lane.site === 'Harbour shop' && lane.category === 'ambient' && lane.vehicles[0].type === 'smallTruck'), 'Harbour shop restocked by small trucks');
    assert.ok(storeLanes.some((lane) => lane.site === 'Harbour shop' && lane.category === 'chilled' && lane.vehicles[0].type === 'refrigeratedTruck'), 'and its chilled goods by refrigerated trucks');
    // Its time is yours, door to door; a lane without one is the route's estimate scaled by your times.
    const harbourBuilt = storeLanes.find((lane) => lane.site === 'Harbour shop');
    assert.equal(harbourBuilt.timeBasis, 'user');
    assert.ok(Math.abs(harbourBuilt.leadTime * 24 - 2) < 0.01, `2 h door to door (${harbourBuilt.leadTime * 24})`);
    assert.ok(storeLanes.some((lane) => lane.timeBasis === 'estimated'), 'the others scaled by your times');
    const provenanceOf = await stateOf(() => window.logisticsToolboxState.built.provenance.find((entry) => entry.entity === 'Road Warehouse 1 → Harbour shop: Ambient' && entry.parameter === 'Travel time'));
    assert.match(provenanceOf.detail, /^Your time at the morning or evening peak, door to door: 2 h\./);
    assert.deepEqual(host.session.links.find((link) => link.id === harbourLink.id).time, { hours: 2, when: 'peak', how: 'yours' });
    assert.deepEqual(host.session.vehicles.find((type) => type.id === 'miniVan').fields.capacity, { value: 2.5, basis: 'user' });
    assert.deepEqual(host.session.categories.find((category) => category.id === 'frozen').fields.leadDays, { value: 7, basis: 'user' });
    assert.equal(await stateOf(() => window.logisticsToolboxState.built.ports.find((port) => port.name === 'Supplier 1: Frozen').leadDays), 7, 'the frozen goods\' suppliers take the lead time given');
    assert.deepEqual(host.session.links.find((link) => link.id === harbourLink.id).vehicles, [{ type: 'smallTruck', fleet: null }]);
    noErrors();

    // 7a. A road chosen to close in the Road closure tab is marked with a faint red X on the map, half way along it;
    // none on a detour, which keeps the road open.
    const marks = (kind) => page.locator(`#map .roadMark.${kind}`).count();
    assert.equal(await marks('planned'), 0, 'no X before a road is chosen to close');
    await page.click('#scenarioTabs [data-scenario="roadClosure"]');
    const harbourLane = storeLanes.find((lane) => lane.site === 'Harbour shop');
    await page.selectOption('#closureLaneSelect', harbourLane.link);
    assert.equal(await marks('planned'), 1);
    assert.match(await page.textContent('#map .roadMark.planned title'), /^Warehouse 1 → Harbour shop: to be closed when the scenario runs$/);
    // The tab speaks of this network: vehicles, a store ordering from its other warehouses, a warehouse from its other
    // suppliers, which ship what they can make. No trucks, ports or towns.
    assert.equal(await page.textContent('#closureVehiclesLabel'), 'Its vehicles');
    assert.equal(await page.textContent('#closureModeSelect option[value="otherPorts"]'), 'Harbour shop orders from its other warehouses');
    const fromSupplier = await stateOf(() => window.logisticsToolboxState.built.lanes.find((lane) => lane.kind === 'supply' && lane.fromSite === 'Supplier 1').link);
    await page.selectOption('#closureLaneSelect', fromSupplier);
    await page.selectOption('#closureModeSelect', 'otherPorts');
    assert.match(await page.textContent('#closureModeSelect option[value="otherPorts"]'), /^Warehouse \d orders from its other suppliers$/);
    assert.match(await page.textContent('#closureHint'), /^Warehouse \d also orders over Supplier 2 \([\d,.]+ pallets\/day\), which ships only what its supplier can make\.$/);
    assert.ok(!/truck|port|town|TEU/i.test(await page.evaluate(() => document.querySelector('.scenarioPanel[data-panel="roadClosure"]').innerText)), 'the road closure tab speaks of this network');
    await page.selectOption('#closureModeSelect', 'wait');
    await page.selectOption('#closureLaneSelect', harbourLane.link);
    assert.equal(await page.isVisible('#legendClosed'), true);
    assert.equal(await page.textContent('#legendClosedText'), 'Road to close');
    // On the road: the X's centre is on the link's own path.
    const onPath = await page.evaluate((id) => {
        const cross = document.querySelector('#map .roadMark .markCross').getBBox();
        const centre = { x: cross.x + cross.width / 2, y: cross.y + cross.height / 2 };
        const path = document.querySelector(`#map path.link[data-link="${CSS.escape(id)}"]`);
        let nearest = Infinity;
        for (let at = 0; at <= path.getTotalLength(); at += path.getTotalLength() / 200) {
            const point = path.getPointAtLength(at);
            nearest = Math.min(nearest, Math.hypot(point.x - centre.x, point.y - centre.y));
        }
        return nearest / cross.width;
    }, harbourLink.id);
    assert.ok(onPath < 0.1, `the X sits on the link's road (${onPath})`);
    await page.selectOption('#closureModeSelect', 'detour');
    assert.equal(await marks('planned'), 0, 'a detour closes nothing');
    await page.selectOption('#closureModeSelect', 'wait');
    assert.equal(await marks('planned'), 1);
    noErrors();

    // 7a2. A supplier short or late: its tab is there because the network has suppliers; from a supplier's menu on the
    // map the tab opens with that supplier chosen, and the hint says what the choice comes to.
    assert.equal(await page.isVisible('#scenarioTabs [data-scenario="supplierTrouble"]'), true);
    assert.equal(await page.isVisible('#scenarioTabs [data-scenario="chokepointDisruption"]'), false, 'no port, no chokepoint');
    // Where a site is now (some were moved since they were placed), and its menu there. The map is drawn again after
    // Escape clears the selection: a right click sent before it has been would land on a site about to be replaced, so
    // the menu is asked for once the window has drawn (twice over, a frame each).
    const whereIs = (name) => page.evaluate((wanted) => { const pin = window.logisticsToolboxState.pins.find((item) => item.name === wanted); return { lat: pin.lat, lon: pin.lon }; }, name);
    const openMenuOn = async (name) => {
        await page.keyboard.press('Escape');
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const at = await screenOf(await whereIs(name));
        await page.mouse.click(at.x, at.y, { button: 'right' });
        await page.waitForSelector('#contextMenu:not([hidden])');
    };
    const menuOn = async (name, label) => {
        await openMenuOn(name);
        await page.click(`#contextMenu button:has-text("${label}")`);
    };
    await menuOn('Supplier 2', 'Make it late or short');
    assert.equal(await page.evaluate(() => document.querySelector('#scenarioTabs .active').dataset.scenario), 'supplierTrouble');
    assert.equal(await page.isVisible('.scenarioPanel[data-panel="supplierTrouble"]'), true);
    assert.equal(await page.inputValue('#supplierSelect'), 'supplier:Supplier 2');
    assert.deepEqual(await page.$$eval('#supplierGoodsSelect option', (options) => options.map((option) => option.textContent)), ['everything it supplies', 'Ambient', 'Chilled', 'Frozen']);
    assert.match(await page.textContent('#supplierHint'), /^Supplier 2 makes [\d.]+ of the [\d.]+ pallets a day ordered from it\. Every warehouse it supplies has another supplier of the same goods\.$/);
    // Late as well, of chilled goods alone, its warehouses ordering elsewhere; a store has no such menu item.
    await page.selectOption('#supplierGoodsSelect', 'chilled');
    await page.fill('#supplierLateInput', '2');
    await page.selectOption('#supplierModeSelect', 'otherSuppliers');
    assert.match(await page.textContent('#supplierHint'), /^Supplier 2 makes [\d.]+ of the [\d.]+ pallets a day ordered from it and its orders take 3 days in place of 1\./);
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.built && { ...JSON.parse(JSON.stringify({ tab: window.logisticsToolboxState.scenarioTab })) }), { tab: 'supplierTrouble' });
    await openMenuOn('Harbour shop');
    assert.ok(!/late or short/.test(await page.textContent('#contextMenu')));
    await page.keyboard.press('Escape');
    await page.click('#scenarioTabs [data-scenario="roadClosure"]');
    noErrors();

    // 7a3. A site down: from a warehouse's menu on the map ("Take it down…") or a store's ("Close it…"), the tab opens
    // with that site chosen; a warehouse says whom it restocks and offers them their other warehouses, a store what it
    // sells and loses.
    assert.equal(await page.isVisible('#scenarioTabs [data-scenario="siteDown"]'), true);
    await menuOn('Warehouse 1', 'Take it down');
    assert.equal(await page.evaluate(() => document.querySelector('#scenarioTabs .active').dataset.scenario), 'siteDown');
    assert.equal(await page.inputValue('#downSiteSelect'), 'site:Warehouse 1');
    assert.deepEqual(await page.$$eval('#downSiteSelect optgroup', (groups) => groups.map((group) => [group.label, group.children.length])), [['Warehouses', 2], ['Stores and dark stores', 5]]);
    assert.equal(await page.isVisible('#downModeRow'), true);
    assert.match(await page.textContent('#downHint'), /^Warehouse 1 restocks \d sites? with [\d.]+ pallets a day/);
    await menuOn('Harbour shop', 'Close it');
    assert.equal(await page.inputValue('#downSiteSelect'), 'site:Harbour shop');
    assert.equal(await page.isVisible('#downModeRow'), false, 'a store restocks no one');
    assert.match(await page.textContent('#downHint'), /^Harbour shop sells [\d.]+ pallets a day: closed, 80% of that is lost and the rest waits for it to open\. It keeps its stock, and receives nothing\.$/);
    // A supplier and a customer area cannot go down here: no such item in their menus.
    for (const name of ['Supplier 1', await stateOf(() => window.logisticsToolboxState.pins.find((pin) => pin.role === 'customerArea').name)]) {
        await openMenuOn(name);
        assert.ok(!/Take it down|Close it/.test(await page.textContent('#contextMenu')));
    }
    await page.keyboard.press('Escape');
    await page.click('#scenarioTabs [data-scenario="roadClosure"]');
    noErrors();

    // 7a4. The weakest link: its tab says how many failures it would run, as ticked, and the button says it runs them all.
    await page.click('#scenarioTabs [data-scenario="weakestLink"]');
    assert.equal(await page.textContent('#runScenarioButton'), 'Run them all and rank');
    const supplyRoads = await linksOf('supply');
    assert.equal(await page.textContent('#rankHint'), `${4 + supplyRoads} failures to run, one after another: 2 suppliers, 2 warehouses, ${supplyRoads} roads.`);
    await page.check('#rankStoreRoads');
    assert.match(await page.textContent('#rankHint'), new RegExp(`^${4 + supplyRoads + await linksOf('store')} failures to run`));
    await page.uncheck('#rankStoreRoads');
    await page.uncheck('#rankRoads');
    assert.equal(await page.textContent('#rankHint'), '4 failures to run, one after another: 2 suppliers, 2 warehouses.');
    await page.click('#scenarioTabs [data-scenario="roadClosure"]');
    assert.equal(await page.textContent('#runScenarioButton'), 'Run the scenario');
    noErrors();

    // 7a5. A new site: a warehouse placed and ticked a candidate is drawn as an outline, takes a fixed cost and a cost to
    // open, is linked from its card, stops nothing and is not built: the New site tab says what it would compare.
    await page.click('#scenarioTabs [data-scenario="newSite"]');
    assert.equal(await page.textContent('#runScenarioButton'), 'Build and compare them');
    assert.equal(await page.textContent('#siteHint'), 'No candidate yet: place a warehouse, tick A candidate on its card, and link it.');
    await page.click('[data-add="warehouse"]');
    await clickAt({ lat: -29.88, lon: -19.6 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#selectionCard:not([hidden]) #pinCandidate');
    assert.equal(await page.inputValue('#pinName'), 'Warehouse 3');
    await page.check('#pinCandidate');
    assert.deepEqual(await stateOf(() => { const pin = window.logisticsToolboxState.pins.at(-1); return [pin.proposed, 'candidate' in pin]; }), [true, false]);
    assert.doesNotMatch(await page.textContent('#selectionCard'), /Adopted from OpenStreetMap/, 'a site placed by hand is not said to be adopted');
    assert.equal(await page.locator('#map .site.candidate').count(), 1, 'drawn as an outline');
    await change('#field-fixedCost', '2000');
    await change('#field-openingCost', '50000');
    // Its suppliers are suggested, as any warehouse's are; the store it would take is the user's to choose.
    const candidateId = await stateOf(() => window.logisticsToolboxState.pins.at(-1).id);
    assert.deepEqual((await links()).filter((link) => link.to === candidateId).map((link) => link.from).sort(), [placed[0].id, placed[1].id].sort());
    assert.equal((await links()).filter((link) => link.from === candidateId).length, 0, 'no store is suggested to a candidate');
    await page.selectOption('#selectionCard [data-add-link="out"]', placed[4].id, { timeout: 5000 });
    assert.equal(await page.textContent('#siteHint'), '1 candidate to compare with the network as it is: Warehouse 3. 2 networks are built and run, one after another.');
    assert.ok(!/Warehouse 3/.test(await page.textContent('#networkStatus')), await page.textContent('#networkStatus'));
    assert.deepEqual(await page.$$eval('#siteStressSelect option', (options) => options.map((option) => option.value)), ['none', 'roadClosure', 'supplierTrouble', 'siteDown', 'demandSurge', 'fleetChange']);
    // Built again (the canvas is kept in step), the model is as it was: the candidate is not in it.
    await page.click('#buildButton');
    await page.waitForFunction(() => document.querySelector('#buildStatus .notice.ok') && !window.logisticsToolboxState.busy, null, { timeout: 60000 }).catch(fail);
    assert.ok(!(await stateOf(() => window.logisticsToolboxState.built.lanes.some((lane) => lane.fromSite === 'Warehouse 3' || lane.site === 'Warehouse 3'))), 'a candidate is left out of the model');
    await page.keyboard.press('Escape');
    await page.click('#scenarioTabs [data-scenario="roadClosure"]');
    await page.selectOption('#closureLaneSelect', harbourLane.link);
    noErrors();

    // 7b. With an engine (KONJUGATE_ENGINE=export runs the model as Konjugate's code export writes it): Harbour shop's
    // only lane closed for ten days, and the summary shows its shelves empty and its shoppers waiting.
    if (process.env.KONJUGATE_ENGINE === 'export') {
        assert.equal(await page.isVisible('#scenarioTabs'), true, 'the scenarios show once the model is built');
        assert.match(await page.textContent('#closureHint'), /Harbour shop's orders over it queue until it reopens/);
        await page.fill('#startInput', '5');
        await page.fill('#durationInput', '10');
        await page.click('#runScenarioButton');
        // A run that is refused says why at once, instead of the test waiting two minutes for a result that will not come.
        await page.waitForSelector('#scenarioResult table, #scenarioStatus .notice.error', { timeout: 120000 }).catch(fail);
        assert.equal(await page.locator('#scenarioStatus .notice.error').count(), 0, await page.textContent('#scenarioStatus'));
        const result = await page.textContent('#scenarioResult');
        assert.match(result.trim(), /^Warehouse 1 → Harbour shop closed from day 5 for 10 days: [\d.]+ pallets a day it no longer carries, its orders waiting for the road to reopen\./, result);
        const row = await page.evaluate(() => [...document.querySelectorAll('#scenarioResult table')].find((table) => /Store/.test(table.tHead.textContent))
            ?.querySelector('tbody tr')?.textContent);
        assert.match(row ?? '', /^Harbour shop/, 'the store that ran lowest comes first');
        const empty = await stateOf(() => window.logisticsToolboxState.scenario.stores.find((item) => item.name === 'Harbour shop').emptyDays);
        assert.ok(empty.scenario > 5 && empty.baseline === 0, `its shelves were empty for most of the closure (${empty.scenario} days)`);
        assert.match(result, /fullest/, 'a warehouse with room for 400 pallets says how full it got');
        // In business terms first: one sentence, then demand met, sales lost and running costs; the rest under Details.
        const headline = await page.textContent('#scenarioResult .headline');
        assert.match(headline, /^Harbour shop ran out of Ambient, Chilled and Frozen for [\d.]+ days, losing [\d,.]+ pallets of sales, worth [\d,]+ INR at an assumed value of a pallet; running costs ((up|down) [\d,]+ \([\d.]+%\) against|as in) the baseline\.$/, headline);
        // By category: the closed road carried all three, so one store ran out of each, and the sales lost add up.
        const byCategory = await stateOf(() => window.logisticsToolboxState.scenario.byCategory);
        assert.deepEqual(byCategory.map((item) => [item.name, item.storesOut]), [['Ambient', 1], ['Chilled', 1], ['Frozen', 1]]);
        const allLost = await stateOf(() => window.logisticsToolboxState.scenario.totals.lost.scenario);
        assert.ok(Math.abs(byCategory.reduce((sum, item) => sum + item.lost.scenario, 0) - allLost) < 1e-6, 'the categories\' lost sales are the total\'s');
        assert.match(await page.textContent('#scenarioResult #byCategory'), /Category.*Ambient.*Chilled.*Frozen/s);
        // Chilled goods keep ten days: what is wasted of them is counted, in all and by category; the others keep.
        const wasted = await stateOf(() => window.logisticsToolboxState.scenario.totals.wasted);
        assert.ok(wasted && wasted.scenario >= 0 && wasted.baseline < 1e-6, `nothing is wasted in the baseline (${JSON.stringify(wasted)})`);
        assert.match(result, /Goods wasted \(pallets\)/);
        assert.deepEqual(byCategory.map((item) => Boolean(item.wasted)), [false, true, false]);
        assert.match(await page.textContent('#scenarioResult #byCategory'), /wasted \(pallets\).*Ambient.*keeps/s);
        assert.match(await page.textContent('#scenarioResult table.business:not(#byCategory) .basis'), /^Ambient: out [\d.]+ days, [\d.]+ lost; Chilled: out/);
        const lost = await stateOf(() => window.logisticsToolboxState.scenario.stores.find((item) => item.name === 'Harbour shop'));
        // Priced by category: chilled goods at the 2,500 a pallet given in the list, the others at the store's 1,000.
        const pricedAt = lost.categories.reduce((sum, item) => sum + item.lost.scenario * (item.name === 'Chilled' ? 2500 : 1000), 0);
        assert.ok(lost.lost.scenario > 0 && lost.lost.baseline === 0 && Math.abs(lost.lostValue.scenario - pricedAt) < 1e-6 && lost.lostValue.scenario > 1000 * lost.lost.scenario, `four in five of the sales it could not make are lost, each category at its own value (${JSON.stringify([lost.lost, lost.lostValue])})`);
        assert.equal(await page.isVisible('#scenarioResult details.resultDetails table'), false, 'the details start folded');
        assert.match(await page.textContent('#scenarioResult details.resultDetails'), /Backlog cost/);
        // The closed road's X, solid now, and gone from the map's baseline view.
        assert.equal(await marks('closed'), 1);
        assert.equal(await marks('planned'), 0, 'one X for the road, not two');
        assert.match(await page.textContent('#map .roadMark.closed title'), /^Warehouse 1 → Harbour shop: closed from day 5 for 10 days$/);
        assert.equal(await page.textContent('#legendClosedText'), 'Road closed');
        // The same closure for half as long, set beside the first run: fewer sales lost, on the same build.
        await page.fill('#durationInput', '5');
        await page.click('#runScenarioButton');
        await page.waitForFunction(() => /for 5 days/.test(document.querySelector('#scenarioResult p')?.textContent ?? ''), null, { timeout: 120000 }).catch(fail);
        const compared = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#scenarioResult .comparison tbody tr')].map((row) => [row.cells[0].textContent, [...row.cells].slice(1).map((cell) => [cell.textContent, cell.className])])));
        const side = await compared();
        assert.match(await page.textContent('#scenarioResult .comparison'), /Run 1, on the same build of the network: Warehouse 1 → Harbour shop closed from day 5 for 10 days/);
        assert.equal(await page.inputValue('#compareSelect'), '1', 'set beside the run before it');
        const [now, then, difference] = side['Value of sales lost'];
        assert.ok(Number(now[0].replace(/,/g, '')) < Number(then[0].replace(/,/g, '')) && /better/.test(difference[1]) && /^−/.test(difference[0]), `a shorter closure loses less (${JSON.stringify(side['Value of sales lost'])})`);
        assert.ok(/better/.test(side['Longest a store was out (days)'][2][1]));
        // Set beside nothing, then the first run again; the choice is kept with the session.
        await page.selectOption('#compareSelect', '');
        assert.equal(await page.locator('#scenarioResult .comparison table').count(), 0);
        await page.selectOption('#compareSelect', '1');
        assert.equal(await page.locator('#scenarioResult .comparison table').count(), 1);
        assert.deepEqual(await stateOf(() => window.logisticsToolboxState.runs.map((run) => run.number)), [1, 2]);
        await page.fill('#durationInput', '10');
        // A supplier short of chilled goods and two days late with them, its warehouses ordering from the other supplier:
        // the run says so, the supplier is ringed on the map, and the details give what it made and what waited.
        await page.click('#scenarioTabs [data-scenario="supplierTrouble"]');
        await page.fill('#supplierShortInput', '80');
        await page.click('#runScenarioButton');
        await page.waitForFunction(() => /^Supplier 2 /.test(document.querySelector('#scenarioResult p')?.textContent ?? '') || document.querySelector('#scenarioStatus .notice.error'), null, { timeout: 120000 }).catch(fail);
        assert.equal(await page.locator('#scenarioStatus .notice.error').count(), 0, await page.textContent('#scenarioStatus'));
        assert.match(await page.textContent('#scenarioResult p'), /^Supplier 2 makes 80% less Chilled than is ordered \([\d.]+ pallets a day\) and takes 2 days longer over Chilled orders from day 5 for 10 days; its warehouses order what it cannot make from Supplier 1\.$/);
        const trouble = await stateOf(() => window.logisticsToolboxState.scenario.suppliers);
        assert.equal(trouble.length, 1);
        assert.ok(trouble[0].name === 'Supplier 2' && trouble[0].made.scenario < trouble[0].made.baseline && trouble[0].waiting.scenario > trouble[0].waiting.baseline, JSON.stringify(trouble));
        assert.match(await page.textContent('#scenarioResult #supplierResult'), /Supplier 2/);
        assert.equal(await page.locator('#map .siteMark.supplier').count(), 1);
        assert.match(await page.textContent('#map .siteMark.supplier title'), /^Supplier 2: makes 80% less and takes 2 days longer from day 5 for 10 days$/);
        assert.equal(await page.isVisible('#legendSupplier'), true);
        // A long legend wraps: the map's credit keeps a line's width and the legend stays a few rows high, the map its height.
        await page.setViewportSize({ width: 1000, height: 950 });
        const legend = await page.evaluate(() => ({
            credit: document.querySelector('.legend .attribution').getBoundingClientRect().width,
            height: document.querySelector('.legend').getBoundingClientRect().height,
            map: document.querySelector('#map').getBoundingClientRect().height
        }));
        await page.setViewportSize({ width: 1500, height: 950 });
        assert.ok(legend.credit >= 260 && legend.height < 60 && legend.map > 680, `the legend takes two rows and the credit a line's width (${JSON.stringify(legend)})`);
        assert.equal(await marks('closed'), 0, 'the closed road\'s X goes with its scenario');
        await page.click('#flowView [data-flows="baseline"]');
        assert.equal(await page.locator('#map .siteMark.supplier').count(), 0, 'no ring on the baseline');
        await page.click('#flowView [data-flows="scenario"]');
        assert.deepEqual(await stateOf(() => window.logisticsToolboxState.runs.map((run) => run.number)), [1, 2, 3]);
        // Harbour shop closed for the ten days: it keeps its stock, so it is not out of anything, and loses its sales;
        // the summary says it was closed, and the map rings it.
        await page.click('#scenarioTabs [data-scenario="siteDown"]');
        assert.equal(await page.inputValue('#downSiteSelect'), 'site:Harbour shop');
        await page.click('#runScenarioButton');
        await page.waitForFunction(() => /^Harbour shop closed/.test(document.querySelector('#scenarioResult p')?.textContent ?? '') || document.querySelector('#scenarioStatus .notice.error'), null, { timeout: 120000 }).catch(fail);
        assert.equal(await page.locator('#scenarioStatus .notice.error').count(), 0, await page.textContent('#scenarioStatus'));
        assert.equal(await page.textContent('#scenarioResult p'), 'Harbour shop closed from day 5 for 10 days: nothing goes into it or out of it, and it sells nothing.');
        const shut = await stateOf(() => window.logisticsToolboxState.scenario.stores.find((item) => item.name === 'Harbour shop'));
        assert.ok(shut.lost.scenario > 1 && shut.emptyDays.scenario - shut.emptyDays.baseline < 0.05, `closed, it loses sales with stock on its shelves (${JSON.stringify([shut.lost, shut.emptyDays])})`);
        const shutRow = await page.evaluate(() => [...document.querySelectorAll('#scenarioResult table')].find((table) => /^Store/.test(table.tHead.textContent))?.querySelector('tbody tr')?.textContent);
        assert.match(shutRow ?? '', /^Harbour shopclosed for 10 days: its stock stayed, its sales did not/);
        assert.equal(await page.locator('#map .siteMark.down').count(), 1);
        assert.match(await page.textContent('#map .siteMark.down title'), /^Harbour shop: closed from day 5 for 10 days$/);
        assert.equal(await page.locator('#map .siteMark.supplier').count(), 0, 'the supplier\'s ring goes with its scenario');
        // Closed, it sold nothing with stock on its shelves: that is not a store running short, and the headline does not call it one.
        const closedHeadline = await page.textContent('#scenarioResult .headline');
        assert.match(closedHeadline, /^No store ran out, but [\d,.]+ pallets of sales were lost, worth [\d,]+ INR at an assumed value of a pallet;/, closedHeadline);
        assert.equal(await page.isVisible('#legendDown'), true);
        // The weakest link: each supplier starting nothing new and each warehouse down, run in turn for the ten days and
        // ranked by the sales they lose, worst first, none of them kept as a run of its own; then the worst run alone.
        await page.click('#scenarioTabs [data-scenario="weakestLink"]');
        await page.click('#runScenarioButton');
        await page.waitForSelector('#rankingTable, #scenarioStatus .notice.error', { timeout: 300000 }).catch(fail);
        assert.equal(await page.locator('#scenarioStatus .notice.error').count(), 0, await page.textContent('#scenarioStatus'));
        const ranking = await stateOf(() => window.logisticsToolboxState.ranking);
        assert.deepEqual(ranking.rows.map((row) => row.name).sort(), ['Supplier 1', 'Supplier 2', 'Warehouse 1', 'Warehouse 2']);
        assert.ok(ranking.rows.every((row, index) => !index || ranking.rows[index - 1].lostValue >= row.lostValue), `worst first (${ranking.rows.map((row) => Math.round(row.lostValue))})`);
        assert.ok(ranking.rows[0].lostValue > 0 && ranking.rows[0].storesOut > 0, 'the worst failure empties stores and loses sales');
        assert.deepEqual([ranking.start, ranking.days], [5, 10]);
        const worst = ranking.rows[0];
        assert.match(await page.textContent('#rankingResult .headline'), new RegExp(`^The weakest link: ${worst.name}\\. If ${worst.what} for 10 days, it costs most, losing sales worth [\\d,]+ INR\\.`));
        assert.equal(await page.locator('#rankingTable tbody tr').count(), 4);
        assert.match(await page.textContent('#rankingTable tbody tr'), new RegExp(`^1${worst.what}`));
        // A supplier's failure is named for what it is: it starts nothing new, and what it was making still ships.
        assert.ok((await stateOf(() => window.logisticsToolboxState.ranking.rows.map((row) => row.what))).some((what) => /^Supplier \d+ starts nothing new$/.test(what)));
        assert.match(await page.textContent('#rankingResult'), /A supplier that starts nothing new still ships what it was already making/);
        assert.deepEqual(await stateOf(() => window.logisticsToolboxState.runs.map((run) => run.number)), [1, 2, 3, 4], 'the failures ranked are not runs of their own');
        // (Kept a moment after it is shown, as every change is.)
        for (let waited = 0; waited < 50 && !host.session?.ranking; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(host.session.ranking.rows.map((row) => row.name), ranking.rows.map((row) => row.name), 'the ranking is kept with the session');
        // Run it: the worst failure alone, from its own tab, with its map and details.
        await page.click('#rankingTable [data-run-failure="0"]');
        await page.waitForFunction((what) => (document.querySelector('#scenarioResult p')?.textContent ?? '').startsWith(what) || document.querySelector('#scenarioStatus .notice.error'), `${worst.name} `, { timeout: 120000 }).catch(fail);
        assert.equal(await page.locator('#scenarioStatus .notice.error').count(), 0, await page.textContent('#scenarioStatus'));
        assert.equal(await page.evaluate(() => document.querySelector('#scenarioTabs .active').dataset.scenario), worst.kind === 'supplier' ? 'supplierTrouble' : 'siteDown');
        assert.equal(await page.isVisible('#rankingResult'), false, 'the ranking shows under its own tab');
        const alone = await stateOf(() => window.logisticsToolboxState.scenario.totals.lostValue);
        assert.ok(Math.abs(alone.scenario - alone.baseline - worst.lostValue) < 0.01 * worst.lostValue + 1, `run alone, it loses what it lost in the ranking (${alone.scenario - alone.baseline} against ${worst.lostValue})`);
        assert.deepEqual(await stateOf(() => window.logisticsToolboxState.runs.map((run) => run.number)), [1, 2, 3, 4, 5]);
        // As planned, with a festival in the calendar: three days from day 20 on which twice the chilled goods are wanted.
        // There is no disruption and nothing to set it against: one column, and what the plan itself loses.
        await page.evaluate(() => { document.querySelector('#holidays').open = true; });
        await page.click('#addHolidayButton');
        await change('#holidayList [data-holiday-field="day"]', '20');
        await change('#holidayList [data-holiday-field="days"]', '3');
        await change('#holidayList [data-holiday-demand="chilled"]', '100');
        await page.click('#buildButton');
        await page.waitForFunction(() => document.querySelector('#buildStatus .notice.ok') && !window.logisticsToolboxState.busy, null, { timeout: 60000 }).catch(fail);
        assert.ok(await stateOf(() => window.logisticsToolboxState.built.provenance.some((entry) => entry.entity === 'Holidays and peaks: Chilled')), 'the festival is in the model');
        await page.click('#scenarioTabs [data-scenario="asPlanned"]');
        assert.equal(await page.textContent('#runScenarioButton'), 'Run it as planned');
        assert.match(await page.textContent('#plannedHint'), /^1 holiday or peak in the calendar: Holiday 1 \(day 20\); no site keeps hours\.$/);
        await page.click('#runScenarioButton');
        await page.waitForFunction(() => /^The network as planned/.test(document.querySelector('#scenarioResult p')?.textContent ?? '') || document.querySelector('#scenarioStatus .notice.error'), null, { timeout: 120000 }).catch(fail);
        assert.equal(await page.locator('#scenarioStatus .notice.error').count(), 0, await page.textContent('#scenarioStatus'));
        const planned = await stateOf(() => window.logisticsToolboxState.scenario);
        assert.equal(planned.absolute, true);
        assert.equal(planned.id, 'asPlanned');
        assert.match(planned.describe, /^The network as planned, counted from day 5: Holiday 1 \(day 20 for 3 days\): Chilled demand \+100%; no disruption\.$/);
        assert.equal(planned.totals.lost.baseline, 0, 'what the plan loses is its own: set against nothing');
        const chilledLost = planned.byCategory.find((item) => item.name === 'Chilled').lost.scenario;
        assert.ok(chilledLost > 0.1 && planned.byCategory.find((item) => item.name === 'Ambient').lost.scenario < 1e-6, `the festival loses sales of chilled goods alone (${chilledLost})`);
        assert.match(await page.textContent('#scenarioResult .headline'), /running costs of [\d,]+ since day 5\.$/);
        assert.deepEqual(await page.$$eval('#scenarioResult table.business thead', (heads) => [...heads[0].querySelectorAll('th')].map((cell) => cell.textContent)), ['Since day 5', 'As planned']);
        // A new site: the network as it is and the network with Warehouse 3 open, each built and run with the road to
        // Harbour shop closed for the ten days. With the candidate, which also restocks Harbour shop, the closure costs
        // less; it is dearer to run by its fixed cost, and the verdict says how often such a closure must come to pay.
        await page.click('#scenarioTabs [data-scenario="newSite"]');
        await page.selectOption('#siteStressSelect', 'roadClosure');
        await page.click('#runScenarioButton');
        await page.waitForSelector('#siteTable, #scenarioStatus .notice.error', { timeout: 400000 }).catch(fail);
        assert.equal(await page.locator('#scenarioStatus .notice.error').count(), 0, await page.textContent('#scenarioStatus'));
        const sites = await stateOf(() => window.logisticsToolboxState.siteComparison);
        assert.deepEqual(sites.rows.map((row) => [row.name, row.candidate, row.fixedMonthly, row.error ?? null]), [['As it is', null, 0, null], ['With Warehouse 3', 'Warehouse 3', 2000, null]]);
        assert.match(sites.described, /^Warehouse 1 → Harbour shop closed from day 5 for 10 days/);
        const [asIs, withSite] = sites.rows;
        assert.ok(asIs.stress.lostValue > 0 && withSite.stress.lostValue < 0.8 * asIs.stress.lostValue, `the closure costs less with the candidate open (${withSite.stress.lostValue} against ${asIs.stress.lostValue})`);
        assert.ok(withSite.extraMonthly > 1500, `dearer to run by its fixed cost and its own running (${withSite.extraMonthly} a month)`);
        assert.match(withSite.verdict, /^Dearer to run by [\d,]+ a month, and one such disruption costs [\d,]+ less with it: it pays for its running if one comes more often than once every [\d.,]+ months\. Its cost to open, 50,000, is back after [\d.,]+ such disruptions\.$/);
        assert.equal(await page.locator('#siteTable tbody tr').count(), 2);
        assert.match(await page.textContent('#siteTable tbody tr:nth-child(2)'), /^With Warehouse 3Dearer to run by/);
        // The network on the map is the one built again: the candidate is out of the model, and the runs are as they were.
        assert.ok(!(await stateOf(() => window.logisticsToolboxState.built.lanes.some((lane) => lane.fromSite === 'Warehouse 3'))));
        assert.deepEqual(await stateOf(() => window.logisticsToolboxState.runs.map((run) => run.number)), [1, 2, 3, 4, 5, 6]);
        await page.click('#scenarioTabs [data-scenario="roadClosure"]');
        // A host that applies none of a scenario's changes (Konjugate up to 1.1.10, on a model its engine partitioned)
        // answers with the baseline twice: the window says the run is the baseline's, and not that nothing was lost.
        host.dropChanges = true;
        await page.click('#runScenarioButton');
        await page.waitForFunction(() => /^This run is the baseline's in every figure/.test(document.querySelector('#scenarioResult .headline')?.textContent ?? '') || document.querySelector('#scenarioStatus .notice.error'), null, { timeout: 120000 }).catch(fail);
        assert.match(await page.textContent('#scenarioResult .headline'), /^This run is the baseline's in every figure, to the last digit: .* Do not read this as "nothing was lost"\.$/);
        assert.equal(await stateOf(() => window.logisticsToolboxState.scenario.unchanged), true);
        host.dropChanges = false;
        noErrors();
    }

    // The candidate undone, step by step, the network is the ten sites it was.
    for (let step = 0; step < 20 && await stateOf(() => window.logisticsToolboxState.pins.length) > placements.length; step += 1) await page.click('#undoButtonTool');
    assert.equal(await stateOf(() => window.logisticsToolboxState.pins.length), placements.length);
    assert.equal(await page.locator('#map .site.candidate').count(), 0);

    // 8. Suggestions, only when asked for: ports from the sample's data (nothing fetched), shown hollow, adopted by a click.
    assert.deepEqual(host.requests, [], 'the sample region fetches nothing');
    await page.click('#suggestions summary');
    await page.click('[data-fetch-source="ports"]');
    await page.waitForFunction(() => document.querySelectorAll('#map .site.dropped').length === 2, null, { timeout: 30000 }).catch(fail);
    assert.match(await page.textContent('[data-source-state="ports"]'), /2 found/);
    assert.match(await page.textContent('#candidateList'), /Port Alder/);
    const alder = await stateOf(() => window.logisticsToolboxState.suggestions.ports.candidates.ports[0]);
    await clickAt(alder);
    await page.waitForFunction(() => window.logisticsToolboxState.pins.some((pin) => pin.name === 'Port Alder' && pin.role === 'port'), null, { timeout: 10000 }).catch(fail);
    assert.equal(await page.locator('#map .site.dropped').count(), 1, 'Birch Harbour is still a suggestion');
    assert.equal(await page.isVisible('#portSettings'), true, 'the port settings show once there is a port');
    // Towns: the top two adopted from the list.
    await page.click('[data-fetch-source="towns"]');
    await page.waitForFunction(() => window.logisticsToolboxState.suggestions.towns, null, { timeout: 30000 }).catch(fail);
    await page.fill('#topN', '2');
    await page.click('#applyTop');
    assert.equal((await pins()).filter((pin) => pin.role === 'customerArea').length, 3);
    assert.equal(await page.locator('#candidateList li.adopted').count(), 2);
    assert.deepEqual(host.requests, [], 'still nothing fetched');
    noErrors();

    // 9. The network saved as a CSV reads back as the same sites and links.
    const download = page.waitForEvent('download');
    await page.click('#saveSitesButton');
    const csv = await readFile(await (await download).path(), 'utf8');
    const parsed = parseSites(csv);
    assert.deepEqual(parsed.errors, []);
    const all = await pins();
    assert.deepEqual([...parsed.sites.ports, ...parsed.sites.zones, ...parsed.sites.towns].map((site) => site.name).sort(), all.map((pin) => pin.name).sort());
    assert.match(csv, /^Harbour shop,store,[-\d.]+,[-\d.]+,20,,,,,Warehouse 1,,,$/m);

    // 10. The session, kept with the project, restores the network on reopening.
    const kept = { pins: await pins(), links: (await links()).map((link) => [link.from, link.to, link.basis]) };
    await page.click('#showButton');
    await openWindow(page, host);
    await page.waitForFunction(() => /Restored the session kept with this project/.test(document.querySelector('#regionStatus').textContent), null, { timeout: 30000 }).catch(fail);
    assert.deepEqual(await pins(), kept.pins);
    assert.deepEqual((await links()).map((link) => [link.from, link.to, link.basis]), kept.links);
    assert.ok((await links()).every((link) => link.routed), 'routed again');
    assert.deepEqual(await harbourVehicles(), [{ type: 'smallTruck', fleet: null }], 'a link keeps its vehicles');
    assert.deepEqual(await timeOf(harbourLink.id), { hours: 2, when: 'peak', how: 'yours' }, 'and its travel time');
    assert.equal(await stateOf(() => window.logisticsToolboxState.useCalibration), true, 'and the calibration chosen');
    assert.equal(await stateOf(() => window.logisticsToolboxState.vehicles.find((type) => type.id === 'miniVan').fields.capacity.value), 2.5, 'the catalogue is kept');
    assert.equal(await stateOf(() => window.logisticsToolboxState.pins[2].fields.capacity.value), 400, 'a warehouse keeps its room');
    assert.match(await page.textContent('#buildResult'), /Harbour shop/);
    assert.equal(await page.locator('#map .site.dropped').count(), 2, 'the suggestions asked for are shown again (Birch Harbour and the third town)');
    noErrors();

    // 11. A file of sites loads as pins with their links.
    host.chosen.sites = 'name,kind,latitude,longitude,teuPerDay,from\nNorth mill,supplier,-29.65,-19.7,30,\nHill shop,store,-29.74,-19.7,,Warehouse 1\nNorth depot,warehouse,-29.7,-19.7,,North mill\n';
    await page.click('#sitesButton');
    await page.waitForFunction(() => /3 sites and 2 links from your file/.test(document.querySelector('#regionStatus').textContent), null, { timeout: 30000 }).catch(fail);
    const fromFile = (await pins()).filter((pin) => ['North mill', 'Hill shop', 'North depot'].includes(pin.name));
    assert.equal(fromFile.length, 3);
    assert.ok((await links()).some((link) => link.to === fromFile.find((pin) => pin.name === 'Hill shop').id && link.basis === 'user'));
    noErrors();

    // 12. A session of the earlier workflow: its kept sites become pins, linked as suggested, and the window says so.
    host.session = { version: 1, place: null, bbox: null, kept: { ports: ['port:way/1008'], zones: ['zone:way/1016'], towns: ['town:node/5004', 'town:node/5005'] }, changes: [['port:way/1008', { teuPerDay: 150 }]], added: [{ id: 'added:1', kind: 'town', name: 'Harbour customers', lat: -29.93, lon: -19.8 }], built: null };
    await openWindow(page, host);
    await page.waitForFunction(() => /kept by the earlier workflow/.test(document.querySelector('#regionStatus').textContent), null, { timeout: 30000 }).catch(fail);
    const migrated = await pins();
    assert.deepEqual(migrated.map((pin) => [pin.name, pin.role]), [['Port Alder', 'port'], ['Alder Industrial Park', 'warehouse'], ['Cedarton', 'customerArea'], ['Dunmore', 'customerArea'], ['Harbour customers', 'customerArea']]);
    assert.equal(await stateOf(() => window.logisticsToolboxState.pins[0].fields.teuPerDay.value), 150);
    assert.equal(await page.textContent('#networkStatus'), '', 'linked as suggested, ready to build');
    noErrors();

    // 13. A searched region: the roads and place names alone; ports fetched only when asked for, with their activity.
    host.requests.length = 0;
    host.session = null;
    await openWindow(page, host);
    await page.fill('#searchInput', 'Port Alder');
    await page.click('#searchButton');
    await page.click('#searchResults button[data-index="0"]');
    await page.selectOption('#roadLevelSelect', 'city');
    // 25 km around the place is too large an area for city streets; 10 km is not.
    assert.match(await page.textContent('#areaSize'), /too large for city streets/);
    assert.equal(await page.isDisabled('#fetchButton'), true);
    await page.selectOption('#marginSelect', '10');
    assert.match(await page.textContent('#areaSize'), /^\d+ × \d+ km(\. A large area: loading may take a minute\.)?$/);
    await page.click('#fetchButton');
    await page.waitForSelector('#stepNetwork:not([hidden])', { timeout: 60000 }).catch(fail);
    await settled();
    const queries = () => host.requests.filter((url) => url.includes('/api/interpreter')).map((url) => new URL(url).searchParams.get('data'));
    assert.ok(queries().length >= 2 && queries().every((query) => query.includes('"highway"') || query.includes('"place"')), 'roads and place names only');
    assert.ok(queries().filter((query) => query.includes('"highway"')).every((query) => /secondary\|tertiary/.test(query)), 'city streets asked for');
    assert.equal(host.requests.filter((url) => url.includes('arcgis')).length, 0, 'no port activity yet');
    assert.equal(await page.locator('#map .site').count(), 0);
    await page.click('#suggestions summary');
    await page.click('[data-fetch-source="ports"]');
    await page.waitForFunction(() => window.logisticsToolboxState.suggestions.ports, null, { timeout: 60000 }).catch(fail);
    assert.ok(queries().some((query) => query.includes('"landuse"="port"')), 'ports fetched when asked for');
    assert.ok(!queries().some((query) => query.includes('"building"="warehouse"')), 'warehouses not fetched');
    assert.equal(host.requests.filter((url) => url.includes('arcgis')).length, 2, 'the PortWatch ports and Alder\'s history');
    assert.match(await page.textContent('#candidateList'), /IMF PortWatch \(Alder\)/);
    assert.match(await page.textContent('#attribution'), /IMF PortWatch/);
    noErrors();

    // 13b. What was fetched is kept on this computer: the same area loads again with nothing fetched, and says when it
    // was fetched; Load fresh fetches it again; Clear empties the cache.
    const interpreter = () => host.requests.filter((url) => url.includes('/api/interpreter')).length;
    assert.match(await page.textContent('#cacheSummary'), /Maps kept on this computer: [\d.]+ MB/);
    assert.match(await page.textContent('#dataAgeText'), /^Roads fetched on .+\.$/);
    assert.ok(!/from the cache/.test(await page.textContent('#dataAgeText')), 'fetched from the servers the first time');
    const fetchedBefore = interpreter();
    const statusBefore = host.requests.filter((url) => url.endsWith('/api/status')).length;
    await page.click('#fetchButton');
    await page.waitForFunction(() => document.querySelectorAll('#fetchProgress li.done').length === 2, null, { timeout: 30000 }).catch(fail);
    await settled();
    assert.equal(interpreter(), fetchedBefore, 'nothing fetched: the roads and place names came from the cache');
    assert.equal(host.requests.filter((url) => url.endsWith('/api/status')).length, statusBefore, 'and the server was not even asked whether it is busy');
    assert.match(await page.textContent('#fetchProgress'), /from the cache, fetched/);
    assert.match(await page.textContent('#dataAgeText'), /from the cache\.$/);
    // Ports asked for again: their answers, and PortWatch's, come from the cache too.
    const arcgisBefore = host.requests.filter((url) => url.includes('arcgis')).length;
    await page.click('[data-fetch-source="ports"]');
    await page.waitForFunction(() => window.logisticsToolboxState.suggestions.ports, null, { timeout: 30000 }).catch(fail);
    assert.equal(interpreter(), fetchedBefore);
    assert.equal(host.requests.filter((url) => url.includes('arcgis')).length, arcgisBefore);
    assert.match(await page.textContent('[data-source-state="ports"]'), /found, fetched .+ \(kept\)/);
    // Load fresh: everything fetched again from the servers, and kept again.
    await page.click('#dataAgeFresh');
    await page.waitForFunction(() => document.querySelectorAll('#fetchProgress li.done').length === 2, null, { timeout: 30000 }).catch(fail);
    await settled();
    assert.ok(interpreter() > fetchedBefore, 'fetched again');
    assert.ok(!/from the cache/.test(await page.textContent('#dataAgeText')));
    // Clear: the cache is emptied, and says so.
    await page.click('#clearCacheButton');
    await page.waitForFunction(() => /No maps kept on this computer yet/.test(document.querySelector('#cacheSummary').textContent), null, { timeout: 10000 }).catch(fail);
    assert.match(await page.textContent('#undoText'), /^Cleared [\d.]+ MB of kept maps\./);
    assert.equal((await host.cache.info()).entries, 0);
    noErrors();

    // 14. On a Mac: ⌘ and ⌫ in every label, ⌘Z to undo (Control+Z does nothing), ⌘-click to add to the selection, and
    // Control-click opens the menu without selecting.
    const macPage = await context.newPage();
    macPage.on('pageerror', (error) => log.push(`pageerror: ${error.message}`));
    await macPage.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
    const macHost = await createHost();
    await openWindow(macPage, macHost);
    await macPage.click('#sampleButton');
    await macPage.waitForSelector('#stepNetwork:not([hidden])', { timeout: 30000 }).catch(fail);
    const macScreen = (point) => macPage.evaluate(({ lat, lon }) => {
        const bbox = window.logisticsToolboxState.roads.map.bbox;
        const origin = { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };
        const svg = document.querySelector('#map');
        const p = svg.createSVGPoint();
        p.x = (lon - origin.lon) * Math.cos(origin.lat * Math.PI / 180) * 111.32;
        p.y = -(lat - origin.lat) * 111.32;
        const s = p.matrixTransform(svg.getScreenCTM());
        return { x: s.x, y: s.y };
    }, point);
    const macPins = () => macPage.evaluate(() => window.logisticsToolboxState.pins.length);
    await macPage.keyboard.press('4');
    const one = await macScreen({ lat: -29.95, lon: -19.72 });
    const two = await macScreen({ lat: -29.85, lon: -19.69 });
    await macPage.mouse.click(one.x, one.y);
    await macPage.mouse.click(two.x, two.y);
    await macPage.keyboard.press('Escape');
    assert.equal(await macPins(), 2);
    await macPage.keyboard.press('?');
    const macList = await macPage.textContent('#shortcutList');
    assert.match(macList, /⌘Z.*⇧⌘Z.*⌘A.*⌘D/s);
    assert.match(macList, /⌫ \(delete\) or ⌦.*Delete what is selected/s);
    assert.match(macList, /Right-click or Control-click/);
    assert.ok(!/Ctrl/.test(macList), 'no Ctrl on a Mac');
    await macPage.keyboard.press('Escape');
    await macPage.keyboard.press('Control+z');
    assert.equal(await macPins(), 2, 'Control+Z is not undo on a Mac');
    await macPage.keyboard.press('Meta+z');
    assert.equal(await macPins(), 1, '⌘Z undoes');
    await macPage.keyboard.press('Meta+Shift+z');
    assert.equal(await macPins(), 2, '⇧⌘Z redoes');
    // ⌘-click adds to the selection; Control-click opens the menu and selects only what it was opened on.
    await macPage.mouse.click(one.x, one.y);
    await macPage.keyboard.down('Meta');
    await macPage.mouse.click(two.x, two.y);
    await macPage.keyboard.up('Meta');
    assert.equal(await macPage.evaluate(() => window.logisticsToolboxState.selection.length), 2);
    await macPage.keyboard.press('Escape');
    await macPage.keyboard.down('Control');
    await macPage.mouse.click(one.x, one.y);
    await macPage.keyboard.up('Control');
    await macPage.waitForSelector('#contextMenu:not([hidden])', { timeout: 5000 }).catch(fail);
    assert.equal(await macPage.evaluate(() => window.logisticsToolboxState.selection.length), 1);
    assert.match(await macPage.textContent('#contextMenu'), /Duplicate⌘D.*Delete⌫/s);
    await macPage.close();
    noErrors();

    // 8. Roads from a file: an OpenStreetMap extract of the user's, read with no map server. A small invented town: a
    // grid of streets, primary ones around it, and its name. The file's own area is taken, as no place is searched.
    {
        const { writeOsmPbf } = await import('../fixtures/osmPbfFixture.mjs');
        const side = 6;
        const at = (row, column) => ({ id: 1 + row * side + column, lat: 40 + row * 0.01, lon: 10 + column * 0.01 });
        const nodes = Array.from({ length: side * side }, (_unused, index) => at(Math.floor(index / side), index % side));
        nodes.push({ id: 900, lat: 40.025, lon: 10.025, tags: { place: 'town', name: 'Gridtown' } });
        const ways = [];
        for (let line = 0; line < side; line += 1) {
            const edge = line === 0 || line === side - 1;
            ways.push({ id: 1000 + line, nodes: Array.from({ length: side }, (_unused, column) => at(line, column).id), tags: { highway: edge ? 'primary' : 'tertiary', name: `Row ${line}` } });
            ways.push({ id: 2000 + line, nodes: Array.from({ length: side }, (_unused, row) => at(row, line).id), tags: { highway: edge ? 'primary' : 'tertiary', name: `Column ${line}` } });
        }
        const town = { south: 39.99, west: 9.99, north: 40.06, east: 10.06 };
        const requestsBefore = host.requests.length;
        await page.click('#sampleButton');
        await page.waitForFunction(() => !document.querySelector('#fetchButton').disabled);
        // A file covering far more than can be loaded, with no place searched, is refused with what to do.
        host.chosen.extract = { name: 'continent.osm.pbf', data: writeOsmPbf({ nodes, ways, bounds: { south: 30, west: 0, north: 50, east: 20 } }) };
        await page.click('#extractButton');
        await page.waitForSelector('#regionStatus .notice.error');
        assert.match(await page.textContent('#regionStatus .notice.error'), /^continent\.osm\.pbf covers an area that is [\d,]+ km across: roads are loaded for areas up to 250 km across\. Search a place first, and the roads around it are read from the file\.$/);
        // The town's own file, eight kilometres across: a city's, so its streets are read too.
        host.chosen.extract = { name: 'gridtown.osm.pbf', data: writeOsmPbf({ nodes, ways, bounds: town }) };
        await page.click('#extractButton');
        await page.waitForSelector('#fetchProgress li.done');
        assert.equal(await page.textContent('#fetchProgress li.done'), 'Roads and city streets12 roads and 1 place names, from gridtown.osm.pbf');
        assert.equal(await page.locator('#regionStatus .notice.error').count(), 0, await page.textContent('#regionStatus'));
        assert.equal(await stateOf(() => window.logisticsToolboxState.roadLevel), 'city');
        // Said where the roads came from, with nothing to fetch fresh; drawn, and routed over.
        assert.equal(await page.textContent('#dataAgeText'), 'Roads read from gridtown.osm.pbf, a file of yours: as fresh as the file.');
        assert.equal(await page.isVisible('#dataAgeFresh'), false);
        assert.deepEqual(await stateOf(() => [window.logisticsToolboxState.extract, window.logisticsToolboxState.roads.graph.vertices.length > 30, window.logisticsToolboxState.roads.map.places.map((place) => place.name)]), ['gridtown.osm.pbf', true, ['Gridtown']]);
        assert.ok(await page.locator('#map path.road').count() >= 12);
        // No map server was asked, and the file itself is not kept: what was read from it is, saying where it came from.
        assert.deepEqual(host.requests.slice(requestsBefore).filter((url) => /overpass/.test(url)), []);
        const kept = [...host.files.values()];
        assert.ok(!kept.some((file) => file.binary), 'the extract is not among the inputs');
        assert.deepEqual(kept.filter((file) => file.source).map((file) => [file.role, file.name, file.source]), [['roads', 'roads-extract-1.json', 'gridtown.osm.pbf'], ['places', 'places-extract.json', 'gridtown.osm.pbf']]);
        // Two sites placed on it are linked by its streets.
        await page.click('[data-add="warehouse"]');
        await clickAt({ lat: 40.0, lon: 10.0 });
        await page.keyboard.press('Escape');
        await page.click('[data-add="store"]');
        await clickAt({ lat: 40.03, lon: 10.03 });
        await page.keyboard.press('Escape');
        const leg = await stateOf(() => { const [link] = window.logisticsToolboxState.links; return link ? [link.basis, Math.round(link.kilometres ?? link.leg?.kilometres ?? 0)] : null; });
        assert.ok(leg, 'the store is linked to the warehouse over the roads read');
        noErrors();
    }

    console.log(`✓ logistics network window: the sample region loads its roads alone; ${placements.length} pins placed from the palette are linked and routed as suggested; every action works from a button or menu, a drag or a right click, and the keyboard, and undoes; a moved store re-routes its one link in ${routing.milliseconds < 1 ? 'under a millisecond' : `${routing.milliseconds.toFixed(0)} ms`}; links are drawn, refused with a reason, deleted and not suggested again; the model is built from the pins and links, a copy for each of its three categories (${built.match(/\d+ nodes/)[0]}), its stores holding stock and its links on the vehicles chosen on their cards, from their menus and with V;${process.env.KONJUGATE_ENGINE === 'export' ? ' a store whose road closes runs out of stock a supplier short and late is ringed on the map, a closed store keeps its stock and loses its sales and the failures of suppliers and warehouses are ranked by what they cost;' : ''} ports and towns are suggested only when asked for and adopted; the network saves as a CSV and loads back; the session restores it, and an earlier session is migrated; shortcuts behave and read as Windows and Linux users and Mac users expect; a network is kept with the project before any build; an area loaded is kept on the computer and loads again with nothing fetched, fresh on request, and the cache clears; a searched region fetches its roads and place names alone, and ports only when asked for.`);
} finally {
    await browser.close();
    await rm(scratch, { recursive: true, force: true });
}
