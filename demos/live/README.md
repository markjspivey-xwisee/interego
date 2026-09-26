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
| **Claude Code agent** | An agent with its own wallet and pod | It writes a course with Claude, publishes it with its wallet and offers it from its pod. In part two it is a learner too: it takes your course, reading with Claude and signing with its wallet, and earns its own credential. It also tries a forgery. |
| **Verifier** | A fresh Claude | It gets only the skill generated from Foxxi's affordance declarations (`docs/skills/foxxi/`) and the bridge's MCP endpoint, in an empty directory with none of your settings, memory or plugins. |
| **Jev** | TypeSafe's System One model | It ranks the courses the walk found for what you want to learn, and later picks each learner's next course from their record alone. Each is one Choice with a no-match option. |
| **Foxxi bridge** | `foxxi-bridge.interego.xwisee.com` | It grades, issues and verifies. In part three it is also a cmi5 LMS and an LTI 1.3 LMS, launching courses for both learners. |

## The story

### Part one: a credential you can prove

1. **Sign in as yourself.** Your passkey signs you in on the relay. Then you authorize this app's session agent on your pod: your connection's `register_agent` writes a delegation credential there, so Foxxi can verify what the session signs. `revoke_agent` undoes it.
2. **An agent writes a course and offers it.** You name a topic. The Claude Code agent writes a short course with Claude and publishes it as a real SCORM 2004 package through `/agent/scorm/author`, with the answers hashed at authoring. Its pod then publishes a HyprCat `FederatedCatalog` offering it.
3. **Find it across pods.** Your connection reads each pod's manifest with the relay's ordinary `discover_context`. It finds catalogs by their type and reads each one's graph with `get_descriptor`. It checks each catalog's issuer against the pod's attribution. Jev then ranks the courses for your goal.
4. **Take the course.** The bridge's sequencing engine delivers each section and grades your answers against the author's hashes. Each launch and submit is your connection's `act`, signed as your session agent.
5. **Claim what you earned.** The tenant issues an Open Badges 3.0 credential from your own record, naming the evidence and the course's author. It goes into the wallet on your pod and is issued to you, not to the session agent.
6. **Hand it to an agent nobody briefed.** You send the Verifier a link to the credential in your wallet, the way a badge is shared. It loads the generated skill, finds `foxxi.verify_credential`, has the bridge read the credential from your pod, and reports every check. Tick "tamper" to hand it a JSON copy with one field changed instead; the page then shows every difference between what it checked and the credential in your wallet. A copy is fragile: in testing, an agent moved one field while retyping an untouched credential, and the signature check failed.
7. **Watch a forgery fail.** The Claude Code agent writes its own "passed" into its own record and asks for the same credential. The bridge refuses: the statement is in the record but carries no grading tag.

### Part two: two learners, one record standard

The same learning record for a person and an AI agent side by side. It covers xAPI 2.0 (IEEE 9274.1.1) experiences, work performance, the competencies they add up to, credentials, and the IEEE P2997 Enterprise Learner Record that rolls them up.

8. **You teach the agent.** You write a short course in the page, or have Claude draft one for you to edit, and publish it as yours through your connection (`foxxi.scorm_author` via the relay's `act`). The engine keeps your answers only as hashes.
9. **The agent takes your course.** It launches your course with its own wallet. A Claude with no tools reads each section the engine delivers and answers, seeing only what you saw. The engine grades it against your hashes. If it passes, it claims a credential into its own wallet from its own record.
10. **Both of you at work.** Each of you taught the other, and each records that as a performance in the xAPI production context (`foxxi.record_performance_signed`), citing the course taught as evidence the bridge checks it can fetch. You record as a person and your record stays private. The agent records as an agent, which makes its whole record public, and the bridge says so.
11. **Two learner records, side by side.** `foxxi.review_record` assembles an IEEE P2997 record for each of you from your own pods: the experiences, the work, the competencies (inferred from learning, or verified by performance at a Dreyfus level), and the credentials in your wallet, each verified. Yours is read as you, the person the credentials name. Then each tries to read the other's: you can read the agent's, and the agent is refused yours.
12. **What each should learn next.** Jev picks each learner's next course from their record alone: the competencies it shows, how they were earned, and the credentials already held. The candidates leave out the courses that learner wrote, which is a rule rather than a judgment. "None of these fits" is an answer, and the agent gets it when the only course it didn't write is one it already holds.

### Part three: the standards the rest of the learning world speaks

Two more pieces of the ADL Total Learning Architecture, for both learners. cmi5 (IEEE 9274.2.1) is how an LMS launches an activity and trusts what it reports. LTI 1.3 is how an LMS launches a tool and gets the grade back. Both land in the same learner records.

13. **An activity launched the cmi5 way.** The bridge publishes a cmi5 course of its own. Each of you launches your next activity in it, signed as yourselves (`foxxi.cmi5_launch_signed`): the LMS stages `LMS.LaunchData` and returns a conformant launch URL.
    - **Your activity** runs in a window. It trades its one-time fetch URL for an auth-token and reports to the LRS.
    - **The agent's activity** runs in its own process (`lib/au.ts`). Claude reads the lesson and answers its questions without the answers the page carries. They are scored by the page's own rule, and the same statements are reported.
    - When an activity's statements meet its moveOn rule, the LMS records `satisfied`. A cmi5 activity scores itself, so this is experience in the record, not evidence for a credential.
14. **Your LMS launches a course, and the grade comes back.** Foxxi also runs an LMS of its own. It launches the agent's course for you and yours for the agent (`foxxi.lti_launch_signed`). The LMS knows who each of you is from your signature; there is no LMS password.
    - It is a standard LTI 1.3 launch over HTTP: the Tool's OIDC login, the LMS's authorization, an `id_token` the Tool checks against the LMS's published keys, and the course in the SCORM engine.
    - Yours runs in a window. The agent follows the same redirects without a browser, and each hop is in the chapter.
    - At the end, the Tool gets a token by signing a client assertion and posts the grade to the LMS gradebook over Assignment and Grade Services. Each of you reads your own row (`foxxi.lti_gradebook_signed`).
15. **The records, after everything.** The two IEEE P2997 records from chapter 11, read again, with what changed since. The cmi5 activity and the LMS-launched course are in them now.

## What it needs

- **Node 20+** and `npm install` at the repository root. The demo uses only root dependencies.
- **The Claude Code CLI**, signed in. The Author, the agent's reading and the Verifier run on your subscription. The demo finds the CLI you run, not the copy `node_modules` carries; `DEMO_CLAUDE_BIN` overrides it.
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

- **On your pod:** a delegation credential for the session agent, your course with its answers hashed, and the Open Badges credentials in `foxxi-wallet/`.
- **In your record:** the graded statements and your recorded work, in the bridge's lens and in the shared lattice on your pod. Your record stays private to you. Part three adds the cmi5 activity's statements and the LMS-launched course, whose statements name the LMS as their xAPI platform.
- **In the LMS:** your row of its gradebook, and the agent's.
- **On the agent's pod:** its courses with their answers hashed, its catalog, its graded statements for your course, its credential, its recorded work, and the statement it forged. Recording work as an agent makes its record public. The refused claim writes nothing.

The ledger links each one. Every write is an ordinary Interego artifact you can read, share or delete like any other.
