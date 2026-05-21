/**
 * cmi5 course-structure model + parser (cmi5 / IEEE 9274.2.1 §13).
 *
 * A cmi5 course ships a `cmi5.xml` — a `<courseStructure>` holding one
 * `<course>` and a tree of `<block>` and `<au>` elements. Foxxi already
 * detected the AUs but discarded the block tree and the AU order. This
 * module parses the full structure, so the LMS can:
 *   · gate AUs by their order in the structure (sequential progress);
 *   · roll satisfaction up — a block is satisfied when all its AUs are,
 *     the course when all its blocks/AUs are.
 *
 * No runtime dependency: a small, scoped XML reader (the repo keeps
 * zero deps; cmi5.xml is a tiny, well-specified document).
 *
 * Layer: L3 vertical. cmi5 is an external IEEE standard; this is a
 * conformant reader of its course-structure binding.
 */

export type Cmi5MoveOn = 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed' | 'NotApplicable';

/** An Assignable Unit node in the course tree. */
export interface Cmi5AuNode {
  kind: 'au';
  id: string;
  title: string;
  /** The AU launch URL (as written in cmi5.xml — may be relative). */
  url: string;
  moveOn: Cmi5MoveOn;
  masteryScore?: number;
  launchMethod?: 'OwnWindow' | 'AnyWindow';
}

/** A block node — groups AUs and nested blocks. */
export interface Cmi5BlockNode {
  kind: 'block';
  id: string;
  title: string;
  children: Cmi5Node[];
}

export type Cmi5Node = Cmi5AuNode | Cmi5BlockNode;

export interface Cmi5Course {
  id: string;
  title: string;
  description?: string;
  /** Top-level blocks and AUs, in document order. */
  structure: Cmi5Node[];
}

// ── A minimal, dependency-free XML reader ────────────────────────────

interface XmlNode { tag: string; attrs: Record<string, string>; children: XmlNode[]; text: string; }

function localName(tag: string): string {
  const c = tag.indexOf(':');
  return c === -1 ? tag : tag.slice(c + 1);
}

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w.-]+(?::[\w.-]+)?)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out[localName(m[1]!)] = decodeEntities(m[2]!);
  return out;
}

/** Parse an XML document into a node tree. Returns the root, or null. */
function parseXml(src: string): XmlNode | null {
  const s = src
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c);
  let i = 0;
  const openTag = /^<([\w.-]+(?::[\w.-]+)?)((?:\s+[\w.-]+(?::[\w.-]+)?\s*=\s*"[^"]*")*)\s*(\/?)>/;

  function parseNode(): XmlNode | null {
    while (i < s.length && s[i] !== '<') i++;
    if (i >= s.length) return null;
    const m = openTag.exec(s.slice(i));
    if (!m) { i++; return null; }
    i += m[0].length;
    const node: XmlNode = { tag: localName(m[1]!), attrs: parseAttrs(m[2]!), children: [], text: '' };
    if (m[3] === '/') return node;
    while (i < s.length) {
      if (s.startsWith('</', i)) {
        const close = /^<\/[\w.:-]+\s*>/.exec(s.slice(i));
        if (close) { i += close[0].length; break; }
        i += 2;
      } else if (s[i] === '<') {
        const child = parseNode();
        if (child) node.children.push(child);
      } else {
        let j = i;
        while (j < s.length && s[j] !== '<') j++;
        node.text += decodeEntities(s.slice(i, j));
        i = j;
      }
    }
    return node;
  }
  return parseNode();
}

// ── cmi5.xml → Cmi5Course ────────────────────────────────────────────

function langString(node: XmlNode | undefined): string {
  if (!node) return '';
  // <title><langstring lang="en-US">text</langstring></title>
  const ls = node.children.filter(c => c.tag === 'langstring');
  if (ls.length > 0) {
    return (ls.find(l => /^en/i.test(l.attrs.lang ?? '')) ?? ls[0]!).text.trim();
  }
  return node.text.trim();
}

function child(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find(c => c.tag === tag);
}

