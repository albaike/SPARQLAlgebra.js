import { isomorphic } from 'rdf-isomorphic';
import * as RDF from '@rdfjs/types'
import { termToString } from 'rdf-string';
import {
    AggregateExpression,
    BgpPattern,
    ClearDropOperation,
    ConstructQuery,
    CopyMoveAddOperation,
    CreateOperation,
    FunctionCallExpression,
    Generator,
    GraphOrDefault,
    GraphPattern,
    GraphReference,
    GroupPattern,
    InsertDeleteOperation,
    IriTerm,
    LoadOperation,
    OperationExpression,
    Ordering,
    Pattern,
    PropertyPath,
    Query,
    SelectQuery,
    ServicePattern,
    Triple,
    UnionPattern,
    Update,
    ValuePatternRow,
    ValuesPattern,
    Variable,
    Wildcard,
    type GeneratorOptions
} from 'sparqljs';
import * as Algebra from './algebra';
import Factory from './factory';
import Util from './util';

const types = Algebra.types;
const eTypes = Algebra.expressionTypes;

let context : { project: boolean, extend: Algebra.Extend[], group: RDF.Variable[], aggregates: Algebra.BoundAggregate[], order: Algebra.Expression[] };
const factory = new Factory();

export function toSparql(op: Algebra.Operation, options: GeneratorOptions = {}): string
{
    let generator = new Generator(options);
    return generator.stringify(toSparqlJs(op, options.prefixes ? options.prefixes : {}));
}

export function toSparqlJs(op: Algebra.Operation, prefixes: Algebra.Prefixes = {}):  any
{
    resetContext();
    op = removeQuads(op);
    let result = translateOperation(op, prefixes);
    if (result.type === 'group')
        return result.patterns[0];
    return result;
}

function resetContext()
{
    context = { project: false, extend: [], group: [], aggregates: [], order: [] };
}

function translateOperation(op: Algebra.Operation, prefixes: Algebra.Prefixes = {}): any
{
    // this allows us to differentiate between BIND and SELECT when translating EXTEND
    // GRAPH was added because the way graphs get added back here is not the same as how they get added in the future
    // ^ seems fine but might have to be changed if problems get detected in the future
    if (op.type !== types.EXTEND && op.type !== types.ORDER_BY && op.type !== types.GRAPH)
        context.project = false;

    switch(op.type)
    {
        case types.EXPRESSION: return translateExpression(op);

        case types.ASK:       return translateProject(op, types.ASK, prefixes);
        case types.BGP:       return translateBgp(op);
        case types.CONSTRUCT: return translateConstruct(op, prefixes);
        case types.DESCRIBE:  return translateProject(op, types.DESCRIBE, prefixes);
        case types.DISTINCT:  return translateDistinct(op);
        case types.EXTEND:    return translateExtend(op);
        case types.FROM:      return translateFrom(op);
        case types.FILTER:    return translateFilter(op);
        case types.GRAPH:     return translateGraph(op);
        case types.GROUP:     return translateGroup(op);
        case types.JOIN:      return translateJoin(op);
        case types.LEFT_JOIN: return translateLeftJoin(op);
        case types.MINUS:     return translateMinus(op);
        case types.NOP:       return {};
        case types.ORDER_BY:  return translateOrderBy(op);
        case types.PATH:      return translatePath(op);
        case types.PATTERN:   return translatePattern(op);
        case types.PROJECT:   return translateProject(op, types.PROJECT, prefixes);
        case types.REDUCED:   return translateReduced(op);
        case types.SERVICE:   return translateService(op);
        case types.SLICE:     return translateSlice(op);
        case types.UNION:     return translateUnion(op);
        case types.VALUES:    return translateValues(op);
        // UPDATE operations
        case types.COMPOSITE_UPDATE: return translateCompositeUpdate(op, prefixes);
        case types.DELETE_INSERT:    return translateDeleteInsert(op, prefixes);
        case types.LOAD:             return translateLoad(op, prefixes);
        case types.CLEAR:            return translateClear(op, prefixes);
        case types.CREATE:           return translateCreate(op, prefixes);
        case types.DROP:             return translateDrop(op, prefixes);
        case types.ADD:              return translateAdd(op, prefixes);
        case types.MOVE:             return translateMove(op, prefixes);
        case types.COPY:             return translateCopy(op, prefixes);
    }

    throw new Error(`Unknown Operation type ${op.type}`);
}

