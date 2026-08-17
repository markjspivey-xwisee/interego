/**
 * DOES EACH PUBLIC SURFACE ACTUALLY ANSWER? Not "is it deployed", not "does it accept a socket".
 *
 * ── ★★ THE INCIDENT THIS EXISTS FOR ─────────────────────────────────────────
 *
 * `css-gate` hung twice in one night. It accepted TCP, completed the TLS handshake, and then never
 * sent a byte. Throughout:
 *
 *   · Railway reported the service SUCCESS
 *   · the gate's own /healthz answered 200 (it does not proxy, so it cannot fail)
 *   · CSS behind it was healthy and serving requests the entire time
 *
 * Nothing in the fleet noticed. It was found because an AGENT was asked to evaluate itself, could
 * not reach anything, and reported that the capability did not exist — and was believed. Three
 * wrong diagnoses came out of that: the agent blamed a missing Foxxi descriptor, I blamed a stale
 * URN in a relay hint, and the actual fault was a dependency that had stopped answering.
 *
 * ★ SO THE PREDICATE IS "IT ANSWERED IN TIME", AND NOTHING WEAKER. A connect is not an answer; a
 * TLS handshake is not an answer; a deployment status is not an answer. The one failure mode this
 * fleet has actually suffered is the one where everything looks fine and no response arrives, and
 * a check that cannot see that is the check that was already there.
 *
 * ★ AND A HANG IS REPORTED SEPARATELY FROM AN ERROR. A 500 means something ran and failed; a
 * timeout means nobody knows. Collapsing them is how "it's up" survived two outages.
 */

const TIMEOUT_MS = Number(process.env.LIVENESS_TIMEOUT_MS ?? 20_000);
/** Above this, a surface is answering but degrading. See the note at the `slow` verdict. */
const SLOW_MS = Number(process.env.LIVENESS_SLOW_MS ?? 5_000);

/**
 * Every surface a person or an agent actually depends on, with the path that proves it is DOING
 * its job rather than merely running.
 *
 * ★ `/healthz` ON THE GATE IS DELIBERATELY NOT THE ONLY CHECK. It is included because it now
 * carries the pool counters, and `saturated` is the early warning; the root path is what proves
 * the proxy itself answers.
 */
const SURFACES = [
  { name: 'relay', url: 'https://relay.interego.xwisee.com/health' },
  { name: 'css-gate', url: 'https://gate.interego.xwisee.com/healthz', poolCheck: true },
  { name: 'css-gate (proxy)', url: 'https://gate.interego.xwisee.com/' },
  { name: 'identity', url: 'https://identity.interego.xwisee.com/health' },
  { name: 'foxxi-bridge', url: 'https://foxxi-bridge.interego.xwisee.com/health' },
  { name: 'foxxi-bridge (affordance)', url: 'https://foxxi-bridge.interego.xwisee.com/agent/review-record/affordance' },
];

/** One surface, one verdict. Never throws — a checker that dies reports nothing. */
async function probe(s) {
  const t0 = Date.now();
  try {
    const res = await fetch(s.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ms = Date.now() - t0;
    // ★ THE BODY IS READ, not just the status. A response whose headers arrive and whose body
    // never does is the same outage wearing a 200.
    const text = await res.text();
    if (s.poolCheck) {
      try {
        const j = JSON.parse(text);
        if (j.saturated === true) {
          return { ...s, verdict: 'saturated', ms, detail: 'every upstream connection busy and requests queuing — proxied requests are probably hanging' };
        }
      } catch { /* a health body we cannot parse is not itself a failure */ }
    }
    if (res.status >= 500) return { ...s, verdict: 'error', ms, detail: 'HTTP ' + res.status };
    /**
     * ★★ SLOW IS THE LEADING INDICATOR, AND IT WAS VISIBLE BEFORE EACH HANG.
     *
     * MEASURED the first time this script was run, minutes after restarting a wedged gate: every
     * other surface answered in ~250 ms and the gate's proxy path took 15,841 ms. It was "up". It
     * hung again later. A pool filling up shows here as a rising response time long before it
     * shows as no response at all, and that window is the whole point of watching.
     */
    if (ms > SLOW_MS) {
      return { ...s, verdict: 'slow', ms, detail: 'HTTP ' + res.status + ' but took ' + ms + ' ms — every healthy surface here answers in well under ' + SLOW_MS + ' ms' };
    }
    return { ...s, verdict: 'ok', ms, detail: 'HTTP ' + res.status + ', ' + text.length + ' bytes' };
  } catch (e) {
    const ms = Date.now() - t0;
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      ...s,
      // ★ THE DISTINCTION THAT MATTERS. "no answer" is the shape of the outage that hid twice.
      verdict: timedOut ? 'no-answer' : 'unreachable',
      ms,
      detail: timedOut ? 'no response within ' + TIMEOUT_MS + ' ms' : (e?.message ?? String(e)),
    };
  }
}

const results = await Promise.all(SURFACES.map(probe));

const pad = (s, n) => String(s).padEnd(n);
console.log('Fleet liveness — a response is required, not a connection.\n');
for (const r of results) {
  const mark = r.verdict === 'ok' ? 'ok  ' : (r.verdict === 'saturated' || r.verdict === 'slow') ? 'WARN' : 'FAIL';
  console.log(`  ${mark}  ${pad(r.name, 26)} ${pad(r.ms + 'ms', 9)} ${r.detail}`);
}

const hung = results.filter((r) => r.verdict === 'no-answer');
const broken = results.filter((r) => r.verdict === 'unreachable' || r.verdict === 'error');
const warned = results.filter((r) => r.verdict === 'saturated' || r.verdict === 'slow');

console.log('');
if (hung.length) {
  console.log('★★ ' + hung.length + ' surface(s) ACCEPTED A CONNECTION AND NEVER ANSWERED:');
  for (const r of hung) console.log('     ' + r.name + ' — ' + r.url);
  console.log('   This is the failure mode that passes every other check. A restart clears it;');
  console.log('   see deploy/css-gate/tests/pool-release.test.mjs for the leak that caused it here.');
}
if (broken.length) {
  console.log((hung.length ? '\n' : '') + broken.length + ' surface(s) failed outright:');
  for (const r of broken) console.log('     ' + r.name + ' — ' + r.detail);
}
if (warned.length) {
  console.log((hung.length || broken.length ? '\n' : '') + warned.length + ' surface(s) warned:');
  for (const r of warned) console.log('     ' + r.name + ' — ' + r.detail);
}
if (!hung.length && !broken.length && !warned.length) console.log('Every surface answered.');

// ★ A WARNING IS NOT A FAILURE. Saturation is worth waking up to before it wedges, but a red run
// for a transient burst would train people to ignore this the way the fleet audit was ignored.
process.exit(hung.length || broken.length ? 1 : 0);
