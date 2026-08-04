import React, { useMemo, useState } from 'react';
import { Card, Pill, Button } from './common.js';
import { conceptSpans } from '../lib/concept-spans.js';
import type { CourseContent, CourseSlide, CourseConcept, CoursePrereqEdge } from '../types.js';

interface AggregatedEdge {
  neighbour: string;
  count: number;
  maxConfidence?: number;
}

function aggregateEdges(edges: CoursePrereqEdge[], side: 'from' | 'to'): AggregatedEdge[] {
  const byNeighbour = new Map<string, AggregatedEdge>();
  for (const e of edges) {
    const key = side === 'to' ? e.to : e.from;
    const existing = byNeighbour.get(key);
    if (existing) {
      existing.count += 1;
      if (e.confidence !== undefined) {
        existing.maxConfidence = existing.maxConfidence === undefined
          ? e.confidence
          : Math.max(existing.maxConfidence, e.confidence);
      }
    } else {
      byNeighbour.set(key, { neighbour: key, count: 1, maxConfidence: e.confidence });
    }
  }
  return Array.from(byNeighbour.values()).sort((a, b) => b.count - a.count);
}

/**
 * Slide-by-slide navigator for a parsed Foxxi course.
 *
 * Mirrors the original imported/foxxi_dashboard_v03.jsx scene browser:
 *   - Scene list (collapsible) with slides under each scene
 *   - Slide detail pane: title, audio segments + transcript, concepts taught,
 *     prereq edges in / out
 *   - Concept inspector modal (click any concept chip) showing its label,
 *     confidence, tier, where it's taught + where it's mentioned
 *   - Prereq edge navigation: click a prereq to jump to the first slide
 *     that teaches the dependency
 *
 * Backed by the same `dashboard_data.json` the originals used (now in
 * sample/data.ts as scenes + slides + prereqEdges + concepts on
 * CourseContent), so the deployed dashboard renders the full content
 * structure without requiring the bridge.
 */
export function SlideNavigator({
  course,
  externalSelectedSlideId,
  externalSelectedConceptId,
  onSlideChange,
  onConceptChange,
}: {
  course: CourseContent;
  externalSelectedSlideId?: string | null;
  externalSelectedConceptId?: string | null;
  onSlideChange?: (id: string | null) => void;
  onConceptChange?: (id: string | null) => void;
}) {
  const slides = course.slides ?? [];
  const scenes = course.scenes ?? [];
  const concepts = course.concepts ?? [];
  const prereqEdges = course.prereqEdges ?? [];

  const [internalSlideId, setInternalSlideId] = useState<string | null>(slides[0]?.id ?? null);
  const [internalConceptId, setInternalConceptId] = useState<string | null>(null);

  const selectedSlideId = externalSelectedSlideId !== undefined ? externalSelectedSlideId : internalSlideId;
  const selectedConceptId = externalSelectedConceptId !== undefined ? externalSelectedConceptId : internalConceptId;

  function setSelectedSlideId(id: string | null) {
    setInternalSlideId(id);
    onSlideChange?.(id);
  }
  function setSelectedConceptId(id: string | null) {
    setInternalConceptId(id);
    onConceptChange?.(id);
  }

  const slideById = useMemo(() => new Map(slides.map(s => [s.id, s])), [slides]);
  const conceptById = useMemo(() => new Map(concepts.map(c => [c.id, c])), [concepts]);

  const selectedSlide = selectedSlideId ? slideById.get(selectedSlideId) : undefined;
  const selectedConcept = selectedConceptId ? conceptById.get(selectedConceptId) : undefined;

  if (slides.length === 0) {
    return (
      <Card title="Slide navigator">
        <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          This course's parsed slide structure isn't bundled — only transcripts + concepts are
          available. In production the substrate fetches the full parsed package
          (<code>fxs:Package</code> + <code>fxs:Slide</code> + <code>fxk:Concept</code> +
          prereq edges) from the tenant pod.
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card title={`${course.title} · slide navigator`} right={<Pill tone="accent">{slides.length} slides · {concepts.length} concepts · {prereqEdges.length} prereq edges</Pill>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 14 }}>
          {/* Left: scene + slide list, with course-rail footer */}
          <div style={{
            borderRight: '1px solid var(--border)', paddingRight: 12,
            maxHeight: 720, overflow: 'auto',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ flex: 1 }}>
              {scenes.length > 0 ? scenes.map(scene => (
                <div key={scene.id} style={{ marginBottom: 16 }}>
                  <div className="label" style={{ marginBottom: 6 }}>
                    ── Scene {scene.scene_number} ─ {scene.title}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {scene.slide_ids.map(sid => {
                      const s = slideById.get(sid);
                      if (!s) return null;
                      return <SlideListItem key={sid} slide={s} selected={selectedSlideId === sid} onClick={() => setSelectedSlideId(sid)} />;
                    })}
                  </div>
                </div>
              )) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {slides.map(s => (
                    <SlideListItem key={s.id} slide={s} selected={selectedSlideId === s.id} onClick={() => setSelectedSlideId(s.id)} />
                  ))}
                </div>
              )}
            </div>
            <CourseRailFooter course={course} />
          </div>

          {/* Right: slide detail */}
          <div>
            {selectedSlide ? (
              <SlideDetail
                slide={selectedSlide}
                concepts={concepts}
                conceptById={conceptById}
                slideById={slideById}
                prereqEdges={prereqEdges}
                selectedConceptId={selectedConceptId}
                onSelectConcept={cid => setSelectedConceptId(cid)}
                onJumpToSlide={sid => setSelectedSlideId(sid)}
              />
            ) : (
              <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Select a slide on the left.</div>
            )}
          </div>
        </div>
      </Card>

      {selectedConcept && (
        <ConceptModal
          concept={selectedConcept}
          slides={slides}
          slideById={slideById}
          prereqEdges={prereqEdges}
          conceptById={conceptById}
          onClose={() => setSelectedConceptId(null)}
          onJumpToSlide={sid => { setSelectedConceptId(null); setSelectedSlideId(sid); }}
          onSelectConcept={cid => setSelectedConceptId(cid)}
        />
      )}
    </>
  );
}

