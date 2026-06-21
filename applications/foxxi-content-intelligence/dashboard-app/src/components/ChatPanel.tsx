import React, { useState } from 'react';
import { Card, Button, TextInput, Pill } from './common.js';
import { LlmSettingsDialog } from './LlmSettings.js';
import { askCourseQuestionAgentic, type AskAgenticResult, type AgenticCoursePayload } from '../interego/client.js';
import { loadLlmSettings, saveLlmSettings, type LlmMode } from '../auth/llm-settings.js';
import { useAffordance, useHypermedia, invokeAffordance } from '../hypermedia.js';
import type { CourseContent } from '../types.js';

interface ChatTurn {
  question: string;
  result: AskAgenticResult;
  at: string;
}

const EXEMPLAR_QUESTIONS = [
  'What is handicap?',
  'How does the golf develop the handicap reference?',
  'Explain difficult lie recovery in simple terms.',
  'How do voltage and current relate in this lesson?',
  'What are the prerequisites for understanding golf etiquette overview?',
];

/**
 * Adapt the sample-mode FoxxiCourseContent (transcripts + concepts) to
 * the agentic payload (packageMeta + slides + edges). For the sample
 * golf-explained we synthesize one slide per transcript so the agentic
 * pipeline has slides to cite; the production deployment passes the
 * full Foxxi-parsed payload (with real slides + prereq edges).
 */
