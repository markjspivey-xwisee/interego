# @interego/skills

agentskills.io <-> iep:Affordance bidirectional translator. Parses + emits skill.md frontmatter; maps to descriptor bundles.

Particular composition over the `@interego/core` substrate — see
`docs/ARCHITECTURAL-FOUNDATIONS.md §12` for the substrate-vs-vertical
split that motivates this package boundary.

`tools/build-skills.ts` at the repository root uses `emitSkillMd` and `parseSkillMd` to derive one skill per vertical from its `affordances.ts`, published under `docs/skills/`.
