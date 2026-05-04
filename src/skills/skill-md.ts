/**
 * @module skills/skill-md
 * @description SKILL.md (agentskills.io) frontmatter parser + emitter.
 *
 * Layer-3 implementation. The YAML frontmatter that agentskills.io
 * requires is a deliberately restricted subset (flat string fields plus
 * a single string→string `metadata` map). Rather than pull a full YAML
 * dependency just for that subset, we parse it directly. This keeps
 * @interego/core's "zero runtime deps" property intact and surfaces a
 * tiny, explicit format contract.
 *
 * Substrate framing: a SKILL.md is structurally a discoverable named
 * capability — i.e. a `cg:Affordance`. This module is purely the
 * frontmatter / body decomposition. The translation to a typed
 * descriptor lives in `agentskills-bridge.ts`.
 *
 * Spec reference: https://agentskills.io/specification
 */

/**
 * The validated, parsed SKILL.md frontmatter. Every field is optional
 * here — validation happens in {@link parseSkillMd}, which yields a
 * separate validation error list. That separation lets callers decide
 * how strict to be (a viewer can render a skill with a warning; the
 * publish path MUST refuse on errors).
 */
export interface SkillFrontmatter {
  /** name field — required; matches /^[a-z0-9](?:[a-z0-9-](?!--))*[a-z0-9]?$/ up to 64 chars */
  readonly name: string;
  /** description field — required; 1-1024 chars */
  readonly description: string;
  /** Optional license name or LICENSE-file reference */
  readonly license?: string;
  /** Optional environment-requirements string, ≤500 chars */
  readonly compatibility?: string;
  /** Arbitrary string→string metadata block; opaque to the substrate */
  readonly metadata: ReadonlyMap<string, string>;
  /** Pre-approved tools (experimental in agentskills.io); space-separated string */
  readonly allowedTools?: string;
}

export interface SkillDocument {
  readonly frontmatter: SkillFrontmatter;
  /** Markdown body that appears AFTER the closing `---`. */
  readonly body: string;
}

export interface SkillValidationError {
  readonly field: string;
  readonly message: string;
}

export interface SkillParseResult {
  readonly document: SkillDocument | null;
  readonly errors: readonly SkillValidationError[];
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;

/**
 * Parse the full SKILL.md text. Returns a structured result with both
 * the parsed document (if any) and the list of validation errors. A
 * SKILL.md MAY parse successfully and still have errors — callers
 * decide whether to publish anyway.
 */
export function parseSkillMd(source: string): SkillParseResult {
  const errors: SkillValidationError[] = [];

  // Frontmatter must start at offset 0 with '---' on its own line and
  // close with another '---' line. Anything else is a body-only file.
  if (!source.startsWith('---')) {
    errors.push({ field: '_frontmatter', message: 'SKILL.md must begin with a YAML frontmatter block (---)' });
    return { document: null, errors };
  }

  // Find the closing '---'
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') {
    errors.push({ field: '_frontmatter', message: 'opening "---" must be on its own line' });
    return { document: null, errors };
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) {
    errors.push({ field: '_frontmatter', message: 'unterminated YAML frontmatter (no closing ---)' });
    return { document: null, errors };
  }

  const fmLines = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join('\n').replace(/^\n+/, '');

  const fields = parseFlatYaml(fmLines, errors);

  // Validate required fields
  const name = fields.scalars.get('name');
  const description = fields.scalars.get('description');

  if (typeof name !== 'string' || name.length === 0) {
    errors.push({ field: 'name', message: 'name is required' });
  } else {
    if (name.length > NAME_MAX) {
      errors.push({ field: 'name', message: `name exceeds ${NAME_MAX} chars` });
    }
    if (!NAME_RE.test(name)) {
      errors.push({ field: 'name', message: 'name must be lowercase alphanumerics + single hyphens; no leading/trailing hyphen, no consecutive hyphens' });
    }
  }

  if (typeof description !== 'string' || description.length === 0) {
    errors.push({ field: 'description', message: 'description is required' });
  } else if (description.length > DESCRIPTION_MAX) {
    errors.push({ field: 'description', message: `description exceeds ${DESCRIPTION_MAX} chars` });
  }

