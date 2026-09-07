/** FOXXI resources use the same HMD semantics and controls as the substrate. */
import { renderHypermediaMarkdown, type HypermediaLink } from '@interego/core';
import type { Affordance } from '../../_shared/affordance-mcp/index.js';
import { affordanceControl, hmdProse } from '../../_shared/hypermedia/index.js';
import { scormArtifactLinks } from './scorm-artifacts.js';

export interface CourseView {
  courseId: string; title: string; masteryScore: number; authoredBy: string;
  scos: readonly { id: string; title: string; body: string;
    assessment?: readonly { question: string }[] }[];
}
export interface MemoryView { kind?: string; title?: string; body?: string; author?: string; memoryIri?: string }

export function courseHmd(course: CourseView, base: string, player: string, launch: Affordance): string {
  const id = `${base}/agent/scorm/course/${encodeURIComponent(course.courseId)}`;
  const artifacts = scormArtifactLinks(base, course.courseId);
  return renderHypermediaMarkdown({ id, type: 'scorm:Organization', descriptorUrl: `${base}/affordances`,
    title: course.title,
    extraContext: {
      scorm: `${base}/ns/scorm-cam#`,
      courseId: 'dct:identifier', courseIri: { '@id': 'owl:sameAs', '@type': '@id' },
      authoredBy: { '@id': 'dct:creator', '@type': '@id' }, scoCount: 'hydra:totalItems',
    },
    fields: { courseId: course.courseId, courseIri: id, authoredBy: course.authoredBy, scoCount: course.scos.length },
    body: hmdProse(`# ${course.title}\n\nSCORM 2004 assessment. The runtime sequences the SCOs and records the outcome. Mastery threshold: ${course.masteryScore}.\n\n`
      + course.scos.map(s => `## ${s.title}\n\n${s.body}`
        + (s.assessment?.length ? '\n\n' + s.assessment.map(q => `> **Assessment.** ${q.question}`).join('\n') : '')).join('\n\n')),
    links: [
      { label: 'Launch an attempt in the player', href: player, rel: 'alternate', type: 'text/html' },
      { label: 'imsmanifest.xml', href: artifacts.manifest, rel: 'describedby', type: 'application/xml' },
      { label: 'Download SCORM 2004 package', href: artifacts.scormZip, rel: 'enclosure', type: 'application/zip' },
      { label: 'SCORM package bytes and digest', href: artifacts.packageData, rel: 'alternate', type: 'application/json' },
      ...course.scos.map(s => ({ label: `${s.title} — SCO HTML`, href: artifacts.sco(s.id), rel: 'item', type: 'text/html' })),
      { label: 'Catalog record', href: id, rel: 'alternate', type: 'application/json' },
      { label: 'Course catalog', href: `${base}/agent/scorm/courses?format=markdown`, rel: 'collection', type: 'text/markdown' },
    ],
    controls: [{ ...affordanceControl(launch, base), id: 'launch',
      whenToUse: `${launch.description}\nFor this course use course_id=${JSON.stringify(course.courseId)} and author_did=${JSON.stringify(course.authoredBy)}. Sign the request as yourself before following this control.` }],
  });
}

export function memoryHmd(memory: MemoryView, base: string, atom: string | null, applied: Affordance): string {
  const id = memory.memoryIri ?? `${base}/memory/x`;
  const links: HypermediaLink[] = [
    { label: 'JSON description', href: id, rel: 'alternate', type: 'application/json' },
    { label: 'Shared memory catalog', href: `${base}/agent/memories?format=markdown`, rel: 'collection', type: 'text/markdown' },
  ];
  if (atom) links.push({ label: 'Content-addressed identity', href: atom, rel: 'canonical' },
    { label: 'Lattice node', href: `${base}/agent/lattice/atom/${atom.split('/').pop()}`, rel: 'alternate', type: 'application/json' });
  if (memory.author) links.push({ label: 'Author', href: memory.author, rel: 'http://purl.org/dc/terms/creator' });
  return renderHypermediaMarkdown({ id, type: 'skos:Concept', descriptorUrl: `${base}/affordances`,
    title: memory.title ?? memory.kind ?? 'Job aid',
    extraContext: { kind: 'dct:type', creator: { '@id': 'dct:creator', '@type': '@id' }, atom: { '@id': 'schema:identifier', '@type': '@id' } },
    fields: { kind: memory.kind ?? 'job-aid', ...(memory.author ? { creator: memory.author } : {}), ...(atom ? { atom } : {}) },
    body: hmdProse(`# ${memory.title ?? 'Job aid'}\n\n${memory.body ?? ''}`), links,
    controls: [{ ...affordanceControl(applied, base), id: 'applied',
      whenToUse: `${applied.description}\nRecord only work actually performed. Cite its evidence and identify this guidance: ${id}.` }],
  });
}

export function collectionHmd(id: string, title: string, base: string,
  entries: readonly { id: string; title: string }[]): string {
  return renderHypermediaMarkdown({ id, type: 'hydra:Collection', descriptorUrl: `${base}/affordances`, title,
    extraContext: { member: { '@id': 'hydra:member', '@type': '@id', '@container': '@set' } },
    fields: { 'hydra:totalItems': entries.length, member: entries.map(e => e.id) },
    body: `# ${title}\n\nFollow a resource to read its content and discover its current controls.`, controls: [],
    links: entries.map(e => ({ label: e.title.replace(/[[\]\\\r\n]/g, ' '), href: `${e.id}?format=markdown`, rel: 'item', type: 'text/markdown' })),
  });
}
