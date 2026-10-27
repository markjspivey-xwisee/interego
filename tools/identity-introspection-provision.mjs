/**
 * Trusted-master runner only (.github/workflows/identity-introspection-provision.yml): put one
 * IDENTITY_INTROSPECTION_SECRET on the relay, css-gate and identity, in that order, and then
 * remove ALLOW_OPEN_INTROSPECTION from identity, without any value reaching a log, a file, a
 * step output or a person.
 *
 * A write (APPLY=true) runs only inside GitHub Actions on master, from this tool's own workflow
 * (GITHUB_WORKFLOW_REF), whose concurrency group keeps two runs from interleaving, and where the
 * preflight can see the deploy workflows' runs and refuses while another run of this workflow
 * has not finished. Two overlapping runs could each pass their read-backs and leave relay and
 * css-gate with different values. A dry run works anywhere. The check reads GITHUB_ACTIONS,
 * GITHUB_REF and GITHUB_WORKFLOW_REF, so it stops an accidental local apply, or another
 * workflow running this tool, not someone who sets them by hand.
 *
 * Identity's POST /tokens/verify answers only a caller presenting that value as a bearer once
 * identity holds it. The relay and css-gate present it whenever they hold it, so they get it
 * first; while identity is open (ALLOW_OPEN_INTROSPECTION=1, no secret) the header is ignored.
 * One stage per run, in this order:
 *   callers   generates 32 random bytes as hex and writes them to relay and css-gate when
 *             neither holds the variable; writes nothing when both hold the same value;
 *             refuses otherwise.
 *   identity  copies the callers' value (compared in memory) to identity; refuses if identity
 *             holds a different one. Keeps ALLOW_OPEN_INTROSPECTION, which is the rollback, and
 *             refuses to write while identity does not store it as exactly '1', the only value
 *             that opens identity (deploy/identity/server.ts).
 *   finalize  removes ALLOW_OPEN_INTROSPECTION from identity once identity enforces the
 *             callers' value.
 * An applied run of any stage also deploys a service that already holds the stage's change but
 * does not report it yet (callers: identityVerifyAuth not true; identity: introspection not
 * 'enforced'; finalize: allowOpenIntrospection not false), so a rerun finishes a run that
 * stopped between its write and its deploy, even when it writes nothing.
 * A dry run (the default) reports names, set or unset, and `equal: yes/no`, and writes nothing.
 *
 * ★ WRITES PASS skipDeploys: true, AND THE TOOL DEPLOYS ITSELF. Railway's variableUpsert
 * redeploys the service unless skipDeploys is true (its documented default is false), and
 * returns a Boolean, not a deployment, so a deployment it started could only be found by
 * polling the service's deployment list. The documented way to change secrets on several
 * services is skipDeploys: true for each, then deployments triggered by hand
 * (https://docs.railway.com/integrations/api/manage-variables, "Rotate secrets"). So each
 * written service gets serviceInstanceDeployV2, which ships the image the service is already
 * pinned to (the preflight checks that pin is the build it serves, so the running code does not
 * change), and the deployment id it returns is polled to SUCCESS. Not serviceInstanceRedeploy,
 * which re-ships the previous deployment (tools/railway-redeploy.mjs, "REDEPLOY ≠ DEPLOY").
 * variableDelete documents no skipDeploys, so after the delete the tool follows a deployment
 * Railway starts within a grace window, and triggers one itself otherwise. After an upsert there
 * is no grace window: the tool reads the deployment list once, follows a new deployment if one
 * is already listed (Railway ignoring skipDeploys), and otherwise triggers its own.
 *
 * ★ THE HEALTH FIELD, NOT `build`, PROVES THE NEW CONTAINER. A deploy of the same image reports
 * the same build before and after, and Railway keeps the old container serving for
 * overlapSeconds (20 s when unset) after SUCCESS. Only the field each stage changes tells the
 * containers apart: relay and css-gate `identityVerifyAuth`, identity `introspection` and
 * `allowOpenIntrospection`. The tool waits for that field, read twice in a row, and fails if it
 * never changes. After the identity stage it checks, with a made-up bearer, that identity still
 * accepts the relay and css-gate.
 *
 * ★ NO VALUE IS PRINTED, written to a file, put in a step output or the environment, or passed
 * in argv; this tool starts no child process. Railway's `variables` query returns every
 * variable of a service; only IDENTITY_INTROSPECTION_SECRET's value (and, for identity,
 * whether ALLOW_OPEN_INTROSPECTION is present, and whether it is '1') is kept, and the rest is
 * dropped at once.
 * Railway error text is never logged, because it can echo inputs. Messages are built from
 * names, states, public build shas, deployment ids and statuses only, never a value, its length
 * or a hash of it. Values are compared as Railway renders them, because that is what the
 * containers receive.
 *
 * ★ DO NOT SEAL THE VARIABLE BEFORE finalize. Railway does not return a sealed variable's value
 * through the API, so a sealed variable reads as unset here while its service reports holding
 * it, and the tool refuses that combination.
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveImageRepo, verifyUrlFor } from './railway-services.mjs';
import { triggerWithRetry } from './railway-deploy-trigger.mjs';

/** The fleet's project and environment, as tools/vertical-bridges-provision.mjs pins them. */
export const TARGET = Object.freeze({
  projectId: 'b88ceabb-7461-4949-81d7-3d29132e7806',
  environmentId: '449996a2-3533-462f-98c6-4ab4c05dd777',
});
export const SECRET_VAR = 'IDENTITY_INTROSPECTION_SECRET';
export const OPEN_VAR = 'ALLOW_OPEN_INTROSPECTION';
export const STAGES = Object.freeze(['callers', 'identity', 'finalize']);
export const CALLERS = Object.freeze(['relay', 'css-gate']);
const SERVICES = Object.freeze([...CALLERS, 'identity']);

