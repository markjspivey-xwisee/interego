/**
 * @module pgsl/tools
 * @description LLM tool interface for PGSL lattice queries.
 *
 * Defines tools the LLM can call to query the PGSL lattice,
 * and a dispatch loop for CLI-based tool calling.
 *
 * Tools:
 *   sparql_query    — Execute SPARQL against the lattice triple store
 *   lookup_entity   — Find all facts/relations about an entity
 *   count_items     — Structural counting via lattice query
 *   temporal_query  — Date arithmetic using extracted temporal facts
 *   validate_shacl  — Run SHACL validation on the lattice
 *
 * The LLM outputs XML-tagged tool calls:
 *   <tool_call>{"name": "sparql_query", "arguments": {"query": "..."}}</tool_call>
 *
 * The runner parses, executes, and re-prompts until final answer.
 */

import type { PGSLInstance } from './types.js';
import type { TripleStore } from './sparql-engine.js';
import { executeSparqlString } from './sparql-engine.js';
import { validateAllPGSL } from './shacl.js';
import type { ShaclShapeDefinition } from './shacl.js';
import { parseDate, dateDifference, countUnique } from './computation.js';

// ── Types ──────────────────────────────────────────────────

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

export interface ToolCall {
  readonly name: string;
  readonly arguments: Record<string, string>;
}

export interface ToolResult {
  readonly name: string;
  readonly result: string;
  readonly error?: string;
}

export interface ToolContext {
  readonly pgsl: PGSLInstance;
  readonly tripleStore: TripleStore;
  readonly domainShapes?: ShaclShapeDefinition[];
  /** Session texts for entity lookup context */
  readonly sessionTexts?: string[];
  /** Session dates for temporal queries */
  readonly sessionDates?: string[];
  /** Question date for temporal queries */
  readonly questionDate?: string;
}

// ── Tool Definitions ───────────────────────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'sparql_query',
    description: 'Execute a SPARQL query against the PGSL lattice triple store. Returns JSON bindings. Use PREFIX pgsl: <https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#> for PGSL classes/properties. Available classes: pgsl:Atom, pgsl:Fragment. Properties: pgsl:value, pgsl:level, pgsl:height, pgsl:item, pgsl:leftConstituent, pgsl:rightConstituent, pgsl:overlap.',
    parameters: {
      query: { type: 'string', description: 'SPARQL query string', required: true },
    },
  },
  {
    name: 'lookup_entity',
    description: 'Find all facts and relations about a specific entity in the lattice. Returns atoms containing the entity name and their containing fragments.',
    parameters: {
      entity: { type: 'string', description: 'Entity name to look up', required: true },
    },
  },
  {
    name: 'count_items',
    description: 'Count unique items matching a category/description across all sessions. Uses structural deduplication to avoid double-counting.',
    parameters: {
      category: { type: 'string', description: 'What to count (e.g., "Korean restaurants", "musical instruments")', required: true },
    },
  },
  {
    name: 'temporal_query',
    description: 'Find temporal information about an event. Can compute date differences, ordering, and relative timing. Returns dates and computed differences.',
    parameters: {
      event: { type: 'string', description: 'Event or activity to find dates for', required: true },
      reference_date: { type: 'string', description: 'Optional reference date (YYYY-MM-DD or natural language)', required: false },
    },
  },
  {
    name: 'validate_shacl',
    description: 'Run SHACL validation on the PGSL lattice. Returns conformance report with any violations.',
    parameters: {
      layer: { type: 'string', description: 'Validation layer: "core", "structural", "domain", or "all" (default: "all")', required: false },
    },
  },
];

export function getToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS;
}

// ── Tool Implementations ───────────────────────────────────