function translateExpression(expr: Algebra.Expression): any
{
    switch(expr.expressionType)
    {
        case eTypes.AGGREGATE: return translateAggregateExpression(expr);
        case eTypes.EXISTENCE: return translateExistenceExpression(expr);
        case eTypes.NAMED:     return translateNamedExpression(expr);
        case eTypes.OPERATOR:  return translateOperatorExpression(expr);
        case eTypes.TERM:      return translateTermExpression(expr);
        case eTypes.WILDCARD:  return translateWildcardExpression(expr);
    }

    throw new Error(`Unknown Expression Operation type ${(expr as any).expressionType}`);
}

function translatePathComponent(path: Algebra.Operation): IriTerm | PropertyPath
{
    switch(path.type)
    {
        case types.ALT:               return translateAlt(path);
        case types.INV:               return translateInv(path);
        case types.LINK:              return translateLink(path);
        case types.NPS:               return translateNps(path);
        case types.ONE_OR_MORE_PATH:  return translateOneOrMorePath(path);
        case types.SEQ:               return translateSeq(path);
        case types.ZERO_OR_MORE_PATH: return translateZeroOrMorePath(path);
        case types.ZERO_OR_ONE_PATH:  return translateZeroOrOnePath(path);
    }

    throw new Error(`Unknown Path type ${path.type}`);
}

function translateTerm(term: RDF.Term): string
{
    return termToString(term);
}

// ------------------------- EXPRESSIONS -------------------------

function translateAggregateExpression(expr: Algebra.AggregateExpression): AggregateExpression
{
    const result: any = {
        expression: translateExpression(expr.expression),
        type: 'aggregate',
        aggregation: expr.aggregator,
        distinct: expr.distinct
    };

    if (expr.separator)
        result.separator = expr.separator;

    return result;
}

function translateExistenceExpression(expr: Algebra.ExistenceExpression): OperationExpression
{
    return {
        type: 'operation',
        operator: expr.not ? 'notexists' : 'exists',
        args: Util.flatten([
            translateOperation(expr.input)
        ])
    };
}

function translateNamedExpression(expr: Algebra.NamedExpression): FunctionCallExpression
{
    return {
        type: 'functionCall',
        // Wrong typings
        function: expr.name as any,
        args: expr.args.map(translateExpression)
    }
}

function translateOperatorExpression(expr: Algebra.OperatorExpression): Ordering | OperationExpression
{
    if (expr.operator === 'desc')
    {
        const result: Ordering = { expression: translateExpression(expr.args[0])};
        result.descending = true;
        return result;
    }

    const result: OperationExpression = {
        type: 'operation',
        operator: expr.operator,
        args: expr.args.map(translateExpression)
    };

    if (result.operator === 'in' || result.operator === 'notin')
        result.args = [result.args[0]].concat([result.args.slice(1)]);

    return result;
}

function translateTermExpression(expr: Algebra.TermExpression): RDF.Term
{
    return expr.term;
}

function translateWildcardExpression(expr: Algebra.WildcardExpression): Wildcard
{
    return expr.wildcard;
}


// ------------------------- OPERATIONS -------------------------
// these get translated in the project function
function translateBoundAggregate(op: Algebra.BoundAggregate): Algebra.BoundAggregate
{
    return op;
}

function translateBgp(op: Algebra.Bgp): BgpPattern | null
{
    let patterns = op.patterns.map(translatePattern);
    if (patterns.length === 0)
        return null;
    return {
        type: 'bgp',
        triples: patterns
    };
}

function translateConstruct(op: Algebra.Construct, prefixes: Algebra.Prefixes = {}): ConstructQuery
{
    return {
        type: 'query',
        prefixes,
        queryType: 'CONSTRUCT',
        template: op.template.map(translatePattern),
        where: Util.flatten([
            translateOperation(op.input)
        ])
    }
}

function translateDistinct(op: Algebra.Distinct): GroupPattern
{
    let result = translateOperation(op.input);
    // project is nested in group object
    result.patterns[0].distinct = true;
    return result
}

