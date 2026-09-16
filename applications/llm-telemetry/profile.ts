/** General LLM telemetry vocabulary. Application data; no kernel domain dispatch. */
export const NS = 'https://foxxi-bridge.interego.xwisee.com/llm-telemetry/';
export const PROFILE = `${NS}profile`;
export const VERSION = `${NS}profile/v1`;
export const META = `${NS}extensions/metadata`;
export const USAGE = `${NS}extensions/usage`;
export const INTENT = `${NS}extensions/intent-sha256`;
export const RELAY_SIGNATURE = 'https://relay.interego.xwisee.com/auth/relay-signature';

export const EVENTS = {
  'session-observed': ['session', 'observed a session', 'An observer saw this session; repeated start/resume observations may coalesce.'],
  'session-ended': ['session', 'observed a session end', 'The runtime explicitly reported that the session ended.'],
  'input-received': ['turn', 'received input', 'A runtime received an input, with its content excluded.'],
  'response-completed': ['turn', 'completed a response', 'The runtime reported that a response turn stopped; not a session end.'],
  interrupted: ['turn', 'observed an interruption', 'The runtime reported an interrupted turn.'],
  'tool-started': ['tool-call', 'started a tool call', 'The runtime observed a tool invocation.'],
  'tool-completed': ['tool-call', 'completed a tool call', 'A tool invocation returned; this alone does not prove its domain outcome.'],
  'tool-failed': ['tool-call', 'observed a tool failure', 'The runtime explicitly reported a failed tool invocation.'],
  'agent-started': ['agent-run', 'started an agent', 'A parent runtime observed a child agent starting.'],
  'agent-stopped': ['agent-run', 'observed an agent stop', 'A parent runtime observed a child agent stopping.'],
  'agent-failed': ['agent-run', 'observed an agent failure', 'A parent runtime explicitly reported an agent failure.'],
  'compaction-started': ['compaction', 'started compaction', 'A runtime began compacting context.'],
  'compaction-completed': ['compaction', 'completed compaction', 'A runtime finished compacting context.'],
  'model-invoked': ['generation', 'invoked a model', 'A provider request began; no request content is included.'],
  'model-completed': ['generation', 'completed a model request', 'A provider request returned; usage is included only when actually reported.'],
  'model-failed': ['generation', 'observed a model failure', 'A provider request explicitly failed.'],
  'handed-off': ['handoff', 'handed off work', 'An observed transfer of work between runtime agents.'],
  'artifact-produced': ['artifact', 'produced an artifact', 'A runtime reported an artifact identifier, without its content or filesystem path.'],
  'feedback-received': ['feedback', 'received feedback', 'A runtime received an explicit rating or outcome signal, without feedback text.'],
} as const;
export type EventKind = keyof typeof EVENTS;

const concept = (id: string, type: string, label: string, definition: string) => ({ id, type, inScheme: VERSION, prefLabel: { en: label }, definition: { en: definition } });
export function telemetryProfile() {
  const templates = Object.entries(EVENTS).map(([kind, [activity, label, definition]]) => ({
    ...concept(`${NS}templates/${kind}`, 'StatementTemplate', label, definition),
    verb: `${NS}verbs/${kind}`, objectActivityType: `${NS}activities/${activity}`,
    rules: [
      { location: '$.context.registration', presence: 'included' },
      { location: '$.context.contextActivities.category[*].id', presence: 'included', all: [VERSION] },
      { location: `$.context.extensions['${META}']`, presence: 'included' },
      { location: '$.timestamp', presence: 'included' },
    ],
  }));
  return {
    '@context': 'https://w3id.org/xapi/profiles/context', id: PROFILE, type: 'Profile',
    conformsTo: 'https://w3id.org/xapi/profiles#1.0',
    prefLabel: { en: 'General LLM telemetry' },
    definition: { en: 'Metadata-only observations of human-assisted and autonomous LLM runtimes, tools and agent teams. The actor is the authenticated observer. Runtime participants, causal identifiers, observation coverage and measured usage are explicit; absent usage is unknown.' },
    author: { type: 'Organization', name: 'Interego', url: 'https://github.com/markjspivey-xwisee/interego' },
    versions: [{ id: VERSION, generatedAtTime: '2026-09-16T00:00:00Z' }],
    concepts: [
      ...Object.entries(EVENTS).map(([kind, [, label, def]]) => concept(`${NS}verbs/${kind}`, 'Verb', label, def)),
      ...[...new Set(Object.values(EVENTS).map(e => e[0]))].map(t => concept(`${NS}activities/${t}`, 'ActivityType', t, `An opaque ${t} activity in an observed LLM runtime.`)),
      { ...concept(META, 'ContextExtension', 'Observation metadata', 'Allowlisted event identifiers, source and actor roles. No message content, reasoning, credentials, arguments, results or filesystem paths.'), inlineSchema: JSON.stringify({ type: 'object', required: ['kind', 'session_id', 'source', 'source_event_id', 'time_basis', 'capture_mode'], properties: { kind: { enum: Object.keys(EVENTS) }, session_id: { type: 'string' }, source: { type: 'string' }, source_event_id: { type: 'string' }, time_basis: { enum: ['source', 'collector'] }, capture_mode: { enum: ['live', 'backfill', 'validation'] } } }) },
      { ...concept(USAGE, 'ResultExtension', 'Measured usage', 'Nonnegative provider-reported token counts or measured duration/cost. Missing quantities are unknown, never implicitly zero.'), inlineSchema: JSON.stringify({ type: 'object', properties: { input_tokens: { type: 'integer', minimum: 0 }, output_tokens: { type: 'integer', minimum: 0 }, cached_input_tokens: { type: 'integer', minimum: 0 }, duration_ms: { type: 'number', minimum: 0 }, cost: { type: 'number', minimum: 0 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } }, additionalProperties: false }) },
      { ...concept(INTENT, 'ContextExtension', 'Event intent digest', 'SHA-256 of canonical normalized event metadata, excluding collector-assigned time. Used to detect a conflicting reuse of a source event identifier.'), inlineSchema: JSON.stringify({ type: 'string', pattern: '^[a-f0-9]{64}$' }) },
    ],
    templates,
    // Observation streams can be partial and unordered. Do not claim complete lifecycle pairs.
    patterns: [{ ...concept(`${NS}patterns/observation-stream`, 'Pattern', 'Observation stream', 'One or more independently valid observations; gaps and ordering are reported separately.'), primary: true, oneOrMore: `${NS}patterns/observation` },
      { ...concept(`${NS}patterns/observation`, 'Pattern', 'Observation', 'One of the declared metadata observation templates.'), alternates: templates.map(t => t.id) }],
  };
}