  const license = fields.scalars.get('license');
  const compatibility = fields.scalars.get('compatibility');
  if (typeof compatibility === 'string' && compatibility.length > COMPATIBILITY_MAX) {
    errors.push({ field: 'compatibility', message: `compatibility exceeds ${COMPATIBILITY_MAX} chars` });
  }

  const allowedTools = fields.scalars.get('allowed-tools');

  if (errors.some(e => e.field === 'name' || e.field === 'description')) {
    return { document: null, errors };
  }

  const fm: SkillFrontmatter = {
    name: name as string,
    description: description as string,
    ...(typeof license === 'string' ? { license } : {}),
    ...(typeof compatibility === 'string' ? { compatibility } : {}),
    metadata: fields.metadata,
    ...(typeof allowedTools === 'string' ? { allowedTools } : {}),
  };

  return { document: { frontmatter: fm, body }, errors };
}

/**
 * Emit SKILL.md text from a structured document. Round-trips through
 * {@link parseSkillMd} for the supported field set.
 */
export function emitSkillMd(doc: SkillDocument): string {
  const fm = doc.frontmatter;
  const lines: string[] = ['---'];
  lines.push(`name: ${quoteIfNeeded(fm.name)}`);
  lines.push(`description: ${quoteIfNeeded(fm.description)}`);
  if (fm.license !== undefined) lines.push(`license: ${quoteIfNeeded(fm.license)}`);
  if (fm.compatibility !== undefined) lines.push(`compatibility: ${quoteIfNeeded(fm.compatibility)}`);
  if (fm.metadata.size > 0) {
    lines.push('metadata:');
    for (const [k, v] of fm.metadata) lines.push(`  ${k}: ${quoteIfNeeded(v)}`);
  }
  if (fm.allowedTools !== undefined) lines.push(`allowed-tools: ${quoteIfNeeded(fm.allowedTools)}`);
  lines.push('---');
  if (doc.body.length > 0) {
    lines.push('');
    lines.push(doc.body);
  }
  return lines.join('\n');
}

// ── Tiny YAML subset parser ───────────────────────────────────────────
//
// The agentskills.io frontmatter is intentionally restricted to:
//   - flat string scalars: name, description, license, compatibility, allowed-tools
//   - a single nested string→string map: metadata
//
// This parser handles exactly that. Inputs the spec doesn't allow
// (lists, deeper nesting) become validation errors. Strings may be
// either bare, single-quoted, or double-quoted; multi-line strings via
// `|` or `>` are NOT supported (the spec doesn't need them).

interface ParsedFields {
  readonly scalars: ReadonlyMap<string, string>;
  readonly metadata: ReadonlyMap<string, string>;
}

function parseFlatYaml(lines: readonly string[], errors: SkillValidationError[]): ParsedFields {
  const scalars = new Map<string, string>();
  const metadata = new Map<string, string>();
  let inMetadata = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    const isIndented = /^\s+\S/.test(raw);
    if (isIndented) {
      if (!inMetadata) {
        errors.push({ field: '_frontmatter', message: `unexpected indentation on line ${i + 1}: nested values are only allowed under metadata:` });
        continue;
      }
      const m = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
      if (!m) {
        errors.push({ field: 'metadata', message: `cannot parse metadata entry on line ${i + 1}` });
        continue;
      }
      metadata.set(m[1]!, unquote(m[2]!));
      continue;
    }

    inMetadata = false;
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) {
      errors.push({ field: '_frontmatter', message: `cannot parse line ${i + 1}` });
      continue;
    }
    const key = m[1]!;
    const valueRaw = m[2]!;

    if (key === 'metadata') {
      if (valueRaw.trim().length === 0) {
        inMetadata = true;
      } else {
        // inline mapping not supported in this subset
        errors.push({ field: 'metadata', message: 'metadata must use a block mapping; inline mappings are not supported' });
      }
      continue;
    }
    scalars.set(key, unquote(valueRaw));
  }

  return { scalars, metadata };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const inner = trimmed.slice(1, -1);
    return inner
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
  }
  return trimmed;
}

function quoteIfNeeded(value: string): string {
  if (value === '') return '""';
  // Quote if contains special YAML chars, leading/trailing whitespace, or ':'
  if (/[:#&*!|>'"%@`\n\r\t]/.test(value) || /^\s|\s$/.test(value)) {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return value;
}