/** Refused before anything was written. */
export class ProvisionRefusal extends Error {}
/** Failed after a write; the message says what is stored and how to rerun or roll back. */
export class StageFailure extends Error {}

/** 32 random bytes as lowercase hex. */
export function newSecret(rand = randomBytes) {
  return rand(32).toString('hex');
}

/** A value a caller can present in a header and that is long enough to be a secret. */
export function usableSecret(v) {
  return typeof v === 'string' && v.length >= 32 && /^[\x21-\x7e]+$/.test(v);
}

/** GITHUB_WORKFLOW_REF of a run of this tool's workflow on master: `<owner>/<repo>/<path>@<ref>`. */
const WORKFLOW_REF = /^[^/]+\/[^/]+\/\.github\/workflows\/identity-introspection-provision\.yml@refs\/heads\/master$/;

/** Why the CLI must not run with this environment, or null. */
export function cliRefusal(env) {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF !== 'refs/heads/master') return 'this runs only from master';
  if (env.APPLY === 'true' && (env.GITHUB_ACTIONS !== 'true' || !WORKFLOW_REF.test(env.GITHUB_WORKFLOW_REF ?? ''))) {
    return 'apply runs only from the master workflow (identity-introspection-provision.yml); a dry run works locally';
  }
  if (!env.RAILWAY_PROJECT_TOKEN) return 'RAILWAY_PROJECT_TOKEN is not set';
  if (!STAGES.includes(env.STAGE)) return `STAGE must be one of ${STAGES.join(', ')}`;
  return null;
}

const set = (v) => typeof v === 'string' && v !== '';

/**
 * A service that reports running the variable while Railway shows it unset: sealed, or changed
 * without a deploy. The refusal text, or null. It goes before lostCallers and every refusal
 * about what a service serves, because a sealed caller that runs the value is not lost, and
 * telling the operator to roll it back would take its working deployment away.
 */
function sealedRefusal(state) {
  const svc = SERVICES.find((s) => state[s].running && !set(state[s].stored));
  return svc ? `${svc} runs with a value Railway does not show (sealed, or changed without a deploy); resolve by hand` : null;
}

/**
 * Identity stores the value while a caller does not: that caller is refused now (or from
 * identity's next deploy). Called only after sealedRefusal, so a caller that does not store the
 * value does not run it either, and identity does not run a value it does not store. A Railway
 * Rollback restores a deployment's variables along with its image, so rolling a caller back past
 * the deployment stage=callers made unsets the variable on it. Deleting the other caller's copy,
 * the way out before identity holds the value, would get that caller refused too, so this says
 * to undo the rollback instead. Deploying master would not help: deploy-railway.yml keeps the
 * service's current variables. The refusal text, or null. `state` is planStage's.
 */
function lostCallers(state) {
  const lost = CALLERS.filter((c) => !set(state[c].stored));
  if (!lost.length || !set(state.identity.stored)) return null;
  const kept = CALLERS.filter((c) => set(state[c].stored));
  const them = lost.length > 1 ? 'them' : 'it';
  return `identity holds ${SECRET_VAR} and ${lost.join(' and ')} ${lost.length > 1 ? 'do' : 'does'} not, so identity refuses ${them} ${state.identity.running ? 'now' : 'from its next deploy'}. `
    + `A Railway Rollback past the deployment stage=callers made unsets the variable: in Railway, roll ${lost.join(' and ')} back again to the deployment that was active before that rollback`
    + `${kept.length ? `, and do not delete ${kept[0]}'s copy` : ''}. Otherwise resolve by hand`;
}

/**
 * What a stage writes, given what Railway stores and what each service reports running. Pure.
 *
 * `state[svc]` is `{ stored, running }`: the stored value (undefined or '' = unset) and whether
 * the service's health shows the variable. identity also carries `openStored`
 * (ALLOW_OPEN_INTROSPECTION stored as exactly '1', the only value that opens identity),
 * `openListed` (stored with any value, which finalize removes) and `openRunning` (reported by
 * /health).
 */