function translateExtend(op: Algebra.Extend): any
{
    if (context.project)
    {
        context.extend.push(op);
        return translateOperation(op.input);
    }
    return Util.flatten([
        translateOperation(op.input),
        {
            type: 'bind',
            variable: op.variable,
            expression: translateExpression(op.expression)
        }
    ])
}

function translateFrom(op: Algebra.From): GroupPattern
{
    const result = translateOperation(op.input);
    // project is nested in group object
    const obj: SelectQuery = result.patterns[0];
    obj.from = {
        default: op.default,
        named: op.named
    };
    return result;
}

function translateFilter(op: Algebra.Filter): GroupPattern
{
    return {
        type: 'group',
        patterns:  Util.flatten ([
                translateOperation(op.input),
                { type : 'filter', expression: translateExpression(op.expression) }
            ])
    };
}

function translateGraph(op: Algebra.Graph): GraphPattern
{
    return {
        type: 'graph',
        patterns: Util.flatten([ translateOperation(op.input) ]),
        name: op.name as IriTerm
    }
}

function translateGroup(op: Algebra.Group): any
{
    const input = translateOperation(op.input);
    const aggs = op.aggregates.map(translateBoundAggregate);
    context.aggregates.push(...aggs);
    // TODO: apply possible extends
    context.group.push(...op.variables);

    return input;
}

function translateJoin(op: Algebra.Join): Pattern[]
{
    const arr: any[] = Util.flatten(op.input.map(o => translateOperation(o)));

    // Merge bgps
    // This is possible if one side was a path and the other a bgp for example
    return arr.reduce((result, val) => {
        if (val.type !== 'bgp' || result.length == 0 || result[result.length-1].type !== 'bgp') {
            result.push(val);
        } else {
            result[result.length - 1].triples.push(...val.triples);
        }
        return result;
    }, []);
}

function translateLeftJoin(op: Algebra.LeftJoin): Pattern[]
{
    const leftjoin = {
        type: 'optional',
        patterns: [
            translateOperation(op.input[1])
        ]
    };

    if (op.expression)
    {
        leftjoin.patterns.push(
            {
                type: 'filter',
                expression: translateExpression(op.expression)
            }
        );
    }
    leftjoin.patterns = Util.flatten(leftjoin.patterns);

    return Util.flatten([
        translateOperation(op.input[0]),
        leftjoin
    ])
}

function translateMinus(op: Algebra.Minus): Pattern[]
{
    let patterns = translateOperation(op.input[1]);
    if (patterns.type === 'group')
        patterns = patterns.patterns;
    if (!Array.isArray(patterns))
        patterns = [ patterns ];
    return Util.flatten([
        translateOperation(op.input[0]),
        {
            type: 'minus',
            patterns: patterns
        }
    ]);
}

function translateOrderBy(op: Algebra.OrderBy): any
{
    context.order.push(...op.expressions);
    return translateOperation(op.input);
}

function translatePath(op: Algebra.Path): BgpPattern
{
    return {
        type: 'bgp',
        triples: [{
            subject  : op.subject as RDF.Quad_Subject,
            predicate: translatePathComponent(op.predicate),
            object   : op.object as RDF.Quad_Object
        }]
    };
}

function translatePattern(op: Algebra.Pattern): Triple
{
    return {
        subject: op.subject as RDF.Quad_Subject,
        predicate: op.predicate as RDF.Quad_Predicate,
        object: op.object as RDF.Quad_Object
    };
}

function replaceAggregatorVariables(s: any, map: any): any
{
    let st = Util.isSimpleTerm(s) ? translateTerm(s) : s;

    if (typeof st === 'string')
    {
        if (map[st])
            return map[st];
    }
    else if (Array.isArray(s))
    {
        s = s.map(e => replaceAggregatorVariables(e, map));
    }
    else
    {
        for (let key of Object.keys(s))
            s[key] = replaceAggregatorVariables(s[key], map);
    }
    return s;
}

