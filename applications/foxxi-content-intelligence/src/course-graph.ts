/**
 * course-graph.ts — turn a parsed SCORM manifest (+ optional extracted page text)
 * into a FoxxiAgenticCourse: the concept/slide graph the existing agentic-RAG
 * retrieval (agentic-rag.ts) reasons over, and the spine terms the PGSL lattice
 * composes as the course knowledge-graph.
 *
 * Composition, not reinvention: we DERIVE the graph from the real manifest —
 * topic folders among the resource <file> hrefs become concepts, the content
 * pages become slides, and (where the page bytes are supplied) their visible
 * text becomes the slide transcript that grounds answers. Prerequisite edges are
 * a STRUCTURAL HEURISTIC (confidence 0.5): when an activity declares imsss
 * pre-condition rules we gate it behind its immediately preceding sibling — a
 * likely order the manifest IMPLIES, not a resolved rule target. Activities with
 * no pre-conditions get no edges; we don't invent an order the manifest is silent on.
 */
import { parseManifest, type ScormActivityTree, type Activity } from './scorm-sequencing.js';
import type { FoxxiAgenticCourse } from './agentic-rag.js';

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';

function humanize(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '').split(/[\\/]/).pop() ?? name;
  return base
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An agent-authored course (as stored by /agent/scorm/author): SCOs with body text
 *  + optional assessment. We have the structured course directly, so we build the
 *  graph from it (each SCO is a concept + a slide) rather than round-tripping a manifest. */
export interface AgentScormCourseLike {
  courseId: string;
  title?: string;
  masteryScore?: number;
  authoredBy?: string;
  scos: Array<{ id: string; title?: string; body?: string; assessment?: Array<{ question: string; answer?: string }> }>;
}

export function agentScormToAgenticCourse(course: AgentScormCourseLike, opts: { courseIri: string; authoritativeSource: string }): ManifestCourseResult {
  const title = course.title || course.courseId;
  const concepts: FoxxiAgenticCourse['concepts'][number][] = [];
  const slides: FoxxiAgenticCourse['slides'][number][] = [];
  const seen = new Set<string>();
  course.scos.forEach((s, i) => {
    const cid = slug(s.title || s.id);
    const sid = slug(s.id || `sco-${i}`);
    const qs = (s.assessment ?? []).map(a => a.question).filter(Boolean);
    const transcript = [s.body ?? '', qs.length ? `Assessment questions: ${qs.join(' ')}` : ''].filter(Boolean).join(' ').trim() || (s.title || s.id);
    slides.push({ id: sid, title: s.title || s.id, sequence_index: i, concept_ids: [cid], transcript_combined: transcript });
    if (!seen.has(cid)) {
      seen.add(cid);
      concepts.push({ id: cid, label: s.title || s.id, confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: [sid], total_freq: 1 });
    } else {
      const c = concepts.find(x => x.id === cid); if (c) (c.taught_in_slides as string[]).push(sid);
    }
  });
  const built: FoxxiAgenticCourse = {
    courseIri: opts.courseIri, title, courseLabel: title, courseId: course.courseId,
    authoritativeSource: opts.authoritativeSource, concepts, slides, modifier_pairs: [], prereq_edges: [],
  };
  const spineTerms = [title, ...concepts.map(c => c.label)].filter((t, i, a) => t && a.indexOf(t) === i).slice(0, 200);
  return {
    course: built, spineTerms,
    structure: { courseId: course.courseId, courseTitle: title, activityCount: course.scos.length, items: course.scos.map(s => ({ id: s.id, title: s.title || s.id })), topics: concepts.map(c => c.label), fileCount: course.scos.length },
  };
}

/** Pull every <file href="..."> out of the manifest (the resource file list). */
export function extractFileHrefs(manifestXml: string): string[] {
  const out: string[] = [];
  for (const m of manifestXml.matchAll(/<file\s+href="([^"]+)"/gi)) out.push(m[1]);
  return out;
}

const CONTENT_RE = /\.html?$/i;
const NONCONTENT = /(^|\/)(shared|common|lib|js|css|assets|images?|img|fonts?|meta|scormdriver)\//i;
const TEMPLATE_RE = /(launchpage|assessmenttemplate|index|story|goodbye|player)\.html?$/i;

export interface ManifestToCourseArgs {
  manifestXml: string;
  /** full file list (from a browser-side unzip); falls back to manifest <file href>. */
  fileList?: string[];
  /** path -> page text (or raw HTML; HTML is stripped). Grounds slide transcripts. */
  fileText?: Record<string, string>;
  courseIri: string;
  authoritativeSource: string;
}

export interface ManifestCourseResult {
  course: FoxxiAgenticCourse;
  /** spine terms for the PGSL lattice (course label + concept labels + slide titles). */
  spineTerms: string[];
  /** structural summary for display. */
  structure: {
    courseId: string;
    courseTitle: string;
    activityCount: number;
    items: Array<{ id: string; title: string; href?: string }>;
    topics: string[];
    fileCount: number;
  };
}

/**
 * Build the course graph. Concepts = topic folders (+ activity items); slides =
 * content pages; transcript = extracted page text where available, else the page
 * title (honest: sparse when only the manifest is supplied).
 */
