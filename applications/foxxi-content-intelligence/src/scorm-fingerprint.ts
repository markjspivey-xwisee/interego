/**
 * scorm-fingerprint.ts — determine WHICH authoring tool produced a SCORM/xAPI
 * package, with a confidence score and the exact signals that fired.
 *
 * This is a pure, dependency-free, deterministic classifier. It runs in the
 * bridge (no unzip needed for the manifest-only path) and in the browser. It
 * works off two inputs, either of which may be absent:
 *   - manifestXml: the raw imsmanifest.xml / cmi5.xml / tincan.xml text
 *   - fileList:    the package's file paths (from a browser-side unzip)
 *
 * The file-tree signals for Articulate Storyline, Articulate Rise and Adobe
 * Captivate are ported from our in-repo Python parser's detect_authoring_tool
 * (course/extracted/foxxi_storyline_parser.py): Storyline = html5/data/js/data.js
 * carrying projectId+courseId; Rise = course.json / presentation.json; Captivate
 * = html5/captivate/ or project.txt. The remaining tools use their well-known
 * public package signatures (the same kind of structural tell-tales an AV
 * signature DB uses — facts about file layout, not anyone's copyrighted code).
 *
 * Honesty by construction: a hand-authored package with no tool tell-tales (e.g.
 * the Rustici "Golf Explained" sample) resolves to `hand-authored` with LOW
 * confidence — we never invent a tool. Every verdict lists the signals that
 * fired and the standard/version we DID detect.
 */

export type FingerprintSource = 'manifest' | 'file-tree';
export interface FingerprintSignal {
  /** human-readable signal, e.g. "html5/data/js/data.js present". */
  signal: string;
  /** which tool this signal points to (toolId). */
  points: string;
  /** evidence weight (higher = more distinctive). */
  weight: number;
  source: FingerprintSource;
}
export interface ToolCandidate {
  toolId: string;
  tool: string;
  vendor: string;
  score: number;
  /** 0..1 share of total fired weight that points at this tool. */
  confidence: number;
  signals: FingerprintSignal[];
  version?: string;
}
export interface ScormStandardInfo {
  /** e.g. "SCORM 2004 4th Edition", "SCORM 1.2", "cmi5", "xAPI (tincan)", "unknown". */
  standard: string;
  /** machine id, e.g. SCORM_2004_4 / SCORM_12 / CMI5 / XAPI / UNKNOWN. */
  standardId: string;
  schema?: string;
  schemaversion?: string;
}
export interface FingerprintResult {
  /** winning tool display name (or "Hand-authored / unknown tool"). */
  tool: string;
  toolId: string;
  vendor: string;
  /** 0..1 confidence in the WINNING tool (0 when hand-authored/unknown). */
  confidence: number;
  version?: string;
  standard: ScormStandardInfo;
  /** all candidates that scored > 0, best first. */
  candidates: ToolCandidate[];
  /** every signal that fired, across all tools + the standard. */
  signals: FingerprintSignal[];
  /** plain-English summary safe to show a user / feed an agent. */
  summary: string;
}

interface ToolDef {
  toolId: string;
  tool: string;
  vendor: string;
  /** file-tree predicates (path is lowercased before testing). */
  fileSignals: Array<{ test: (paths: string[]) => boolean; signal: string; weight: number }>;
  /** manifest predicates over the lowercased manifest text. */
  manifestSignals: Array<{ test: (xmlLower: string, xml: string) => boolean; signal: string; weight: number }>;
}

const has = (paths: string[], needle: string): boolean => paths.some(p => p.includes(needle));
const hasFile = (paths: string[], name: string): boolean => paths.some(p => p === name || p.endsWith('/' + name));

/** Tool signature table. Storyline/Rise/Captivate ported from the in-repo Python
 *  parser; the rest are documented public package signatures. */
