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
    assert.ok(Math.abs(popoverBox.x - sitePoint.x) < 40 && sitePoint.y - (popoverBox.y + popoverBox.height) > 0 && sitePoint.y - (popoverBox.y + popoverBox.height) < 40, `the popover at ${JSON.stringify(popoverBox)} is beside the site at ${JSON.stringify(sitePoint)}`);
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
    assert.deepEqual(await page.$$eval('#vehicleList [data-vehicle-name]', (inputs) => inputs.map((input) => input.value)), ['Heavy truck', 'Medium truck', 'Small truck', 'Mini-van']);
    const vanCapacity = '#vehicleList [data-type="miniVan"] [data-vehicle-field="capacity"]';
    await page.fill(vanCapacity, '2.5');
    await page.dispatchEvent(vanCapacity, 'change');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.vehicles.find((type) => type.id === 'miniVan').fields.capacity), { value: 2.5, basis: 'user' });
    assert.equal(await page.textContent('#vehicleList [data-type="miniVan"] .field .basis'), 'yours');
    await page.click('#addVehicleButton');
    assert.deepEqual(await stateOf(() => window.logisticsToolboxState.vehicles.map((type) => type.name)), ['Heavy truck', 'Medium truck', 'Small truck', 'Mini-van', 'Vehicle 1']);
    await page.click('#undoButtonTool');
    assert.equal(await stateOf(() => window.logisticsToolboxState.vehicles.length), 4, 'adding a type undone');
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
    assert.deepEqual(await harbourVehicles(), [{ type: 'mediumTruck', fleet: null }]);
    assert.match(await page.textContent('#undoText'), /carried by medium trucks/);
    // Medium trucks kept off stores: the link to Harbour shop cannot be built, and says why.
    await page.uncheck('#vehicleList [data-type="mediumTruck"] [data-vehicle-stores]');
    assert.match(await page.textContent('#networkStatus'), /Medium truck may not deliver to stores: choose another vehicle for Warehouse 1 → Harbour shop\./);
    assert.equal(await page.isDisabled('#buildButton'), true);
    await page.click('#undoButtonTool');
    assert.ok(!/may not deliver/.test(await page.textContent('#networkStatus')));
    // Undo, step by step: V, the menu, the type taken off, the fleet, the type added, the type chosen.
    for (let step = 0; step < 6; step += 1) await page.click('#undoButtonTool');
    assert.equal(await harbourVehicles(), undefined, 'back to its kind\'s vehicles');
    await page.click('#redoButtonTool');
    assert.deepEqual(await harbourVehicles(), [{ type: 'smallTruck', fleet: null }]);
    await page.keyboard.press('Escape');
    noErrors();

    // 7. The model, built from the pins and links.
    await page.click('#buildButton');
    await page.waitForSelector('#buildStatus .notice.ok, #buildStatus .notice.error', { timeout: 60000 }).catch(fail);
    const built = await page.textContent('#buildStatus');
    assert.match(built, /^2 suppliers, \d+ road lanes?, 6 stores and customer areas served: \d+ nodes and \d+ relationships, now in the canvas\./, built);
    const lanes = await page.evaluate(() => document.querySelector('#buildResult table').tBodies[0].rows.length);
    const supplyLanes = await stateOf(() => window.logisticsToolboxState.built.lanes.filter((lane) => lane.kind === 'supply').length);
    const unusedLinks = await stateOf(() => window.logisticsToolboxState.built.unusedLinks.length);
    assert.equal(supplyLanes + unusedLinks, 4, 'a lane for each supply link, or the link said to be left out');
    // And one to each store and dark store from each of its warehouses: they hold stock, restocked by road.
    const stocked = placements.filter(([role]) => role === 'store' || role === 'darkStore').length;
    const storeLanes = await stateOf(() => window.logisticsToolboxState.built.lanes.filter((lane) => lane.kind === 'store'));
    assert.equal(new Set(storeLanes.map((lane) => lane.site)).size, stocked, 'a lane to every store and dark store');
    assert.equal(lanes, supplyLanes + storeLanes.length, 'every lane in the table');
    assert.match(await page.textContent('#buildResult'), /Harbour shop/);
    assert.ok(host.session?.version === 2 && host.session.pins.length === placements.length, 'the session went with the model');
    assert.match(await page.textContent('#buildResult'), /pallets\/day.*vehicles/s);
    assert.ok(storeLanes.some((lane) => lane.site === 'Harbour shop' && lane.vehicles[0].type === 'smallTruck'), 'Harbour shop restocked by small trucks');
    assert.deepEqual(host.session.vehicles.find((type) => type.id === 'miniVan').fields.capacity, { value: 2.5, basis: 'user' });
    assert.deepEqual(host.session.links.find((link) => link.id === harbourLink.id).vehicles, [{ type: 'smallTruck', fleet: null }]);
    noErrors();

    // 7b. With an engine (KONJUGATE_ENGINE=export runs the model as Konjugate's code export writes it): Harbour shop's
    // only lane closed for ten days, and the summary shows its shelves empty and its shoppers waiting.
    if (process.env.KONJUGATE_ENGINE === 'export') {
        assert.equal(await page.isVisible('#scenarioTabs'), true, 'the scenarios show once the model is built');
        await page.click('#scenarioTabs [data-scenario="roadClosure"]');
        const harbourLane = storeLanes.find((lane) => lane.site === 'Harbour shop');
        await page.selectOption('#closureLaneSelect', harbourLane.name);
        assert.match(await page.textContent('#closureHint'), /Harbour shop's orders over it queue until it reopens/);
        await page.fill('#startInput', '5');
        await page.fill('#durationInput', '10');
        await page.click('#runScenarioButton');
        await page.waitForSelector('#scenarioResult table', { timeout: 120000 }).catch(fail);
        const result = await page.textContent('#scenarioResult');
        assert.match(result.trim(), /^Warehouse 1 → Harbour shop closed from day 5 for 10 days: [\d.]+ pallets a day it no longer carries, its orders waiting for the road to reopen\./, result);
        const row = await page.evaluate(() => [...document.querySelectorAll('#scenarioResult table')].find((table) => /Store/.test(table.tHead.textContent))
            ?.querySelector('tbody tr')?.textContent);
        assert.match(row ?? '', /^Harbour shop/, 'the store that ran lowest comes first');
        const empty = await stateOf(() => window.logisticsToolboxState.scenario.stores.find((item) => item.name === 'Harbour shop').emptyDays);
        assert.ok(empty.scenario > 5 && empty.baseline === 0, `its shelves were empty for most of the closure (${empty.scenario} days)`);
        assert.match(result, /fullest/, 'a warehouse with room for 400 pallets says how full it got');
        noErrors();
    }

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
    assert.match(csv, /^Harbour shop,store,[-\d.]+,[-\d.]+,20,,,,,Warehouse 1$/m);

    // 10. The session, kept with the project, restores the network on reopening.
    const kept = { pins: await pins(), links: (await links()).map((link) => [link.from, link.to, link.basis]) };
    await page.click('#showButton');
    await openWindow(page, host);
    await page.waitForFunction(() => /Restored the session kept with this project/.test(document.querySelector('#regionStatus').textContent), null, { timeout: 30000 }).catch(fail);
    assert.deepEqual(await pins(), kept.pins);
    assert.deepEqual((await links()).map((link) => [link.from, link.to, link.basis]), kept.links);
    assert.ok((await links()).every((link) => link.routed), 'routed again');
    assert.deepEqual(await harbourVehicles(), [{ type: 'smallTruck', fleet: null }], 'a link keeps its vehicles');
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

    console.log(`✓ logistics network window: the sample region loads its roads alone; ${placements.length} pins placed from the palette are linked and routed as suggested; every action works from a button or menu, a drag or a right click, and the keyboard, and undoes; a moved store re-routes its one link in ${routing.milliseconds < 1 ? 'under a millisecond' : `${routing.milliseconds.toFixed(0)} ms`}; links are drawn, refused with a reason, deleted and not suggested again; the model is built from the pins and links (${built.match(/\d+ nodes/)[0]}), its stores holding stock and its links on the vehicles chosen on their cards, from their menus and with V;${process.env.KONJUGATE_ENGINE === 'export' ? ' a store whose road closes runs out of stock;' : ''} ports and towns are suggested only when asked for and adopted; the network saves as a CSV and loads back; the session restores it, and an earlier session is migrated; shortcuts behave and read as Windows and Linux users and Mac users expect; a network is kept with the project before any build; an area loaded is kept on the computer and loads again with nothing fetched, fresh on request, and the cache clears; a searched region fetches its roads and place names alone, and ports only when asked for.`);
} finally {
    await browser.close();
    await rm(scratch, { recursive: true, force: true });
}
