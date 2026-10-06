/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Builds a Konjugate project document from this toolbox's component templates, the way the app
// places them: a node template becomes a node with its source terms, a bundle becomes its edges
// between the given nodes, and shared parameters are created per placement ("instance") or reused
// by symbol ("project"). It has no dependencies of its own: the equation helpers come from the host
// (an importer receives them) or, in scripts and tests, from the Konjugate checkout. The interaction
// tests check that the app places templates the same way.

// The time binding the node editor adds to every source term: `t`, or `t2`, ... if `t` is taken.
export function timeBinding(usedSymbols = new Set(), preferred = 't') {
    let symbol = preferred;
    for (let suffix = 2; usedSymbols.has(symbol); suffix += 1) symbol = `${preferred}${suffix}`;
    return { kind: 'time', symbol, label: `${symbol} (time)` };
}

export class ModelBuilder {
    // `helpers` are Konjugate's equation helpers: reconcileEquationBindings and validateEquationLatex, as
    // the host hands them to an importer, and optionally timeBinding.
    constructor(templates, helpers) {
        if (!helpers?.reconcileEquationBindings || !helpers?.validateEquationLatex) throw new Error('ModelBuilder needs Konjugate\'s equation helpers.');
        this.templates = templates;
        this.helpers = helpers;
        this.nextId = 1;
        this.nodes = [];
        this.edges = [];
        this.sharedParameters = [];
    }

    id() {
        return this.nextId++;
    }

    template(id, kind) {
        const template = this.templates.get(id);
        if (!template || template.kind !== kind) throw new Error(`No ${kind} template "${id}".`);
        return template;
    }

    // Unit words to say otherwise in every unit the model shows: { TEU: 'pallets', trucks: 'vehicles' } for a network
    // that counts pallets and runs on vehicles of several kinds. The templates' equations do not change.
    unitNames = {};

    relabel(unit = '') {
        return Object.entries(this.unitNames).reduce((text, [word, said]) => text.replace(new RegExp(`\\b${word}\\b`, 'g'), said), unit);
    }

    // `values` overrides the value of a shared parameter this placement creates, by key -- what a
    // user does by editing it after placing. A project-scoped one that already exists is reused as is.
    // `as` places a shared parameter as another one, by key: { symbol, name, unit, value, own }. Without `own` it is
    // the one shared parameter of that symbol, created by the first placement that names it and reused by the rest (so
    // a vehicle type's capacity is one parameter for every lane and shipment it runs on, though the template declares a
    // lane's truck capacity once for the whole model); with `own`, this placement's alone (so one warehouse can have
    // a stock cover of its own). What a user does by linking parameters in the parameters panel.
    resolveShared(declaredList = [], values = {}, as = {}) {
        const byKey = new Map();
        for (const declared of declaredList) {
            const alias = as[declared.key];
            const symbolWanted = alias?.symbol ?? declared.symbol;
            const reuse = alias ? !alias.own : declared.scope === 'project';
            const existing = reuse ? this.sharedParameters.find((shared) => shared.symbol === symbolWanted) : null;
            if (existing) {
                byKey.set(declared.key, existing);
                continue;
            }
            let symbol = symbolWanted;
            for (let suffix = 2; this.sharedParameters.some((shared) => shared.symbol === symbol); suffix += 1) symbol = `${symbolWanted}${suffix}`;
            const created = {
                id: this.id(), name: alias?.name ?? declared.name, symbol, value: alias?.value ?? values[declared.key] ?? declared.value,
                unit: this.relabel(alias?.unit ?? declared.unit ?? ''), mode: declared.mode ?? 'constant'
            };
            this.sharedParameters.push(created);
            byKey.set(declared.key, created);
        }
        // What the last placement created or reused, by template key: symbols are numbered as they are taken, so
        // `fleetSize2` may be one lane's second size or another lane's first, and only the key says which.
        this.lastShared = byKey;
        return byKey;
    }

    parameter(parameter, sharedByKey) {
        const shared = parameter.shared === undefined ? null : sharedByKey.get(parameter.shared);
        const source = shared ?? parameter;
        return {
            id: this.id(), name: parameter.name, symbol: parameter.symbol, value: Number(source.value) || 0,
            unit: shared ? shared.unit : this.relabel(source.unit ?? ''), mode: source.mode ?? 'constant', ...(shared ? { sharedParameterId: shared.id } : {})
        };
    }

    // Changes a shared parameter's value by symbol, as a user would in the parameters panel.
    setShared(symbol, value) {
        const shared = this.sharedParameters.find((candidate) => candidate.symbol === symbol);
        if (!shared) throw new Error(`No shared parameter "${symbol}".`);
        shared.value = value;
        for (const parameter of this.allParameters()) if (parameter.sharedParameterId === shared.id) parameter.value = value;
    }

    // Makes a shared parameter live, with a slider, so a run can be forked with a new value -- what a
    // user does in the parameters table. `control` is { minimum, maximum, step }.
    setLive(symbol, control) {
        const shared = this.sharedParameters.find((candidate) => candidate.symbol === symbol);
        if (!shared) throw new Error(`No shared parameter "${symbol}".`);
        // A value a rounding error past the slider's end (a share of 1.0000000000000002) is the end itself.
        const slack = 1e-9 * Math.max(1, Math.abs(control.maximum), Math.abs(control.minimum));
        if (!(control.minimum - slack <= shared.value && shared.value <= control.maximum + slack)) throw new Error(`${symbol} = ${shared.value} lies outside its slider.`);
        shared.value = Math.min(Math.max(shared.value, control.minimum), control.maximum);
        for (const parameter of this.allParameters()) if (parameter.sharedParameterId === shared.id) parameter.value = shared.value;
        for (const parameter of [shared, ...this.allParameters().filter((candidate) => candidate.sharedParameterId === shared.id)]) {
            parameter.mode = 'live';
            parameter.control = { ...control };
        }
    }