const TOOLS: ToolDef[] = [
  {
    toolId: 'articulate-storyline', tool: 'Articulate Storyline', vendor: 'Articulate',
    fileSignals: [
      { test: p => has(p, 'story_content/'), signal: 'story_content/ folder', weight: 5 },
      { test: p => has(p, 'html5/data/js/data.js'), signal: 'html5/data/js/data.js (Storyline HTML5 output)', weight: 6 },
      { test: p => hasFile(p, 'story.html'), signal: 'story.html launcher', weight: 4 },
      { test: p => has(p, 'mobile/') && has(p, 'story_content/'), signal: 'mobile/ + story_content/', weight: 2 },
    ],
    manifestSignals: [
      { test: x => x.includes('storyline'), signal: '"storyline" in manifest', weight: 4 },
    ],
  },
  {
    toolId: 'articulate-rise', tool: 'Articulate Rise', vendor: 'Articulate',
    fileSignals: [
      { test: p => hasFile(p, 'course.json'), signal: 'course.json at root (Rise)', weight: 4 },
      { test: p => hasFile(p, 'presentation.json') && !has(p, 'ispring'), signal: 'presentation.json (Rise)', weight: 3 },
      { test: p => has(p, 'scormcontent/index.html'), signal: 'scormcontent/index.html (Rise SCORM wrapper)', weight: 4 },
      { test: p => has(p, 'lib/main.bundle.js'), signal: 'lib/main.bundle.js (Rise runtime)', weight: 4 },
    ],
    manifestSignals: [
      { test: x => x.includes('rise.articulate') || x.includes('articulate rise'), signal: 'Rise marker in manifest', weight: 4 },
    ],
  },
  {
    toolId: 'adobe-captivate', tool: 'Adobe Captivate', vendor: 'Adobe',
    fileSignals: [
      { test: p => has(p, 'html5/captivate/'), signal: 'html5/captivate/ folder', weight: 6 },
      { test: p => hasFile(p, 'project.txt'), signal: 'project.txt (Captivate)', weight: 3 },
      { test: p => p.some(x => x.endsWith('_cpm.js')) || hasFile(p, 'cpm.js'), signal: 'CPM.js (Captivate Publish Module)', weight: 5 },
      { test: p => hasFile(p, 'cp.css') && hasFile(p, 'goodbye.html'), signal: 'cp.css + goodbye.html (Captivate)', weight: 4 },
      { test: p => has(p, 'dr/') && has(p, 'assets/'), signal: 'dr/ + assets/ (Captivate layout)', weight: 2 },
    ],
    manifestSignals: [
      { test: x => x.includes('captivate'), signal: '"captivate" in manifest', weight: 4 },
    ],
  },
  {
    toolId: 'ispring', tool: 'iSpring Suite', vendor: 'iSpring',
    fileSignals: [
      { test: p => has(p, 'ispring/') || p.some(x => x.includes('ispring')), signal: 'iSpring marker path', weight: 5 },
      { test: p => hasFile(p, 'ispring_player.html'), signal: 'ispring_player.html', weight: 5 },
      { test: p => has(p, 'data/') && has(p, 'res/') && hasFile(p, 'index.html'), signal: 'data/ + res/ + index.html (iSpring layout)', weight: 2 },
    ],
    manifestSignals: [
      { test: x => x.includes('ispring'), signal: '"ispring" in manifest', weight: 5 },
    ],
  },
  {
    toolId: 'lectora', tool: 'Lectora', vendor: 'ELB Learning / Trivantis',
    fileSignals: [
      { test: p => p.some(x => /a001index\.html?$/.test(x)) || p.some(x => /\/a001/.test(x)), signal: 'a001index.html (Lectora page naming)', weight: 5 },
      { test: p => p.some(x => x.includes('trivantis')) || p.some(x => x.includes('lectora')), signal: 'Trivantis/Lectora marker', weight: 5 },
    ],
    manifestSignals: [
      { test: x => x.includes('trivantis') || x.includes('lectora'), signal: 'Trivantis/Lectora in manifest', weight: 5 },
    ],
  },
  {
    toolId: 'camtasia', tool: 'TechSmith Camtasia', vendor: 'TechSmith',
    fileSignals: [
      { test: p => p.some(x => x.includes('camtasia')) || p.some(x => x.endsWith('.smil')), signal: 'Camtasia/SMIL marker', weight: 5 },
      { test: p => hasFile(p, 'controller.swf') && hasFile(p, 'firstframe.png'), signal: 'controller.swf + firstframe.png (Camtasia)', weight: 4 },
    ],
    manifestSignals: [
      { test: x => x.includes('techsmith') || x.includes('camtasia'), signal: 'TechSmith/Camtasia in manifest', weight: 5 },
    ],
  },
  {
    toolId: 'h5p', tool: 'H5P', vendor: 'H5P / Joubel',
    fileSignals: [
      { test: p => hasFile(p, 'h5p.json'), signal: 'h5p.json', weight: 6 },
      { test: p => has(p, 'content/content.json'), signal: 'content/content.json (H5P)', weight: 4 },
      { test: p => p.some(x => /h5p-[a-z]/.test(x)), signal: 'h5p-* library folder', weight: 3 },
    ],
    manifestSignals: [
      { test: x => x.includes('h5p'), signal: '"h5p" in manifest', weight: 3 },
    ],
  },
  {
    toolId: 'dominknow', tool: 'dominKnow | ONE', vendor: 'dominKnow',
    fileSignals: [
      { test: p => p.some(x => x.includes('dominknow')), signal: 'dominKnow marker', weight: 5 },
      { test: p => has(p, 'scormdriver/') && has(p, 'player/'), signal: 'scormdriver/ + player/ (dominKnow)', weight: 3 },
    ],
    manifestSignals: [
      { test: x => x.includes('dominknow'), signal: '"dominknow" in manifest', weight: 5 },
    ],
  },
  {
    toolId: 'gomo', tool: 'gomo', vendor: 'Learning Pool',
    fileSignals: [
      { test: p => p.some(x => x.includes('gomo')), signal: 'gomo marker', weight: 5 },
      { test: p => hasFile(p, 'course_config.js') || hasFile(p, 'gomo_config.js'), signal: 'gomo config', weight: 3 },
    ],
    manifestSignals: [
      { test: x => x.includes('gomo'), signal: '"gomo" in manifest', weight: 5 },
    ],
  },
  {
    toolId: 'easygenerator', tool: 'easygenerator', vendor: 'easygenerator',
    fileSignals: [
      { test: p => p.some(x => x.includes('easygenerator')), signal: 'easygenerator marker', weight: 5 },
    ],
    manifestSignals: [
      { test: x => x.includes('easygenerator'), signal: '"easygenerator" in manifest', weight: 5 },
    ],
  },
  {
    toolId: 'adapt', tool: 'Adapt', vendor: 'Adapt Learning',
    fileSignals: [
      { test: p => hasFile(p, 'adapt.json') || has(p, 'course/config.json'), signal: 'adapt.json / course/config.json (Adapt)', weight: 5 },
      { test: p => has(p, 'adapt/js/adapt.min.js'), signal: 'adapt/js/adapt.min.js', weight: 4 },
    ],
    manifestSignals: [
      { test: x => x.includes('adapt'), signal: '"adapt" in manifest', weight: 2 },
    ],
  },
];

