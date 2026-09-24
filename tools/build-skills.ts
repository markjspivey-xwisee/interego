/**
 * Every affordance as an agent skill.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * Each vertical declares its capabilities once, as iep:Affordance entries in its
 * `affordances.ts`, and the bridges derive everything else from that file: the Turtle
 * manifest, the MCP tool schemas, the SHACL input shapes, the OpenAPI document. The one
 * derivation missing on 2026-09-24 was the form agent runtimes actually load: an
 * agentskills.io SKILL.md. The only skill in the tree was written by hand for jev-harness, so
 * an agent in Claude Code, Codex or Cursor could use one vertical of ten, and only after a
 * person had typed its instructions out.
 *
 * This tool derives one skill per vertical from the same declarations, with @interego/skills
 * emitting the frontmatter, and writes them under docs/skills/ where GitHub Pages serves
 * them. The SKILL.md is short — what the vertical is for, how to invoke any of its
 * affordances, and a table of them — and the full contract (every description, every input)
 * sits beside it in reference.md, loaded on demand. `tests/skills-from-affordances.test.ts`
 * fails when the committed files differ from a fresh build, so the published skills cannot
 * drift from the declarations.
 *
 *   npx tsx tools/build-skills.ts            # write docs/skills/**
 *   npx tsx tools/build-skills.ts --check    # exit 1 when a committed file would change
 *   npx tsx tools/build-skills.ts --list     # print the skills and their sizes
 */
import { emitSkillMd, parseSkillMd, type SkillDocument } from '@interego/skills';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Affordance } from '../applications/_shared/affordance-mcp/index.js';

/** One skill: a vertical, the affordance arrays it declares, and how a runtime reaches its bridge. */
export interface SkillSource {
  /** The skill's name is `interego-<slug>`. */
  readonly slug: string;
  readonly title: string;
  /** Directory under applications/ that holds the affordances.ts. */
  readonly dir: string;
  /** The exported affordance arrays to read, in order. */
  readonly exports: readonly string[];
  /** The vertical segment of the action IRIs that belong to this skill (`urn:iep:action:<vertical>:…`). */
  readonly vertical: string;
  /** When an agent should reach for this skill; becomes the frontmatter description's second sentence. */
  readonly use: string;
  /** The deployed bridge, when one is public; `{base}` in the targets is this origin. */
  readonly bridge?: string;
  /** Whether the bridge serves `POST /mcp` and `/affordances/<tool>/input` (every createVerticalBridge vertical does). */
  readonly mcp: boolean;
  /** A hand-written skill that guides the same vertical end to end, when one exists. */
  readonly guide?: string;
}

