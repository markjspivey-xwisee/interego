/**
 * One page that says what can be done here, to a person and to an agent alike.
 *
 * ★ WHY. Everything on this bridge is reachable without an account: a key the browser makes can
 * sign in, play a hosted package, read its own record and bring a package of its own, and an agent
 * can do the same by signing. None of that was said anywhere a newcomer would land. The root
 * answers with every affordance at once, which is the right answer for a client that already knows
 * what it wants and no answer for someone who does not.
 *
 * The page is one description, rendered twice: HTML for a browser, JSON for anything else. It
 * names only what the bridge it is served from offers, so a step whose affordance is absent or
 * whose route is closed is left out rather than promised.
 */
import { htmlEscape } from './lti-player.js';

export interface FrontDoorOptions {
  /** This bridge's public base URL, without a trailing slash. */
  readonly bridgeUrl: string;
  /** Where the dashboard is served, when this deployment has one. */
  readonly dashboardUrl?: string;
  /** The affordances this bridge offers, by tool name. */
  readonly offered: ReadonlySet<string>;
  /** Whether anyone who signs may bring a package, and the bounds if so. */
  readonly openHosting: { readonly enabled: boolean; readonly maxZipMb: number; readonly perSignerHourly: number };
}

export interface FrontDoorStep {
  readonly id: string;
  readonly title: string;
  /** What a person does. */
  readonly forPeople: string;
  /** A link a person follows, when the step has one. */
  readonly link?: { readonly href: string; readonly label: string };
  /** What an agent calls: the affordance, and where its request goes. */
  readonly forAgents?: { readonly affordance: string; readonly method: string; readonly target: string; readonly contract: string };
}

export interface FrontDoor {
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly FrontDoorStep[];
  /** How a request is signed, for an agent that has only a key. */
  readonly signing: { readonly summary: string; readonly envelope: Readonly<Record<string, string>> };
  /** Where everything this bridge offers is listed. */
  readonly everything: { readonly entryPoint: string; readonly affordances: string; readonly mcp: string; readonly guidance: string };
}

function agentCall(o: FrontDoorOptions, affordance: string, path: string): FrontDoorStep['forAgents'] {
  return { affordance, method: 'POST', target: `${o.bridgeUrl}${path}`, contract: `${o.bridgeUrl}/affordances/${affordance}/input` };
}

/** What this bridge offers a newcomer, in the order they would do it. */
export function frontDoor(o: FrontDoorOptions): FrontDoor {
  const steps: FrontDoorStep[] = [];
  if (o.dashboardUrl) steps.push({
    id: 'start',
    title: 'Start with no account',
    forPeople: 'Open the dashboard and choose "Start as a guest". Your browser tab makes a key and signs in as it. Nothing is asked of you. The key lives in the tab only, so write down its recovery phrase if you want to come back as the same identity.',
    link: { href: o.dashboardUrl, label: 'Open the dashboard' },
  });
  if (o.offered.has('foxxi.cmi5_launch_signed')) steps.push({
    id: 'play',
    title: 'Play something hosted here',
    forPeople: 'The Learn page lists the packages hosted on this bridge. Launch one and it opens in a tab of its own, signed as you.',
    link: { href: `${o.bridgeUrl}/scorm/packages`, label: 'See what is hosted' },
    forAgents: agentCall(o, 'foxxi.cmi5_launch_signed', '/agent/cmi5/launch'),
  });
  if (o.offered.has('foxxi.read_xapi_statements_signed')) steps.push({
    id: 'record',
    title: 'Read your own record',
    forPeople: 'What a package reports about you is kept as xAPI statements under your identity. The Learn page shows them, and only your signature reads them.',
    forAgents: agentCall(o, 'foxxi.read_xapi_statements_signed', '/agent/xapi-statements/read'),
  });
  if (o.openHosting.enabled && o.offered.has('foxxi.host_package_signed')) steps.push({
    id: 'bring',
    title: 'Bring a package of your own',
    forPeople: `Choose a SCORM or cmi5 .zip on the Learn page. It is signed as you, hosted here and listed for anyone to play, so bring only what you may share. Up to ${o.openHosting.maxZipMb} MB a package and ${o.openHosting.perSignerHourly} packages an hour.`,
    forAgents: agentCall(o, 'foxxi.host_package_signed', '/agent/scorm/host'),
  });
  return {
    title: 'Start here',
    summary: 'A learning record store and a place to host and play learning packages, open to any key. A person needs no account and an agent needs no registration: whoever signs a request acts as the key that signed it.',
    steps,
    signing: {
      summary: 'Any secp256k1 key may sign for itself. Build the payload, sign the text "sha256:" followed by the hex SHA-256 of the payload string as an Ethereum personal message, and send both.',
      envelope: {
        _signed_payload: 'A JSON string of your arguments plus agent_id ("did:ethr:<your address>") and timestamp (ISO 8601, now).',
        _signature: 'The signature over "sha256:<hex sha-256 of _signed_payload>".',
      },
    },
    everything: {
      entryPoint: `${o.bridgeUrl}/`,
      affordances: `${o.bridgeUrl}/affordances`,
      mcp: `${o.bridgeUrl}/mcp`,
      guidance: `${o.bridgeUrl}/guidance`,
    },
  };
}


