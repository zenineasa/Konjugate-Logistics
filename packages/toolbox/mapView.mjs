/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The window's map: an SVG drawn from the region's own data (no map tiles: an add-on window may only
// show what it was given). North is up; distances are true near the region's centre. Wheel to zoom,
// drag the background to pan, click a site to keep or drop it, drag a kept site to move it, and in
// add mode click anywhere to place a new site.

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
        this.origin = { lat: 0, lon: 0 };
        this.view = { x: -50, y: -50, width: 100, height: 100 };
        this.sites = [];
        this.flows = { lanes: [], serves: [] };
        this.addKind = null;
        this.highlight = null;
        this.base = element('g', { class: 'base' }, svg);
        this.flowLayer = element('g', { class: 'flows' }, svg);
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
        this.drawSites();
        this.drawFlows();
        this.base.querySelectorAll('.scaled').forEach((node) => node.setAttribute('stroke-width', Number(node.dataset.width) * unit));
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

    // `map` is the importer's mapLayers(); it sets the region and redraws the base layers.
    setMap(map) {
        this.bbox = map.bbox;
        this.origin = { lat: (map.bbox.south + map.bbox.north) / 2, lon: (map.bbox.west + map.bbox.east) / 2 };
        this.base.replaceChildren();
        const path = (points, close = false) => points.map(([lat, lon], index) => {
            const { x, y } = this.project(lat, lon);
            return `${index ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`;
        }).join('') + (close ? 'Z' : '');
        const scaled = (node, width) => { node.classList.add('scaled'); node.dataset.width = width; return node; };
        for (const ring of map.industrial) scaled(element('path', { d: path(ring, true), class: 'industrial' }, this.base), 1);
        for (const ring of map.ports) scaled(element('path', { d: path(ring, true), class: 'portArea' }, this.base), 1);
        const widths = { motorway: 2.6, trunk: 2.2, primary: 1.6 };
        const sorted = [...map.roads].sort((a, b) => (widths[a.highway] ?? 1) - (widths[b.highway] ?? 1));
        for (const road of sorted) scaled(element('path', { d: path(road.points), class: `road ${road.highway}` }, this.base), widths[road.highway] ?? 1);
        for (const line of map.rail) scaled(element('path', { d: path(line), class: 'rail' }, this.base), 1.2);
        for (const [lat, lon] of map.anchorages) {
            const { x, y } = this.project(lat, lon);
            scaled(element('circle', { cx: x, cy: y, r: 1.2, class: 'anchorage' }, this.base), 1);
        }
        this.fit();
    }

    // `sites`: [{ id, kind: port|zone|town, name, lat, lon, kept, moved }]
    setSites(sites) {
        this.sites = sites;
        this.drawSites();
    }

    setFlows(flows) {
        this.flows = flows ?? { lanes: [], serves: [] };
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

    shape(kind, x, y, r) {
        if (kind === 'port') return { name: 'rect', attributes: { x: x - r, y: y - r, width: 2 * r, height: 2 * r } };
        if (kind === 'zone') return { name: 'path', attributes: { d: `M${x} ${y - r * 1.3}L${x + r * 1.3} ${y}L${x} ${y + r * 1.3}L${x - r * 1.3} ${y}Z` } };
        return { name: 'circle', attributes: { cx: x, cy: y, r } };
    }

    drawSites() {
        const unit = this.unit();
        this.siteLayer.replaceChildren();
        const order = { town: 0, zone: 1, port: 2 };
        const sorted = [...this.sites].sort((a, b) => (a.kept - b.kept) || (order[a.kind] - order[b.kind]));
        for (const site of sorted) {
            const { x, y } = this.project(site.lat, site.lon);
            const r = (site.kept ? 5 : 3.5) * unit;
            const { name, attributes } = this.shape(site.kind, x, y, r);
            const highlighted = this.highlight === site.id;
            const node = element(name, { ...attributes, class: `site ${site.kind}${site.kept ? '' : ' dropped'}${highlighted ? ' highlight' : ''}`, 'stroke-width': (highlighted ? 2.5 : 1.5) * unit, 'data-id': site.id }, this.siteLayer);
            element('title', {}, node).textContent = `${site.name}${site.kept ? '' : ' (not kept: click to keep)'}`;
            if (site.kept) {
                const label = element('text', { x: x + 8 * unit, y: y + 4 * unit, class: 'label', 'font-size': 11 * unit, 'stroke-width': 3 * unit }, this.siteLayer);
                label.textContent = site.name;
            }
        }
    }

    drawFlows() {
        const unit = this.unit();
        this.flowLayer.replaceChildren();
        const at = (point) => this.project(point.lat, point.lon);
        const maximum = Math.max(1, ...this.flows.lanes.map((lane) => lane.rate));
        for (const lane of this.flows.lanes) {
            const a = at(lane.from);
            const b = at(lane.to);
            const line = element('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'lane', 'stroke-width': (1.5 + 5 * lane.rate / maximum) * unit }, this.flowLayer);
            element('title', {}, line).textContent = lane.title;
        }
        for (const serve of this.flows.serves) {
            const a = at(serve.from);
            const b = at(serve.to);
            element('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'serve', 'stroke-width': 1.2 * unit, 'stroke-dasharray': `${3 * unit} ${3 * unit}` }, this.flowLayer);
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

    listen() {
        let drag = null;
        this.svg.addEventListener('pointerdown', (event) => {
            const target = event.target.closest('.site');
            const site = target ? this.sites.find((item) => item.id === target.dataset.id) : null;
            drag = { site, start: { x: event.clientX, y: event.clientY }, view: { ...this.view }, moved: false, origin: this.toMap(event) };
            this.svg.setPointerCapture(event.pointerId);
        });
        this.svg.addEventListener('pointermove', (event) => {
            if (!drag) return;
            if (!drag.moved && Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) < 4) return;
            drag.moved = true;
            if (drag.site?.kept) {
                const { x, y } = this.toMap(event);
                Object.assign(drag.site, this.unproject(x, y), { moved: true });
                this.drawSites();
            } else if (!drag.site) {
                const unit = this.unit();
                this.view.x = drag.view.x - (event.clientX - drag.start.x) * unit;
                this.view.y = drag.view.y - (event.clientY - drag.start.y) * unit;
                this.applyView();
            }
        });
        this.svg.addEventListener('pointerup', (event) => {
            if (!drag) return;
            const { site, moved, origin } = drag;
            drag = null;
            if (site && moved && site.kept) this.handlers.onMove?.(site.id, site.lat, site.lon);
            else if (site && !moved) this.handlers.onToggle?.(site.id);
            else if (!site && !moved && this.addKind) this.handlers.onAdd?.(this.addKind, this.unproject(origin.x, origin.y));
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
