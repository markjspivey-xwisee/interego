/**
 * "Ask your course": a question about an authored course, answered from the course's own sections
 * and the I2IDL Digital Learning Glossary, decorated with I2IDL-X.
 *
 * ★ NO MODEL, NO GUESS. The answer is assembled, not generated: the I2IDL terms the question names
 * (found by I2IDL-X's surface forms), what I2IDL says each one means, where the course covers it, and
 * the sections whose words overlap the question's. The same question about the same course and
 * glossary release gets the same answer, and every part of it says where it came from.
 *
 * ★ WHAT'S WHOSE, PER FIELD. A definition, a label and its sources are I2IDL's; the provenance
 * wording and the reuse class are I2IDL-X · derived (computed from I2IDL's evidence); a referent
 * category or an enactment is I2IDL-X · proposed (Hypothetical until reviewers ratify); a section is
 * the course author's. A definition whose direct sources do not allow commercial reuse is not
 * quoted (i2idl-glossary.ts).
 *
 * ★ NEVER THE ANSWERS. Only a section's title and body are read. An assessment's questions, and the
 * hashes the engine grades them by, are not part of an answer.
 */
import {
  I2IDL_GLOSSARY_URL, I2IDLX_GRAPHS, PROVENANCE_WORDING, REUSE, i2idlCardUrl,
  type GlossarySources, type I2idlConcept, type ReuseClass,
} from './i2idl-glossary.js';

export interface AskableSection { readonly id: string; readonly title: string; readonly body: string }
export interface AskableCourse { readonly courseId: string; readonly title: string; readonly scos: readonly AskableSection[] }

export type Origin = 'I2IDL' | 'I2IDL-X · derived' | 'I2IDL-X · proposed' | 'Course';

export interface SectionHit {
  readonly id: string;
  readonly title: string;
  readonly href?: string;
  readonly snippet: string;
  /** The I2IDL terms of the question this section uses. */
  readonly concepts: readonly string[];
  /** The question's words this section uses. */
  readonly words: readonly string[];
  readonly origin: 'Course';
}

export interface ConceptAnswer {
  readonly iri: string;
  readonly card: string;
  readonly label: string;
  readonly origin: 'I2IDL';
  /** I2IDL's definition, when its sources allow it to be quoted here. */
  readonly definition?: string;
  readonly definitionWithheld?: string;
  readonly provenance: { readonly wording: string; readonly origin: 'I2IDL-X · derived' };
  readonly reuse: { readonly class: ReuseClass; readonly label: string; readonly note: string; readonly origin: 'I2IDL-X · derived' };
  readonly sources: ReadonlyArray<{ readonly label: string; readonly title: string; readonly relation: 'direct' | 'supporting'; readonly url?: string; readonly rights: string; readonly origin: 'I2IDL' }>;
  readonly inCourse: ReadonlyArray<{ readonly id: string; readonly title: string; readonly href?: string }>;
  readonly i2idlx?: {
    readonly referent?: { readonly category: string; readonly label: string; readonly rationale?: string; readonly origin: 'I2IDL-X · proposed'; readonly modalStatus: 'Hypothetical'; readonly graph: string };
    readonly enactments?: ReadonlyArray<{ readonly action: string; readonly role: string; readonly status: string; readonly rationale?: string; readonly origin: 'I2IDL-X · proposed'; readonly modalStatus: 'Hypothetical'; readonly graph: string }>;
  };
}

export interface CourseAnswer {
  readonly kind: 'course-answer';
  readonly course: { readonly id: string; readonly title: string };
  readonly question: string;
  readonly grounding: 'glossary-and-course' | 'glossary' | 'course' | 'none';
  readonly answer: string;
  readonly concepts: readonly ConceptAnswer[];
  readonly sections: readonly SectionHit[];
  /** I2IDL terms the course itself uses most, for a next question. */
  readonly courseTerms: ReadonlyArray<{ readonly iri: string; readonly label: string; readonly card: string }>;
  readonly attribution?: {
    readonly glossary: { readonly title: string; readonly release: string; readonly url: string; readonly rights: string };
    readonly i2idlx?: { readonly graphs: readonly string[]; readonly note: string };
  };
  readonly method: string;
  /** Set when the glossary could not be read: the answer comes from the course alone. */
  readonly glossaryUnavailable?: boolean;
}

const MAX_QUESTION = 500;
const MAX_SECTIONS = 3;
const MAX_SNIPPET = 300;
const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in into is it its '
  + 'me my of on or our should so than that the their them then there these they this those to was we were what when where which '
  + 'who whom why will with would you your about course mean means meaning define defined definition tell explain please').split(' '));