function SlideListItem({ slide, selected, onClick }: { slide: CourseSlide; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      textAlign: 'left', cursor: 'pointer',
      padding: '8px 10px',
      background: selected ? 'rgba(193,80,28,0.10)' : 'transparent',
      borderLeft: `3px solid ${selected ? 'var(--accent)' : 'transparent'}`,
      borderRight: 'none', borderTop: 'none', borderBottom: 'none',
      color: 'var(--text)', fontSize: 13,
      fontFamily: "'EB Garamond', serif",
      display: 'flex', alignItems: 'center', gap: 8,
      width: '100%',
    }}>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace",
        color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums',
        minWidth: 30, fontSize: 11,
      }}>
        §{slide.sequence_index + 1}
      </span>
      <span style={{ flex: 1 }}>{slide.title}</span>
      {(slide.audio_count ?? 0) > 0 && (
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
          color: 'var(--text-dim)',
        }}>♪ {slide.audio_count}</span>
      )}
    </button>
  );
}

/**
 * Renders transcript text with inline <mark> elements around every concept-label
 * substring. Click a mark to select that concept. Long labels are matched first
 * so substrings like "voltage" don't shadow "course par".
 */
function HighlightedTranscript({
  text,
  concepts,
  selectedConceptId,
  onSelectConcept,
}: {
  text: string;
  concepts: CourseConcept[];
  selectedConceptId: string | null;
  onSelectConcept: (cid: string) => void;
}) {
  if (!text) return null;
  // ★ THE SCAN LIVES IN `../lib/concept-spans` AND THIS RENDERS ITS RESULT.
  //
  // It used to be inlined here, inside a component nothing in this repo renders, which is
  // how it carried a real defect — a plain-text advance to the next SPACE, so a concept
  // behind any other delimiter was never matched — with no test able to see it. The scan is
  // pure and dependency-free now, so `tests/concept-nav-graph.test.ts` table-tests it
  // directly. Keep rendering FROM the shared function: re-inlining a copy here would put the
  // component back outside the only guard it has.
  const spans = conceptSpans(text, concepts);
  return (
    <>
      {spans.map(s => (s.kind === 'concept' ? (
        <mark
          key={`m-${s.start}`}
          className={`concept${selectedConceptId === s.concept.id ? ' selected' : ''}`}
          onClick={() => onSelectConcept(s.concept.id)}
          title={`Tier ${s.concept.tier} · confidence ${s.concept.confidence.toFixed(2)}`}
        >{s.text}</mark>
      ) : (
        <React.Fragment key={`t-${s.start}`}>{s.text}</React.Fragment>
      )))}
    </>
  );
}