/** The same description as a page a person reads. No script, no outside resource. */
export function frontDoorHtml(d: FrontDoor): string {
  const step = (s: FrontDoorStep, i: number): string => `
    <li>
      <h2><span class="n">${i + 1}</span>${htmlEscape(s.title)}</h2>
      <p>${htmlEscape(s.forPeople)}</p>
      ${s.link ? `<p><a class="go" href="${htmlEscape(s.link.href)}">${htmlEscape(s.link.label)}</a></p>` : ''}
      ${s.forAgents ? `<p class="agent">For an agent: <code>${htmlEscape(s.forAgents.affordance)}</code>, ${htmlEscape(s.forAgents.method)} <code>${htmlEscape(s.forAgents.target)}</code> (<a href="${htmlEscape(s.forAgents.contract)}">what to send</a>)</p>` : ''}
    </li>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(d.title)}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--mute:#5f5c55;--line:#dedbd3;--accent:#1f5fbf;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eceae4;--mute:#a5a199;--line:#33312d;--accent:#8ab4f8;--card:#1e1e1b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:44rem;margin:0 auto;padding:2.5rem 1rem 4rem}h1{font-size:2rem;margin:0 0 .5rem}
.lead{color:var(--mute);margin:0 0 2rem}ol{list-style:none;padding:0;margin:0;display:grid;gap:1rem}
li{background:var(--card);border:1px solid var(--line);border-radius:.6rem;padding:1rem 1.2rem}
h2{font-size:1.1rem;margin:0 0 .4rem;display:flex;gap:.6rem;align-items:center}
.n{flex:none;width:1.6rem;height:1.6rem;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;font-size:.85rem}
p{margin:.4rem 0}a{color:var(--accent)}.go{font-weight:600}.agent{color:var(--mute);font-size:.9rem;overflow-wrap:anywhere}
code{font:.85em ui-monospace,monospace;overflow-wrap:anywhere}section{margin-top:2rem}h3{font-size:1rem;margin:0 0 .4rem}
dl{margin:0}dt{font:600 .85rem ui-monospace,monospace;margin-top:.5rem}dd{margin:0;color:var(--mute)}
</style></head><body><main>
<h1>${htmlEscape(d.title)}</h1>
<p class="lead">${htmlEscape(d.summary)}</p>
<ol>${d.steps.map(step).join('')}
</ol>
<section><h3>For an agent with only a key</h3>
<p>${htmlEscape(d.signing.summary)}</p>
<dl>${Object.entries(d.signing.envelope).map(([k, v]) => `<dt>${htmlEscape(k)}</dt><dd>${htmlEscape(v)}</dd>`).join('')}</dl>
<p>Ask for this page as JSON (<code>Accept: application/json</code>) to read the same steps as data.</p></section>
<section><h3>Everything this bridge offers</h3>
<p><a href="${htmlEscape(d.everything.entryPoint)}">Entry point</a> · <a href="${htmlEscape(d.everything.affordances)}">Affordances</a> · <a href="${htmlEscape(d.everything.guidance)}">Guidance</a> · MCP at <code>${htmlEscape(d.everything.mcp)}</code></p></section>
</main></body></html>`;
}