export const SKILL_SOURCES: readonly SkillSource[] = [
  { slug: 'foxxi', title: 'Foxxi content intelligence, learner surface', dir: 'foxxi-content-intelligence', exports: ['foxxiAffordances'], vertical: 'foxxi', mcp: true, bridge: 'https://foxxi-bridge.interego.xwisee.com',
    use: 'Use when a learner or an agent acting for one needs their assigned courses, a course\'s concept map or context, an answer grounded in course content, a credential, a learner record, a SCORM or cmi5 session, or private performance feedback on an Interego pod.' },
  { slug: 'foxxi-admin', title: 'Foxxi content intelligence, administration', dir: 'foxxi-content-intelligence', exports: ['foxxiAdminAffordances'], vertical: 'foxxi', mcp: true, bridge: 'https://foxxi-bridge.interego.xwisee.com',
    use: 'Use when administering a Foxxi tenant: ingesting SCORM, cmi5 or xAPI packages, assigning audiences, publishing policies and ontologies, running coverage and audit queries, issuing credentials, judging and confirming content claims, or connecting an LMS.' },
  { slug: 'llm-telemetry', title: 'LLM telemetry', dir: 'llm-telemetry', exports: ['telemetryAffordances'], vertical: 'llm-telemetry', mcp: true, bridge: 'https://foxxi-bridge.interego.xwisee.com',
    use: 'Use when observing an agent\'s own model calls as xAPI: capturing sessions and turns, querying and reporting on them, finding capture gaps, or exporting the observation stream. Served by the Foxxi bridge.' },
  { slug: 'jev-harness', title: 'jev-harness development judgments', dir: 'jev-harness', exports: ['jevHarnessAffordances'], vertical: 'jev-harness', mcp: false, bridge: 'https://jev-harness-bridge-production.up.railway.app', guide: 'applications/jev-harness/claude-skill/SKILL.md',
    use: 'Use when developing in a repository the bridge is bound to: where a task\'s change belongs, which tests to run after it, why a run failed, whether a diff needs a person, and recording the outcomes so the judgments calibrate.' },
  { slug: 'agentic-performance-practice', title: 'Agentic performance practice', dir: 'agentic-performance-practice', exports: ['agpAffordances'], vertical: 'agp', mcp: true,
    use: 'Use when an agent plans and records a performance intervention: reading the method catalogue, contextualising a task, choosing an intervention, recording what happened and how it turned out, and attesting readiness.' },
  { slug: 'learner-performer-companion', title: 'Learner-performer companion', dir: 'learner-performer-companion', exports: ['lpcAffordances', 'lpcEnterpriseAffordances'], vertical: 'lpc', mcp: true,
    use: 'Use when accompanying a learner-performer: ingesting training content, tracking learning experiences, importing credentials into a learner wallet, and publishing authoritative enterprise content and cohort credential templates.' },
  { slug: 'organizational-working-memory', title: 'Organizational working memory', dir: 'organizational-working-memory', exports: ['owmAffordances', 'owmOperatorAffordances'], vertical: 'owm', mcp: true,
    use: 'Use when keeping an organisation\'s working memory on pods: people, decisions, commitments and their context, and the operator\'s aggregate queries over them.' },
  { slug: 'agent-development-practice', title: 'Agent development practice', dir: 'agent-development-practice', exports: ['adpAffordances'], vertical: 'adp', mcp: true,
    use: 'Use when an agent is developing itself deliberately: defining a capability, practising it, recording the attempt and the evidence, and reviewing what changed.' },
  { slug: 'agent-collective', title: 'Agent collective', dir: 'agent-collective', exports: ['acAffordances'], vertical: 'ac', mcp: true,
    use: 'Use when agents build for each other: authoring a tool, publishing it to the collective, discovering and adopting what other agents authored.' },
  { slug: 'lrs-adapter', title: 'LRS adapter', dir: 'lrs-adapter', exports: ['lrsAffordances'], vertical: 'lrs', mcp: true,
    use: 'Use at the boundary between xAPI learning record stores and Interego pods: ingesting statements as descriptors, projecting descriptors out to an LRS, and querying the experience index.' },
  { slug: 'shared-workspace', title: 'Shared workspace', dir: 'shared-workspace', exports: ['wspAffordances'], vertical: 'wsp', mcp: true, bridge: 'https://wsp-bridge-production.up.railway.app',
    use: 'Use when an agent takes part in a shared workspace channel as a member, answering in its own name without taking custody of what others wrote.' },
];

export interface LoadedSkill {
  readonly source: SkillSource;
  readonly affordances: readonly Affordance[];
}