function translateProject(op: Algebra.Project | Algebra.Ask | Algebra.Describe, type: string, prefixes: Algebra.Prefixes = {}): GroupPattern
{
    const result: Query = {
        type: 'query',
        prefixes,
    } as any;

    // Makes typing easier in some places
    const select: SelectQuery = result as any;
    let variables: RDF.Variable[] | undefined;

    if (type === types.PROJECT)
    {
        result.queryType = 'SELECT';
        variables = op.variables;
    } else if (type === types.ASK) {
        result.queryType = 'ASK';
    } else if (type === types.DESCRIBE) {
        result.queryType = 'DESCRIBE';
        variables = op.terms;
    }

    // backup values in case of nested queries
    // everything in extend, group, etc. is irrelevant for this project call
    const extend = context.extend;
    const group = context.group;
    const aggregates = context.aggregates;
    const order = context.order;
    resetContext();

    context.project = true;
    let input = Util.flatten<any>([ translateOperation(op.input) ]);
    if (input.length === 1 && input[0].type === 'group')
        input = input[0].patterns;
    result.where = input;

    let aggregators: any = {};
    // these can not reference each other
    for (let agg of context.aggregates)
        aggregators[translateTerm(agg.variable)] = translateExpression(agg);

    // do these in reverse order since variables in one extend might apply to an expression in an other extend
    let extensions: any = {};
    for (let i = context.extend.length-1; i >= 0; --i)
    {
        let e = context.extend[i];
        extensions[translateTerm(e.variable)] = replaceAggregatorVariables(translateExpression(e.expression), aggregators);
    }
    if (context.group.length > 0)
        select.group = context.group.map(variable =>
        {
            let v = translateTerm(variable);
            if (extensions[v])
            {
                let result = extensions[v];
                delete extensions[v]; // make sure there is only 1 'AS' statement
                return {
                    variable,
                    expression: result
                };
            }
            return { expression: variable };
        });

    // descending expressions will already be in the correct format due to the structure of those
    if (context.order.length > 0)
        select.order = context.order.map(o => translateOperation(o)).map(o => o.descending ? o : ({ expression: o }));

    // this needs to happen after the group because it might depend on variables generated there
    if (variables)
    {
        select.variables = variables.map((term): Variable => {
            let v = translateTerm(term);
            if (extensions[v])
                return {
                    variable  : term,
                    expression: extensions[v]
                };
            return term;
        });
        // if the * didn't match any variables this would be empty
        if (select.variables.length === 0)
            select.variables = [new Wildcard()];
    }


    // convert filter to 'having' if it contains an aggregator variable
    // could always convert, but is nicer to use filter when possible
    if (result.where.length > 0 && result.where[result.where.length-1].type === 'filter')
    {
        const filter = result.where[result.where.length-1];
        if (objectContainsValues(filter, Object.keys(aggregators)))
        {
            select.having = Util.flatten([ replaceAggregatorVariables((filter as any).expression, aggregators) ]);
            result.where.splice(-1);
        }
    }

    context.extend = extend;
    context.group = group;
    context.aggregates = aggregates;
    context.order = order;

    // subqueries need to be in a group, this will be removed again later for the root query
    return { type: 'group', patterns: [select] };
}

function objectContainsValues(o: any, vals: string[]): boolean
{
    if (Util.isSimpleTerm(o))
        return vals.indexOf(translateTerm(o)) >= 0;
    if (Array.isArray(o))
        return o.some(e => objectContainsValues(e, vals));
    if (o === Object(o))
        return Object.keys(o).some(key => objectContainsValues(o[key], vals));
    return vals.indexOf(o) >= 0;
}

function translateReduced(op: Algebra.Reduced): Pattern
{
    let result = translateOperation(op.input);
    // project is nested in group object
    result.patterns[0].reduced = true;
    return result
}

function translateService(op: Algebra.Service): ServicePattern
{
    let patterns = translateOperation(op.input);
    if (patterns.type === 'group')
        patterns = patterns.patterns;
    if (!Array.isArray(patterns))
        patterns = [patterns];
    return {
        type: 'service',
        // Typings are wrong, name can also be a variable
        name: op.name as RDF.NamedNode,
        silent: op.silent,
        patterns
    };
}

function translateSlice(op: Algebra.Slice): Pattern
{
    let result = translateOperation(op.input);
    // results can be nested in a group object
    let obj = result;
    if (result.type && result.type === 'group')
        obj = result.patterns[0];
    if (op.start !== 0)
        obj.offset = op.start;
    if (op.length !== undefined)
        obj.limit = op.length;
    return result;
}