function toCourseNode(n: XmlNode): Cmi5Node | null {
  if (n.tag === 'au') {
    const moveOnRaw = n.attrs.moveOn;
    const moveOn: Cmi5MoveOn = isMoveOn(moveOnRaw) ? moveOnRaw : 'CompletedOrPassed';
    return {
      kind: 'au',
      id: n.attrs.id ?? '',
      title: langString(child(n, 'title')) || n.attrs.id || 'Assignable Unit',
      url: (child(n, 'url')?.text ?? '').trim(),
      moveOn,
      ...(n.attrs.masteryScore !== undefined ? { masteryScore: Number(n.attrs.masteryScore) } : {}),
      ...(n.attrs.launchMethod === 'OwnWindow' || n.attrs.launchMethod === 'AnyWindow'
        ? { launchMethod: n.attrs.launchMethod } : {}),
    };
  }
  if (n.tag === 'block') {
    return {
      kind: 'block',
      id: n.attrs.id ?? '',
      title: langString(child(n, 'title')) || n.attrs.id || 'Block',
      children: n.children.map(toCourseNode).filter((x): x is Cmi5Node => x !== null),
    };
  }
  return null;
}

function isMoveOn(v: string | undefined): v is Cmi5MoveOn {
  return v === 'Passed' || v === 'Completed' || v === 'CompletedAndPassed'
    || v === 'CompletedOrPassed' || v === 'NotApplicable';
}

/**
 * Parse a `cmi5.xml` document into a Cmi5Course. Throws on a document
 * that is not a recognisable `<courseStructure>`.
 */
export function parseCmi5Course(xml: string): Cmi5Course {
  const root = parseXml(xml);
  if (!root || root.tag !== 'courseStructure') {
    throw new Error('not a cmi5 course-structure document (expected a <courseStructure> root)');
  }
  const courseEl = child(root, 'course');
  if (!courseEl) throw new Error('cmi5.xml has no <course> element');
  return {
    id: courseEl.attrs.id ?? '',
    title: langString(child(courseEl, 'title')) || courseEl.attrs.id || 'Course',
    description: langString(child(courseEl, 'description')) || undefined,
    structure: root.children.map(toCourseNode).filter((x): x is Cmi5Node => x !== null),
  };
}

// ── Structure helpers ────────────────────────────────────────────────

/** Every AU in the course, in document (sequential) order. */
export function flatAus(course: Cmi5Course): Cmi5AuNode[] {
  const out: Cmi5AuNode[] = [];
  const walk = (nodes: Cmi5Node[]): void => {
    for (const n of nodes) {
      if (n.kind === 'au') out.push(n);
      else walk(n.children);
    }
  };
  walk(course.structure);
  return out;
}

/** Every block in the course. */
export function flatBlocks(course: Cmi5Course): Cmi5BlockNode[] {
  const out: Cmi5BlockNode[] = [];
  const walk = (nodes: Cmi5Node[]): void => {
    for (const n of nodes) {
      if (n.kind === 'block') { out.push(n); walk(n.children); }
    }
  };
  walk(course.structure);
  return out;
}

export function auById(course: Cmi5Course, auId: string): Cmi5AuNode | undefined {
  return flatAus(course).find(a => a.id === auId);
}

/**
 * The AU a learner must satisfy before launching `auId` — the preceding
 * AU in document order (cmi5 sequential progression). Undefined for the
 * first AU.
 */
export function precedingAu(course: Cmi5Course, auId: string): Cmi5AuNode | undefined {
  const aus = flatAus(course);
  const idx = aus.findIndex(a => a.id === auId);
  return idx > 0 ? aus[idx - 1] : undefined;
}

/** All AU ids contained (at any depth) by a block. */
export function blockAuIds(block: Cmi5BlockNode): string[] {
  const out: string[] = [];
  const walk = (nodes: Cmi5Node[]): void => {
    for (const n of nodes) {
      if (n.kind === 'au') out.push(n.id);
      else walk(n.children);
    }
  };
  walk(block.children);
  return out;
}