/** A section's Markdown as plain prose, for snippets and word overlap. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const wordsOf = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** A word with a plain plural "s" taken off, so "verbs" finds "verb". */
const stem = (w: string): string => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

function snippetAround(text: string, at: number): string {
  const sentences: Array<{ start: number; end: number }> = [];
  const re = /[^.!?\n]+(?:[.!?]+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { if (m[0].trim()) sentences.push({ start: m.index, end: m.index + m[0].length }); if (m[0].length === 0) re.lastIndex++; }
  const hit = sentences.find(s => at >= s.start && at < s.end) ?? sentences[0];
  const s = hit ? text.slice(hit.start, hit.end).trim() : text.trim();
  return s.length > MAX_SNIPPET ? `${s.slice(0, MAX_SNIPPET - 1).trimEnd()}…` : s;
}

const quote = (s: string): string => `“${s}”`;
const list = (xs: readonly string[]): string => xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;

/**
 * Answer a question about a course. `sources` is the glossary with I2IDL-X's layers (null when it
 * could not be read); `href` links a section.
 */
export function askCourse(args: { course: AskableCourse; question: string; sources: GlossarySources | null; href?: (scoId: string) => string }): CourseAnswer {
  const { course, sources } = args;
  const question = args.question.trim().slice(0, MAX_QUESTION);
  const matcher = sources?.matcher;
  const glossary = sources?.glossary;
  const asked: string[] = [];
  const mentioned = matcher?.find(question, { weak: true }) ?? [];
  for (const m of mentioned) if (!asked.includes(m.iri)) asked.push(m.iri);
  // The words a term already accounts for ("learning" in "Learning Record Store") are not matched again on their own.
  let rest = question;
  for (const m of [...mentioned].reverse()) rest = `${rest.slice(0, m.start)} ${rest.slice(m.end)}`;
  const askedWords = [...new Set(wordsOf(rest).filter(w => w.length >= 3 && !STOP.has(w)).map(stem))];

  const sections = course.scos.map((s, order) => {
    const text = plainText(`${s.title}\n${s.body}`);
    const mentions = matcher?.find(text, { weak: true }) ?? [];
    const concepts = asked.filter(iri => mentions.some(m => m.iri === iri));
    const tokens = new Set(wordsOf(text).map(stem));
    const words = askedWords.filter(w => tokens.has(w));
    const firstAt = mentions.find(m => asked.includes(m.iri))?.start
      ?? (words.length ? text.toLowerCase().search(new RegExp(`(?<![\\p{L}\\p{N}])${words[0]}s?(?![\\p{L}\\p{N}])`, 'u')) : 0);
    const strong = matcher?.find(text) ?? [];
    return { s, order, text, concepts, words, score: concepts.length * 3 + words.length, firstAt: Math.max(0, firstAt), strong };
  });
  const hits: SectionHit[] = sections.filter(x => x.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .slice(0, MAX_SECTIONS)
    .map(x => ({
      id: x.s.id, title: x.s.title, ...(args.href ? { href: args.href(x.s.id) } : {}),
      snippet: snippetAround(x.text, x.firstAt),
      concepts: x.concepts.map(iri => glossary?.byIri.get(iri)?.label ?? iri), words: x.words, origin: 'Course' as const,
    }));

  const concepts: ConceptAnswer[] = asked.map(iri => glossary!.byIri.get(iri)).filter((c): c is I2idlConcept => !!c).map(c => {
    const reuse = REUSE[c.reuse];
    const direct = c.evidence.filter(e => e.relation === 'direct');
    const withheldFrom = [...new Set(direct.map(e => glossary!.sources.get(e.source)).filter(s => s && !REUSE[s.reuse].quotable).map(s => `${s!.label} (${s!.rights})`))];
    const inCourse = sections.filter(x => x.concepts.includes(c.iri)).map(x => ({ id: x.s.id, title: x.s.title, ...(args.href ? { href: args.href(x.s.id) } : {}) }));
    const referent = sources?.decorations?.referents.get(c.iri);
    const enactments = sources?.decorations?.enactments.get(c.iri) ?? [];
    const seenSource = new Set<string>();
    return {
      iri: c.iri, card: i2idlCardUrl(c), label: c.label, origin: 'I2IDL' as const,
      ...(reuse.quotable ? { definition: c.definition } : { definitionWithheld: `I2IDL's definition rests directly on ${list(withheldFrom)}, which does not allow commercial reuse without permission, so it is not quoted here. Read it on I2IDL's card.` }),
      provenance: { wording: PROVENANCE_WORDING[c.provenance], origin: 'I2IDL-X · derived' as const },
      reuse: { class: c.reuse, label: reuse.label, note: reuse.note, origin: 'I2IDL-X · derived' as const },
      sources: c.evidence.filter(e => { if (seenSource.has(e.source)) return false; seenSource.add(e.source); return true; }).map(e => {
        const s = glossary!.sources.get(e.source);
        return { label: s?.label ?? e.source, title: s?.title ?? e.source, relation: e.relation, ...(e.url ? { url: e.url } : s?.url ? { url: s.url } : {}), rights: s?.rights ?? '', origin: 'I2IDL' as const };
      }),
      inCourse,
      ...(referent || enactments.length ? { i2idlx: {
        ...(referent ? { referent: { category: referent.category, label: referent.label, ...(referent.rationale ? { rationale: referent.rationale } : {}), origin: 'I2IDL-X · proposed' as const, modalStatus: 'Hypothetical' as const, graph: I2IDLX_GRAPHS.referents } } : {}),
        ...(enactments.length ? { enactments: enactments.map(e => ({ action: e.action, role: e.roleLabel, status: e.statusLabel, ...(e.rationale ? { rationale: e.rationale } : {}), origin: 'I2IDL-X · proposed' as const, modalStatus: 'Hypothetical' as const, graph: I2IDLX_GRAPHS.enactments })) } : {}),
      } } : {}),
    };
  });

  const counts = new Map<string, number>();
  for (const x of sections) for (const m of x.strong) counts.set(m.iri, (counts.get(m.iri) ?? 0) + 1);
  const courseTerms = [...counts.entries()].filter(([iri]) => !asked.includes(iri))
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).slice(0, 8)
    .map(([iri]) => glossary!.byIri.get(iri)!).filter(Boolean).map(c => ({ iri: c.iri, label: c.label, card: i2idlCardUrl(c) }));

  const directLabels = (c: ConceptAnswer): string[] => [...new Set(c.sources.filter(s => s.relation === 'direct').map(s => s.label))];
  const sentences: string[] = [];
  concepts.forEach((c, i) => {
    const where = c.inCourse.length ? `This course covers it in ${list(c.inCourse.map(s => quote(s.title)))}.` : 'This course does not use the term.';
    if (i === 0) {
      sentences.push(c.definition
        ? `${c.label} is an I2IDL glossary term. I2IDL defines it as ${quote(c.definition)} (${c.provenance.wording}${directLabels(c).length ? `: ${list(directLabels(c))}` : ''}).`
        : `${c.label} is an I2IDL glossary term. ${c.definitionWithheld}`);
      sentences.push(where);
    } else {
      sentences.push(`${c.label} is also an I2IDL term${c.inCourse.length ? `, covered in ${list(c.inCourse.map(s => quote(s.title)))}` : ', not used in this course'}.`);
    }
  });
  const fromWords = hits.filter(h => !h.concepts.length);
  if (!concepts.length && hits.length) sentences.push(hits.length === 1
    ? `The part of this course closest to the question is ${quote(hits[0]!.title)}.`
    : `The parts of this course closest to the question are ${list(hits.map(h => quote(h.title)))}.`);
  else if (concepts.length && fromWords.length) sentences.push(`${list(fromWords.map(h => quote(h.title)))} ${fromWords.length === 1 ? 'shares' : 'share'} words with the question too.`);
  if (!sentences.length) sentences.push(sources
    ? 'Nothing in this course or the I2IDL glossary matches that question. Try the words the course uses, or one of the I2IDL terms it uses.'
    : 'Nothing in this course matches that question. Try the words the course uses.');

  const coursed = hits.length > 0 || concepts.some(c => c.inCourse.length);
  const grounding = concepts.length ? (coursed ? 'glossary-and-course' : 'glossary') : hits.length ? 'course' : 'none';
  const usedGlossary = !!glossary && (concepts.length > 0 || courseTerms.length > 0);
  return {
    kind: 'course-answer',
    course: { id: course.courseId, title: course.title },
    question, grounding, answer: sentences.join(' '), concepts, sections: hits, courseTerms,
    ...(usedGlossary ? { attribution: {
      glossary: { title: glossary!.title, release: glossary!.release, url: I2IDL_GLOSSARY_URL, rights: glossary!.rights },
      ...(sources?.decorations ? { i2idlx: { graphs: [I2IDLX_GRAPHS.referents, I2IDLX_GRAPHS.enactments], note: 'Referent categories and enactments are I2IDL-X proposals, Hypothetical until reviewers ratify. I2IDL-X is independent work, not affiliated with or endorsed by I2IDL.' } } : {}),
    } } : {}),
    method: 'Assembled, not generated: I2IDL terms found by I2IDL-X\'s surface forms, and the question\'s words found in the course\'s sections. No model is called.',
    ...(sources ? {} : { glossaryUnavailable: true }),
  };
}