function translateUnion(op: Algebra.Union): UnionPattern
{
    return {
        type: 'union',
        patterns: Util.flatten(op.input.map(o => translateOperation(o)))
    }
}

function translateValues(op: Algebra.Values): ValuesPattern
{
    // TODO: check if handled correctly when outside of select block
    return {
        type: 'values',
        values: op.bindings.map(binding =>
        {
            let result: ValuePatternRow = {};
            for (let v of op.variables)
            {
                let s = `?${v.value}`;
                if (binding[s])
                    result[s] = binding[s];
                else
                    result[s] = undefined;
            }
            return result;
        })
    };
}

// PATH COMPONENTS

function translateAlt(path: Algebra.Alt): any
{
    const mapped = path.input.map(translatePathComponent);
    if (mapped.every(entry => 'pathType' in entry && entry.pathType === '!'))
    {
        return {
            type: 'path',
            pathType: '!',
            items: [ {
                type: 'path',
                pathType: '|',
                items: Util.flatten(mapped.map(entry => (<PropertyPath> entry).items))
            } ]
        }
    }

    return {
        type: 'path',
        pathType: '|',
        items: mapped
    }
}

function translateInv(path: Algebra.Inv): PropertyPath
{
    if (path.path.type === types.NPS)
    {
        const inv: PropertyPath[] = path.path.iris.map((iri: RDF.NamedNode) =>
        {
            return {
                type: 'path',
                pathType: '^',
                items: [ iri ]
            }
        });

        if (inv.length <= 1)
            return {
                type    : 'path',
                pathType: '!',
                items   : inv
            };

        return {
            type: 'path',
            pathType: '!',
            items: [ {
                type: 'path',
                pathType: '|',
                items: inv
            } ]
        }
    }

    return {
        type: 'path',
        pathType: '^',
        items: [ translatePathComponent(path.path) ]
    }
}

function translateLink(path: Algebra.Link): RDF.NamedNode
{
    return path.iri;
}

function translateNps(path: Algebra.Nps): PropertyPath
{
    if (path.iris.length <= 1)
        return {
            type: 'path',
            pathType: '!',
            items: path.iris
        };

    return {
        type: 'path',
        pathType: '!',
        items: [ {
            type: 'path',
            pathType: '|',
            items: path.iris
        } ]
    }
}

function translateOneOrMorePath(path: Algebra.OneOrMorePath): PropertyPath
{
    return {
        type: 'path',
        pathType: '+',
        items: [ translatePathComponent(path.path) ]
    }
}

function translateSeq(path: Algebra.Seq): PropertyPath
{
    return {
        type: 'path',
        pathType: '/',
        items: path.input.map(translatePathComponent)
    }
}

function translateZeroOrMorePath(path: Algebra.ZeroOrMorePath): PropertyPath
{
    return {
        type: 'path',
        pathType: '*',
        items: [ translatePathComponent(path.path) ]
    }
}
function translateZeroOrOnePath(path: Algebra.ZeroOrOnePath): PropertyPath
{
    // Typings are missing '?' operator
    return {
        type: 'path',
        // Typings are missing this path
        pathType: '?' as any,
        items: [ translatePathComponent(path.path) ]
    }
}

// UPDATE OPERATIONS

function translateCompositeUpdate(op: Algebra.CompositeUpdate, prefixes: Algebra.Prefixes = {}): Update
{
  const updates = op.updates.map(update => {
    const result = translateOperation(update);
    return result.updates[0];
  });

  return { prefixes, type: 'update', updates }
}