/** The vertical segment of an action IRI, in its urn or its dereferenceable URL form. */
export function actionVertical(action: string): string {
  const tail = action.replace(/^urn:iep:action:/, '').replace(/^https?:\/\/[^/]+\/ns\/iep\/action\//, '');
  return tail.split(/[:/]/)[0] ?? '';
}

/** The verb of an action IRI: the last segment. */
export function actionVerb(action: string): string {
  const parts = action.split(/[:/]/);
  return parts[parts.length - 1] ?? action;
}

/** Every skill's affordances, read from the verticals' own declarations, each affordance in the skill whose vertical its action names. */
export async function loadSkills(root: string, sources: readonly SkillSource[] = SKILL_SOURCES): Promise<LoadedSkill[]> {
  const loaded: LoadedSkill[] = [];
  for (const source of sources) {
    const file = join(root, 'applications', source.dir, 'affordances.ts');
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const seen = new Set<string>();
    const affordances: Affordance[] = [];
    for (const name of source.exports) {
      const arr = mod[name];
      if (!Array.isArray(arr)) throw new Error(`${source.dir}/affordances.ts exports no array named ${name}`);
      for (const a of arr as Affordance[]) {
        if (actionVertical(a.action) !== source.vertical || seen.has(a.toolName)) continue;
        seen.add(a.toolName);
        affordances.push(a);
      }
    }
    loaded.push({ source, affordances });
  }
  return loaded;
}

const DESCRIPTION_MAX = 1024;

/** The first sentence of a description, for the table; the full text is in the reference. */
export function firstSentence(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(flat);
  const s = m?.[1] ?? flat;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const target = (a: Affordance, bridge: string | undefined): string => a.targetTemplate.replace('{base}', bridge ?? '{base}');
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The frontmatter description: what the vertical offers, then when to use it, within the agentskills.io budget. */
export function skillDescription(source: SkillSource, affordances: readonly Affordance[]): string {
  const verbs = affordances.map((a) => actionVerb(a.action));
  let sample = verbs.slice(0, 6).join(', ');
  const head = (): string => `${source.title} as Interego affordances: ${affordances.length} tools (${sample}${verbs.length > 6 ? ', and more' : ''}). `;
  while (head().length + source.use.length > DESCRIPTION_MAX && sample.includes(', ')) sample = sample.slice(0, sample.lastIndexOf(', '));
  return `${head()}${source.use}`;
}

/** The short skill: purpose, how to invoke, and the table of affordances. */
export function skillDocument(source: SkillSource, affordances: readonly Affordance[]): SkillDocument {
  const bridge = source.bridge;
  const manifest = `${bridge ?? '{base}'}/affordances`;
  const metadata = new Map<string, string>([
    ['vertical', source.dir],
    ['source', `applications/${source.dir}/affordances.ts`],
    ['affordances', String(affordances.length)],
    ['manifest', manifest],
    ['generator', 'tools/build-skills.ts'],
  ]);
  const lines: string[] = [];
  lines.push(`# ${source.title}`, '', source.use, '');
  lines.push(
    `Everything here is derived from \`applications/${source.dir}/affordances.ts\`, the vertical's single source of truth, by \`tools/build-skills.ts\`; do not edit it by hand. The live contract is the bridge's manifest at \`${manifest}\` (Turtle; \`?format=jsonld\` or \`?format=markdown\` for other projections)${source.mcp ? `, and each tool's input contract is at \`${bridge ?? '{base}'}/affordances/<tool>/input\` (JSON Schema, or SHACL with \`?format=shacl\`)` : ''}. Full descriptions and inputs for every affordance: [reference.md](reference.md).`,
    '',
  );
  if (!bridge) lines.push('`{base}` is the origin of a deployment of this vertical\'s bridge; none is public at the time of generation.', '');
  if (source.guide) lines.push(`A hand-written skill guides this vertical end to end, with the flow an agent should follow: [\`${source.guide}\`](../../../${source.guide}). Prefer it; this file is the complete list of what the bridge offers.`, '');
  lines.push('## How to invoke', '');
  lines.push(`1. **Through any Interego MCP connector** (the relay or the stdio server): call \`invoke_affordance\` with \`descriptor_url\` = \`${manifest}\`, \`action_iri\` = the affordance's action IRI below, and \`payload\` = its inputs. The connector follows \`hydra:target\` for you. An affordance whose description says the request must be signed needs \`sign_request\` first.`);
  if (source.mcp) lines.push(`2. **Through the bridge's own MCP endpoint**: \`POST ${bridge ?? '{base}'}/mcp\` with JSON-RPC \`tools/call\`, \`name\` = the tool name, \`arguments\` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.`);
  lines.push(`${source.mcp ? 3 : 2}. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).`, '');
  lines.push('Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.', '');
  lines.push('## Affordances', '');
  lines.push('| Tool | Does | Invoke |', '| --- | --- | --- |');
  for (const a of affordances) {
    const note = a.externallyRouted && source.mcp ? ' *(HTTP only)*' : '';
    lines.push(`| \`${a.toolName}\` | ${cell(firstSentence(a.description))} | \`${a.method} ${cell(target(a, bridge))}\`${note} |`);
  }
  lines.push('');
  return { frontmatter: { name: `interego-${source.slug}`, description: skillDescription(source, affordances), license: 'MIT', metadata }, body: `${lines.join('\n')}\n` };
}

/** The reference beside the skill: every affordance in full. */
export function referenceMarkdown(source: SkillSource, affordances: readonly Affordance[]): string {
  const bridge = source.bridge;
  const lines: string[] = [];
  lines.push(`# ${source.title}: every affordance`, '', `Derived from \`applications/${source.dir}/affordances.ts\` by \`tools/build-skills.ts\`; the skill is [SKILL.md](SKILL.md). ${affordances.length} affordances.`, '');
  for (const a of affordances) {
    lines.push(`## \`${a.toolName}\``, '', `**${a.title}**`, '', a.description.replace(/\r\n/g, '\n').trim(), '');
    lines.push(`- Action: \`${a.action}\``);
    lines.push(`- HTTP: \`${a.method} ${target(a, bridge)}\`${a.externallyRouted ? ' (served by a bespoke route; not through the bridge\'s MCP endpoint)' : ''}`);
    if (a.inputShape) lines.push(`- Input shape: \`${a.inputShape}\``);
    if (a.returns) lines.push(`- Returns: \`${a.returns}\``);
    if (a.mediaType) lines.push(`- Media type: \`${a.mediaType}\``);
    if (a.inputs.length === 0) lines.push('- Inputs: none');
    lines.push('');
    if (a.inputs.length > 0) {
      lines.push('| Input | Type | Required | Description |', '| --- | --- | --- | --- |');
      for (const i of a.inputs) {
        const type = i.type === 'array' && i.itemType ? `array of ${i.itemType}` : i.enum ? `one of ${i.enum.map((e) => `\`${e}\``).join(', ')}` : i.type;
        lines.push(`| \`${i.name}\` | ${cell(type)} | ${i.required ? 'yes' : 'no'} | ${cell(i.description)} |`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The index of every skill, at docs/skills/README.md. */
export function indexMarkdown(skills: readonly LoadedSkill[]): string {
  const lines: string[] = [];
  lines.push('# Interego skills', '');
  lines.push('One agentskills.io skill per vertical, each derived from that vertical\'s `affordances.ts` by `tools/build-skills.ts`. The SKILL.md says what the vertical is for, how to invoke any affordance, and lists them; the `reference.md` beside it carries every description and input. They are regenerated whenever the declarations change, and `tests/skills-from-affordances.test.ts` fails when a committed file differs from a fresh build.', '');
  lines.push('| Skill | Vertical | Affordances | Bridge | Files |', '| --- | --- | --- | --- | --- |');
  for (const { source, affordances } of skills) {
    const bridge = source.bridge ? `\`${source.bridge}\`` : 'not public';
    lines.push(`| \`interego-${source.slug}\` | ${source.title} | ${affordances.length} | ${bridge} | [SKILL.md](${source.slug}/SKILL.md), [reference.md](${source.slug}/reference.md) |`);
  }
  lines.push('');
  lines.push('## Installing one', '');
  lines.push('- **Claude Code**: copy the skill\'s directory to `.claude/skills/<name>/` in your project (or `~/.claude/skills/<name>/`); the skill is invoked as `/<name>` or when a task matches its description.', '- **Codex, Cursor and other agentskills.io runtimes**: point the runtime at the directory, or paste `SKILL.md` into the agent\'s instructions; `reference.md` is loaded when the agent needs a full contract.', '- **Any MCP client**: no install is needed. Connect the Interego relay or the stdio server and call `invoke_affordance` with the manifest URL and the action IRI each skill lists.', '');
  lines.push('## Regenerating', '', '```bash', 'npx tsx tools/build-skills.ts', '```', '', 'Then commit `docs/skills/`. `npx tsx tools/build-skills.ts --check` exits 1 when a committed file would change.', '');
  return `${lines.join('\n')}\n`;
}

/** Every file the build produces, keyed by path relative to the repository root, with LF line endings. */
export async function buildSkills(root: string, sources: readonly SkillSource[] = SKILL_SOURCES): Promise<Map<string, string>> {
  const skills = await loadSkills(root, sources);
  const files = new Map<string, string>();
  for (const skill of skills) {
    const doc = skillDocument(skill.source, skill.affordances);
    const md = emitSkillMd(doc);
    const parsed = parseSkillMd(md);
    if (parsed.errors.length > 0) throw new Error(`interego-${skill.source.slug}: ${parsed.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
    files.set(`docs/skills/${skill.source.slug}/SKILL.md`, md);
    files.set(`docs/skills/${skill.source.slug}/reference.md`, referenceMarkdown(skill.source, skill.affordances));
  }
  files.set('docs/skills/README.md', indexMarkdown(skills));
  return files;
}

/** The files under docs/skills that a build did not produce: stale skills from a removed vertical. */
export function strayFiles(root: string, built: ReadonlyMap<string, string>): string[] {
  const dir = join(root, 'docs', 'skills');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(root, p).split('\\').join('/');
        if (!built.has(rel)) out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

async function main(): Promise<void> {
  const root = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const mode = process.argv[2] ?? '';
  const files = await buildSkills(root);
  if (mode === '--list') {
    for (const [p, c] of files) console.log(`${String(Buffer.byteLength(c)).padStart(7)} ${p}`);
    return;
  }
  const changed: string[] = [];
  for (const [p, c] of files) {
    const abs = join(root, p);
    if (!existsSync(abs) || readFileSync(abs, 'utf8') !== c) changed.push(p);
  }
  const stray = strayFiles(root, files);
  if (mode === '--check') {
    for (const p of changed) console.log(`would change: ${p}`);
    for (const p of stray) console.log(`not produced by the build: ${p}`);
    if (changed.length > 0 || stray.length > 0) process.exit(1);
    console.log(`docs/skills is current: ${files.size} files`);
    return;
  }
  for (const p of changed) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, files.get(p) ?? '');
  }
  console.log(`wrote ${changed.length} of ${files.size} files under docs/skills${stray.length > 0 ? `; ${stray.length} stray file(s) not produced by the build: ${stray.join(', ')}` : ''}`);
}

if (process.argv[1] && basename(process.argv[1]) === 'build-skills.ts') {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