export function planStage(stage, state, { generate = () => null } = {}) {
  const sealed = sealedRefusal(state);
  if (sealed) throw new ProvisionRefusal(sealed);
  const relay = state.relay.stored;
  const gate = state['css-gate'].stored;
  const identity = state.identity.stored;
  const callersSet = [relay, gate].filter(set).length;
  const callersEqual = callersSet === 2 ? (relay === gate ? 'yes' : 'no') : 'n/a';
  const identityEqual = set(identity) && callersEqual === 'yes' ? (identity === relay ? 'yes' : 'no') : 'n/a';
  const result = (writes, notes = []) => ({ writes, callersEqual, identityEqual, notes });
  const lost = lostCallers(state);
  if (lost) throw new ProvisionRefusal(stage === 'callers' && callersSet === 0 ? `${lost}; a new value would not match identity's` : lost);
  const callersReady = () => {
    if (callersSet < 2) throw new ProvisionRefusal(`relay and css-gate must both hold ${SECRET_VAR}; run stage=callers with apply first`);
    if (callersEqual !== 'yes') throw new ProvisionRefusal(`relay and css-gate hold different values of ${SECRET_VAR}; resolve by hand`);
    if (!usableSecret(relay)) throw new ProvisionRefusal(`the callers' ${SECRET_VAR} is not usable (it must be at least 32 printable ASCII characters with no spaces); resolve by hand`);
  };

  // From here on, identity holds nothing whenever a caller is unset.
  if (stage === 'callers') {
    if (callersSet === 0) {
      const value = generate();
      const write = (service) => ({ service, op: 'upsert', name: SECRET_VAR, generated: true, ...(value === null ? {} : { value }) });
      return result([write('relay'), write('css-gate')]);
    }
    if (callersSet === 1) {
      const holder = set(relay) ? 'relay' : 'css-gate';
      throw new ProvisionRefusal(`only ${holder} holds ${SECRET_VAR}; nothing enforces yet: delete it from ${holder} in Railway, then rerun`);
    }
    callersReady();
    return result([], identityEqual === 'no' ? [`identity holds a different ${SECRET_VAR}; stage=identity will refuse until that is resolved`] : []);
  }
  if (stage === 'identity') {
    callersReady();
    if (!set(identity)) {
      // ALLOW_OPEN_INTROSPECTION=1 is what keeps identity open once the secret is deleted again,
      // so without it this write would have no one-step rollback.
      if (!state.identity.openStored) {
        throw new ProvisionRefusal(`identity does not hold ${OPEN_VAR}=1, this stage's rollback: without it, deleting ${SECRET_VAR} from identity again would leave introspection disabled, which refuses both callers. Set ${OPEN_VAR}=1 on identity and deploy identity, then rerun`);
      }
      return result([{ service: 'identity', op: 'upsert', name: SECRET_VAR, value: relay }]);
    }
    if (identity === relay) return result([]);
    throw new ProvisionRefusal(`identity holds a different ${SECRET_VAR} from the callers; resolve by hand`);
  }
  if (stage === 'finalize') {
    callersReady();
    if (identityEqual !== 'yes') throw new ProvisionRefusal(`identity must hold the callers' ${SECRET_VAR}; run stage=identity first`);
    return result(state.identity.openListed ? [{ service: 'identity', op: 'delete', name: OPEN_VAR }] : []);
  }
  throw new ProvisionRefusal(`unknown stage ${stage}`);
}

/** The one line the CLI prints for a failure. Only this tool's own messages are repeated. */
export function describeFailure(e) {
  if (e instanceof ProvisionRefusal) return `refused: ${e.message}`;
  if (e instanceof StageFailure) return `failed: ${e.message}`;
  return 'provisioning failed at a Railway or HTTP request; no value or API response is logged.';
}

const DEFAULT_TIMING = Object.freeze({
  deployPollMs: 7_000,
  deployDeadlineMs: 12 * 60_000,
  healthPollMs: 6_000,
  healthDeadlineMs: 3 * 60_000,
  deleteGraceMs: 60_000,
  deleteGracePollMs: 5_000,
  overlapExtraMs: 10_000,
  probeAttempts: 5,
  probeGapMs: 2_000,
  triggerBaseMs: 5_000,
});
const IN_FLIGHT = new Set(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING', 'NEEDS_APPROVAL']);
const GOOD = new Set(['SUCCESS']);
const BAD = new Set(['FAILED', 'CRASHED', 'SKIPPED', 'REMOVED', 'REMOVING', 'NEEDS_APPROVAL']);
const PROBE_BEARER = 'introspection-rollout-probe';
const UNCONFIRMED = 'unconfirmed';
const short = (sha) => String(sha).slice(0, 8);

const Q = {
  token: '{projectToken{projectId environmentId}}',
  services: 'query($p:String!){project(id:$p){services{edges{node{id name}}}}}',
  variables: 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}',
  domains: 'query($p:String!,$s:String!,$e:String!){domains(projectId:$p,serviceId:$s,environmentId:$e){serviceDomains{domain} customDomains{domain}}}',
  instance: 'query($s:String!,$e:String!){serviceInstance(serviceId:$s,environmentId:$e){source{image} numReplicas overlapSeconds drainingSeconds latestDeployment{id status}}}',
  newest: 'query($s:String!,$e:String!){deployments(first:1,input:{serviceId:$s,environmentId:$e}){edges{node{id status}}}}',
  upsert: 'mutation($input:VariableUpsertInput!){variableUpsert(input:$input)}',
  remove: 'mutation($input:VariableDeleteInput!){variableDelete(input:$input)}',
  deploy: 'mutation($s:String!,$e:String!){serviceInstanceDeployV2(serviceId:$s,environmentId:$e)}',
  status: 'query($id:String!){deployment(id:$id){status}}',
};

/** Which health field shows the stage's change on `svc`, as a short value-free description. */
function fieldText(svc, h) {
  if (svc === 'identity') return `introspection=${h?.introspection}, allowOpenIntrospection=${h?.allowOpenIntrospection}`;
  return `identityVerifyAuth=${h?.identityVerifyAuth}`;
}

/**
 * Run one stage. `gql(query, variables)` is Railway's GraphQL API; `http.getJson(url, opts)` and
 * `http.send(url, { method, headers, body })` answer `{ status, body }` (body parsed as JSON, or
 * null). Returns a summary that holds no value.
 */
