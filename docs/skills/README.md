# Interego skills

One agentskills.io skill per vertical, each derived from that vertical's `affordances.ts` by `tools/build-skills.ts`. The SKILL.md says what the vertical is for, how to invoke any affordance, and lists them; the `reference.md` beside it carries every description and input. They are regenerated whenever the declarations change, and `tests/skills-from-affordances.test.ts` fails when a committed file differs from a fresh build.

| Skill | Vertical | Affordances | Bridge | Files |
| --- | --- | --- | --- | --- |
| `interego-foxxi` | Foxxi content intelligence, learner surface | 38 | `https://foxxi-bridge.interego.xwisee.com` | [SKILL.md](foxxi/SKILL.md), [reference.md](foxxi/reference.md) |
| `interego-foxxi-admin` | Foxxi content intelligence, administration | 73 | `https://foxxi-bridge.interego.xwisee.com` | [SKILL.md](foxxi-admin/SKILL.md), [reference.md](foxxi-admin/reference.md) |
| `interego-llm-telemetry` | LLM telemetry | 8 | `https://foxxi-bridge.interego.xwisee.com` | [SKILL.md](llm-telemetry/SKILL.md), [reference.md](llm-telemetry/reference.md) |
| `interego-jev-harness` | jev-harness development judgments | 9 | `https://jev-harness-bridge-production.up.railway.app` | [SKILL.md](jev-harness/SKILL.md), [reference.md](jev-harness/reference.md) |
| `interego-agentic-performance-practice` | Agentic performance practice | 12 | not public | [SKILL.md](agentic-performance-practice/SKILL.md), [reference.md](agentic-performance-practice/reference.md) |
| `interego-learner-performer-companion` | Learner-performer companion | 11 | not public | [SKILL.md](learner-performer-companion/SKILL.md), [reference.md](learner-performer-companion/reference.md) |
| `interego-organizational-working-memory` | Organizational working memory | 14 | not public | [SKILL.md](organizational-working-memory/SKILL.md), [reference.md](organizational-working-memory/reference.md) |
| `interego-agent-development-practice` | Agent development practice | 8 | not public | [SKILL.md](agent-development-practice/SKILL.md), [reference.md](agent-development-practice/reference.md) |
| `interego-agent-collective` | Agent collective | 5 | not public | [SKILL.md](agent-collective/SKILL.md), [reference.md](agent-collective/reference.md) |
| `interego-lrs-adapter` | LRS adapter | 4 | not public | [SKILL.md](lrs-adapter/SKILL.md), [reference.md](lrs-adapter/reference.md) |
| `interego-shared-workspace` | Shared workspace | 1 | `https://wsp-bridge-production.up.railway.app` | [SKILL.md](shared-workspace/SKILL.md), [reference.md](shared-workspace/reference.md) |

## Installing one

- **Claude Code**: copy the skill's directory to `.claude/skills/<name>/` in your project (or `~/.claude/skills/<name>/`); the skill is invoked as `/<name>` or when a task matches its description.
- **Codex, Cursor and other agentskills.io runtimes**: point the runtime at the directory, or paste `SKILL.md` into the agent's instructions; `reference.md` is loaded when the agent needs a full contract.
- **Any MCP client**: no install is needed. Connect the Interego relay or the stdio server and call `invoke_affordance` with the manifest URL and the action IRI each skill lists.

## Regenerating

```bash
npx tsx tools/build-skills.ts
```

Then commit `docs/skills/`. `npx tsx tools/build-skills.ts --check` exits 1 when a committed file would change.

