/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The window's map: an SVG drawn from the region's own data (no map tiles: an add-on window may only
// show what it was given). North is up; distances are true near the region's centre. Wheel to zoom and
// drag the background to pan. The user's network is drawn on top: pins by role, the links between them,
// and suggestions from public data as hollow pins.
//
//   click a pin or a link: select it (its card opens); Shift-click, or ⌘-click on a Mac and Ctrl-click elsewhere: add it to
//   the selection, or take it out
//   Shift-drag on the empty map: select every pin in the box (with ⌘ or Ctrl too: add them); click the empty map: select nothing
//   click a suggestion: adopt it; click a pin twice: rename it
//   drag a pin: move it (and every other pin selected with it)
//   drag from a selected pin's handle, or Shift-drag from any pin, to another pin: link them
//   drag an end of a selected link to another pin: move that end
//   right-click (or Control-click on a Mac) a pin, a link or the map: its menu
//   in add mode, click anywhere: place a pin of that role

import { choosePlaceLabels } from './lib/labels.mjs';
import { addsToSelection, commandHeld, isMenuClick, platformKeys } from './lib/platform.mjs';

const svgNamespace = 'http://www.w3.org/2000/svg';
const kilometresPerDegree = 111.32;

function element(name, attributes = {}, parent = null) {
    const node = document.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (parent) parent.append(node);
    return node;
}

export class MapView {
    constructor(svg, handlers) {
        this.svg = svg;
        this.handlers = handlers;
        this.keys = platformKeys();
        this.origin = { lat: 0, lon: 0 };
        this.view = { x: -50, y: -50, width: 100, height: 100 };
        this.sites = [];
        this.links = [];
        this.flows = { lanes: [], serves: [] };
        this.addKind = null;
        this.highlight = null;
        this.selection = []; // [{ kind: 'pin' | 'link', id }]
        this.rubber = null; // a link being drawn: { from, x, y }
        this.base = element('g', { class: 'base' }, svg);
        this.placeLayer = element('g', { class: 'places' }, svg);
        this.places = [];
        this.flowLayer = element('g', { class: 'flows' }, svg);
        this.linkLayer = element('g', { class: 'links' }, svg);
        // Marks on the roads: a red X where a road is closed (or about to be, in a scenario being set up).
        this.marks = [];
        this.markLayer = element('g', { class: 'marks' }, svg);
        this.siteLayer = element('g', { class: 'sites' }, svg);
        this.listen();
        new ResizeObserver(() => this.applyView()).observe(svg);
    }

    project(lat, lon) {
        return {
            x: (lon - this.origin.lon) * Math.cos(this.origin.lat * Math.PI / 180) * kilometresPerDegree,
            y: -(lat - this.origin.lat) * kilometresPerDegree
        };
    }

    unproject(x, y) {
        return {
            lat: this.origin.lat - y / kilometresPerDegree,
            lon: this.origin.lon + x / (Math.cos(this.origin.lat * Math.PI / 180) * kilometresPerDegree)
        };
    }

    // Kilometres per screen pixel at the current zoom.
    unit() {
        const width = this.svg.clientWidth || 800;
        const height = this.svg.clientHeight || 600;
        return Math.max(this.view.width / width, this.view.height / height);
    }

    applyView() {
        const width = this.svg.clientWidth || 800;
        const height = this.svg.clientHeight || 600;
        // Keep the aspect of the window, centred on the view.
        const unit = Math.max(this.view.width / width, this.view.height / height);
        const cx = this.view.x + this.view.width / 2;
        const cy = this.view.y + this.view.height / 2;
        this.svg.setAttribute('viewBox', `${cx - width * unit / 2} ${cy - height * unit / 2} ${width * unit} ${height * unit}`);
        this.box = { x: cx - width * unit / 2, y: cy - height * unit / 2, width, height, unit };
        this.drawPlaces();
        this.drawSites();
        this.drawLinks();
        this.drawFlows();
        this.drawMarks();
        this.base.querySelectorAll('.scaled').forEach((node) => {
            node.setAttribute('stroke-width', Number(node.dataset.width) * unit);
            // A dash pattern in screen pixels, like the width.
            if (node.dataset.dash) node.setAttribute('stroke-dasharray', node.dataset.dash.split(' ').map((length) => Number(length) * unit).join(' '));
        });
        this.handlers.onView?.();
    }

    fit() {
        if (!this.bbox) return;
        const a = this.project(this.bbox.north, this.bbox.west);
        const b = this.project(this.bbox.south, this.bbox.east);
        const pad = 0.04 * Math.max(b.x - a.x, b.y - a.y);
        // More room on the right, where a site at the edge of the region writes its name.
        const labels = 0.12 * (b.x - a.x);
        this.view = { x: a.x - pad, y: a.y - pad, width: b.x - a.x + 2 * pad + labels, height: b.y - a.y + 2 * pad };
        this.applyView();
    }

    // The view around some points ({ lat, lon }), with room around them; a single point at a street's scale.
    fitTo(points) {
        if (!points.length) return;
        const projected = points.map((point) => this.project(point.lat, point.lon));
        const xs = projected.map((point) => point.x);
        const ys = projected.map((point) => point.y);
        const width = Math.max(2, Math.max(...xs) - Math.min(...xs));
        const height = Math.max(2, Math.max(...ys) - Math.min(...ys));
        this.view = { x: Math.min(...xs) - 0.2 * width, y: Math.min(...ys) - 0.2 * height, width: 1.4 * width, height: 1.4 * height };
        this.applyView();
    }

    zoom(factor) {
        const cx = this.view.x + this.view.width / 2;
        const cy = this.view.y + this.view.height / 2;
        this.view = {
            x: cx - (cx - this.view.x) * factor,
            y: cy - (cy - this.view.y) * factor,
            width: this.view.width * factor,
            height: this.view.height * factor
        };
        this.applyView();
    }

    // `map` is the importer's mapLayers(); it sets the region and redraws the base layers.
    setMap(map) {
        this.bbox = map.bbox;
        this.origin = { lat: (map.bbox.south + map.bbox.north) / 2, lon: (map.bbox.west + map.bbox.east) / 2 };
        this.base.replaceChildren();
        const path = (points, close = false) => points.map(([lat, lon], index) => {
            const { x, y } = this.project(lat, lon);
            return `${index ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`;
        }).join('') + (close ? 'Z' : '');
        const scaled = (node, width, dash = null) => { node.classList.add('scaled'); node.dataset.width = width; if (dash) node.dataset.dash = dash; return node; };
        // Under everything: land (Natural Earth), its coastline and country borders, faint, so the region's own data reads
        // first. A border Natural Earth does not class as an international boundary (disputed, indefinite, a line of
        // control or a claim) is dashed; every other border is solid.
        if (map.geography) {
            element('path', { d: map.geography.land.map((ring) => path(ring, true)).join(''), class: 'land', 'fill-rule': 'evenodd' }, this.base);
            for (const line of map.geography.coast) scaled(element('path', { d: path(line), class: 'coast' }, this.base), 1);
            for (const border of map.geography.borders) {
                scaled(element('path', { d: path(border.points), class: `border${border.settled ? '' : ' unsettled'}` }, this.base), 1.2, border.settled ? null : '5 4');
            }
        }
        for (const ring of map.industrial) scaled(element('path', { d: path(ring, true), class: 'industrial' }, this.base), 1);
        for (const ring of map.ports) scaled(element('path', { d: path(ring, true), class: 'portArea' }, this.base), 1);
        // What suggestions from public data show (port land, industrial land), under the roads.
        this.overlayLayer = element('g', { class: 'overlay' }, this.base);
        this.path = path;
        this.scaledNode = scaled;
        if (this.overlay) this.setOverlay(this.overlay);
        const widths = { motorway: 2.6, trunk: 2.2, primary: 1.6, secondary: 1.1, tertiary: 0.8 };
        const sorted = [...map.roads].sort((a, b) => (widths[a.highway] ?? 1) - (widths[b.highway] ?? 1));
        for (const road of sorted) scaled(element('path', { d: path(road.points), class: `road ${road.highway}` }, this.base), widths[road.highway] ?? 1);
        for (const line of map.rail) scaled(element('path', { d: path(line), class: 'rail' }, this.base), 1.2);
        for (const [lat, lon] of map.anchorages) {
            const { x, y } = this.project(lat, lon);
            scaled(element('circle', { cx: x, cy: y, r: 1.2, class: 'anchorage' }, this.base), 1);
        }
        // Place names, faint, so the user can find their way: written as the zoom allows (drawPlaces).
        this.places = (map.places ?? []).map((place) => ({ ...place, ...this.project(place.lat, place.lon) }));
        this.fit();
    }

    // The place names the zoom allows: cities always, towns, suburbs and quarters as the map is zoomed in, the larger
    // first and none over another (lib/labels.mjs). Cities are larger than towns, suburbs smaller.
    drawPlaces() {
        this.placeLayer.replaceChildren();
        const box = this.box;
        if (!box || !this.places.length) return;
        const sizes = { city: 13, town: 11, suburb: 9.5, quarter: 9 };
        const written = choosePlaceLabels(this.places, {
            unit: box.unit,
            size: (place) => sizes[place.place] ?? 9,
            toScreen: (place) => {
                const x = (place.x - box.x) / box.unit;
                const y = (place.y - box.y) / box.unit;
                return x >= 0 && x <= box.width && y >= 0 && y <= box.height ? { x, y } : null;
            }
        });
        for (const { place } of written) {
            const label = element('text', { x: place.x, y: place.y, class: `place ${place.place}`, 'text-anchor': 'middle', 'font-size': (sizes[place.place] ?? 9) * box.unit, 'stroke-width': 3 * box.unit }, this.placeLayer);
            label.textContent = place.name;
        }
    }

    // Where a point of the map is, in pixels from the map's top left corner.
    toScreen(lat, lon) {
        if (!this.box) return null;
        const { x, y } = this.project(lat, lon);
        return { x: (x - this.box.x) / this.box.unit, y: (y - this.box.y) / this.box.unit };
    }

    // Port land, anchorages and industrial land from the suggestions fetched: { ports, anchorages, industrial }.
    setOverlay(overlay) {
        this.overlay = overlay;
        if (!this.overlayLayer) return;
        this.overlayLayer.replaceChildren();
        for (const ring of overlay?.industrial ?? []) this.scaledNode(element('path', { d: this.path(ring, true), class: 'industrial' }, this.overlayLayer), 1);
        for (const ring of overlay?.ports ?? []) this.scaledNode(element('path', { d: this.path(ring, true), class: 'portArea' }, this.overlayLayer), 1);
        for (const [lat, lon] of overlay?.anchorages ?? []) {
            const { x, y } = this.project(lat, lon);
            this.scaledNode(element('circle', { cx: x, cy: y, r: 1.2, class: 'anchorage' }, this.overlayLayer), 1);
        }
        this.applyView();
    }

    // `sites`: [{ id, role, name, lat, lon, kept, problem, far }]: the user's pins (kept) and suggestions not adopted.
    setSites(sites) {
        this.sites = sites;
        this.selection = this.selection.filter((item) => item.kind !== 'pin' || sites.some((site) => site.id === item.id && site.kept));
        this.drawSites();
        this.drawLinks();
    }

    // `links`: [{ id, from, to (pin ids), basis: suggested | user, points (the road it was routed over), unused }]
    setLinks(links) {
        this.links = links;
        this.selection = this.selection.filter((item) => item.kind !== 'link' || links.some((link) => link.id === item.id));
        this.drawLinks();
    }

    // What is selected: pins and links, by id ([{ kind, id }]).
    setSelected(selection) {
        this.selection = selection ?? [];
        this.drawSites();
        this.drawLinks();
    }

    isSelected(kind, id) {
        return this.selection.some((item) => item.kind === kind && item.id === id);
    }

    // `marks`: [{ lat, lon, kind: 'closed' | 'planned', title }]. A closed road is a red X; one a scenario is about to
    // close, a fainter, dashed X.
    setMarks(marks) {
        this.marks = marks ?? [];
        this.drawMarks();
    }

    drawMarks() {
        const unit = this.unit();
        this.markLayer.replaceChildren();
        for (const mark of this.marks) {
            const { x, y } = this.project(mark.lat, mark.lon);
            const arm = 8 * unit;
            const cross = `M${x - arm} ${y - arm}L${x + arm} ${y + arm}M${x + arm} ${y - arm}L${x - arm} ${y + arm}`;
            // A supplier in trouble, or a site that is down: a ring round its pin, not a cross on a road.
            if (mark.kind === 'supplier' || mark.kind === 'down') {
                const ring = element('g', { class: `siteMark ${mark.kind}`, 'data-mark': mark.kind }, this.markLayer);
                element('circle', { cx: x, cy: y, r: 13 * unit, class: 'markRing', 'stroke-width': 3 * unit, 'stroke-dasharray': `${4 * unit} ${3 * unit}` }, ring);
                if (mark.title) element('title', {}, ring).textContent = mark.title;
                continue;
            }
            const group = element('g', { class: `roadMark ${mark.kind}`, 'data-mark': mark.kind }, this.markLayer);
            element('path', { d: cross, class: 'markCasing', 'stroke-width': 6 * unit }, group);
            element('path', { d: cross, class: 'markCross', 'stroke-width': 3.2 * unit, ...(mark.kind === 'planned' ? { 'stroke-dasharray': `${3 * unit} ${2 * unit}` } : {}) }, group);
            if (mark.title) element('title', {}, group).textContent = mark.title;
        }
    }

    setFlows(flows) {
        this.flows = flows ?? { corridors: null, lanes: [], serves: [] };
        this.drawFlows();
    }

    // Toggles the highlight on the sites it changes, without redrawing every site: hovering down a long list stays quick.
    setHighlight(id) {
        this.highlight = id;
        const unit = this.unit();
        for (const node of this.siteLayer.querySelectorAll('.site')) {
            const on = node.dataset.id === id;
            if (on === node.classList.contains('highlight')) continue;
            node.classList.toggle('highlight', on);
            node.setAttribute('stroke-width', (on ? 2.5 : 1.5) * unit);
        }
    }

    // A shape per role: a port square, a supplier triangle, a warehouse diamond, a store circle, a dark store a circle
    // with a dot in it (drawn as a ring), a customer area a larger soft disc.
    shape(role, x, y, r) {
        if (role === 'port') return { name: 'rect', attributes: { x: x - r, y: y - r, width: 2 * r, height: 2 * r } };
        if (role === 'supplier') return { name: 'path', attributes: { d: `M${x} ${y - r * 1.35}L${x + r * 1.25} ${y + r * 0.95}L${x - r * 1.25} ${y + r * 0.95}Z` } };
        if (role === 'warehouse') return { name: 'path', attributes: { d: `M${x} ${y - r * 1.3}L${x + r * 1.3} ${y}L${x} ${y + r * 1.3}L${x - r * 1.3} ${y}Z` } };
        if (role === 'customerArea') return { name: 'circle', attributes: { cx: x, cy: y, r: r * 1.5 } };
        return { name: 'circle', attributes: { cx: x, cy: y, r } };
    }

    drawSites() {
        const unit = this.unit();
        this.siteLayer.replaceChildren();
        const order = { customerArea: 0, store: 1, darkStore: 2, warehouse: 3, supplier: 4, port: 5 };
        const sorted = [...this.sites].sort((a, b) => (a.kept - b.kept) || ((order[a.role] ?? 0) - (order[b.role] ?? 0)));
        const labelled = [];
        for (const site of sorted) {
            const { x, y } = this.project(site.lat, site.lon);
            const r = (site.kept ? 5 : 3.5) * unit;
            const { name, attributes } = this.shape(site.role, x, y, r);
            const highlighted = this.highlight === site.id;
            const selected = this.isSelected('pin', site.id);
            const classes = ['site', site.role, site.kept ? 'pin' : 'dropped', highlighted ? 'highlight' : '', selected ? 'selected' : '', site.problem ? 'problem' : '', site.far ? 'far' : ''].filter(Boolean).join(' ');
            if (site.far && site.kept) element('circle', { cx: x, cy: y, r: r * 2.2, class: 'farRing', 'stroke-width': 1.2 * unit, 'stroke-dasharray': `${2 * unit} ${2 * unit}` }, this.siteLayer);
            const node = element(name, { ...attributes, class: classes, 'stroke-width': (highlighted || selected ? 2.5 : 1.5) * unit, 'data-id': site.id }, this.siteLayer);
            element('title', {}, node).textContent = `${site.name}${site.kept ? '' : ' (a suggestion: click to adopt it)'}${site.far ? ` (${site.far})` : ''}`;
            if (site.role === 'darkStore') element('circle', { cx: x, cy: y, r: r * 0.4, class: 'siteDot', 'pointer-events': 'none' }, this.siteLayer);
            if (site.kept) labelled.push({ site, x, y });
            // The handle a link is drawn from, on a pin selected alone.
            if (selected && site.kept && this.selection.length === 1) {
                const handle = element('circle', { cx: x + r * 2.6, cy: y - r * 2.6, r: 5 * unit, class: 'linkHandle', 'stroke-width': 1.5 * unit, 'data-from': site.id }, this.siteLayer);
                element('title', {}, handle).textContent = `Drag to another site to link ${site.name} to it`;
            }
        }
        this.drawLabels(labelled, unit);
        if (this.rubber) {
            const from = this.sites.find((site) => site.id === this.rubber.from);
            if (from) {
                const a = this.project(from.lat, from.lon);
                element('line', { x1: a.x, y1: a.y, x2: this.rubber.x, y2: this.rubber.y, class: 'rubber', 'stroke-width': 1.5 * unit, 'stroke-dasharray': `${4 * unit} ${3 * unit}` }, this.siteLayer);
            }
        }
        if (this.box && this.boxing) {
            const { a, b } = this.boxing;
            element('rect', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), class: 'selectBox', 'stroke-width': 1 * unit }, this.siteLayer);
        }
    }

    // The links: along the road each was routed over (straight while one of its pins is dragged, or before it is
    // routed), dashed while suggested, solid once the user's, faint when the model left it out.
    drawLinks() {
        const unit = this.unit();
        this.linkLayer.replaceChildren();
        const byId = new Map(this.sites.map((site) => [site.id, site]));
        for (const link of this.links) {
            const from = byId.get(link.from);
            const to = byId.get(link.to);
            if (!from || !to) continue;
            const dragged = [this.dragging ?? []].flat();
            const straight = dragged.includes(link.from) || dragged.includes(link.to);
            const points = !straight && link.points?.length > 1 ? link.points : [from, to];
            const d = points.map((point, index) => {
                const { x, y } = this.project(point.lat, point.lon);
                return `${index ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`;
            }).join('');
            const selected = this.isSelected('link', link.id);
            const kind = link.basis === 'user' ? 'drawn' : 'suggested';
            element('path', { d, class: 'linkHit', 'stroke-width': 9 * unit, 'data-link': link.id }, this.linkLayer);
            const path = element('path', {
                d, class: `link ${kind}${selected ? ' selected' : ''}${link.unused ? ' unused' : ''}`, 'data-link': link.id,
                'stroke-width': (selected ? 2.6 : 1.4) * unit, ...(kind === 'suggested' ? { 'stroke-dasharray': `${5 * unit} ${3 * unit}` } : {})
            }, this.linkLayer);
            element('title', {}, path).textContent = `${from.name} → ${to.name}${link.title ? `\n${link.title}` : ''}`;
            // An arrow head half way along the link as drawn, pointing along it, so the direction reads.
            const projected = points.map((point) => this.project(point.lat, point.lon));
            const lengths = projected.slice(1).map((point, index) => Math.hypot(point.x - projected[index].x, point.y - projected[index].y));
            let half = lengths.reduce((total, length) => total + length, 0) / 2;
            let segment = 0;
            while (segment < lengths.length - 1 && half > lengths[segment]) { half -= lengths[segment]; segment += 1; }
            const a = projected[segment];
            const b = projected[segment + 1] ?? projected[segment];
            const share = lengths[segment] > 0 ? half / lengths[segment] : 0;
            const middle = { x: a.x + (b.x - a.x) * share, y: a.y + (b.y - a.y) * share };
            const angle = Math.atan2(b.y - a.y, b.x - a.x);
            const size = 4.5 * unit;
            const tip = { x: middle.x + Math.cos(angle) * size, y: middle.y + Math.sin(angle) * size };
            const left = { x: middle.x + Math.cos(angle + 2.5) * size, y: middle.y + Math.sin(angle + 2.5) * size };
            const right = { x: middle.x + Math.cos(angle - 2.5) * size, y: middle.y + Math.sin(angle - 2.5) * size };
            element('path', { d: `M${tip.x} ${tip.y}L${left.x} ${left.y}L${right.x} ${right.y}Z`, class: `linkArrow ${kind}${link.unused ? ' unused' : ''}`, 'data-link': link.id }, this.linkLayer);
            if (selected && this.selection.length === 1) {
                for (const [end, site] of [['from', from], ['to', to]]) {
                    const { x, y } = this.project(site.lat, site.lon);
                    const handle = element('circle', { cx: x, cy: y, r: 7.5 * unit, class: 'endHandle', 'stroke-width': 1.5 * unit, 'data-link': link.id, 'data-end': end }, this.linkLayer);
                    element('title', {}, handle).textContent = `Drag this end to another site`;
                }
            }
        }
    }

    // Names beside the pins, sources first, then warehouses, then stores and customers: each to the right of its site, else to the
    // left, else left out where it would overlap a name already written (hovering the site still names it). Where sites
    // crowd, the map stays readable at this zoom and zooming in brings the names back.
    drawLabels(labelled, unit) {
        const order = { port: 0, supplier: 0, warehouse: 1, darkStore: 2, store: 2, customerArea: 3 };
        const placed = [];
        const overlaps = (box) => placed.some((other) => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom);
        for (const { site, x, y } of [...labelled].sort((a, b) => (order[a.site.role] ?? 3) - (order[b.site.role] ?? 3))) {
            const label = element('text', { x: x + 8 * unit, y: y + 4 * unit, class: 'label', 'font-size': 11 * unit, 'stroke-width': 3 * unit }, this.siteLayer);
            label.textContent = site.name;
            const width = label.getComputedTextLength?.() || site.name.length * 6 * unit;
            const top = y - 6 * unit;
            const bottom = y + 7 * unit;
            const right = { left: x + 7 * unit, right: x + 9 * unit + width, top, bottom };
            const left = { left: x - 9 * unit - width, right: x - 7 * unit, top, bottom };
            if (!overlaps(right)) {
                placed.push(right);
            } else if (!overlaps(left)) {
                label.setAttribute('x', x - 8 * unit);
                label.setAttribute('text-anchor', 'end');
                placed.push(left);
            } else {
                label.remove();
            }
        }
    }

    drawFlows() {
        const unit = this.unit();
        this.flowLayer.replaceChildren();
        const at = (point) => this.project(point.lat, point.lon);
        // Corridors: each lane along the roads it was routed over, a road several lanes share drawn once, as thick as
        // what it carries. A lane estimated rather than routed is straight and dashed; one on standby (no flow yet) thin
        // and dotted. After a scenario run a corridor also carries its baseline and how it changed (fell, rose or
        // stopped), and `scale` keeps the widths those of the model as built.
        if (this.flows.corridors) {
            const maximum = this.flows.scale ?? Math.max(1, ...this.flows.corridors.map((corridor) => corridor.rate));
            const number = (value) => Number(value).toLocaleString('en', { maximumFractionDigits: 0 });
            for (const corridor of this.flows.corridors) {
                const d = corridor.points.map(([lat, lon], index) => {
                    const { x, y } = this.project(lat, lon);
                    return `${index ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`;
                }).join('');
                const estimated = corridor.basis === 'straight-line';
                // A changed corridor stays wide enough to see its colour, however little it carried.
                const width = Math.max(corridor.change ? 2.5 : 0, 1.5 + 5 * Math.min(1, corridor.rate / maximum));
                // A dark casing under the corridor lifts it off the road it follows.
                if (!(corridor.standby && !(corridor.rate > 0))) element('path', { d, class: 'laneCasing', 'stroke-width': (width + 2) * unit }, this.flowLayer);
                const stopped = corridor.change === 'stopped';
                const dash = corridor.standby && !(corridor.rate > 0) ? `${1.5 * unit} ${3 * unit}` : stopped ? `${4 * unit} ${3 * unit}` : estimated ? `${6 * unit} ${4 * unit}` : null;
                const path = element('path', {
                    d, class: `lane${estimated ? ' estimated' : ''}${corridor.standby && !(corridor.rate > 0) ? ' standby' : ''}${corridor.change ? ` ${corridor.change}` : ''}`,
                    'stroke-width': (corridor.standby && !(corridor.rate > 0) ? 1.2 : width) * unit,
                    ...(dash ? { 'stroke-dasharray': dash } : {})
                }, this.flowLayer);
                const how = { routed: 'over major roads', local: 'local streets, estimated', 'straight-line': 'no road route found: a straight-line estimate' }[corridor.basis] ?? corridor.basis;
                const against = corridor.baseline === undefined ? '' : ` while the scenario lasted, ${number(corridor.baseline)} in the baseline`;
                element('title', {}, path).textContent = `${number(corridor.rate)} ${this.flows.unit ?? 'TEU'}/day${against} (${how})\n${corridor.lanes.map((name) => name.replace(/^Road /, '')).join('\n')}`;
            }
        } else {
            this.drawStraightLanes(unit, at);
        }
        for (const serve of this.flows.serves) {
            const a = at(serve.from);
            const b = at(serve.to);
            element('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'serve', 'stroke-width': 1.2 * unit, 'stroke-dasharray': `${3 * unit} ${3 * unit}` }, this.flowLayer);
        }
    }

    // A build saved before corridors: each lane straight between its ends.
    drawStraightLanes(unit, at) {
        const maximum = Math.max(1, ...this.flows.lanes.map((lane) => lane.rate));
        for (const lane of this.flows.lanes) {
            const a = at(lane.from);
            const b = at(lane.to);
            const line = element('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'lane', 'stroke-width': (1.5 + 5 * lane.rate / maximum) * unit }, this.flowLayer);
            element('title', {}, line).textContent = lane.title;
        }
    }

    setAddKind(kind) {
        this.addKind = kind;
        this.svg.classList.toggle('adding', Boolean(kind));
    }

    toMap(event) {
        const point = this.svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const local = point.matrixTransform(this.svg.getScreenCTM().inverse());
        return { x: local.x, y: local.y };
    }

    // The menu of what is under the pointer, or of the map there.
    menuAt(event) {
        const site = this.siteAt(event);
        // Links that share a road lie over each other: of those under the pointer, the menu is the selected one's when
        // one is selected (so a link picked from a card can be reached where others cover it), else the one on top.
        const linkNodes = (document.elementsFromPoint?.(event.clientX, event.clientY) ?? []).map((node) => node.closest?.('[data-link]')).filter(Boolean);
        const linkNode = linkNodes.find((node) => this.isSelected('link', node.dataset.link)) ?? linkNodes[0] ?? null;
        const { x, y } = this.toMap(event);
        const target = site ? { kind: site.kept ? 'pin' : 'suggestion', id: site.id } : linkNode ? { kind: 'link', id: linkNode.dataset.link } : null;
        this.handlers.onContextMenu?.({ target, point: this.unproject(x, y), clientX: event.clientX, clientY: event.clientY });
    }

    siteAt(event) {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.site');
        return target ? this.sites.find((item) => item.id === target.dataset.id) ?? null : null;
    }

    listen() {
        let drag = null;
        this.svg.addEventListener('pointerdown', (event) => {
            // A right click is the menu's (the contextmenu event), not a selection; so is Control-click on a Mac, opened here
            // as well, since not every browser turns it into a right click.
            if (event.button === 0 && isMenuClick(event, this.keys)) { event.stopPropagation(); this.menuAt(event); return; }
            if (event.button !== 0) return;
            const handle = event.target.closest('.linkHandle');
            const end = event.target.closest('.endHandle');
            const linkNode = event.target.closest('[data-link]');
            const target = event.target.closest('.site');
            const site = target ? this.sites.find((item) => item.id === target.dataset.id) : null;
            const adding = addsToSelection(event, this.keys);
            let mode = 'pan';
            if (handle) mode = 'link';
            else if (end) mode = 'relink';
            else if (site?.kept && event.shiftKey) mode = 'link';
            else if (site) mode = 'site';
            // In add mode a click beside a link places a pin there, as anywhere else on the map.
            else if (linkNode && !this.addKind) mode = 'selectLink';
            else if (event.shiftKey && !this.addKind) mode = 'box';
            // Dragging a selected pin moves every pin selected with it.
            const group = site?.kept && this.isSelected('pin', site.id) && this.selection.filter((item) => item.kind === 'pin').length > 1
                ? this.sites.filter((item) => item.kept && this.isSelected('pin', item.id)).map((item) => ({ site: item, lat: item.lat, lon: item.lon }))
                : null;
            drag = {
                mode, site, adding, boxAdding: commandHeld(event, this.keys), group, fromHandle: Boolean(handle), start: { x: event.clientX, y: event.clientY }, view: { ...this.view }, moved: false, origin: this.toMap(event),
                from: handle?.dataset.from ?? (mode === 'link' ? site.id : null), link: end?.dataset.link ?? linkNode?.dataset.link ?? null, end: end?.dataset.end ?? null,
                position: site ? { lat: site.lat, lon: site.lon } : null
            };
            this.svg.setPointerCapture(event.pointerId);
        });
        this.svg.addEventListener('pointermove', (event) => {
            if (!drag) return;
            if (!drag.moved && Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) < 4) return;
            drag.moved = true;
            const { x, y } = this.toMap(event);
            if (drag.mode === 'link' || drag.mode === 'relink') {
                // From the pin a new link starts at, or from the end of the selected link that stays put.
                const link = this.links.find((item) => item.id === drag.link);
                const from = drag.mode === 'link' ? drag.from : drag.end === 'to' ? link?.from : link?.to;
                this.rubber = { from, x, y };
                this.drawSites();
            } else if (drag.mode === 'box') {
                this.boxing = { a: drag.origin, b: { x, y } };
                this.drawSites();
            } else if (drag.mode === 'site' && drag.site.kept && drag.group) {
                const here = this.unproject(x, y);
                const start = this.unproject(drag.origin.x, drag.origin.y);
                for (const item of drag.group) Object.assign(item.site, { lat: item.lat + here.lat - start.lat, lon: item.lon + here.lon - start.lon });
                this.dragging = drag.group.map((item) => item.site.id);
                this.drawSites();
                this.drawLinks();
            } else if (drag.mode === 'site' && drag.site.kept) {
                Object.assign(drag.site, this.unproject(x, y));
                this.dragging = drag.site.id;
                this.drawSites();
                this.drawLinks();
                this.handlers.onDrag?.(drag.site.id, drag.site.lat, drag.site.lon);
            } else if (drag.mode === 'pan' || drag.mode === 'selectLink') {
                drag.mode = 'pan';
                const unit = this.unit();
                this.view.x = drag.view.x - (event.clientX - drag.start.x) * unit;
                this.view.y = drag.view.y - (event.clientY - drag.start.y) * unit;
                this.applyView();
            }
        });
        const finish = (event, cancelled = false) => {
            if (!drag) return;
            const current = drag;
            drag = null;
            this.dragging = null;
            const hadRubber = Boolean(this.rubber);
            this.rubber = null;
            if (hadRubber) this.drawSites();
            const hadBox = Boolean(this.boxing);
            this.boxing = null;
            if (hadBox) this.drawSites();
            if (cancelled) {
                for (const item of current.group ?? []) Object.assign(item.site, { lat: item.lat, lon: item.lon });
                if (current.mode === 'site' && current.moved && current.position) Object.assign(current.site, current.position);
                this.drawSites();
                this.drawLinks();
                return;
            }
            const { mode, site, moved, origin, adding } = current;
            if (mode === 'box' && moved) {
                const a = this.unproject(origin.x, origin.y);
                const { x, y } = this.toMap(event);
                const b = this.unproject(x, y);
                // Shift draws the box; with Cmd or Ctrl as well, the box adds to the selection.
                this.handlers.onSelectArea?.({ south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat), west: Math.min(a.lon, b.lon), east: Math.max(a.lon, b.lon) }, { adding: current.boxAdding });
            } else if (mode === 'link' && moved) {
                const onto = this.siteAt(event);
                if (onto && onto.kept && onto.id !== current.from) this.handlers.onLink?.(current.from, onto.id);
            } else if (mode === 'relink' && moved) {
                const onto = this.siteAt(event);
                if (onto && onto.kept) this.handlers.onRelink?.(current.link, current.end, onto.id);
            } else if (mode === 'site' && moved && site.kept && current.group) {
                this.handlers.onMoveMany?.(current.group.map((item) => ({ id: item.site.id, lat: item.site.lat, lon: item.site.lon })));
            } else if (mode === 'site' && moved && site.kept) {
                this.handlers.onMove?.(site.id, site.lat, site.lon);
            } else if (mode === 'site' && !moved) {
                // Two clicks on one pin in quick succession: rename it. (Counted here, as the first click redraws the pins
                // and the browser's own double click then never comes.)
                const now = performance.now();
                const twice = this.lastClick?.id === site.id && now - this.lastClick.time < 450;
                this.lastClick = { id: site.id, time: now };
                if (site.kept && twice && !adding) this.handlers.onRename?.(site.id);
                else if (site.kept) this.handlers.onSelect?.({ kind: 'pin', id: site.id }, { adding });
                else this.handlers.onToggle?.(site.id);
            } else if ((mode === 'link' || mode === 'relink') && !moved) {
                // A click on a handle selects what it belongs to; a Shift-click on a pin adds it to the selection; a click on
                // a selected link's end (which sits on a pin) selects that pin.
                if (mode === 'link') this.handlers.onSelect?.({ kind: 'pin', id: current.from }, { adding: !current.fromHandle && adding });
                const under = mode === 'relink' ? this.siteAt(event) : null;
                if (under?.kept) this.handlers.onSelect?.({ kind: 'pin', id: under.id }, { adding });
            } else if (mode === 'selectLink' && !moved) {
                this.handlers.onSelect?.({ kind: 'link', id: current.link }, { adding });
            } else if ((mode === 'pan' || mode === 'box') && !moved) {
                if (this.addKind) this.handlers.onAdd?.(this.addKind, this.unproject(origin.x, origin.y));
                else if (!adding) this.handlers.onSelect?.(null);
            }
        };
        this.svg.addEventListener('pointerup', (event) => finish(event));

        this.svg.addEventListener('pointercancel', (event) => finish(event, true));
        // A right click: the menu of what is under the pointer, or of the map there.
        this.svg.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            this.menuAt(event);
        });
        this.svg.addEventListener('wheel', (event) => {
            event.preventDefault();
            const factor = Math.exp(event.deltaY * 0.0015);
            const { x, y } = this.toMap(event);
            this.view = {
                x: x - (x - this.view.x) * factor, y: y - (y - this.view.y) * factor,
                width: this.view.width * factor, height: this.view.height * factor
            };
            this.applyView();
        }, { passive: false });
    }
}