export async function runStage({
  gql, http, stage, apply = false, rand = randomBytes, log = () => {}, mask = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(),
  timing = {}, github,
}) {
  const t = { ...DEFAULT_TIMING, ...timing };
  if (!STAGES.includes(stage)) throw new ProvisionRefusal(`stage must be one of ${STAGES.join(', ')}`);
  const masked = new Set();
  const maskOnce = (v) => { if (!masked.has(v)) { masked.add(v); mask(v); } };

  // ── Preflight: nothing below writes until the plan is made. ────────────────────────────────
  const pt = await gql(Q.token);
  if (pt?.projectToken?.projectId !== TARGET.projectId || pt?.projectToken?.environmentId !== TARGET.environmentId) {
    throw new ProvisionRefusal('the token does not belong to the fleet project and environment this tool is pinned to');
  }
  const project = await gql(Q.services, { p: TARGET.projectId });
  const nodes = (project?.project?.services?.edges ?? []).map((e) => e?.node).filter(Boolean);
  const ids = {};
  for (const svc of SERVICES) {
    const found = nodes.filter((n) => n.name === svc);
    if (found.length !== 1) throw new ProvisionRefusal(`expected exactly one service named ${svc}, found ${found.length}`);
    ids[svc] = found[0].id;
  }
  await checkNoDeployRunning({ http, github, log, apply });

  const readVars = async (svc) => {
    const d = await gql(Q.variables, { p: TARGET.projectId, e: TARGET.environmentId, s: ids[svc] });
    const all = d?.variables ?? {};
    // Only these facts are kept; the map, with every other variable's value, is dropped here.
    const stored = typeof all[SECRET_VAR] === 'string' && all[SECRET_VAR] !== '' ? all[SECRET_VAR] : undefined;
    // Identity opens only on exactly '1', so only that is the rollback; any value is removed by finalize.
    const openStored = all[OPEN_VAR] === '1';
    const openListed = Object.hasOwn(all, OPEN_VAR);
    if (usableSecret(stored)) maskOnce(stored);
    return { stored, openStored, openListed };
  };
  const instanceOf = async (svc) => (await gql(Q.instance, { s: ids[svc], e: TARGET.environmentId }))?.serviceInstance;
  const newestOf = async (svc) => (await gql(Q.newest, { s: ids[svc], e: TARGET.environmentId }))?.deployments?.edges?.[0]?.node;

  const info = {};
  // Refusals about what a service runs (its pin, its health) wait until all three are read. After
  // a Railway Rollback of a caller to an older image, they would say to deploy master or reconcile
  // the pin, which keeps the restored variables, so lostCallers' advice goes first when it applies,
  // and sealedRefusal's before both, as in planStage.
  const servingRefusals = [];
  for (const svc of SERVICES) {
    const vars = await readVars(svc);
    const dom = await gql(Q.domains, { p: TARGET.projectId, s: ids[svc], e: TARGET.environmentId });
    const hosts = [...(dom?.domains?.customDomains ?? []), ...(dom?.domains?.serviceDomains ?? [])].map((d) => d?.domain).filter(Boolean);
    const verify = verifyUrlFor(svc, hosts);
    if (!verify.ok) throw new ProvisionRefusal(`${svc}: no health URL (${verify.reason})`);
    const inst = await instanceOf(svc);
    const image = String(inst?.source?.image ?? '');
    const repo = resolveImageRepo(svc);
    const m = /^(.*):([0-9a-f]{40})$/.exec(image);
    const pinned = repo.ok && m && m[1] === repo.repo;
    const newest = await newestOf(svc);
    if (newest && IN_FLIGHT.has(newest.status)) throw new ProvisionRefusal(`${svc} has deployment ${newest.id} ${newest.status}; rerun when it has finished`);
    const h = await readHealth(http, verify.url);
    const missing = h && (svc === 'identity'
      ? !['enforced', 'open', 'disabled'].includes(h.introspection) || typeof h.allowOpenIntrospection !== 'boolean'
      : typeof h.identityVerifyAuth !== 'boolean' || (svc === 'css-gate' && (typeof h.identityVerifyResults !== 'object' || h.identityVerifyResults === null)));
    if (!pinned) servingRefusals.push(`${svc} is not pinned to ${repo.ok ? repo.repo : 'its image'}:<40-hex sha> (a mutable tag, or a repository that disagrees with tools/railway-services.mjs); a redeploy would not ship a known build`);
    else if (!h) servingRefusals.push(`${svc}: GET ${verify.url} did not answer 200 with JSON`);
    else if (h.build !== m[2]) servingRefusals.push(`${svc} is pinned to ${short(m[2])} but serving ${short(h.build)}; a redeploy would change running code; reconcile with deploy-railway.yml first`);
    else if (missing) servingRefusals.push(`${svc} serves an image without the introspection health fields; deploy master first`);
    else if (svc === 'css-gate' && Number(inst?.numReplicas ?? 1) > 1) {
      log('note: css-gate runs more than one replica; its identityVerifyResults counters are per replica, so the gate check can be inconclusive');
    }
    info[svc] = {
      ...vars, url: verify.url, origin: new URL(verify.url).origin, tag: pinned ? m[2] : undefined, health: h ?? {},
      snapshot: newest?.id, overlapSeconds: inst?.overlapSeconds ?? null,
    };
  }

  const state = {
    relay: { stored: info.relay.stored, running: info.relay.health.identityVerifyAuth === true },
    'css-gate': { stored: info['css-gate'].stored, running: info['css-gate'].health.identityVerifyAuth === true },
    identity: {
      stored: info.identity.stored, running: info.identity.health.introspection === 'enforced',
      openStored: info.identity.openStored, openListed: info.identity.openListed,
      openRunning: info.identity.health.allowOpenIntrospection === true,
    },
  };
  if (servingRefusals.length) throw new ProvisionRefusal(sealedRefusal(state) ?? lostCallers(state) ?? servingRefusals[0]);
  const generate = apply ? () => { const v = newSecret(rand); maskOnce(v); return v; } : () => null;
  const plan = planStage(stage, state, { generate });

  // ── Report: names and states only. ─────────────────────────────────────────────────────────
  log(`stage: ${stage}${apply ? '' : ' (dry run)'}`);
  for (const svc of SERVICES) {
    const i = info[svc];
    const extra = svc === 'identity' ? `, ${OPEN_VAR}${i.openStored ? '=1' : i.openListed ? ' set to a value other than 1' : ' unset'}` : '';
    log(`${svc}: ${SECRET_VAR} ${i.stored ? 'set' : 'unset'}${extra}; serving ${short(i.tag)}, ${fieldText(svc, i.health)}`);
  }
  log(`relay and css-gate equal: ${plan.callersEqual}`);
  log(`identity equal to the callers: ${plan.identityEqual}`);
  for (const n of plan.notes) log(`note: ${n}`);
  for (const w of plan.writes) {
    log(`plan: ${w.op === 'delete' ? 'delete' : 'write'} ${w.name} on ${w.service}${w.generated ? ' (generated now, never shown)' : w.op === 'upsert' ? ' (copied from the callers, never shown)' : ''}`);
  }
  if (plan.writes.length === 0) log('plan: no writes');

  // ── Stage preconditions. ───────────────────────────────────────────────────────────────────
  const probes = () => ({ relay: relayProbe(http, info.relay.origin), gate: gateProbe(http, info['css-gate'].url, info['css-gate'].origin) });
  if (stage === 'identity') {
    for (const svc of CALLERS) {
      if (info[svc].health.identityVerifyAuth !== true) throw new ProvisionRefusal(`${svc} does not report presenting a bearer yet; run stage=callers with apply first`);
    }
    // Stored as '1' but not running is no problem: the rollback's own deploy picks it up.
    if (!info.identity.openStored) {
      log(`warning: identity does not hold ${OPEN_VAR}=1, so deleting the secret to roll back would leave introspection disabled (every caller refused)`);
    }
    const p = probes();
    const [r, g] = [await p.relay, await p.gate];
    log(`check before the write: identity accepts relay: ${r}; accepts css-gate: ${g}`);
    if (r !== 'accepted' || g !== 'accepted') throw new ProvisionRefusal('identity does not accept both callers now; a write would not be verifiable. Investigate first');
  }
  if (stage === 'finalize') {
    if (info.identity.health.introspection !== 'enforced') throw new ProvisionRefusal('identity does not enforce the secret yet; run stage=identity first');
    const p = probes();
    const [r, g] = [await p.relay, await p.gate];
    log(`check: identity accepts relay: ${r}; accepts css-gate: ${g}`);
    if (r !== 'accepted' || g !== 'accepted') throw new ProvisionRefusal(`identity does not accept both callers; do not remove ${OPEN_VAR} (the rollback) until it does`);
  }

  const summary = { stage, applied: apply, wrote: [], deployed: [] };
  if (!apply) {
    log('dry run: nothing written or deployed. Re-run with apply ticked.');
    return summary;
  }

  // ── Writes, each read back before any deploy. ──────────────────────────────────────────────
  // What is stored after this run's writes so far, and the way on, for StageFailure messages.
  // `pending` is the write whose request has been sent and not yet confirmed and read back. Its
  // outcome is unknown: Railway may have applied it and the answer been lost, or applied it and
  // the read-back failed. So it never decides which copy to delete; a rerun reads what is stored.
  // `started` is the identity deployment this run created or followed, until it ends in a failed
  // status: it was created with the secret stored, so a deletion now would not reach it. It is
  // UNCONFIRMED from the moment a deploy request is sent until an id comes back, because a request
  // whose answer is lost (or carries no id) may still have created one.
  let pending = null;
  let started = null;
  const has = (svc, name) => summary.wrote.includes(`${svc}:${name}`);
  // How to reopen identity. The identity stage never changes ALLOW_OPEN_INTROSPECTION, so this is
  // what the preflight read, until a deployment shows the rollback gone (openKept turns false).
  let openKept = info.identity.openStored;
  const reopen = () => (openKept
    ? `delete ${SECRET_VAR} from identity (${OPEN_VAR}=1 is still set)`
    : `set ${OPEN_VAR}=1 on identity, then delete ${SECRET_VAR} from identity`);
  const whatIsStored = () => {
    if (stage === 'callers') {
      // The stage writes only while identity holds nothing, but it deploys a caller that holds
      // the value and does not run it whatever identity does, so identity's mode is read here.
      const identityNow = state.identity.running
        ? `identity enforces ${SECRET_VAR}, so a caller that does not run it yet is refused until a deployment of it succeeds`
        : set(state.identity.stored)
          ? `identity holds ${SECRET_VAR} and enforces it from its next deploy (an auto-deploy included), refusing a caller that does not run it by then`
          : state.identity.openRunning ? 'identity is still open, so nothing enforces yet' : `identity does not hold ${SECRET_VAR}, so nothing enforces it yet`;
      const IdentityNow = identityNow[0].toUpperCase() + identityNow.slice(1);
      const holders = CALLERS.filter((c) => has(c, SECRET_VAR) || state[c].stored);
      if (pending) {
        return `Whether ${SECRET_VAR} landed on ${pending.service} is unknown${holders.length ? ` (${holders.join(' and ')} holds it)` : ''}. ${IdentityNow}. Rerun stage=callers before changing anything in Railway: it writes a new value when neither caller holds one, finishes when both hold the same value, and otherwise refuses and names the copy to delete.`;
      }
      if (holders.length === 1) {
        return `Only ${holders[0]} holds ${SECRET_VAR}. ${IdentityNow}: delete it from ${holders[0]} in Railway, then rerun stage=callers.`;
      }
      return holders.length === 2
        ? `${SECRET_VAR} is stored on relay and css-gate; ${identityNow}. Rerun stage=callers to finish the deploys.`
        : `No caller write is confirmed; ${identityNow}. Rerun stage=callers (if one caller now holds the variable it refuses and says how to recover).`;
    }
    if (stage === 'identity') {
      if (started) {
        const which = started === UNCONFIRMED
          ? `A deployment of identity may have been created with ${SECRET_VAR} stored (this run sent a deploy request and got no deployment id back), so identity may enforce it from that deployment, and otherwise does from its next deploy`
          : `Deployment ${started} of identity was created with ${SECRET_VAR} stored, so identity enforces it from that deployment if it carries the change, and otherwise from its next deploy`;
        return `${which}. Rerun stage=identity once no identity deployment is in flight: its check before any write tells whether identity accepts both callers, and it deploys identity again if identity does not enforce yet. To reopen instead, ${reopen()}, and deploy identity again.`;
      }
      return `${SECRET_VAR} ${has('identity', SECRET_VAR) || state.identity.stored ? 'is' : 'may be'} stored on identity, and the next identity deploy (an auto-deploy included) will enforce it. Rerun stage=identity, or ${reopen()} to stay open.`;
    }
    return `${OPEN_VAR} ${has('identity', OPEN_VAR) || !state.identity.openListed ? 'is' : 'may be'} removed from identity, which keeps enforcing the secret. Rerun stage=finalize to finish, and set ${OPEN_VAR}=1 again before any rollback.`;
  };
  for (const w of plan.writes) {
    pending = w;
    try {
      if (w.op === 'upsert') {
        const r = await gql(Q.upsert, { input: { projectId: TARGET.projectId, environmentId: TARGET.environmentId, serviceId: ids[w.service], name: w.name, value: w.value, skipDeploys: true } });
        if (r?.variableUpsert !== true) throw new StageFailure(`Railway did not confirm writing ${w.name} on ${w.service}. ${whatIsStored()}`);
        const back = await readVars(w.service);
        if (back.stored !== w.value) throw new StageFailure(`${w.name} on ${w.service} does not read back as written. ${whatIsStored()}`);
      } else {
        const r = await gql(Q.remove, { input: { projectId: TARGET.projectId, environmentId: TARGET.environmentId, serviceId: ids[w.service], name: w.name } });
        if (r?.variableDelete !== true) throw new StageFailure(`Railway did not confirm deleting ${w.name} on ${w.service}. ${whatIsStored()}`);
        const back = await readVars(w.service);
        if (back.openListed) throw new StageFailure(`${w.name} is still listed on ${w.service} after the delete. ${whatIsStored()}`);
      }
    } catch (e) {
      if (e instanceof StageFailure) throw e;
      throw new StageFailure(`${w.op === 'delete' ? 'deleting' : 'writing'} ${w.name} on ${w.service} failed at a Railway request (${kindOf(e)}). ${whatIsStored()}`);
    }
    summary.wrote.push(`${w.service}:${w.name}`);
    pending = null;
    log(`${w.op === 'delete' ? 'deleted' : 'wrote and read back'} ${w.name} on ${w.service}`);
  }

  // ── Deploys, with the image each service already runs. ─────────────────────────────────────
  const wrote = (svc) => plan.writes.some((w) => w.service === svc);
  const deployCurrentImage = async (svc, expect, { followRailway = false } = {}) => {
    try {
      const id = await startDeployment(svc, followRailway);
      if (svc === 'identity') started = id;
      log(`${svc}: deployment ${id}`);
      await waitForSuccess(svc, id);
      const inst = await instanceOf(svc);
      if (String(inst?.source?.image ?? '') !== `${resolveImageRepo(svc).repo}:${info[svc].tag}`) {
        throw new StageFailure(`${svc} was repointed during this run; rerun after that deploy finishes. ${whatIsStored()}`);
      }
      await waitForHealth(svc, expect);
      summary.deployed.push(svc);
      log(`${svc}: serving ${short(info[svc].tag)} with ${fieldText(svc, (await readHealth(http, info[svc].url)) ?? {})}`);
    } catch (e) {
      if (e instanceof StageFailure) throw e;
      throw new StageFailure(`the deploy of ${svc} failed at a Railway or HTTP request (${kindOf(e)}). ${whatIsStored()}`);
    }
  };
  const startDeployment = async (svc, followRailway) => {
    const before = info[svc].snapshot;
    const appeared = async () => { const n = await newestOf(svc); return n && n.id !== before ? n.id : undefined; };
    let found = await appeared();
    if (!found && followRailway) {
      const until = now() + t.deleteGraceMs;
      while (!found && now() < until) {
        await sleep(t.deleteGracePollMs);
        found = await appeared();
      }
    }
    if (found) {
      log(`Railway started deployment ${found} after the write; following it`);
      return found;
    }
    if (svc === 'identity') started = UNCONFIRMED;
    const dep = await triggerWithRetry(() => gql(Q.deploy, { s: ids[svc], e: TARGET.environmentId }), {
      log, sleep, baseMs: t.triggerBaseMs, reconcile: appeared,
    });
    const id = dep?.serviceInstanceDeployV2;
    if (typeof id !== 'string' || !id) throw new StageFailure(`Railway returned no deployment id for ${svc}. ${whatIsStored()}`);
    return id;
  };
  const waitForSuccess = async (svc, id) => {
    const deadline = now() + t.deployDeadlineMs;
    let status = '(unknown)';
    while (now() < deadline) {
      await sleep(t.deployPollMs);
      let d;
      try { d = await gql(Q.status, { id }); } catch { continue; } // transient until the deadline
      status = String(d?.deployment?.status ?? '(unknown)');
      if (GOOD.has(status)) return;
      if (BAD.has(status)) {
        started = null; // it will not serve, so the next deploy is the one that enforces
        throw new StageFailure(`deployment ${id} of ${svc} ended ${status}. ${whatIsStored()}`);
      }
    }
    throw new StageFailure(`deployment ${id} of ${svc} is still ${status}; do not rerun while it is in flight; inspect deployment ${id}. ${whatIsStored()}`);
  };
  const waitForHealth = async (svc, expect) => {
    const deadline = now() + t.healthDeadlineMs;
    let streak = 0;
    let last;
    while (now() < deadline) {
      last = await readHealth(http, info[svc].url);
      streak = last && last.build === info[svc].tag && expect(last) ? streak + 1 : 0;
      if (streak >= 2) return;
      await sleep(t.healthPollMs);
    }
    if (stage === 'identity' && info.identity.openStored && last?.build === info[svc].tag
      && last.introspection === 'enforced' && last.allowOpenIntrospection === false) {
      openKept = false;
      throw new StageFailure(`identity enforces ${SECRET_VAR} but no longer runs ${OPEN_VAR}=1, which it stored when this run began, so the rollback is gone: deleting the secret now would leave introspection disabled. ${whatIsStored()}`);
    }
    throw new StageFailure(`${svc} reached SUCCESS but still reports ${last ? `${fieldText(svc, last)} on build ${short(last.build)}` : 'no health'}; the deployment does not carry the change; check Railway's staged changes for ${svc}. ${whatIsStored()}`);
  };

  if (stage === 'callers') {
    for (const svc of CALLERS) {
      if (wrote(svc) || info[svc].health.identityVerifyAuth !== true) await deployCurrentImage(svc, (h) => h.identityVerifyAuth === true);
    }
  } else if (stage === 'identity') {
    if (wrote('identity') || info.identity.health.introspection !== 'enforced') {
      // When the preflight saw the rollback stored, the new container must still run it, so the
      // rollback text below is true when it says ALLOW_OPEN_INTROSPECTION=1 is still set.
      await deployCurrentImage('identity', (h) => h.introspection === 'enforced' && (!info.identity.openStored || h.allowOpenIntrospection === true));
      // The old, open identity container may still answer for overlapSeconds after SUCCESS, and
      // it accepts any caller, so the check waits it out.
      await sleep(((info.identity.overlapSeconds ?? 20) * 1000) + t.overlapExtraMs);
      const [r, g] = [await decisive(() => relayProbe(http, info.relay.origin)), await decisive(() => gateProbe(http, info['css-gate'].url, info['css-gate'].origin))];
      log(`check after the deploy: identity accepts relay: ${r}; accepts css-gate: ${g}`);
      const rollback = `Roll back: ${reopen()} and redeploy identity`;
      if (r === 'rejected' || g === 'rejected') {
        throw new StageFailure(`identity refuses ${[r === 'rejected' ? 'the relay' : '', g === 'rejected' ? 'css-gate' : ''].filter(Boolean).join(' and ')}: the ${SECRET_VAR} that caller runs with is not identity's. ${rollback}.`);
      }
      if (r !== 'accepted' || g !== 'accepted') {
        throw new StageFailure(`identity enforces, but the check is inconclusive for ${[r !== 'accepted' ? 'the relay' : '', g !== 'accepted' ? 'css-gate' : ''].filter(Boolean).join(' and ')}. Check by hand: POST ${info.relay.origin}/tool/publish_context with 'Authorization: Bearer probe' and body {} must answer 401 with detail 'Token not found'; GET ${info['css-gate'].origin}/<your userId>/auth-methods.jsonld with your own identity token must answer 200. If either fails: ${rollback}.`);
      }
    }
  } else if (wrote('identity') || info.identity.health.allowOpenIntrospection !== false) {
    await deployCurrentImage('identity', (h) => h.introspection === 'enforced' && h.allowOpenIntrospection === false, { followRailway: wrote('identity') });
  }
  log(summary.deployed.length ? `done: deployed ${summary.deployed.join(', ')}` : 'done: nothing needed deploying');

  async function decisive(probe) {
    let r = 'inconclusive';
    for (let i = 0; i < t.probeAttempts; i++) {
      if (i > 0) await sleep(t.probeGapMs);
      r = await probe();
      if (r !== 'inconclusive') return r;
    }
    return r;
  }
  return summary;
}