function translateDeleteInsert(op: Algebra.DeleteInsert, prefixes: Algebra.Prefixes = {}): Update
{
    let where: Algebra.Operation | undefined = op.where;
    let using = undefined;
    if (where && where.type === types.FROM) {
        let from = where;
        where = from.input;
        using = { default: from.default, named: from.named };
    }

    const updates: [InsertDeleteOperation] = [{
        updateType: 'insertdelete',
        delete: convertUpdatePatterns(op.delete || []),
        insert: convertUpdatePatterns(op.insert || []),
    }];
    // Typings don't support 'using' yet
    if (using)
        (updates[0] as any).using = using;

    // corresponds to empty array in SPARQL.js
    if (!where || (where.type === types.BGP && where.patterns.length === 0))
        updates[0].where = [];
    else
    {
        const graphs: NodeJS.Dict<{ graph: RDF.NamedNode, values: Algebra.Operation[]}> = {};
        let result = translateOperation(removeQuadsRecursive(where, graphs));
        if (result.type === 'group')
            updates[0].where = result.patterns;
        else
            updates[0].where = [result];
        // graph might not be applied yet since there was no project
        // this can only happen if there was a single graph
        const graphNames = Object.keys(graphs);
        if (graphNames.length > 0) {
            if (graphNames.length !== 1)
                throw new Error('This is unexpected and might indicate an error in graph handling for updates.');
            const graphName = graphs[graphNames[0]]?.graph;
            // ignore if default graph
            if (graphName && graphName.value !== '')
                updates[0].where = [{ type: 'graph', patterns: updates[0].where!, name: graphName }]
        }
    }

    // not really necessary but can give cleaner looking queries
    if (!op.delete && !op.where) {
        updates[0].updateType = 'insert';
        delete updates[0].delete;
        delete updates[0].where;
    } else if (!op.insert && !op.where) {
        delete updates[0].insert;
        delete updates[0].where;
        if (op.delete!.some(pattern =>
          pattern.subject.termType === 'Variable' ||
          pattern.predicate.termType === 'Variable' ||
          pattern.object.termType === 'Variable'))
            updates[0].updateType = 'deletewhere';
        else
            updates[0].updateType = 'delete';
    } else if (!op.insert && op.where && op.where.type === 'bgp') {
        if (isomorphic(op.delete!, op.where.patterns)) {
            delete updates[0].where;
            updates[0].updateType = 'deletewhere';
        }
    }

    return { prefixes, type: 'update', updates }
}

function translateLoad(op: Algebra.Load, prefixes: Algebra.Prefixes = {}): Update
{
    // Typings are wrong, destiniation is optional
    const updates: [LoadOperation] = [{ type: 'load', silent: Boolean(op.silent), source: op.source } as any];
    if (op.destination)
        updates[0].destination = op.destination;
    return { prefixes, type: 'update', updates }
}

function translateClear(op: Algebra.Clear, prefixes: Algebra.Prefixes = {}): Update
{
    return translateClearCreateDrop(op, 'clear', prefixes);
}

function translateCreate(op: Algebra.Create, prefixes: Algebra.Prefixes = {}): Update
{
    return translateClearCreateDrop(op, 'create', prefixes);
}

function translateDrop(op: Algebra.Drop, prefixes: Algebra.Prefixes = {}): Update
{
    return translateClearCreateDrop(op, 'drop', prefixes);
}

function translateClearCreateDrop(op: Algebra.Clear | Algebra.Create | Algebra.Drop, type: 'clear' | 'create' | 'drop', prefixes: Algebra.Prefixes = {}): Update
{
    const updates: [CreateOperation | ClearDropOperation] = [{ type, silent: Boolean(op.silent) } as any];
    // Typings are wrong, type is not required, see for example "clear-drop" test
    if (op.source === 'DEFAULT')
        updates[0].graph = { default: true } as GraphOrDefault;
    else if (op.source === 'NAMED')
        updates[0].graph = { named: true } as GraphReference;
    else if (op.source === 'ALL')
        updates[0].graph = { all: true } as GraphReference;
    else
        updates[0].graph = { type: 'graph', name: op.source };

    return { prefixes, type: 'update', updates }
}

function translateAdd(op: Algebra.Add, prefixes: Algebra.Prefixes = {}): Update
{
    return translateUpdateGraphShortcut(op, 'add', prefixes);
}

function translateMove(op: Algebra.Move, prefixes: Algebra.Prefixes = {}): Update
{
    return translateUpdateGraphShortcut(op, 'move', prefixes);
}

function translateCopy(op: Algebra.Copy, prefixes: Algebra.Prefixes = {}): Update
{
    return translateUpdateGraphShortcut(op, 'copy', prefixes);
}

function translateUpdateGraphShortcut(op: Algebra.UpdateGraphShortcut, type: 'add' | 'move' | 'copy', prefixes: Algebra.Prefixes = {}): Update
{
    const updates: CopyMoveAddOperation[] = [{ type, silent: Boolean(op.silent) } as any];
    updates[0].source = op.source === 'DEFAULT' ? { type: 'graph', default: true } : { type: 'graph', name: op.source };
    updates[0].destination = op.destination === 'DEFAULT' ? { type: 'graph', default: true } : { type: 'graph', name: op.destination };

    return { prefixes, type: 'update', updates }
}