function courseContentToAgenticPayload(c: CourseContent): AgenticCoursePayload {
  const slides = Object.entries(c.transcripts).map(([path, t], i) => ({
    id: `synthetic:${path}`,
    title: `Audio segment ${i + 1}`,
    sequence_index: i,
    concept_ids: [] as string[],
    transcript_combined: t.text,
  }));
  const concepts = c.concepts.map(co => {
    const lower = co.label.toLowerCase();
    const taughtIn = slides.filter(s => s.transcript_combined.toLowerCase().includes(lower)).map(s => s.id);
    return {
      id: co.id, label: co.label, confidence: co.confidence, tier: co.tier,
      taught_in_slides: taughtIn,
    };
  });
  const slidesWithConcepts = slides.map(s => ({
    ...s,
    concept_ids: concepts.filter(co => co.taught_in_slides.includes(s.id)).map(co => co.id),
  }));
  const courseId = c.courseIri.split('/').pop()?.replace(/#.*/, '') ?? 'unknown';
  return {
    packageMeta: {
      course_id: courseId,
      course_label: c.title.replace(/:.*/, '').trim(),
      title: c.title,
      federation_iri_base: c.courseIri.replace(/#.*/, ''),
    },
    concepts,
    slides: slidesWithConcepts,
    modifier_pairs: [],
    prereq_edges: [],
  };
}

export function ChatPanel(props: {
  learnerDid: string;
  course: CourseContent;
}) {
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [llm, setLlm] = useState(loadLlmSettings());

  const affordance = useAffordance('foxxi.ask_course_question_agentic');
  const { bearer } = useHypermedia();

  async function ask() {
    if (!question.trim() || loading) return;
    setLoading(true); setError(null);
    try {
      const primary = courseContentToAgenticPayload(props.course);
      const histPayload = history.flatMap(t => [
        { role: 'user' as const, content: t.question },
        { role: 'assistant' as const, content: t.result.synthesizedAnswer ?? '(retrieval-only — no LLM synthesis)' },
      ]);
      const argsBase: Record<string, unknown> = {
        learner_did: props.learnerDid,
        question: question.trim(),
        primary,
        federation: [],
        history: histPayload,
      };
      if (llm.mode === 'byok' && llm.byokKey) argsBase.llm_api_key = llm.byokKey;
      if (llm.llmModel) argsBase.llm_model = llm.llmModel;

      const result = affordance
        ? (await invokeAffordance({ affordance, bearer, args: argsBase })) as AskAgenticResult
        : await askCourseQuestionAgentic({
            learnerDid: props.learnerDid,
            question: question.trim(),
            primary,
            history: histPayload,
            mode: llm.mode,
            byokKey: llm.byokKey,
            llmModel: llm.llmModel,
          });
      setHistory(h => [...h, { question: question.trim(), result, at: new Date().toISOString() }]);
      setQuestion('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const llmPill = llmModeChip(llm.mode);
  const toolName = affordance ? `affordance: ${affordance.rel}` : 'foxxi.ask_course_question_agentic (sample)';

  return (
    <Card
      title="Ask the course (agentic RAG)"
      right={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Pill tone={llmPill.tone}>{llmPill.label}</Pill>
          <Pill tone="accent">{toolName}</Pill>
          <Button onClick={() => setSettingsOpen(true)}>LLM ⚙</Button>
        </div>
      }
    >
      {settingsOpen && (
        <LlmSettingsDialog
          current={llm}
          onSave={s => { saveLlmSettings(s); setLlm(s); }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <div style={{ marginBottom: 16, color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.55 }}>
        Multi-step agentic retrieval: federated concept-graph search → prereq + modifier-of edge expansion
        → round-robin slide allocation → optional LLM synthesis. Two LLM modes (configure via the
        ⚙ button): <strong>bridge-env</strong> (bridge has its own key) or <strong>byok</strong> (paste
        your Anthropic key here, used per-request). Each step emits an Interego descriptor
        (modal-statused, supersedes-chained) so the auditor walks the trace from the final answer
        back to the original question.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <TextInput
          value={question}
          onChange={setQuestion}
          placeholder="e.g., what is handicap?"
          onSubmit={ask}
        />
        <Button primary onClick={ask} disabled={loading || !question.trim()}>
          {loading ? 'Asking…' : 'Ask'}
        </Button>
      </div>

      {error && <div style={{ color: 'var(--bad)', fontSize: 13, marginBottom: 16 }}>✗ {error}</div>}

      {loading && (
        <div style={{
          padding: 14, marginBottom: 14,
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          borderRadius: 6, fontSize: 14,
          fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          Traversing the graph
          <span className="foxxi-dots" aria-hidden="true">
            <span>·</span><span>·</span><span>·</span>
          </span>
        </div>
      )}

      {history.length === 0 && !loading && (
        <div style={{ marginTop: 4 }}>
          <div style={{
            fontFamily: "'EB Garamond', serif", fontSize: 15,
            color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: 10,
          }}>
            Ask anything about the course content. The agent traverses the parsed concept
            graph, expands prereq + modifier-of edges, allocates slides round-robin across
            primary + federated peer courses, and synthesises with verbatim transcript citations.
          </div>
          <div className="label" style={{ marginBottom: 6 }}>Exemplar questions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {EXEMPLAR_QUESTIONS.map((q, i) => (
              <button key={i} onClick={() => setQuestion(q)} style={{
                textAlign: 'left', cursor: 'pointer',
                padding: '8px 12px',
                background: 'var(--panel-2)',
                border: '1px solid var(--border)',
                borderLeft: '3px solid var(--accent)',
                borderRadius: 4,
                fontFamily: "'EB Garamond', serif",
                fontSize: 15, color: 'var(--text)',
              }}>"{q}"</button>
            ))}
          </div>
        </div>
      )}

      {history.slice().reverse().map((turn, i) => (
        <TurnView key={i} turn={turn} />
      ))}
    </Card>
  );
}

function llmModeChip(mode: LlmMode): { label: string; tone: 'accent' | 'good' } {
  if (mode === 'bridge-env') return { label: 'mode: bridge-env', tone: 'accent' };
  return { label: 'mode: byok', tone: 'good' };
}

function TurnView({ turn }: { turn: ChatTurn }) {
  const r = turn.result;
  return (
    <div style={{
      marginBottom: 14, padding: 12,
      background: 'var(--panel-2)', borderRadius: 6,
      border: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>
        You asked · <code>{new Date(turn.at).toLocaleTimeString()}</code>
      </div>
      <div style={{ marginBottom: 12, fontStyle: 'italic' }}>{turn.question}</div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <Pill tone={r.retrieval.retrievalKind === 'graph' ? 'good' : 'warn'}>
          retrieval: {r.retrieval.retrievalKind}
        </Pill>
        <Pill tone="accent">{r.retrieval.seedConcepts.length} seed concept{r.retrieval.seedConcepts.length === 1 ? '' : 's'}</Pill>
        <Pill tone="accent">{r.retrieval.expandedConcepts.length} expanded</Pill>
        <Pill tone="accent">{r.retrieval.citedSlides.length} cited slide{r.retrieval.citedSlides.length === 1 ? '' : 's'}</Pill>
        <Pill tone={r.synthesizedAnswer ? 'good' : 'neutral'}>
          llm: {r.llmModel}
        </Pill>
        {r.llmKeySource && r.llmKeySource !== 'none' && (
          <Pill tone="good">
            key: {r.llmKeySource}
          </Pill>
        )}
      </div>

      {/* Synthesized prose (when LLM is configured) */}
      {r.synthesizedAnswer && (
        <div style={{
          padding: 12, marginBottom: 12,
          background: 'var(--panel)', borderRadius: 6,
          borderLeft: '3px solid var(--good)',
          whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6,
        }}>
          {r.synthesizedAnswer}
        </div>
      )}
      {!r.synthesizedAnswer && (
        <div style={{
          padding: 10, marginBottom: 12,
          background: 'rgba(255,177,85,0.08)',
          border: '1px solid rgba(255,177,85,0.3)',
          borderRadius: 6, fontSize: 13,
        }}>
          <Pill tone="warn">no llm synthesis</Pill>{' '}
          The bridge isn't configured with an Anthropic API key (or the dashboard is in offline-sample
          mode). The substrate returned the retrieval scaffold + descriptor trace alone — the cited
          slide transcripts below are still authoritative and verbatim.
        </div>
      )}

      {/* Retrieval breadcrumbs */}
      <details open style={{ marginBottom: 12 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12, marginBottom: 8 }}>
          Retrieval breadcrumbs · {r.retrieval.contributingCourseIds.join(', ') || '(no contributors)'}
        </summary>
        <div style={{ marginTop: 8 }}>
          {r.retrieval.seedConcepts.length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              <strong>Seed concepts:</strong>{' '}
              {r.retrieval.seedConcepts.map((s, k) => (
                <span key={k} style={{ marginRight: 8 }}>
                  <code>{s.conceptLabel}</code>
                  <span style={{ color: 'var(--text-dim)' }}>
                    {' '}({s.course.courseLabel}, score {s.score.toFixed(1)})
                  </span>
                </span>
              ))}
            </div>
          )}
          {r.retrieval.citedSlides.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>
                Cited slides (verbatim transcripts — substrate ground truth):
              </div>
              {r.retrieval.citedSlides.map((cs, k) => (
                <div key={k} style={{
                  marginBottom: 8, padding: 10,
                  background: 'var(--panel)', borderRadius: 6,
                  borderLeft: '3px solid var(--accent)',
                }}>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
                    [{cs.course.courseLabel}] §{cs.sequenceIndex + 1}: <strong>{cs.slideTitle}</strong>
                    {' · '}
                    <code style={{ wordBreak: 'break-all' }}>{cs.course.courseId}:{cs.slideId}</code>
                  </div>
                  <div style={{ fontSize: 13 }}>
                    "{cs.transcriptCombined.length > 360
                      ? cs.transcriptCombined.slice(0, 360) + '…'
                      : cs.transcriptCombined}"
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </details>

      {/* Interego trace */}
      <details>
        <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12 }}>
          Interego trace · {r.trace.length} descriptor{r.trace.length === 1 ? '' : 's'} (modal-statused, supersedes-chained)
        </summary>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {r.trace.map((step, k) => (
            <div key={k} style={{
              padding: 8, background: 'var(--panel)', borderRadius: 4,
              border: '1px solid var(--border)', fontSize: 11, fontFamily: 'monospace',
            }}>
              <div style={{ marginBottom: 4 }}>
                <Pill tone={step.modalStatus === 'Asserted' ? 'good' : 'warn'}>{step.modalStatus}</Pill>{' '}
                <strong>{step.type}</strong>
              </div>
              <div style={{ color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                {step.iri}
              </div>
              {step.wasDerivedFrom.length > 0 && (
                <div style={{ color: 'var(--text-dim)', marginTop: 2 }}>
                  prov:wasDerivedFrom → {step.wasDerivedFrom.map(d => d.split(':').slice(-2).join(':')).join(', ')}
                </div>
              )}
              {step.supersedes && (
                <div style={{ color: 'var(--text-dim)', marginTop: 2 }}>
                  iep:supersedes → {step.supersedes.split(':').slice(-2).join(':')}
                </div>
              )}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