/** 'GraphQL' or 'network' from this tool's own wrapper messages; never the text of an error. */
function kindOf(e) {
  const m = String(e?.message ?? '');
  return m.startsWith('GraphQL: ') ? 'GraphQL' : m.startsWith('network: ') ? 'network' : 'error';
}

async function readHealth(http, url) {
  try {
    const r = await http.getJson(url);
    return r.status === 200 && r.body && typeof r.body === 'object' ? r.body : null;
  } catch {
    return null;
  }
}

/** Does identity accept the relay's bearer? Through the relay's own 401 detail for a bearer identity does not know. */
async function relayProbe(http, origin) {
  try {
    const r = await http.send(`${origin}/tool/publish_context`, {
      method: 'POST', headers: { Authorization: `Bearer ${PROBE_BEARER}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    const detail = typeof r.body?.detail === 'string' ? r.body.detail : '';
    if (r.status === 401 && detail === 'Token not found') return 'accepted';
    if (r.status === 401 && /^Identity server error: 40[13]$/.test(detail)) return 'rejected';
  } catch { /* inconclusive */ }
  return 'inconclusive';
}

/**
 * Does identity accept css-gate's bearer? A fresh made-up bearer (never cached by the gate) on a
 * private document makes the gate ask identity, and its /healthz counters say how identity answered.
 */
async function gateProbe(http, healthUrl, origin) {
  try {
    const before = (await readHealth(http, healthUrl))?.identityVerifyResults;
    await http.getJson(`${origin}/introspection-rollout-probe/auth-methods.jsonld`, {
      headers: { Authorization: `Bearer ${PROBE_BEARER}-${randomBytes(8).toString('hex')}` },
    });
    const after = (await readHealth(http, healthUrl))?.identityVerifyResults;
    if (!before || !after) return 'inconclusive';
    if (after.refused > before.refused) return 'rejected';
    if (after.accepted > before.accepted) return 'accepted';
  } catch { /* inconclusive */ }
  return 'inconclusive';
}

/**
 * Refuse while a deploy workflow, or another run of this tool's own workflow, is running. A
 * reusable-workflow leg is listed under its caller's run, not under deploy-railway.yml, and
 * auto-deploy.yml is the only caller whose leg deploys relay, css-gate or identity
 * (i2idlx-v93-release.yml's leg deploys only foxxi-bridge), so these two files cover every
 * workflow that deploys the three services. The workflow's concurrency group already keeps two
 * provisioning runs apart; listing them here keeps that true if the group changes, and this run
 * (GITHUB_RUN_ID) is the one run of that list that does not count. A deployment started in
 * Railway itself is caught by the preflight's in-flight check instead. Outside GitHub Actions a
 * dry run skips the check and an applied run is refused.
 */
async function checkNoDeployRunning({ http, github, log, apply }) {
  if (!github) {
    if (apply) throw new ProvisionRefusal('apply runs only inside GitHub Actions, where the deploy workflows can be checked');
    log('note: not in GitHub Actions; not checking for a running deploy workflow');
    return;
  }
  if (!github.token || !github.repository || !github.runId) {
    throw new ProvisionRefusal('GITHUB_TOKEN, GITHUB_REPOSITORY or GITHUB_RUN_ID is not set; cannot check for a running deploy or provisioning run');
  }
  for (const file of ['auto-deploy.yml', 'deploy-railway.yml', 'identity-introspection-provision.yml']) {
    let r;
    try {
      r = await http.getJson(`https://api.github.com/repos/${github.repository}/actions/workflows/${file}/runs?per_page=20`, {
        headers: { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'identity-introspection-provision' },
      });
    } catch {
      throw new ProvisionRefusal(`could not list the runs of ${file}`);
    }
    if (r.status !== 200 || !Array.isArray(r.body?.workflow_runs)) throw new ProvisionRefusal(`could not list the runs of ${file} (HTTP ${r.status})`);
    const running = r.body.workflow_runs.filter((run) => String(run.id) !== String(github.runId) && run.status !== 'completed');
    if (running.length) throw new ProvisionRefusal(`${file} has a run that has not finished (${running.map((x) => x.id).join(', ')}); rerun when it has`);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Railway's GraphQL API. An answered refusal (2xx with `errors`) is 'GraphQL:', the only kind
 * railway-deploy-trigger.mjs retries; a non-2xx answer is as ambiguous as a lost one, so it is
 * 'network:', even when its body is JSON with `errors`. A redirect is not followed and is
 * 'network:' too. Railway's own text is never kept, and no `cause` is attached.
 */
export function railwayGql(token, fetchImpl = fetch) {
  return async (query, variables = {}) => {
    let response;
    let body;
    try {
      response = await fetchImpl('https://backboard.railway.com/graphql/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token },
        body: JSON.stringify({ query, variables }),
        // A followed redirect would carry the token and the body (the value, on an upsert) to
        // wherever Location points: fetch drops only Authorization across origins.
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      body = await response.json();
    } catch {
      throw new Error('network: request failed');
    }
    if (!response.ok) throw new Error('network: request failed');
    if (body?.errors?.length) throw new Error('GraphQL: Railway refused the request');
    return body?.data;
  };
}

/** Plain HTTP for health checks, probes and the GitHub API: no redirects, 15 s, JSON or null. */
export function httpClient(fetchImpl = fetch) {
  const request = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const r = await fetchImpl(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: parsed };
  };
  return { getJson: (url, opts = {}) => request(url, { headers: opts.headers }), send: (url, opts) => request(url, opts) };
}

async function main() {
  const refusal = cliRefusal(process.env);
  if (refusal) throw new ProvisionRefusal(refusal);
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  await runStage({
    gql: railwayGql(process.env.RAILWAY_PROJECT_TOKEN),
    http: httpClient(),
    stage: process.env.STAGE,
    apply: process.env.APPLY === 'true',
    log: (line) => console.log(line),
    // A runner command: GitHub hides the value from every later line of this job's log.
    mask: inActions ? (v) => process.stdout.write(`::add-mask::${v}\n`) : () => {},
    github: inActions
      ? { repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, runId: process.env.GITHUB_RUN_ID }
      : undefined,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fail = (e) => { console.error(describeFailure(e)); process.exit(1); };
  process.on('unhandledRejection', fail);
  process.on('uncaughtException', fail);
  main().catch((e) => {
    console.error(describeFailure(e));
    process.exitCode = 1;
  });
}