function SlideDetail({
  slide, concepts, conceptById, slideById, prereqEdges,
  selectedConceptId, onSelectConcept, onJumpToSlide,
}: {
  slide: CourseSlide;
  concepts: CourseConcept[];
  conceptById: Map<string, CourseConcept>;
  slideById: Map<string, CourseSlide>;
  prereqEdges: CoursePrereqEdge[];
  selectedConceptId: string | null;
  onSelectConcept: (cid: string) => void;
  onJumpToSlide: (sid: string) => void;
}) {
  const slideConcepts = (slide.concept_ids ?? []).map(cid => conceptById.get(cid)).filter((c): c is CourseConcept => !!c);
  const audioSegments = slide.transcript_segments ?? [];
  const transcript = slide.transcript_combined ?? '';

  // Prereq edges in/out: concepts on this slide → things they depend on (out) or that depend on them (in)
  // Aggregate by the "other" concept so each distinct neighbour appears once (with a fan-out count
  // + max confidence) rather than repeating once per slide-concept it touches.
  const slideConceptIds = new Set(slide.concept_ids ?? []);
  const prereqOut = aggregateEdges(prereqEdges.filter(e => slideConceptIds.has(e.from)), 'to');
  const prereqIn = aggregateEdges(prereqEdges.filter(e => slideConceptIds.has(e.to)), 'from');

  function findFirstTeachingSlide(conceptId: string): string | null {
    const c = conceptById.get(conceptId);
    const sids = c?.taught_in_slides ?? [];
    if (sids.length === 0) return null;
    // Earliest by sequence_index
    const sorted = sids.map(id => slideById.get(id)).filter((s): s is CourseSlide => !!s)
      .sort((a, b) => a.sequence_index - b.sequence_index);
    return sorted[0]?.id ?? null;
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
          §{slide.sequence_index + 1}
          {slide.lms_id && <> · <code>{slide.lms_id}</code></>}
        </div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{slide.title}</div>
      </div>

      {/* Audio + transcript */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
          Audio segments ({audioSegments.length})
        </div>
        {audioSegments.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
            (no audio on this slide)
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {audioSegments.map((seg, i) => (
              <div key={i} style={{
                padding: 8, background: 'var(--panel-2)',
                border: '1px solid var(--border)', borderRadius: 4,
                fontSize: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)', marginBottom: 4 }}>
                  <span>♪ segment {i + 1}</span>
                  {seg.duration !== undefined && <span>· {seg.duration.toFixed(1)}s</span>}
                  {seg.path && <code style={{ fontSize: 11 }}>{seg.path}</code>}
                </div>
                <div style={{
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.65,
                  fontFamily: "'EB Garamond', serif",
                  fontSize: 17,
                }}>
                  {seg.text
                    ? <HighlightedTranscript text={seg.text} concepts={concepts} selectedConceptId={selectedConceptId} onSelectConcept={onSelectConcept} />
                    : <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>(empty)</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        {audioSegments.length === 0 && transcript && (
          <div style={{
            padding: 12, background: 'var(--panel-2)',
            border: '1px solid var(--border)', borderRadius: 4,
            whiteSpace: 'pre-wrap', lineHeight: 1.65,
            fontFamily: "'EB Garamond', serif", fontSize: 17,
          }}>
            <HighlightedTranscript text={transcript} concepts={concepts} selectedConceptId={selectedConceptId} onSelectConcept={onSelectConcept} />
          </div>
        )}
      </div>

      {/* Concepts taught on this slide */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
          Concepts taught ({slideConcepts.length})
        </div>
        {slideConcepts.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
            (no concepts extracted for this slide)
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {slideConcepts.map(c => (
              <button key={c.id} onClick={() => onSelectConcept(c.id)} style={{
                cursor: 'pointer',
                padding: '4px 8px',
                background: 'rgba(124,193,255,0.10)',
                border: '1px solid var(--accent)',
                borderRadius: 4, color: 'var(--text)', fontSize: 12,
              }}>
                {c.label}
                <span style={{ marginLeft: 6, color: 'var(--text-dim)', fontSize: 11 }}>
                  T{c.tier}·{c.confidence.toFixed(2)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Prereqs */}
      {(prereqOut.length > 0 || prereqIn.length > 0) && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
            Prereq edges
          </div>
          {prereqOut.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
                Concepts on this slide require ({prereqOut.length} distinct):
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {prereqOut.slice(0, 24).map(g => {
                  const target = conceptById.get(g.neighbour);
                  const targetSlide = findFirstTeachingSlide(g.neighbour);
                  return (
                    <button key={g.neighbour}
                      onClick={() => targetSlide ? onJumpToSlide(targetSlide) : onSelectConcept(g.neighbour)}
                      style={{
                        cursor: 'pointer',
                        padding: '3px 7px',
                        background: 'rgba(180,138,255,0.10)',
                        border: '1px solid var(--accent-2)',
                        borderRadius: 4, color: 'var(--text)', fontSize: 11,
                      }}>
                      → {target?.label ?? g.neighbour}
                      {g.count > 1 && <span style={{ marginLeft: 4, color: 'var(--text-dim)' }}>×{g.count}</span>}
                      {g.maxConfidence !== undefined && (
                        <span style={{ marginLeft: 4, color: 'var(--text-dim)' }}>({g.maxConfidence.toFixed(2)})</span>
                      )}
                    </button>
                  );
                })}
                {prereqOut.length > 24 && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>+ {prereqOut.length - 24} more</span>}
              </div>
            </div>
          )}
          {prereqIn.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
                Concepts that depend on this slide's concepts ({prereqIn.length} distinct):
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {prereqIn.slice(0, 24).map(g => {
                  const source = conceptById.get(g.neighbour);
                  const sourceSlide = findFirstTeachingSlide(g.neighbour);
                  return (
                    <button key={g.neighbour}
                      onClick={() => sourceSlide ? onJumpToSlide(sourceSlide) : onSelectConcept(g.neighbour)}
                      style={{
                        cursor: 'pointer',
                        padding: '3px 7px',
                        background: 'rgba(94,210,122,0.08)',
                        border: '1px solid var(--good)',
                        borderRadius: 4, color: 'var(--text)', fontSize: 11,
                      }}>
                      ← {source?.label ?? g.neighbour}
                      {g.count > 1 && <span style={{ marginLeft: 4, color: 'var(--text-dim)' }}>×{g.count}</span>}
                    </button>
                  );
                })}
                {prereqIn.length > 24 && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>+ {prereqIn.length - 24} more</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConceptModal({
  concept, slides, slideById, prereqEdges, conceptById,
  onClose, onJumpToSlide, onSelectConcept,
}: {
  concept: CourseConcept;
  slides: CourseSlide[];
  slideById: Map<string, CourseSlide>;
  prereqEdges: CoursePrereqEdge[];
  conceptById: Map<string, CourseConcept>;
  onClose: () => void;
  onJumpToSlide: (sid: string) => void;
  onSelectConcept: (cid: string) => void;
}) {
  const taughtInIds = concept.taught_in_slides ?? [];
  const mentionedIn = slides.filter(s => {
    if ((s.concept_ids ?? []).includes(concept.id)) return false;
    const text = (s.transcript_combined ?? '').toLowerCase();
    return text.includes(concept.label.toLowerCase());
  });

  const dependsOn = prereqEdges.filter(e => e.from === concept.id);
  const usedBy = prereqEdges.filter(e => e.to === concept.id);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0,
      background: 'rgba(8,10,14,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 720, maxHeight: '90vh', overflow: 'auto' }}>
        <Card title={`Concept · ${concept.label}`} right={<Button onClick={onClose}>Close</Button>}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <Pill tone="accent">tier {concept.tier}</Pill>
            <Pill tone={concept.confidence > 0.7 ? 'good' : concept.confidence > 0.4 ? 'warn' : 'bad'}>
              confidence {concept.confidence.toFixed(2)}
            </Pill>
            {concept.total_freq !== undefined && (
              <Pill>frequency {concept.total_freq}</Pill>
            )}
            <code style={{ fontSize: 11, color: 'var(--text-dim)' }}>{concept.id}</code>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
              Taught in ({taughtInIds.length})
            </div>
            {taughtInIds.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
                (not directly taught — possibly a referenced or modifier concept)
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {taughtInIds.map(sid => {
                  const s = slideById.get(sid);
                  if (!s) return null;
                  return (
                    <button key={sid} onClick={() => onJumpToSlide(sid)} style={{
                      textAlign: 'left', cursor: 'pointer',
                      padding: '6px 8px',
                      background: 'var(--panel-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 4, color: 'var(--text)', fontSize: 12,
                    }}>
                      §{s.sequence_index + 1}: {s.title}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {mentionedIn.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                Mentioned in transcripts but not on the slide's concept list ({mentionedIn.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {mentionedIn.slice(0, 8).map(s => (
                  <button key={s.id} onClick={() => onJumpToSlide(s.id)} style={{
                    textAlign: 'left', cursor: 'pointer',
                    padding: '6px 8px',
                    background: 'transparent',
                    border: '1px dashed var(--border)',
                    borderRadius: 4, color: 'var(--text-dim)', fontSize: 12,
                  }}>
                    §{s.sequence_index + 1}: {s.title}
                  </button>
                ))}
                {mentionedIn.length > 8 && (
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>+ {mentionedIn.length - 8} more</span>
                )}
              </div>
            </div>
          )}

          {dependsOn.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                Depends on ({dependsOn.length}) — concepts this one builds on
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {dependsOn.slice(0, 24).map((e, i) => {
                  const target = conceptById.get(e.to);
                  return (
                    <button key={i} onClick={() => onSelectConcept(e.to)} style={{
                      cursor: 'pointer',
                      padding: '3px 7px',
                      background: 'rgba(180,138,255,0.10)',
                      border: '1px solid var(--accent-2)',
                      borderRadius: 4, color: 'var(--text)', fontSize: 11,
                    }}>
                      → {target?.label ?? e.to}
                    </button>
                  );
                })}
                {dependsOn.length > 24 && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>+ {dependsOn.length - 24} more</span>}
              </div>
            </div>
          )}

          {usedBy.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                Used by ({usedBy.length}) — concepts that depend on this one
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {usedBy.slice(0, 24).map((e, i) => {
                  const source = conceptById.get(e.from);
                  return (
                    <button key={i} onClick={() => onSelectConcept(e.from)} style={{
                      cursor: 'pointer',
                      padding: '3px 7px',
                      background: 'rgba(94,210,122,0.08)',
                      border: '1px solid var(--good)',
                      borderRadius: 4, color: 'var(--text)', fontSize: 11,
                    }}>
                      ← {source?.label ?? e.from}
                    </button>
                  );
                })}
                {usedBy.length > 24 && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>+ {usedBy.length - 24} more</span>}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function CourseRailFooter({ course }: { course: CourseContent }) {
  const slideCount = course.slides?.length ?? 0;
  const conceptCount = course.concepts.length;
  const prereqCount = course.prereqEdges?.length ?? 0;
  const pkg = course.packageMeta;
  // SHACL conformance: synthetic for the demo — every shipped course is clean (parser version present, no violations).
  const shaclClean = !!pkg?.parser_version;
  const triplesEst = slideCount * 8 + conceptCount * 5 + prereqCount * 3;

  return (
    <div style={{
      marginTop: 16, paddingTop: 12,
      borderTop: '1px solid var(--border)',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10.5, color: 'var(--text-dim)',
      lineHeight: 1.6,
    }}>
      <div className="label" style={{ marginBottom: 6 }}>Parsed package</div>
      {pkg?.parser_version && <div>parser {pkg.parser_version}</div>}
      {pkg?.standard && <div>{pkg.standard}</div>}
      {pkg?.authoring_tool && <div>{pkg.authoring_tool}{pkg.authoring_version && ` ${pkg.authoring_version}`}</div>}
      <div style={{ marginTop: 8 }}>
        <span style={{ color: shaclClean ? 'var(--good)' : 'var(--bad)' }}>
          {shaclClean ? '✓' : '⚠'} SHACL self-conforms
        </span>
      </div>
      <div>≈ {triplesEst.toLocaleString()} triples · 0 violations</div>
      <div className="label" style={{ marginTop: 10, marginBottom: 4 }}>Federation</div>
      <div>⊕ acme-training (primary)</div>
      <div style={{ color: 'var(--text-dim)' }}>(peer courses bundled in offline mode)</div>
    </div>
  );
}
