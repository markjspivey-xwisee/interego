import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPGSL,
  ingest,
  materializeTriples,
  getToolDefinitions,
  parseToolCalls,
  executeToolCall,
  formatToolPrompt,
  formatToolResult,
  runToolLoop,
} from '../src/index.js';
import type { PGSLInstance, ToolContext, ToolCall } from '../src/index.js';
import type { IRI } from '../src/model/types.js';

describe('PGSL LLM Tools', () => {
  let pgsl: PGSLInstance;
  let ctx: ToolContext;

  beforeEach(() => {
    pgsl = createPGSL({
      wasAttributedTo: 'urn:test:agent' as IRI,
      generatedAtTime: '2026-01-01T00:00:00Z',
    });
    ingest(pgsl, ['the', 'cat', 'sat', 'on', 'the', 'mat']);
    const tripleStore = materializeTriples(pgsl);
    ctx = {
      pgsl,
      tripleStore,
      sessionTexts: ['The cat sat on the mat. It was a sunny day.'],
      sessionDates: ['2023/01/15 (Sun) 10:00'],
      questionDate: '2023/02/01',
    };
  });

  describe('Tool Definitions', () => {
    it('returns 5 tool definitions', () => {
      const tools = getToolDefinitions();
      expect(tools.length).toBe(5);
      expect(tools.map(t => t.name)).toEqual([
        'sparql_query', 'lookup_entity', 'count_items', 'temporal_query', 'validate_shacl',
      ]);
    });

    it('each tool has name, description, and parameters', () => {
      const tools = getToolDefinitions();
      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters).toBeTruthy();
      }
    });
  });

  describe('Tool Call Parsing', () => {
    it('parses single tool call', () => {
      const output = 'Let me query the lattice.\n<tool_call>{"name": "sparql_query", "arguments": {"query": "SELECT ?x WHERE { ?x a pgsl:Atom }"}}</tool_call>';
      const calls = parseToolCalls(output);
      expect(calls.length).toBe(1);
      expect(calls[0]!.name).toBe('sparql_query');
      expect(calls[0]!.arguments['query']).toContain('SELECT');
    });

    it('parses multiple tool calls', () => {
      const output = '<tool_call>{"name": "lookup_entity", "arguments": {"entity": "cat"}}</tool_call>\n<tool_call>{"name": "count_items", "arguments": {"category": "animals"}}</tool_call>';
      const calls = parseToolCalls(output);
      expect(calls.length).toBe(2);
    });

    it('returns empty for no tool calls', () => {
      const calls = parseToolCalls('Just a regular answer with no tools.');
      expect(calls.length).toBe(0);
    });

    it('skips malformed JSON', () => {
      const calls = parseToolCalls('<tool_call>not json</tool_call>');
      expect(calls.length).toBe(0);
    });
  });

  describe('Tool Execution', () => {
    it('sparql_query executes and returns bindings', () => {
      const call: ToolCall = {
        name: 'sparql_query',
        arguments: {
          query: 'PREFIX pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#> SELECT ?atom WHERE { ?atom a pgsl:Atom }',
        },
      };
      const result = executeToolCall(ctx, call);
      expect(result.name).toBe('sparql_query');
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.count).toBeGreaterThan(0);
    });

    it('lookup_entity finds matching atoms', () => {
      const call: ToolCall = {
        name: 'lookup_entity',
        arguments: { entity: 'cat' },
      };
      const result = executeToolCall(ctx, call);
      const parsed = JSON.parse(result.result);
      expect(parsed.entity).toBe('cat');
      expect(parsed.atoms.length).toBeGreaterThan(0);
    });

    it('lookup_entity searches session texts', () => {
      const call: ToolCall = {
        name: 'lookup_entity',
        arguments: { entity: 'sunny' },
      };
      const result = executeToolCall(ctx, call);
      const parsed = JSON.parse(result.result);
      expect(parsed.sessionMatches.length).toBeGreaterThan(0);
    });

    it('count_items counts matching items', () => {
      const call: ToolCall = {
        name: 'count_items',
        arguments: { category: 'cat' },
      };
      const result = executeToolCall(ctx, call);
      const parsed = JSON.parse(result.result);
      expect(parsed.count).toBeGreaterThan(0);
    });

    it('temporal_query finds dates and computes differences', () => {
      const call: ToolCall = {
        name: 'temporal_query',
        arguments: { event: 'cat', reference_date: '2023-02-01' },
      };
      const result = executeToolCall(ctx, call);
      const parsed = JSON.parse(result.result);
      expect(parsed.event).toBe('cat');
      expect(parsed.referenceDate).toBeTruthy();
    });

    it('validate_shacl returns conformance report', () => {
      const call: ToolCall = {
        name: 'validate_shacl',
        arguments: {},
      };
      const result = executeToolCall(ctx, call);
      const parsed = JSON.parse(result.result);
      expect(parsed.conforms).toBe(true);
    });

    it('unknown tool returns error', () => {
      const call: ToolCall = {
        name: 'nonexistent_tool',
        arguments: {},
      };
      const result = executeToolCall(ctx, call);
      expect(result.error).toContain('Unknown tool');
    });
  });

  describe('Tool Prompt Formatting', () => {
    it('formats tool definitions as readable text', () => {
      const prompt = formatToolPrompt(getToolDefinitions());
      expect(prompt).toContain('sparql_query');
      expect(prompt).toContain('lookup_entity');
      expect(prompt).toContain('<tool_call>');
    });

    it('formats tool results with JSON', () => {
      const result = formatToolResult({
        name: 'test',
        result: '{"count": 3}',
      });
      expect(result).toContain('tool_result');
      expect(result).toContain('count');
    });

    it('formats error results', () => {
      const result = formatToolResult({
        name: 'test',
        result: '',
        error: 'Something went wrong',
      });
      expect(result).toContain('error');
    });
  });

  describe('Tool Loop', () => {
    it('returns direct answer when LLM does not use tools', () => {
      const mockLlm = (_prompt: string) => 'The answer is 42.';
      const answer = runToolLoop(ctx, 'What is the answer?', '', '', mockLlm);
      expect(answer).toBe('The answer is 42.');
    });

    it('executes tool call and re-prompts', () => {
      let callCount = 0;
      const mockLlm = (_prompt: string) => {
        callCount++;
        if (callCount === 1) {
          return '<tool_call>{"name": "lookup_entity", "arguments": {"entity": "cat"}}</tool_call>';
        }
        return 'The cat was found in the session.';
      };
      const answer = runToolLoop(ctx, 'What about the cat?', '', '', mockLlm);
      expect(answer).toBe('The cat was found in the session.');
      expect(callCount).toBe(2);
    });

    it('respects maxTurns', () => {
      let callCount = 0;
      const mockLlm = (_prompt: string) => {
        callCount++;
        return '<tool_call>{"name": "lookup_entity", "arguments": {"entity": "cat"}}</tool_call>';
      };
      // maxTurns=2, plus 1 final call = 3 total
      runToolLoop(ctx, 'Loop forever?', '', '', mockLlm, 2);
      expect(callCount).toBe(3); // 2 turns + 1 final
    });
  });
});
