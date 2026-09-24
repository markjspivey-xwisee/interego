/**
 * Every affordance as an agent skill: the committed skills under docs/skills are what a fresh
 * build of tools/build-skills.ts produces from the verticals' affordance declarations, every
 * SKILL.md parses under the agentskills.io rules the skills package enforces, and every
 * affordance a vertical declares appears in exactly one skill.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillMd } from '@interego/skills';
import { actionVerb, actionVertical, buildSkills, firstSentence, loadSkills, skillDescription, SKILL_SOURCES, strayFiles } from '../tools/build-skills.js';

const ROOT = join(import.meta.dirname, '..');

describe('the action IRI helpers', () => {
  it('read the vertical and the verb from a urn and from a dereferenceable URL', () => {
    expect(actionVertical('urn:iep:action:foxxi:judge-content-claim')).toBe('foxxi');
    expect(actionVertical('https://relay.interego.xwisee.com/ns/iep/action/wsp/respond-as-member')).toBe('wsp');
    expect(actionVerb('urn:iep:action:foxxi:judge-content-claim')).toBe('judge-content-claim');
    expect(actionVerb('https://relay.interego.xwisee.com/ns/iep/action/wsp/respond-as-member')).toBe('respond-as-member');
  });
  it('take the first sentence for the table and cut a long one', () => {
    expect(firstSentence('Judge a claim. Then more.')).toBe('Judge a claim.');
    expect(firstSentence('A short one')).toBe('A short one');
    expect(firstSentence(`${'x'.repeat(200)}.`)).toHaveLength(160);
  });
});

describe('the skills built from the declarations', () => {
  const skillsP = loadSkills(ROOT);
  const filesP = buildSkills(ROOT);

  it('cover every vertical once, and every declared affordance lands in exactly one skill', async () => {
    const skills = await skillsP;
    expect(skills.map((s) => s.source.slug)).toEqual(SKILL_SOURCES.map((s) => s.slug));
    const names = skills.flatMap((s) => s.affordances.map((a) => a.toolName));
    expect(new Set(names).size).toBe(names.length);
    for (const s of skills) expect(s.affordances.length, s.source.slug).toBeGreaterThan(0);
    // The telemetry tools are declared by llm-telemetry and re-exported through Foxxi's learner array; they belong to one skill.
    expect(skills.find((s) => s.source.slug === 'foxxi')?.affordances.some((a) => a.toolName.startsWith('llm_telemetry.'))).toBe(false);
    expect(skills.find((s) => s.source.slug === 'llm-telemetry')?.affordances).toHaveLength(8);
  });

  it('keep every frontmatter description within the agentskills.io budget and every SKILL.md parseable', async () => {
    const files = await filesP;
    for (const [path, content] of files) {
      if (!path.endsWith('SKILL.md')) continue;
      const parsed = parseSkillMd(content);
      expect(parsed.errors, path).toEqual([]);
      expect(parsed.document?.frontmatter.name).toBe(`interego-${path.split('/')[2]}`);
      expect(parsed.document?.frontmatter.description.length).toBeLessThanOrEqual(1024);
      expect(parsed.document?.frontmatter.metadata.get('generator')).toBe('tools/build-skills.ts');
      expect(content).not.toContain('\r');
    }
    const skills = await skillsP;
    const foxxi = skills.find((s) => s.source.slug === 'foxxi-admin');
    if (foxxi) expect(skillDescription(foxxi.source, foxxi.affordances).length).toBeLessThanOrEqual(1024);
  });

  it('are what is committed under docs/skills, with nothing stale beside them', async () => {
    const files = await filesP;
    const drift: string[] = [];
    for (const [path, content] of files) {
      const abs = join(ROOT, path);
      if (!existsSync(abs) || readFileSync(abs, 'utf8') !== content) drift.push(path);
    }
    expect(drift, 'run: npx tsx tools/build-skills.ts').toEqual([]);
    expect(strayFiles(ROOT, files)).toEqual([]);
  });
});