    allParameters() {
        return [
            ...this.nodes.flatMap((node) => node.sourceTerms.flatMap((term) => term.parameters ?? [])),
            ...this.edges.flatMap((edge) => edge.parameters)
        ];
    }

    placeNode(templateId, { name, position = [0, 0, 0], initialValues = {}, shared = {}, as = {} } = {}) {
        const template = this.template(templateId, 'node');
        const sharedByKey = this.resolveShared(template.sharedParameters, shared, as);
        const node = {
            id: this.id(), name: name ?? template.name, type: template.name, position, sourceTerms: [],
            states: template.states.map((state) => ({
                id: this.id(), name: state.label, symbol: state.symbol,
                initialValue: initialValues[state.symbol] ?? state.initialValue, unit: this.relabel(state.unit ?? '')
            })),
            appearance: { type: 'primitive', shape: template.shape ?? 'box', color: template.color ?? '#34727a' }
        };
        for (const term of template.sourceTerms ?? []) {
            const parameters = (term.parameters ?? []).map((parameter) => this.parameter(parameter, sharedByKey));
            // Every state of the node is bound, as the node editor does; the expression uses what it needs.
            const bindings = [
                ...node.states.map((state) => ({ kind: 'state', nodeId: node.id, stateId: state.id, symbol: state.symbol })),
                ...parameters.map((parameter) => ({ kind: 'parameter', parameterId: parameter.id, symbol: parameter.symbol }))
            ];
            bindings.push((this.helpers.timeBinding ?? timeBinding)(new Set(bindings.map((binding) => binding.symbol))));
            const validation = this.helpers.validateEquationLatex(term.expression, bindings);
            if (!validation.valid) throw new Error(`${node.name} ${term.state}: ${validation.errors.join(' ')}`);
            const output = node.states.find((state) => state.symbol === term.state);
            node.sourceTerms.push({
                id: this.id(), state: term.state, expression: term.expression, parameters,
                ...(term.setsValue ? { setsValue: true } : {}),
                expressionModel: { latex: term.expression, bindings, output: { stateId: output.id }, mathJson: validation.mathJson }
            });
        }
        this.nodes.push(node);
        return node;
    }

    // `endpoints` maps each of the bundle's endpoint ids to a placed node.
    applyBundle(templateId, endpoints, { shared = {}, as = {} } = {}) {
        const template = this.template(templateId, 'bundle');
        for (const endpoint of template.endpoints) if (!endpoints[endpoint.id]) throw new Error(`${template.name}: no node for endpoint "${endpoint.id}".`);
        const sharedByKey = this.resolveShared(template.sharedParameters, shared, as);
        const created = [];
        for (const edge of template.edges) {
            const source = endpoints[edge.from];
            const target = endpoints[edge.to];
            const stateOf = (node, symbol) => {
                const state = node.states.find((candidate) => candidate.symbol === symbol);
                if (!state) throw new Error(`${template.name} / ${edge.name}: ${node.name} has no state "${symbol}".`);
                return state;
            };
            const parameters = (edge.parameters ?? []).map((parameter) => this.parameter(parameter, sharedByKey));
            const bindings = this.helpers.reconcileEquationBindings([], source, target, parameters);
            const validation = this.helpers.validateEquationLatex(edge.latex, bindings);
            if (!validation.valid) throw new Error(`${template.name} / ${edge.name}: ${validation.errors.join(' ')}`);
            const outputNode = edge.output.role === 'source' ? source : target;
            const output = stateOf(outputNode, edge.output.state);
            const sourceState = edge.output.role === 'source' ? output : stateOf(source, [edge.ports.source].flat()[0]);
            const targetState = edge.output.role === 'target' ? output : stateOf(target, [edge.ports.target].flat()[0]);
            const definition = {
                id: this.id(), name: `${edge.name}: ${source.name} → ${target.name}`,
                source: { nodeId: source.id, stateId: sourceState.id }, target: { nodeId: target.id, stateId: targetState.id },
                directionality: edge.bidirectional ? 'bidirectional' : 'directed', equation: edge.latex,
                equationModel: { latex: edge.latex, output: { role: edge.output.role, stateId: output.id }, bindings, mathJson: validation.mathJson },
                parameters, appearance: { color: edge.color ?? template.color ?? '#9c83c4', offset: 0 }
            };
            this.edges.push(definition);
            created.push(definition);
        }
        return created;
    }

    // Time is in seconds; `days`, `stepDays` and `outputDays` are converted here.
    document({ days = 120, stepDays = 0.05, outputDays = 1 } = {}) {
        const runConfigurationId = this.id();
        return {
            format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
            metadata: { units: 'SI' },
            nodes: this.nodes, edges: this.edges, sharedParameters: this.sharedParameters,
            runConfigurations: [{ id: runConfigurationId, name: `${days} days`, targetTime: days * 86400, globalTimeStep: stepDays * 86400, outputInterval: outputDays * 86400 }],
            activeRunConfigurationId: runConfigurationId
        };
    }
}
