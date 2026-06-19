/**
 * course ↔ skills.md bridge tests: a course projects to an agent skill, a skills.md
 * ingests as a course, and the round-trip preserves the capability's concepts.
 */
import { describe, it, expect } from 'vitest';
import { courseToSkillMd, parseSkillMd, skillMdToAgenticCourse } from '../src/course-skill-bridge.js';
import type { FoxxiAgenticCourse } from '../src/agentic-rag.js';

const course: FoxxiAgenticCourse = {
  courseIri: 'urn:foxxi:course:golf', title: 'Golf Explained', courseLabel: 'Golf Explained', courseId: 'golf',
  authoritativeSource: 'urn:foxxi:course:golf',
  concepts: [
    { id: 'handicapping', label: 'Handicapping', confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: ['s1'], total_freq: 1 },
    { id: 'etiquette', label: 'Etiquette', confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: ['s2'], total_freq: 1 },
  ],
  slides: [
    { id: 's1', title: 'Overview', sequence_index: 0, concept_ids: ['handicapping'], transcript_combined: 'A golf handicap is a numerical measure of a player\'s ability used to level competition.' },
    { id: 's2', title: 'Course', sequence_index: 1, concept_ids: ['etiquette'], transcript_combined: 'Etiquette covers behavior on the course: pace of play and respect for others.' },
  ],
  modifier_pairs: [], prereq_edges: [],
};

describe('courseToSkillMd', () => {
  it('emits a valid SKILL.md with frontmatter + concept knowledge + provenance', () => {
    const { skillMd, name } = courseToSkillMd(course, { tool: 'Foxxi (agent-authored)', authoredBy: 'did:ethr:0xabc', holonUri: 'urn:pgsl:fragment:deadbeef', courseId: 'golf' });
    expect(name).toBe('golf-explained');
    expect(skillMd).toMatch(/^---\nname: golf-explained\ndescription: .+\n---/);
    expect(skillMd).toContain('## What you\'ll be able to do');
    expect(skillMd).toContain('Handicapping');
    expect(skillMd).toContain('numerical measure'); // real course content distilled in
    expect(skillMd).toContain('## Provenance');
    expect(skillMd).toContain('urn:pgsl:fragment:deadbeef');
  });
});

describe('parseSkillMd', () => {
  it('parses frontmatter + ## sections', () => {
    const md = `---\nname: extend-a-standard\ndescription: How to extend a standard in Interego/Foxxi.\n---\n\n# Extend a standard\n\n## Discover guidance\nFind the /guidance catalog first.\n\n## Call the affordance\nUse extend_standards; what you did rides in the object.`;
    const p = parseSkillMd(md);
    expect(p.name).toBe('extend-a-standard');
    expect(p.description).toMatch(/extend a standard/i);
    expect(p.sections.map(s => s.heading)).toEqual(['Discover guidance', 'Call the affordance']);
    expect(p.sections[1].body).toContain('extend_standards');
  });
  it('handles a body with no sections', () => {
    const p = parseSkillMd(`---\nname: x\ndescription: y\n---\nJust a flat instruction with no headings.`);
    expect(p.sections.length).toBe(1);
    expect(p.sections[0].body).toContain('flat instruction');
  });
});

describe('skillMdToAgenticCourse', () => {
  it('ingests a skills.md into a course graph (sections → concepts + slides)', () => {
    const md = `---\nname: extend-a-standard\ndescription: How to extend a standard.\n---\n## Discover guidance\nFind the /guidance catalog.\n## Call the affordance\nUse extend_standards on your pod.`;
    const r = skillMdToAgenticCourse(md, { courseIri: 'urn:s', authoritativeSource: 'urn:s' });
    const labels = r.course.concepts.map(c => c.label);
    expect(labels[0]).toBe('Extend A Standard'); // the skill name = the overall capability concept
    expect(labels).toContain('Discover guidance');
    expect(labels).toContain('Call the affordance');
    expect(r.course.slides.length).toBe(2);
    expect(r.parsed.name).toBe('extend-a-standard');
    expect(r.spineTerms).toContain('Discover guidance');
  });
});

describe('parseSkillMd robustness (adversarial-review regressions)', () => {
  it('an empty name field does NOT swallow the next line', () => {
    const p = parseSkillMd(`---\nname:\ndescription: The real description.\n---\n## A\nbody`);
    expect(p.name).toBe('');                       // not "The real description."
    expect(p.description).toBe('The real description.');
  });
  it('does NOT strip a mid-section `# ` line (only a leading title)', () => {
    const p = parseSkillMd(`---\nname: s\ndescription: d\n---\n## Setup\nlorem\n# Important: never skip\nthen continue.\n## Teardown\ntear`);
    expect(p.sections[0].body).toContain('Important: never skip');
  });
  it('does NOT treat `## ` inside a fenced code block as a heading', () => {
    const p = parseSkillMd('---\nname: s\ndescription: d\n---\n## Real\nbefore\n```md\n## not a real heading\n```\nafter\n## Second\nx');
    expect(p.sections.map(s => s.heading)).toEqual(['Real', 'Second']);
    expect(p.sections[0].body).toContain('not a real heading'); // the fenced content is preserved in the body
  });
  it('symbol-only headings do not collapse onto one id', () => {
    const r = skillMdToAgenticCourse('---\nname: s\ndescription: d\n---\n## ***\nalpha\n## ---\nbeta', { courseIri: 'u', authoritativeSource: 'u' });
    const sectionConcepts = r.course.concepts.filter(c => c.id.startsWith('section-'));
    expect(sectionConcepts.length).toBe(2); // two distinct sections, not merged
  });
  it('emitted skill resists structural injection from a malicious course title', () => {
    const evil = { ...course, title: '---\nname: evil\n---\n## injected' };
    const { skillMd } = courseToSkillMd(evil);
    // the injected newlines/frontmatter collapse to one safe line under the real heading
    expect(skillMd.match(/^---$/gm)?.length).toBe(2); // only the real frontmatter fences
    expect(skillMd).not.toMatch(/\n## injected/);
  });
});

describe('round-trip course → skills.md → course preserves concepts', () => {
  it('keeps the concept set across the round trip', () => {
    const { skillMd } = courseToSkillMd(course);
    const back = skillMdToAgenticCourse(skillMd, { courseIri: 'urn:rt', authoritativeSource: 'urn:rt' });
    // the "What you'll be able to do" + "Key knowledge" sections become concepts; the
    // original concept labels survive inside the body text.
    expect(skillMd).toContain('Handicapping');
    expect(skillMd).toContain('Etiquette');
    expect(back.course.concepts.length).toBeGreaterThan(0);
    const joined = back.course.slides.map(s => s.transcript_combined).join(' ');
    expect(joined).toContain('Handicapping');
    expect(joined).toContain('Etiquette');
  });
});