export function manifestToAgenticCourse(args: ManifestToCourseArgs): ManifestCourseResult {
  let tree: ScormActivityTree | null = null;
  try { tree = parseManifest(args.manifestXml); } catch { tree = null; }
  const courseId = tree?.courseId || 'course';
  const courseTitle = tree?.courseTitle || 'Course';
  const items: Activity[] = tree ? tree.preorder.filter(a => a.href || a.children.length === 0) : [];

  const files = (args.fileList && args.fileList.length ? args.fileList : extractFileHrefs(args.manifestXml))
    .map(f => f.replace(/^\.?\//, ''));
  const contentFiles = files.filter(f => CONTENT_RE.test(f) && !NONCONTENT.test(f) && !TEMPLATE_RE.test(f));

  // Topics = first path segment of each content file (folder), excluding non-content folders.
  const topicOf = (path: string): string | null => {
    const parts = path.split('/');
    if (parts.length < 2) return null;
    const top = parts[0];
    if (/^(shared|common|lib|js|css|assets|images?|img|fonts?|meta)$/i.test(top)) return null;
    return top;
  };
  const topicOrder: string[] = [];
  const topicSlides = new Map<string, string[]>();

  const slides: FoxxiAgenticCourse['slides'][number][] = [];
  let seq = 0;
  for (const path of contentFiles) {
    const topic = topicOf(path);
    const sid = slug(path);
    const rawText = args.fileText?.[path] ?? args.fileText?.[path.replace(/^\.?\//, '')] ?? '';
    const text = /<[a-z!][^>]*>/i.test(rawText) ? stripHtml(rawText) : rawText.trim();
    const title = humanize(path);
    const conceptIds = topic ? [slug(topic)] : [];
    slides.push({ id: sid, title, sequence_index: seq++, concept_ids: conceptIds, transcript_combined: text || title });
    if (topic) {
      if (!topicSlides.has(topic)) { topicSlides.set(topic, []); topicOrder.push(topic); }
      topicSlides.get(topic)!.push(sid);
    }
  }

  // Concepts: one per topic folder, plus any activity item titles not already a topic.
  const concepts: FoxxiAgenticCourse['concepts'][number][] = [];
  const seenConcept = new Set<string>();
  for (const topic of topicOrder) {
    const id = slug(topic);
    if (seenConcept.has(id)) continue;
    seenConcept.add(id);
    concepts.push({ id, label: humanize(topic), confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: topicSlides.get(topic) ?? [], total_freq: (topicSlides.get(topic) ?? []).length });
  }
  for (const it of items) {
    const id = slug(it.title || it.id);
    if (!it.title || seenConcept.has(id)) continue;
    seenConcept.add(id);
    concepts.push({ id, label: it.title, confidence: 0.8, tier: 2, is_free_standing: false, taught_in_slides: [], total_freq: 1 });
  }
  // If there were no topic folders (single-SCO/flat), fall back to the course title as one concept.
  if (concepts.length === 0) {
    concepts.push({ id: slug(courseTitle), label: courseTitle, confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: slides.map(s => s.id), total_freq: slides.length });
    // Replace the element rather than casting away readonly to mutate it: the array
    // is local and mutable, only the element properties are readonly, and nothing
    // aliases these slide objects yet.
    slides.forEach((s, i) => { slides[i] = { ...s, concept_ids: [slug(courseTitle)] }; });
  }

  // Prereq edges (structural heuristic, conf 0.5): an activity that DECLARES imsss
  // pre-condition rules is gated behind its immediately preceding sibling. This is a
  // likely order the manifest implies — NOT the rule's resolved target objective — so
  // it carries low confidence. No pre-conditions ⇒ no edge (we don't invent an order).
  const prereq_edges: FoxxiAgenticCourse['prereq_edges'][number][] = [];
  if (tree) {
    for (const a of tree.preorder) {
      const hasPre = a.sequencing?.preConditionRules?.length;
      if (hasPre && a.parent) {
        const sib = a.parent.children;
        const idx = sib.indexOf(a);
        if (idx > 0) prereq_edges.push({ from: slug(sib[idx - 1].title || sib[idx - 1].id), to: slug(a.title || a.id), confidence: 0.5 });
      }
    }
  }

  const course: FoxxiAgenticCourse = {
    courseIri: args.courseIri,
    title: courseTitle,
    courseLabel: courseTitle,
    courseId,
    authoritativeSource: args.authoritativeSource,
    concepts,
    slides,
    modifier_pairs: [],
    prereq_edges,
  };

  const spineTerms = [
    courseTitle,
    ...concepts.map(c => c.label),
    ...slides.map(s => s.title),
  ].filter((t, i, a) => t && a.indexOf(t) === i).slice(0, 200);

  return {
    course,
    spineTerms,
    structure: {
      courseId, courseTitle,
      activityCount: tree?.preorder.length ?? 0,
      items: items.slice(0, 50).map(a => ({ id: a.id, title: a.title, href: a.href })),
      topics: topicOrder,
      fileCount: files.length,
    },
  };
}
