/**
 * course-skill-bridge.ts — the convergence between a learning package (course) and
 * an agent skill (skills.md). Both are capability-transfer artifacts; this bridges
 * the two representations:
 *
 *   courseToSkillMd       course knowledge-graph  →  an agent skill (SKILL.md)
 *   skillMdToAgenticCourse   a skills.md          →  a course graph (KG + chat + credentialable)
 *
 * Honesty: the emitted skill is a DISTILLATION of the real course content (concept
 * labels + the top slide excerpt per concept), explicitly labelled as a projection
 * that points back at the authoritative course holon — nothing is fabricated.
 */
import type { FoxxiAgenticCourse } from './agentic-rag.js';
import type { ManifestCourseResult } from './course-graph.js';

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill';
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const humanize = (s: string): string => s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());

export interface SkillProvenance {
  /** display name of the tool/agent that produced the source course. */
  tool?: string;
  /** the agent/author DID, if known. */
  authoredBy?: string;
  /** the course KG holon URI (authoritative source). */
  holonUri?: string;
  courseId?: string;
}

/** Project a course knowledge-graph into an agent skill (SKILL.md text). */
export function courseToSkillMd(course: FoxxiAgenticCourse, prov: SkillProvenance = {}): { skillMd: string; name: string } {
  const name = slug(course.title || course.courseId);
  // Sanitize any interpolated text to a single line + strip leading markdown control chars
  // so course content can't inject frontmatter delimiters, headings, or list structure.
  const inl = (s: string): string => oneLine(String(s ?? '')).replace(/^[#>\-*`|]+\s*/, '').slice(0, 400);
  const safeTitle = inl(course.title) || course.courseId;
  const conceptLabels = course.concepts.map(c => inl(c.label)).filter(Boolean);
  const description = oneLine(
    `Capability distilled from the "${safeTitle}" course knowledge-graph — ${conceptLabels.length} concept(s)`
    + (prov.tool ? `, authored with ${prov.tool}` : '') + '.',
  );

  // The top slide excerpt per concept = the real knowledge the skill conveys.
  const slideById = new Map(course.slides.map(s => [s.id, s]));
  const knowledge: string[] = [];
  for (const c of course.concepts.slice(0, 30)) {
    const sid = c.taught_in_slides[0];
    const slide = sid ? slideById.get(sid) : undefined;
    const excerpt = oneLine(slide?.transcript_combined ?? '').slice(0, 360);
    knowledge.push(`- **${inl(c.label)}**${excerpt ? ` — ${excerpt}` : ''}`);
  }

  const provLines: string[] = [];
  if (prov.courseId) provLines.push(`- course: \`${prov.courseId}\``);
  if (prov.tool) provLines.push(`- authoring tool: ${prov.tool}`);
  if (prov.authoredBy) provLines.push(`- authored by: \`${prov.authoredBy}\``);
  if (prov.holonUri) provLines.push(`- authoritative source (course KG holon): \`${prov.holonUri}\``);

  const skillMd =
`---
name: ${name}
description: ${description}
---

# ${safeTitle}

> Projected from a Foxxi course knowledge-graph for an agent to load. This is a
> procedural distillation; the course holon remains the authoritative source of truth
> (assessment, sequencing, and credentialing live there, not here).

## What you'll be able to do
${conceptLabels.length ? conceptLabels.map(l => `- ${l}`).join('\n') : '- (no concepts extracted)'}

## Key knowledge (from the course content)
${knowledge.join('\n')}
${provLines.length ? `\n## Provenance\n${provLines.join('\n')}\n` : ''}`;

  return { skillMd, name };
}

export interface ParsedSkill { name: string; description: string; sections: Array<{ heading: string; body: string }>; }

/** Parse a SKILL.md (frontmatter name/description + `## ` sections). */
export function parseSkillMd(md: string): ParsedSkill {
  let name = '', description = '', body = md;
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (fm) {
    const front = fm[1]; body = fm[2];
    // [ \t] (not \s) around the value so an EMPTY field can't swallow the next line; (.*) allows ''.
    name = oneLine((front.match(/^[ \t]*name:[ \t]*(.*)$/m) ?? [, ''])[1]).replace(/^["']|["']$/g, '');
    description = oneLine((front.match(/^[ \t]*description:[ \t]*(.*)$/m) ?? [, ''])[1]).replace(/^["']|["']$/g, '');
  }
  // strip a LEADING `# Title` only (anchored to the start — never a mid-document `# ` line).
  body = body.replace(/^\s*#\s+.+(\r?\n|$)/, '').trim();
  // Mask fenced code blocks (keeping offsets) so `## ` INSIDE a fence isn't read as a heading.
  const scan = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, m => m.replace(/[^\n]/g, ' '));
  const sections: Array<{ heading: string; body: string }> = [];
  const re = /^##\s+(.+)$/gm;
  const heads: Array<{ heading: string; index: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(scan)) !== null) heads.push({ heading: oneLine(m[1]), index: m.index + m[0].length, end: m.index });
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index;
    const stop = i + 1 < heads.length ? heads[i + 1].end : body.length;
    sections.push({ heading: heads[i].heading, body: oneLine(body.slice(start, stop)) }); // slice the ORIGINAL body (keeps code)
  }
  if (sections.length === 0 && body.trim()) sections.push({ heading: name || 'Overview', body: oneLine(body).slice(0, 4000) });
  return { name, description, sections };
}

/** Ingest a skills.md as a course graph (each `## ` section → a concept + a slide). */
export function skillMdToAgenticCourse(md: string, opts: { courseIri: string; authoritativeSource: string }): ManifestCourseResult & { parsed: ParsedSkill } {
  const parsed = parseSkillMd(md);
  const title = parsed.name || 'Agent skill';
  const concepts: FoxxiAgenticCourse['concepts'][number][] = [];
  const slides: FoxxiAgenticCourse['slides'][number][] = [];
  const seen = new Set<string>();
  parsed.sections.forEach((sec, i) => {
    // Per-section id: include the index when the heading has no [a-z0-9] (so symbol/emoji
    // headings don't all collapse onto the 'skill' fallback and merge unrelated sections).
    const cid = /[a-z0-9]/i.test(sec.heading) ? slug(sec.heading) : `section-${i}`;
    const sid = `${cid}-${i}`;
    const transcript = `${sec.heading}. ${sec.body}`.trim() || sec.heading;
    slides.push({ id: sid, title: sec.heading, sequence_index: i, concept_ids: [cid], transcript_combined: transcript });
    if (!seen.has(cid)) { seen.add(cid); concepts.push({ id: cid, label: sec.heading, confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: [sid], total_freq: 1 }); }
    else { const c = concepts.find(x => x.id === cid); if (c) (c.taught_in_slides as string[]).push(sid); }
  });
  // The skill NAME is the overall capability — add it as a top concept spanning every
  // slide so subject-level questions (not just per-section ones) ground against it. Use a
  // RESERVED id so it can never collide with (and get dropped by) a section heading slug.
  const capLabel = humanize(parsed.name || title);
  const capId = `cap-${slug(capLabel)}`;
  if (capLabel) {
    concepts.unshift({ id: capId, label: capLabel, confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: slides.map(s => s.id), total_freq: slides.length });
    for (const s of slides) (s.concept_ids as string[]).push(capId); // keep the back-reference consistent
  }
  if (concepts.length === 0) concepts.push({ id: slug(title), label: title, confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: [], total_freq: 0 });

  const course: FoxxiAgenticCourse = {
    courseIri: opts.courseIri, title, courseLabel: title, courseId: slug(title),
    authoritativeSource: opts.authoritativeSource, concepts, slides, modifier_pairs: [], prereq_edges: [],
  };
  const spineTerms = [title, parsed.description, ...concepts.map(c => c.label)].filter((t, i, a) => t && a.indexOf(t) === i).slice(0, 200);
  return {
    course, spineTerms, parsed,
    structure: { courseId: slug(title), courseTitle: title, activityCount: parsed.sections.length, items: parsed.sections.map((s, i) => ({ id: `${slug(s.heading)}-${i}`, title: s.heading })), topics: concepts.map(c => c.label), fileCount: 1 },
  };
}