function executeTool(ctx: ToolContext, call: ToolCall): ToolResult {
  try {
    switch (call.name) {
      case 'sparql_query':
        return executeSparqlTool(ctx, call.arguments);
      case 'lookup_entity':
        return executeLookupEntity(ctx, call.arguments);
      case 'count_items':
        return executeCountItems(ctx, call.arguments);
      case 'temporal_query':
        return executeTemporalQuery(ctx, call.arguments);
      case 'validate_shacl':
        return executeValidateShacl(ctx, call.arguments);
      default:
        return { name: call.name, result: '', error: `Unknown tool: ${call.name}` };
    }
  } catch (e) {
    return { name: call.name, result: '', error: `Tool error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function executeSparqlTool(ctx: ToolContext, args: Record<string, string>): ToolResult {
  const query = args['query'];
  if (!query) return { name: 'sparql_query', result: '', error: 'Missing query parameter' };

  const result = executeSparqlString(ctx.tripleStore, query);

  if (result.boolean !== undefined) {
    return { name: 'sparql_query', result: JSON.stringify({ boolean: result.boolean }) };
  }

  // Convert Map bindings to plain objects for JSON
  const rows = result.bindings.map(b => Object.fromEntries(b));
  return { name: 'sparql_query', result: JSON.stringify({ bindings: rows, count: rows.length }) };
}

function executeLookupEntity(ctx: ToolContext, args: Record<string, string>): ToolResult {
  const entity = args['entity'];
  if (!entity) return { name: 'lookup_entity', result: '', error: 'Missing entity parameter' };

  const entityLower = entity.toLowerCase();

  // Find atoms whose values contain the entity
  const matchingAtoms: Array<{ uri: string; value: string }> = [];
  for (const node of ctx.pgsl.nodes.values()) {
    if (node.kind === 'Atom' && String(node.value).toLowerCase().includes(entityLower)) {
      matchingAtoms.push({ uri: node.uri, value: String(node.value) });
    }
  }

  // Find fragments containing those atoms
  const containingFragments: Array<{ uri: string; level: number; items: string[] }> = [];
  const atomUris = new Set(matchingAtoms.map(a => a.uri));
  for (const node of ctx.pgsl.nodes.values()) {
    if (node.kind === 'Fragment') {
      const frag = node as any;
      if (frag.items.some((i: string) => atomUris.has(i))) {
        // Resolve item values for readability
        const itemValues = frag.items.map((i: string) => {
          const n = ctx.pgsl.nodes.get(i as any);
          return n?.kind === 'Atom' ? String((n as any).value) : i;
        });
        containingFragments.push({ uri: frag.uri, level: frag.level, items: itemValues });
      }
    }
  }

  // Also search session texts directly
  const sessionMatches: string[] = [];
  if (ctx.sessionTexts) {
    for (let i = 0; i < ctx.sessionTexts.length; i++) {
      const text = ctx.sessionTexts[i]!;
      if (text.toLowerCase().includes(entityLower)) {
        // Extract relevant sentences
        const sentences = text.split(/[.!?]+/).filter(s => s.toLowerCase().includes(entityLower));
        for (const s of sentences.slice(0, 5)) {
          sessionMatches.push(`Session ${i + 1}: ${s.trim()}`);
        }
      }
    }
  }

  return {
    name: 'lookup_entity',
    result: JSON.stringify({
      entity,
      atoms: matchingAtoms.slice(0, 20),
      fragments: containingFragments.slice(0, 10),
      sessionMatches: sessionMatches.slice(0, 10),
    }),
  };
}

function executeCountItems(ctx: ToolContext, args: Record<string, string>): ToolResult {
  const category = args['category'];
  if (!category) return { name: 'count_items', result: '', error: 'Missing category parameter' };

  const categoryLower = category.toLowerCase();
  const keywords = categoryLower.split(/\s+/).filter(w => w.length > 2);

  // Find atoms matching the category
  const matches: string[] = [];
  for (const node of ctx.pgsl.nodes.values()) {
    if (node.kind === 'Atom') {
      const val = String(node.value).toLowerCase();
      if (keywords.some(kw => val.includes(kw))) {
        matches.push(String(node.value));
      }
    }
  }

  // Also search session texts for explicit items
  const sessionItems: string[] = [];
  if (ctx.sessionTexts) {
    for (const text of ctx.sessionTexts) {
      const sentences = text.split(/[.!?]+/);
      for (const s of sentences) {
        if (keywords.some(kw => s.toLowerCase().includes(kw))) {
          sessionItems.push(s.trim());
        }
      }
    }
  }

  const unique = countUnique([...matches, ...sessionItems]);

  return {
    name: 'count_items',
    result: JSON.stringify({
      category,
      count: unique.count,
      uniqueItems: unique.unique.slice(0, 20),
      duplicates: unique.duplicates.slice(0, 10),
    }),
  };
}

function executeTemporalQuery(ctx: ToolContext, args: Record<string, string>): ToolResult {
  const event = args['event'];
  if (!event) return { name: 'temporal_query', result: '', error: 'Missing event parameter' };

  const refDateStr = args['reference_date'] ?? ctx.questionDate;
  const refDate = refDateStr ? parseDate(refDateStr) : null;

  // Find date-related atoms
  const dateAtoms: Array<{ value: string; date: Date | null }> = [];
  for (const node of ctx.pgsl.nodes.values()) {
    if (node.kind === 'Atom') {
      const val = String(node.value);
      const parsed = parseDate(val);
      if (parsed) dateAtoms.push({ value: val, date: parsed });
    }
  }

  // Find event mentions in session texts with nearby dates
  const eventDates: Array<{ context: string; date: string; sessionIndex: number }> = [];
  if (ctx.sessionTexts) {
    const eventLower = event.toLowerCase();
    for (let i = 0; i < ctx.sessionTexts.length; i++) {
      const text = ctx.sessionTexts[i]!;
      if (text.toLowerCase().includes(eventLower)) {
        // Find dates in the same session
        const dateMatches = text.match(/\d{4}\/\d{2}\/\d{2}|\w+ \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
        for (const dm of dateMatches) {
          const idx = text.indexOf(dm);
          const context = text.slice(Math.max(0, idx - 80), Math.min(text.length, idx + dm.length + 80));
          eventDates.push({ context: context.trim(), date: dm, sessionIndex: i + 1 });
        }
        // Also include session date
        if (ctx.sessionDates?.[i]) {
          eventDates.push({
            context: `Session ${i + 1} date`,
            date: ctx.sessionDates[i]!,
            sessionIndex: i + 1,
          });
        }
      }
    }
  }

  // Compute date differences if we have reference
  const computedDiffs: Array<{ from: string; to: string; days: number; weeks: number; months: number }> = [];
  if (refDate) {
    for (const ed of eventDates) {
      const parsed = parseDate(ed.date);
      if (parsed) {
        const diff = dateDifference(parsed, refDate);
        computedDiffs.push({
          from: ed.date,
          to: refDateStr!,
          days: diff.days,
          weeks: diff.weeks,
          months: diff.months,
        });
      }
    }
  }

  return {
    name: 'temporal_query',
    result: JSON.stringify({
      event,
      referenceDate: refDateStr ?? 'none',
      eventDates: eventDates.slice(0, 10),
      computedDifferences: computedDiffs.slice(0, 5),
      latticeDataAtoms: dateAtoms.length,
    }),
  };
}

function executeValidateShacl(ctx: ToolContext, _args: Record<string, string>): ToolResult {
  const result = validateAllPGSL(ctx.pgsl, ctx.domainShapes);

  const summary = {
    conforms: result.conforms,
    totalViolations: result.violations.length,
    violations: result.violations.slice(0, 20).map(v => ({
      node: v.node,
      shape: v.shape,
      path: v.path,
      message: v.message,
      severity: v.severity,
    })),
  };

  return { name: 'validate_shacl', result: JSON.stringify(summary) };
}

// ── Tool Call Parsing ──────────────────────────────────────

const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

/**
 * Parse tool calls from LLM output.
 * Returns all tool calls found in the text.
 */
export function parseToolCalls(llmOutput: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let match;
  TOOL_CALL_RE.lastIndex = 0;
  while ((match = TOOL_CALL_RE.exec(llmOutput)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!.trim());
      if (parsed.name && parsed.arguments) {
        calls.push({ name: parsed.name, arguments: parsed.arguments });
      }
    } catch {
      // Skip malformed tool calls
    }
  }
  return calls;
}

/**
 * Execute a tool call and return the result.
 */
export function executeToolCall(ctx: ToolContext, call: ToolCall): ToolResult {
  return executeTool(ctx, call);
}

// ── Tool Prompt Formatting ─────────────────────────────────

/**
 * Format tool definitions for inclusion in the LLM prompt.
 */
export function formatToolPrompt(tools: ToolDefinition[]): string {
  const lines = ['You have the following tools available to query the knowledge lattice:'];
  lines.push('');
  for (const tool of tools) {
    lines.push(`### ${tool.name}`);
    lines.push(tool.description);
    lines.push('Parameters:');
    for (const [name, param] of Object.entries(tool.parameters)) {
      lines.push(`  - ${name} (${param.type}${param.required ? ', required' : ', optional'}): ${param.description}`);
    }
    lines.push('');
  }
  lines.push('To use a tool, output:');
  lines.push('<tool_call>{"name": "tool_name", "arguments": {"param": "value"}}</tool_call>');
  lines.push('');
  lines.push('You can call multiple tools. After receiving tool results, answer the question.');
  lines.push('If you can answer directly without tools, just give the answer.');
  return lines.join('\n');
}

/**
 * Format a tool result for inclusion in the LLM prompt.
 */
export function formatToolResult(result: ToolResult): string {
  if (result.error) {
    return `<tool_result>{"name": "${result.name}", "error": "${result.error}"}</tool_result>`;
  }
  return `<tool_result>{"name": "${result.name}", "result": ${result.result}}</tool_result>`;
}

// ── Multi-Turn Tool Loop ───────────────────────────────────

/**
 * Run a multi-turn tool calling loop.
 *
 * 1. Send initial prompt with tool definitions + question
 * 2. Parse tool calls from LLM output
 * 3. Execute tools, append results
 * 4. Re-prompt until LLM gives a final answer (no tool calls)
 *
 * @param ctx - Tool execution context
 * @param question - The question to answer
 * @param scaffolding - Structural analysis scaffolding
 * @param sessionText - Full session text for the LLM
 * @param llmCall - Function to call the LLM
 * @param maxTurns - Maximum tool calling rounds (default 3)
 */
export function runToolLoop(
  ctx: ToolContext,
  question: string,
  scaffolding: string,
  sessionText: string,
  llmCall: (prompt: string) => string,
  maxTurns: number = 3,
): string {
  const toolPrompt = formatToolPrompt(getToolDefinitions());

  // Initial prompt
  let prompt = `${scaffolding}\n\n${toolPrompt}\n\n${sessionText}\n\nQuestion: ${question}\n\nIMPORTANT: If the SPECIFIC thing asked about is NOT mentioned in any session, respond EXACTLY: "The information provided is not enough to answer this question."\n\nUse tools if needed, or answer directly. Be SPECIFIC and CONCISE. Give ONLY the answer.`;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = llmCall(prompt);
    if (!response) return '';

    // Parse tool calls
    const calls = parseToolCalls(response);

    if (calls.length === 0) {
      // No tool calls — this is the final answer
      // Strip any remaining XML tags
      return response.replace(/<\/?tool_(?:call|result)>/g, '').trim();
    }

    // Execute all tool calls
    const results: ToolResult[] = [];
    for (const call of calls) {
      results.push(executeToolCall(ctx, call));
    }

    // Build continuation prompt with results
    const resultText = results.map(r => formatToolResult(r)).join('\n');
    prompt = `${prompt}\n\nAssistant: ${response}\n\n${resultText}\n\nNow answer the question based on the tool results. Be SPECIFIC and CONCISE. Give ONLY the answer.`;
  }

  // Max turns exceeded — do a final LLM call without tools
  const finalResponse = llmCall(`${prompt}\n\nPlease give your final answer now.`);
  return finalResponse?.replace(/<\/?tool_(?:call|result)>/g, '').trim() ?? '';
}
