# Interego, live

A demo you run on your own machine and click through in your browser. Every call it makes goes to the deployed Interego services, with real identities, and appears in a ledger beside the story as it happens. Nothing is simulated.

```bash
npx tsx demos/live/server.ts
```

Then open <http://localhost:4747>.

## The cast

| Who | What they are | How they act |
| --- | --- | --- |
| **You** | Your own Interego identity | You sign in with your passkey on the relay's own page, the way a Claude connector does. The token comes back to this local process on a loopback redirect and never reaches the page. Everything done as you is the relay's `act` tool following a Foxxi affordance, signed by your session agent. |
| **Claude Code agent** | An agent with its own wallet and pod | It writes a course with Claude, publishes it with its wallet, offers it from its pod, and later tries a forgery. |
| **Verifier** | A fresh Claude | It gets only the skill generated from Foxxi's affordance declarations (`docs/skills/foxxi/`) and the bridge's MCP endpoint, in an empty directory with none of your settings, memory or plugins. |
| **Jev** | TypeSafe's System One model | It ranks the courses the walk found for what you want to learn: one Choice with a no-match option. |
| **Foxxi bridge** | `foxxi-bridge.interego.xwisee.com` | It grades, issues and verifies. |

## The story

1. **Sign in as yourself.** Your passkey signs you in on the relay. Then you authorize this app's session agent on your pod: your connection's `register_agent` writes a delegation credential there, so Foxxi can verify what the session signs. `revoke_agent` undoes it.
2. **An agent writes a course and offers it.** You name a topic. The Claude Code agent writes a short course with Claude and publishes it as a real SCORM 2004 package through `/agent/scorm/author`, with the answers hashed at authoring. Its pod then publishes a HyprCat `FederatedCatalog` offering it.
3. **Find it across pods.** Your connection reads each pod's manifest with the relay's ordinary `discover_context`. It finds catalogs by their type and reads each one's graph with `get_descriptor`. It checks each catalog's issuer against the pod's attribution. Jev then ranks the courses for your goal.
4. **Take the course.** The bridge's sequencing engine delivers each section and grades your answers against the author's hashes. Each launch and submit is your connection's `act`, signed as your session agent.
5. **Claim what you earned.** The tenant issues an Open Badges 3.0 credential from your own record, naming the evidence and the course's author. It goes into the wallet on your pod and is issued to you, not to the session agent.
6. **Hand it to an agent nobody briefed.** You send the Verifier a link to the credential in your wallet, the way a badge is shared. It loads the generated skill, finds `foxxi.verify_credential`, has the bridge read the credential from your pod, and reports every check. Tick "tamper" to hand it a JSON copy with one field changed instead; the page then shows every difference between what it checked and the credential in your wallet. A copy is fragile: in testing, an agent moved one field while retyping an untouched credential, and the signature check failed.
7. **Watch a forgery fail.** The Claude Code agent writes its own "passed" into its own record and asks for the same credential. The bridge refuses: the statement is in the record but carries no grading tag.

## What it needs

- **Node 20+** and `npm install` at the repository root. The demo uses only root dependencies.
- **The Claude Code CLI**, signed in. The Author and the Verifier run on your subscription. The demo finds the CLI you run, not the copy `node_modules` carries; `DEMO_CLAUDE_BIN` overrides it.
- **`TYPESAFE_API_KEY`** for Jev.
- **An agent wallet** at `DEMO_AGENT_KEY_FILE` (a JSON file holding `address` and `privateKey`). It defaults to the Claude Code agent's wallet on this machine. The key is read in-process and never printed or sent.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `DEMO_PORT` | `4747` | The local port. The loopback redirect follows it. |
| `DEMO_AGENT_KEY_FILE` | the Claude Code agent's wallet | Whose wallet the agent signs with. |
| `DEMO_AGENT_MODEL` | `sonnet` | The Claude model the Author and the Verifier run on. |
| `DEMO_CLAUDE_BIN` | the first `claude` on PATH outside `node_modules` | The Claude Code CLI to run. |
| `FOXXI_BRIDGE`, `INTEREGO_RELAY`, `INTEREGO_GATE` | the deployed services | Where the calls go. |
| `DEMO_YOU_WALLET` | unset | Testing only: sign "you" in with a wallet instead of a passkey, with no browser. |
| `DEMO_DEBUG` | unset | Testing only: print the course answers to this process's console. They never reach the page. |

## What it leaves behind

- **On your pod:** a delegation credential for the session agent, and the Open Badges credential in `foxxi-wallet/`.
- **In your record:** the graded statements, in the bridge's lens and in the shared lattice on your pod.
- **On the agent's pod:** the course with its answers hashed, its catalog, and the statement it forged. The refused claim writes nothing.

The ledger links each one. Every write is an ordinary Interego artifact you can read, share or delete like any other.