// similar to removeQuads but more simplified for UPDATEs
function convertUpdatePatterns(patterns: Algebra.Pattern[]): any[]
{
    if (!patterns)
        return [];
    const graphs: { [graph: string]: Algebra.Pattern[] } = {};
    patterns.forEach(pattern =>
    {
        const graph = pattern.graph.value;
        if (!graphs[graph])
            graphs[graph] = [];
        graphs[graph].push(pattern);
    });
    return Object.keys(graphs).map(graph =>
    {
        if (graph === '')
            return { type: 'bgp', triples: graphs[graph].map(translatePattern) };
        return { type: 'graph', triples: graphs[graph].map(translatePattern), name: graphs[graph][0].graph };
    });
}

function removeQuads(op: Algebra.Operation): any
{
    return removeQuadsRecursive(op, {});
}

// remove quads
function removeQuadsRecursive(op: any, graphs: NodeJS.Dict<{ graph: RDF.NamedNode, values: Algebra.Operation[]}>): any
{
    if (Array.isArray(op))
        return op.map(sub => removeQuadsRecursive(sub, graphs));

    if (!op.type)
        return op;

    // UPDATE operations with Patterns handle graphs a bit differently
    if (op.type === types.DELETE_INSERT)
      return op;

    if ((op.type === types.PATTERN || op.type === types.PATH) && op.graph)
    {
        if (!graphs[op.graph.value])
            graphs[op.graph.value] = { graph: op.graph, values: []};
        graphs[op.graph.value]!.values.push(op);
        return op;
    }

    const result: any = {};
    const keyGraphs: {[id: string]: RDF.NamedNode} = {}; // unique graph per key
    const globalNames: {[id: string]: RDF.NamedNode} = {}; // track all the unique graph names for the entire Operation
    for (let key of Object.keys(op))
    {
        const newGraphs: {[id: string]: { graph: RDF.NamedNode, values: Algebra.Operation[]}} = {};
        result[key] = removeQuadsRecursive(op[key], newGraphs);

        const graphNames = Object.keys(newGraphs);

        // create graph statements if multiple graphs are found
        if (graphNames.length > 1)
        {
            // nest joins
            let left: Algebra.Operation = potentialGraphFromPatterns(<Algebra.Pattern[]>newGraphs[graphNames[0]].values);
            for (let i = 1; i < graphNames.length; ++i)
            {
                const right = potentialGraphFromPatterns(<Algebra.Pattern[]>newGraphs[graphNames[i]].values);
                left = factory.createJoin([ left, right ]);
            }
            graphNames.map(name => delete newGraphs[name]);
            // this ignores the result object that is being generated, but should not be a problem
            // is only an issue for objects that have 2 keys where this can occur, which is none
            return left;
        }
        else if (graphNames.length === 1)
        {
            const graph = newGraphs[graphNames[0]].graph;
            keyGraphs[key] = graph;
            globalNames[graph.value] = graph;
        }
    }

    const graphNameSet = Object.keys(globalNames);
    if (graphNameSet.length > 0)
    {
        // also need to create graph statement if we are at the edge of the query
        if (graphNameSet.length === 1 && op.type !== types.PROJECT)
            graphs[graphNameSet[0]] = { graph: globalNames[graphNameSet[0]], values: [result] };
        else
        {
            // multiple graphs (or project), need to create graph objects for them
            for (let key of Object.keys(keyGraphs))
                if (keyGraphs[key].value.length > 0)
                    // TODO: Should check if this cast and graph cast below are correct
                    result[key] = factory.createGraph(result[key], keyGraphs[key]);
        }
    }

    return result;
}

function potentialGraphFromPatterns(patterns: Algebra.Pattern[]): Algebra.Graph | Algebra.Bgp
{
    const bgp = factory.createBgp(patterns);
    const name = patterns[0].graph;
    if (name.value.length === 0)
        return bgp;
    // TODO: not sure about typings here, would have to check in the future
    return factory.createGraph(bgp, name as RDF.NamedNode);
}