/** Detect the SCORM/cmi5/xAPI standard + version from the manifest text. */
export function detectStandard(manifestXml?: string, fileList?: string[]): ScormStandardInfo {
  const paths = (fileList ?? []).map(p => p.toLowerCase());
  if (manifestXml) {
    const x = manifestXml;
    const schema = (x.match(/<schema>\s*([^<]+?)\s*<\/schema>/i) ?? [])[1];
    const schemaversion = (x.match(/<schemaversion>\s*([^<]+?)\s*<\/schemaversion>/i) ?? [])[1];
    if (/adlcp_v1p3|adlcp_rootv1p3|imsss/i.test(x) || /2004/.test(schemaversion ?? '')) {
      const ed = /4th/i.test(schemaversion ?? '') ? '4th Edition'
        : /3rd/i.test(schemaversion ?? '') ? '3rd Edition'
        : /2nd/i.test(schemaversion ?? '') ? '2nd Edition' : '';
      return { standard: `SCORM 2004${ed ? ' ' + ed : ''}`, standardId: 'SCORM_2004', schema, schemaversion };
    }
    if (/adlcp_rootv1p2|adlcp_v1p2/i.test(x) || /1\.2/.test(schemaversion ?? '')) {
      return { standard: 'SCORM 1.2', standardId: 'SCORM_12', schema, schemaversion };
    }
  }
  if (hasFile(paths, 'cmi5.xml')) return { standard: 'cmi5', standardId: 'CMI5' };
  if (hasFile(paths, 'tincan.xml')) return { standard: 'xAPI (Tin Can)', standardId: 'XAPI' };
  if (manifestXml && /<manifest/i.test(manifestXml)) return { standard: 'SCORM (version unspecified)', standardId: 'SCORM' };
  return { standard: 'unknown', standardId: 'UNKNOWN' };
}

/** Extract the Storyline data.js version, if its bytes were supplied (optional). */
function storylineVersion(files?: Record<string, string>): string | undefined {
  const dataJs = files && (files['html5/data/js/data.js'] ?? files['story_content/data.js']);
  if (!dataJs) return undefined;
  const m = dataJs.match(/"version"\s*:\s*"([^"]+)"/);
  return m?.[1];
}

