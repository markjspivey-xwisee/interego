#!/usr/bin/env node
/**
 * Generate the published artifact's substrate block from `@interego/workspace-client`.
 *
 * ★ WHY THIS TOOL EXISTS. The artifact must stay ONE self-contained file — that is what
 * "publish this and it becomes your page" means — so it cannot `import`. The alternative
 * everyone reaches for is a copy, and a copy is how every drift defect in this project
 * happened: a reader is hardened in one place and the other place keeps the bug. So the
 * artifact's substrate block is GENERATED here, delimited by the two markers below, and
 * `tests/workspace-artifact-no-drift.test.ts` fails when the committed file's block differs
 * from a fresh build. Editing inside the markers is therefore always caught.
 *
 *   node tools/build-workspace-artifact.mjs          # rewrite the artifact in place
 *   node tools/build-workspace-artifact.mjs --check  # exit 1 if it would change
 *   node tools/build-workspace-artifact.mjs --print  # write the block to stdout
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ARTIFACT = join(ROOT, 'applications/shared-workspace/artifact/channel.html');
export const BEGIN = '/* ══ BEGIN GENERATED — @interego/workspace-client ══════════════════════════';
export const END = '/* ══ END GENERATED ════════════════════════════════════════════════════════ */';

/**
 * Bundle the package to one IIFE assigning `globalThis.WSPC`.
 *
 * NOT minified. The artifact is read by people deciding whether to trust it with their pod;
 * a minified blob in the middle of a file whose whole argument is that you can read what it
 * does would undo the argument.
 */
export async function bundle() {
  const out = await build({
    entryPoints: [join(ROOT, 'packages/workspace-client/src/index.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'WSPC',
    target: 'es2020',
    platform: 'browser',
    write: false,
    legalComments: 'none',
    // The artifact is served as one HTML file with no source map alongside it.
    sourcemap: false,
  });
  const file = out.outputFiles[0];
  if (!file) throw new Error('esbuild produced no output file');
  return file.text.replace(/\r\n/g, '\n').trimEnd();
}

/**
 * The whole generated region: the bundle, then the adapters that bind it to this page's own
 * `RELAY` constant and re-export it under the names the hand-written script below already
 * calls. The adapters are generated too — a hand-written adapter is a copy with extra steps.
 */
export async function block() {
  const js = await bundle();
  return [
    BEGIN,
    '   Built by `node tools/build-workspace-artifact.mjs` from packages/workspace-client/src.',
    '   DO NOT EDIT INSIDE THESE MARKERS — `npx vitest run tests/workspace-artifact-no-drift.test.ts`',
    '   rebuilds this block and fails on any difference, so an edit here is reverted, not merged.',
    '   ══════════════════════════════════════════════════════════════════════════ */',
    js,
    '',
    '/* The module is transport-agnostic and knows no relay; this page has exactly one. These',
    '   adapters bind RELAY once and hand the rest of this file the same names and signatures it',
    '   used when the definitions were written out here by hand — so no call site below had to',
    '   change, and none of them can drift from the module again. */',
    'const BAD_IRI = WSPC.BAD_IRI;',
    'const REQUIRED_TOOLS = WSPC.REQUIRED_TOOLS.slice();',
    'const POD_RX = WSPC.POD_RX, SLUG_RX = WSPC.SLUG_RX, slugProblem = WSPC.slugProblem;',
    'const unescapeLiteral = WSPC.unescapeLiteral, scanTurtle = WSPC.scanTurtle;',
    'const maskFill = WSPC.maskFill, masked = WSPC.masked, maskComments = WSPC.maskComments;',
    'const literalAt = WSPC.literalAt, forms = WSPC.forms, nsOf = WSPC.nsOf;',
    'const readLiteral = WSPC.readLiteral, readIri = WSPC.readIri, readIriList = WSPC.readIriList;',
    'const readInt = WSPC.readInt, hasTrue = WSPC.hasTrue, hasType = WSPC.hasType;',
    'const graphRegion = WSPC.graphRegion, parseRoleProfile = WSPC.parseRoleProfile;',
    'const escTtl = WSPC.escapeTurtleLiteral, orderChain = WSPC.orderChain;',
    'const preconditionLine = WSPC.preconditionLine, assignPodMarks = WSPC.assignPodMarks;',
    'const podOfWebid = WSPC.podOfWebid, podOfNsIri = WSPC.podOfNsIri;',
    'const podOfDescriptorUrl = WSPC.podOfDescriptorUrl, podBaseOfDescriptorUrl = WSPC.podBaseOfDescriptorUrl;',
    'const podClaimVsServed = WSPC.podClaimVsServed, assertPod = WSPC.assertPod;',
    'const refusal = WSPC.refusal, asRefusal = WSPC.asRefusal, fail = WSPC.fail;',
    'const nsIri = (pod, name) => WSPC.nsIri(RELAY, pod, name);',
    'const qualifiedName = WSPC.qualifiedName, legacyName = WSPC.legacyName;',
    'const memberDocIris = (memberPod, convenerPod, slug, kind) => WSPC.memberDocIris(RELAY, memberPod, convenerPod, slug, kind);',
    'const parseAcceptanceIri = (iri, memberPod) => WSPC.parseAcceptanceIri(RELAY, iri, memberPod);',
    '/* `entryTurtle` keeps its four positional arguments here because every call site below',
    '   passes them that way; the module takes an object, and the mapping is generated so the',
    '   two orderings cannot come apart. WORKSPACE is read at call time, not bound here: it',
    '   changes when the viewer opens a different workspace. */',
    'const entryTurtle = (streamIri, seq, body, prior) =>',
    '  WSPC.entryTurtle({ streamIri: streamIri, workspace: WORKSPACE, seq: seq, body: body, prior: prior || null });',
    END,
  ].join('\n');
}

function splice(html, generated) {
  const from = html.indexOf(BEGIN);
  const to = html.indexOf(END);
  if (from < 0 || to < 0) throw new Error('the artifact carries no BEGIN/END GENERATED markers');
  return html.slice(0, from) + generated + html.slice(to + END.length);
}

if (process.argv[1] && process.argv[1].endsWith('build-workspace-artifact.mjs')) {
  const mode = process.argv[2] ?? '';
  const generated = await block();
  if (mode === '--print') { process.stdout.write(generated); process.exit(0); }
  const html = readFileSync(ARTIFACT, 'utf8');
  const next = splice(html, generated);
  if (mode === '--check') {
    if (next !== html) {
      console.error('DRIFT: applications/shared-workspace/artifact/channel.html does not match a fresh build of packages/workspace-client.');
      console.error('Run: node tools/build-workspace-artifact.mjs');
      process.exit(1);
    }
    console.log('artifact generated block matches packages/workspace-client');
    process.exit(0);
  }
  writeFileSync(ARTIFACT, next);
  console.log('wrote', ARTIFACT, '(' + generated.length + ' generated bytes)');
}
