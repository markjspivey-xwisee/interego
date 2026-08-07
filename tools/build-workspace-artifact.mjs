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
    '/* The vocabulary IRI. It was a literal in this page AND a constant in the module, spelled',
    '   identically — and the two were only ever going to stay identical by luck. Every `wsp:`',
    '   term the readers resolve expands against the module\'s copy, so a page writing documents',
    '   in a namespace one character different from the one its own reader expands would produce',
    '   graphs that parse, publish, and then fold into nothing. One constant. */',
    'const WSP = WSPC.WSP, IEP = WSPC.IEP;',
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
    '',
    '/* ══ THE PAGE\'S ONE SUBSTRATE CLIENT ═══════════════════════════════════════',
    '   Every read and every write below goes through ONE WSPC.WorkspaceClient over ONE',
    '   WSPC.ConnectorTransport. This page used to carry its own `tool`, `resolveServer`,',
    '   `currentHead`, `descriptor`, `manifest`, `resolveMemberDoc`, `publishAndConfirm`,',
    '   `fetchProfileTurtle`, its own roster fold and its own append — the same calls the module',
    '   already made for the desktop shell, written a second time because each one was',
    '   interleaved with the panel that reports it. Two copies of one intention is how every',
    '   drift defect in this vertical happened: a reader hardened in one place, the bug kept in',
    '   the other. The calls are the module\'s now and the panels are still the page\'s — every',
    '   binding below is a NAME, never a reimplementation, so a fix to one of them cannot arrive',
    '   in only one of the two clients. */',
    'let CLIENT = null;',
    '/* Assigned once, here, because the connector\'s display name is not known until it answers.',
    '   `mcp()` is the page\'s — the host object is the one thing a page must supply. */',
    'async function resolveServer() {',
    '  const m = mcp();',
    '  if (!m) throw WSPC.fail("capability_disabled", "This view was served without connector access.");',
    '  CLIENT = new WSPC.WorkspaceClient(RELAY, new WSPC.ConnectorTransport(m));',
    '  return CLIENT.connect();',
    '}',
    '/* The connector\'s DISPLAY NAME as it answered, never a literal in this page. */',
    'const connectorLabel = () => (CLIENT ? CLIENT.tx.label : "not resolved");',
    'const tool = (name, input, opts) => CLIENT.tool(name, input, opts);',
    'const currentHead = (urn, podName) => CLIENT.currentHead(urn, podName);',
    'const descriptor = (url) => CLIENT.descriptor(url);',
    'const manifest = (podName, graphIri) => CLIENT.manifest(podName, graphIri);',
    'const resolveMemberDoc = (memberPod, convenerPod, slug, kind) => CLIENT.resolveMemberDoc(memberPod, convenerPod, slug, kind);',
    'const fetchProfileTurtle = (iri) => CLIENT.fetchProfileTurtle(iri);',
    'const publishAndConfirm = (args, podName, graphIri, onState) => CLIENT.publishAndConfirm(args, podName, graphIri, onState);',
    'const readWorkspaceRecord = (iri, ownerPod) => CLIENT.readWorkspaceRecord(iri, ownerPod);',
    'const foldRoster = (args) => WSPC.foldRoster(CLIENT, args);',
    'const postEntry = (args) => WSPC.postEntry(CLIENT, args);',
    'const toChainRow = WSPC.toChainRow, grantPodFor = WSPC.grantPodFor;',
    '/* The live watch and the cache drop address the SAME tool the one-shot reads use, over the',
    '   same transport — so they inherit the transport\'s registration contract (a failed watch',
    '   returns null; it does not throw) instead of this page guessing at the host\'s. */',
    'const watchStream = (input, onEvent, opts) => CLIENT.tx.watchTool("discover_context", input, onEvent, opts);',
    'const invalidateStreams = () => CLIENT.tx.invalidate("discover_context");',
    '/* `entryShapeAnswer` keeps its one-argument shape because every call site below passes only',
    '   the shape. The record it reasons about is this page\'s settled read, held on S and read at',
    '   call time — binding it here would freeze the answer from before a workspace was opened. */',
    'const entryShapeAnswer = (shape) => WSPC.entryShapeAnswer(shape, S.recordResult, WORKSPACE);',
    '',
    '/* ══ MEMBERSHIP AND THE CANVAS — the second copy, deleted ══════════════════',
    '   Below the END marker this page carried its own `shapesTurtle`, `rolesTurtle`,',
    '   `workspaceTurtle`, `grantTurtle`, `acceptanceTurtle`, `canvasTurtle`, `resolveInvitee`,',
    '   `verifyGrantIri`, `findSeat`, `roleName`/`roleWhy`/`roleKnown`, its own inbox read, its',
    '   own list of the workspaces you are in, its own canvas read and its own head-wait — a',
    '   second copy of every decision the module was already making for the desktop shell. The',
    '   two had already come apart, in ways that cost more than tidiness:',
    '     · the page\'s six document writers interpolated IRIs with NO guard. A Turtle IRI',
    '       reference ends at the first ">" and the production has no escape for one, and',
    '       `resolveInvitee` reads the grantee WebID out of the INVITEE\'s own pod registry — so a',
    '       WebID carrying ">" closed the reference and every byte after it was parsed as further',
    '       triples, in a grant published on the CONVENER\'s pod under the convener\'s signature.',
    '       `documents.ts` refuses to serialise one; this page never looked.',
    '     · the page\'s `findSeat` computed a scan-saturation flag no caller ever read, so a scan',
    '       that came back full still reported "none of them names you" as a finding.',
    '     · the page\'s `awaitHead` and the module\'s disagreed about what licenses the word',
    '       "Saved" — the CID moving, or the head becoming YOUR descriptor.',
    '   The panels below are still the page\'s. The decisions are the module\'s, and every line',
    '   here is a NAME. Six of the module\'s functions are deliberately NOT bound —',
    '   `createWorkspace`, `sendInvite`, `acceptGrant`, `revokeGrant`, `saveCanvas` and',
    '   `mergeForward` — because the page keeps a function of each of those names whose whole',
    '   body is the panel that reports it, and a `const` of the same name in this scope is a',
    '   redeclaration; each of the six calls `WSPC.…` at exactly one site. `checkOwnHandle`',
    '   collides the same way and is bound under `ownHandleCheck` instead. */',
    'const turtleIri = WSPC.turtleIri;',
    'const shapesTurtle = WSPC.shapesTurtle, rolesTurtle = WSPC.rolesTurtle;',
    'const workspaceTurtle = WSPC.workspaceTurtle, grantTurtle = WSPC.grantTurtle;',
    'const acceptanceTurtle = WSPC.acceptanceTurtle, canvasTurtle = WSPC.canvasTurtle;',
    'const GRANT_IRI_RX = WSPC.GRANT_IRI_RX;',
    'const INBOX_LIMIT = WSPC.INBOX_LIMIT;',
    'const SEAT_SCAN_LIMIT = WSPC.SEAT_SCAN_LIMIT, SEAT_READ_CAP = WSPC.SEAT_READ_CAP;',
    'const awaitHead = WSPC.awaitHead, staleDetail = WSPC.staleDetail;',
    '/* ★ WHO WROTE AN ENTRY, which is not whose log it is in. A delegate writes into its',
    '   delegator\'s log and the entry names the delegate; a reader that labelled every entry',
    '   with its pod\'s owner would assert the one thing the distinction exists to stop',
    '   asserting. Bound rather than reimplemented for the reason this whole block exists: the',
    '   page had its own copies of these readers once, and every one of them drifted. */',
    'const readEntryAuthorship = WSPC.readEntryAuthorship, authorshipLine = WSPC.authorshipLine;',
    '/* `S.viewer` is read at CALL time and never captured here. It is null until boot resolves',
    '   it, and boot is RE-ENTRANT: the retry control on a startup failure calls it again and',
    '   replaces the object, so a viewer captured now would keep handing the module the previous',
    '   run\'s pod name and WebID — writes addressed to a pod this run never confirmed. */',
    'const readViewer = () => WSPC.readViewer(CLIENT);',
    'const composedHandle = () => WSPC.composedHandle(RELAY, S.viewer.podName);',
    'const ownHandleCheck = () => WSPC.checkOwnHandle(CLIENT, RELAY, S.viewer.podName);',
    'const checkWriteEligibility = () => WSPC.checkWriteEligibility(CLIENT, S.viewer);',
    'const resolveInvitee = (handle) => WSPC.resolveInvitee(CLIENT, handle);',
    'const verifyGrantIri = (grantIri, opts) =>',
    '  WSPC.verifyGrantIri(CLIENT, { relay: RELAY, viewer: S.viewer, grantIri: grantIri, nameMustTargetMe: opts && opts.nameMustTargetMe });',
    'const findSeat = (workspace) => WSPC.findSeat(CLIENT, { relay: RELAY, viewer: S.viewer, workspace: workspace });',
    'const readInbox = () => WSPC.readInbox(CLIENT);',
    'const verifyInvitation = (inv) => WSPC.verifyInvitation(CLIENT, RELAY, S.viewer, inv);',
    'const listWorkspaces = (podName) => WSPC.listWorkspaces(CLIENT, RELAY, podName);',
    'const verifyWorkspaceEntry = (entry) => WSPC.verifyWorkspaceEntry(CLIENT, RELAY, S.viewer, entry);',
    'const readCanvas = (canvasIri, podName) => WSPC.readCanvas(CLIENT, canvasIri, podName);',
    '/* The role table is a DOCUMENT, read per workspace into S.roles/S.capLabels, so it is passed',
    '   at call time for the same reason: bound here it would freeze the table from before any',
    '   workspace was open, which is no table at all — and "no table" is the state in which every',
    '   one of these four says so rather than falling back to the role IRI\'s fragment. */',
    'const roleName = (iri) => WSPC.roleName({ roles: S.roles, caps: S.capLabels }, iri);',
    'const roleWhy = (iri) => WSPC.roleWhy({ roles: S.roles, caps: S.capLabels }, iri);',
    'const roleKnown = (iri) => WSPC.roleKnown({ roles: S.roles, caps: S.capLabels }, iri);',
    'const checkRoleForWorkspace = (iri) => WSPC.checkRoleForWorkspace({ roles: S.roles, caps: S.capLabels }, iri);',
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
