/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Builds a Konjugate project document from this plugin's component templates, the way the app
// places them: a node template becomes a node with its source terms, a bundle becomes its edges
// between the given nodes, and shared parameters are created per placement ("instance") or reused
// by symbol ("project"). Tests and example models use this so they run exactly what the templates
// say. The interaction tests check that the app places them the same way.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { konjugateModule, logisticsRoot } from './konjugatePaths.mjs';

const { reconcileEquationBindings, timeBinding, validateEquationLatex } = await import(pathToFileURL(konjugateModule('src/equationModel.mjs')));
const { validateComponentTemplate } = await import(pathToFileURL(konjugateModule('src/componentTemplate.mjs')));

const packageDirectory = join(logisticsRoot, 'packages', 'engine');

export async function loadTemplates() {
    const manifest = JSON.parse(await readFile(join(packageDirectory, 'plugin.json'), 'utf8'));
    const templates = new Map();
    for (const contribution of manifest.contributes.filter((entry) => entry.kind === 'component')) {
        const template = validateComponentTemplate(JSON.parse(await readFile(join(packageDirectory, contribution.entry), 'utf8')));
        templates.set(template.id, template);
    }
    return templates;
}

export class ModelBuilder {
    constructor(templates) {
        this.templates = templates;
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

    // `values` overrides the value of a shared parameter this placement creates, by key -- what a
    // user does by editing it after placing. A project-scoped one that already exists is reused as is.
    resolveShared(declaredList = [], values = {}) {
        const byKey = new Map();
        for (const declared of declaredList) {
            const existing = declared.scope === 'project' ? this.sharedParameters.find((shared) => shared.symbol === declared.symbol) : null;
            if (existing) {
                byKey.set(declared.key, existing);
                continue;
            }
            let symbol = declared.symbol;
            for (let suffix = 2; this.sharedParameters.some((shared) => shared.symbol === symbol); suffix += 1) symbol = `${declared.symbol}${suffix}`;
            const created = {
                id: this.id(), name: declared.name, symbol, value: values[declared.key] ?? declared.value,
                unit: declared.unit ?? '', mode: declared.mode ?? 'constant'
            };
            this.sharedParameters.push(created);
            byKey.set(declared.key, created);
        }
        return byKey;
    }

    parameter(parameter, sharedByKey) {
        const shared = parameter.shared === undefined ? null : sharedByKey.get(parameter.shared);
        const source = shared ?? parameter;
        return {
            id: this.id(), name: parameter.name, symbol: parameter.symbol, value: Number(source.value) || 0,
            unit: source.unit ?? '', mode: source.mode ?? 'constant', ...(shared ? { sharedParameterId: shared.id } : {})
        };
    }

    // Changes a shared parameter's value by symbol, as a user would in the parameters panel.
    setShared(symbol, value) {
        const shared = this.sharedParameters.find((candidate) => candidate.symbol === symbol);
        if (!shared) throw new Error(`No shared parameter "${symbol}".`);
        shared.value = value;
        for (const parameter of this.allParameters()) if (parameter.sharedParameterId === shared.id) parameter.value = value;
    }

    allParameters() {
        return [
            ...this.nodes.flatMap((node) => node.sourceTerms.flatMap((term) => term.parameters ?? [])),
            ...this.edges.flatMap((edge) => edge.parameters)
        ];
    }

    placeNode(templateId, { name, position = [0, 0, 0], initialValues = {}, shared = {} } = {}) {
        const template = this.template(templateId, 'node');
        const sharedByKey = this.resolveShared(template.sharedParameters, shared);
        const node = {
            id: this.id(), name: name ?? template.name, type: template.name, position, sourceTerms: [],
            states: template.states.map((state) => ({
                id: this.id(), name: state.label, symbol: state.symbol,
                initialValue: initialValues[state.symbol] ?? state.initialValue, unit: state.unit ?? ''
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
            bindings.push(timeBinding(new Set(bindings.map((binding) => binding.symbol))));
            const validation = validateEquationLatex(term.expression, bindings);
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
    applyBundle(templateId, endpoints, { shared = {} } = {}) {
        const template = this.template(templateId, 'bundle');
        for (const endpoint of template.endpoints) if (!endpoints[endpoint.id]) throw new Error(`${template.name}: no node for endpoint "${endpoint.id}".`);
        const sharedByKey = this.resolveShared(template.sharedParameters, shared);
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
            const bindings = reconcileEquationBindings([], source, target, parameters);
            const validation = validateEquationLatex(edge.latex, bindings);
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