export interface FingerprintInput {
  manifestXml?: string;
  fileList?: string[];
  /** optional: a few key file CONTENTS (e.g. { 'html5/data/js/data.js': '…' }) to confirm Storyline projectId/courseId + version. */
  fileContents?: Record<string, string>;
}

/** Fingerprint the authoring tool. Pure + deterministic. */
export function fingerprintAuthoringTool(input: FingerprintInput): FingerprintResult {
  const manifestXml = input.manifestXml ?? '';
  const xmlLower = manifestXml.toLowerCase();
  const paths = (input.fileList ?? []).map(p => p.toLowerCase().replace(/^\.?\//, ''));
  const standard = detectStandard(manifestXml, input.fileList);
  const allSignals: FingerprintSignal[] = [];

  const candidates: ToolCandidate[] = [];
  for (const def of TOOLS) {
    const fired: FingerprintSignal[] = [];
    for (const fs of def.fileSignals) {
      if (paths.length && fs.test(paths)) fired.push({ signal: fs.signal, points: def.toolId, weight: fs.weight, source: 'file-tree' });
    }
    for (const ms of def.manifestSignals) {
      if (manifestXml && ms.test(xmlLower, manifestXml)) fired.push({ signal: ms.signal, points: def.toolId, weight: ms.weight, source: 'manifest' });
    }
    if (fired.length === 0) continue;
    // Storyline confirmation: data.js must carry projectId+courseId to count the strongest signal at full weight.
    let version: string | undefined;
    if (def.toolId === 'articulate-storyline') {
      const dataJs = input.fileContents?.['html5/data/js/data.js'];
      if (dataJs && !(dataJs.includes('projectId') && dataJs.includes('courseId'))) {
        // present but unconfirmed — keep signal but halve its weight
        for (const s of fired) if (s.signal.includes('data.js')) s.weight = Math.max(1, Math.round(s.weight / 2));
      }
      version = storylineVersion(input.fileContents);
    }
    const score = fired.reduce((a, s) => a + s.weight, 0);
    candidates.push({ toolId: def.toolId, tool: def.tool, vendor: def.vendor, score, confidence: 0, signals: fired, version });
    allSignals.push(...fired);
  }

  candidates.sort((a, b) => b.score - a.score);
  const totalScore = candidates.reduce((a, c) => a + c.score, 0);
  for (const c of candidates) c.confidence = totalScore > 0 ? round2(c.score / totalScore) : 0;

  const top = candidates[0];
  // A tool is only "detected" if it has a meaningful, somewhat-distinctive signal.
  const detected = top && top.score >= 4;
  const result: FingerprintResult = detected
    ? {
        tool: top.tool, toolId: top.toolId, vendor: top.vendor,
        confidence: top.confidence, version: top.version, standard,
        candidates, signals: allSignals,
        summary: summarize(top, standard, candidates),
      }
    : {
        tool: 'Hand-authored / unknown tool', toolId: 'hand-authored', vendor: '—',
        confidence: 0, standard, candidates, signals: allSignals,
        summary: summarizeUnknown(standard, paths, manifestXml),
      };
  return result;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function summarize(top: ToolCandidate, std: ScormStandardInfo, candidates: ToolCandidate[]): string {
  const pct = Math.round(top.confidence * 100);
  const runner = candidates[1];
  const vers = top.version ? ` ${top.version}` : '';
  const other = runner ? ` (next: ${runner.tool} at ${Math.round(runner.confidence * 100)}%)` : '';
  return `Authored with ${top.tool}${vers} — ${pct}% confidence from ${top.signals.length} signal${top.signals.length === 1 ? '' : 's'}${other}. Packaged as ${std.standard}.`;
}
function summarizeUnknown(std: ScormStandardInfo, paths: string[], manifestXml: string): string {
  const handAuthored = /rustici|scorm\.com|golfsamples/i.test(manifestXml) || paths.some(p => p.includes('scormfunctions.js'));
  const lead = handAuthored
    ? 'No specific authoring tool detected — this looks hand-authored (Rustici-style SCO functions / golf sample).'
    : 'No specific authoring-tool signature matched.';
  return `${lead} Packaged as ${std.standard}. We do not guess a tool when the tell-tale signals are absent.`;
}
