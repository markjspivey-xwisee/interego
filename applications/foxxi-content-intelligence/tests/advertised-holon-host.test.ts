/**
 * THE ADVERTISED HOST OF AN ENCRYPTED HOLON — driven through the real projection, not the helper.
 *
 * ── ★★ WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────
 *
 * `toAdvertisedHolonUrl` in src/foundation-persist.ts decided "is this URL on our own store, and
 * how should a cross-seat reader spell it" by asking whether the host CONTAINED the dotted string
 * ".internal.". That is true of an Azure Container Apps internal FQDN
 * ("interego-css.internal.livelysky-ID.eastus.azurecontainerapps.io") and false of Railway's
 * ("css.railway.internal:3456"), because there ".internal" is the final label. The fleet moved
 * providers and the test stopped matching the only internal host this deployment has — so the
 * iep:encryptedHolon link went on advertising an address only this cluster can resolve, which is
 * the exact defect the function was added to fix.
 *
 * The same substring was true of hosts that are not ours at all: "a.internal.evil.example" matched,
 * and its origin was replaced with ours while its PATH was carried across — a foreign address
 * laundered into a link naming our store. placement.target is an ABSOLUTE url read verbatim out of
 * the agent's own Solid Type Index, so that input is chosen by the agent, not by us.
 *
 * ★ DRIVEN THROUGH `persistEncryptedHolonProjection`, NOT THE HELPER. The helper is not exported,
 * and a test that re-implements the decision proves only that the author agrees with themselves.
 * These cases run the shipped Stage-1/2/3 composition against a fetch that serves the Type Index and
 * captures the descriptor, and assert on the Turtle that is actually PUT.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createPGSL, mintAtom } from '@interego/pgsl';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { persistEncryptedHolonProjection } from '../src/foundation-persist.js';
import { configureStoreSpelling } from '../src/store-origins.js';

const GATE = 'https://gate.interego.xwisee.com';
const TENANT = `${GATE}/foxxi/`;
const RAILWAY_INTERNAL = 'http://css.railway.internal:3456';
const AZURE_INTERNAL = 'https://interego-css.internal.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const SHAPE = 'https://example.org/ns/foxxi#RecordedPerformance' as IRI;

/** A pod on whichever origin the case is about. */
const podOn = (origin: string): string => `${origin}/eth-abc/`;

interface Run {
  readonly holonWrittenTo: string;
  readonly descriptorWrittenTo: string;
  readonly advertised: string | undefined;
}

/**
 * Run the real persistence composition.
 *
 * `typeIndexTarget`, when given, is served as the agent's own Type Index registration — which is
 * how an agent chooses `placement.target`, and therefore how a foreign origin gets into this code
 * path at all. Without it the conventional fallback container under the agent's pod is used.
 */
async function run(agentPod: string, typeIndexTarget?: string): Promise<Run> {
  const pgsl = createPGSL({ wasAttributedTo: 'did:test:advertised' as IRI, generatedAtTime: '2026-01-01T00:00:00.000Z' });
  const top = mintAtom(pgsl, 'one recorded performance');
  const writes: Array<{ url: string; body: string }> = [];

  const fetchFn = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      writes.push({ url, body: String(init?.body ?? '') });
      return new Response('', { status: 201 });
    }
    if (typeIndexTarget && url.endsWith('settings/publicTypeIndex.ttl')) {
      // A minimal registration in the shape `registrationTargetFor` parses. The angle brackets are
      // Turtle syntax, so the IRIs are composed by concatenation rather than interpolated inside
      // them — the repository's raw-IRI ratchet counts the latter, and is right to.
      const ttl = '@prefix solid: <http://www.w3.org/ns/solid/terms#> .\n'
        + '<#reg> a solid:TypeRegistration ; solid:forClass <' + String(SHAPE) + '> ; '
        + 'solid:instanceContainer <' + typeIndexTarget + '> .\n';
      return new Response(ttl, { status: 200, headers: { 'content-type': 'text/turtle' } });
    }
    return new Response('', { status: 404 });
  }) as unknown as Parameters<typeof persistEncryptedHolonProjection>[0]['fetch'];

  const result = await persistEncryptedHolonProjection({
    agent: agentPod,
    shapeClass: SHAPE,
    defaultContainer: 'foxxi-records/',
    pgsl,
    holonUri: top,
    recipientPublicKeys: [deriveEncryptionKeyPair('a'.repeat(64)).publicKey],
    senderKeyPair: deriveEncryptionKeyPair('b'.repeat(64)),
    fetch: fetchFn,
  });
  const descriptor = writes.find((w) => w.url === result.descriptorUrl);
  const advertised = descriptor?.body.match(/iep:encryptedHolon\s+<([^>]+)>/)?.[1];
  return { holonWrittenTo: result.holonResourceUrl, descriptorWrittenTo: result.descriptorUrl, advertised };
}

const originOf = (u: string | undefined): string => { try { return new URL(String(u)).origin; } catch { return 'unparseable'; } };
const pathOf = (u: string | undefined): string => { try { return new URL(String(u)).pathname; } catch { return 'unparseable'; } };

/**
 * ★★ THE SPELLING IS CONFIGURED, NOT PUT IN THE ENVIRONMENT, AND THAT IS WHY THIS FILE CAN EXIST.
 *
 * applications/_shared/tests/shared-live-externals.test.ts records FOXXI_TENANT_POD_URL as a live
 * address NOTHING in this tree supplies, and re-measures that claim over every tracked file. A test
 * that set it to reach this decision would red that guard — correctly, because a collected module
 * could then write to a real pod. So the decision moved behind `configureStoreSpelling`, which is
 * what bridge/server.ts calls at start-up, and this drives the same entry point the deployment does.
 */
describe('the iep:encryptedHolon link a cross-seat reader is handed', () => {
  configureStoreSpelling({ publicPodUrl: TENANT, internalPodUrl: `${RAILWAY_INTERNAL}/` });

  afterAll(() => { configureStoreSpelling(undefined); });

  it('re-spells THIS deployment internal host onto the public gate — the case the substring missed', async () => {
    const r = await run(podOn(RAILWAY_INTERNAL));
    // The WRITE is unchanged: still the in-env host, still the same path.
    expect(originOf(r.holonWrittenTo)).toBe(RAILWAY_INTERNAL);
    // The ADVERTISED link is the gate, at the identical path.
    expect(originOf(r.advertised)).toBe(GATE);
    expect(pathOf(r.advertised)).toBe(pathOf(r.holonWrittenTo));
  });

  it('leaves a URL already on the public gate exactly as it is', async () => {
    const r = await run(podOn(GATE));
    expect(r.advertised).toBe(r.holonWrittenTo);
  });

  it('REFUSES to re-spell a foreign host, including one whose name contains the old substring', async () => {
    const foreign = 'https://a.internal.evil.example';
    const r = await run(podOn(GATE), `${foreign}/steal/`);
    // The agent's Type Index really did steer the write off our store — that is not this
    // function's job to prevent, and the case asserts it so it cannot become vacuous.
    expect(originOf(r.holonWrittenTo)).toBe(foreign);
    // What must never happen: our origin in front of somebody else's path.
    expect(originOf(r.advertised)).toBe(foreign);
    expect(r.advertised).toBe(r.holonWrittenTo);
  });

  it('does not re-spell a host that merely ends in .internal but is not ours', async () => {
    const foreign = 'https://attacker.internal';
    const r = await run(podOn(GATE), `${foreign}/steal/`);
    expect(originOf(r.advertised)).toBe(foreign);
  });

  it('re-spells the Azure internal FQDN too, when THAT is the configured internal host', async () => {
    configureStoreSpelling({ publicPodUrl: TENANT, internalPodUrl: `${AZURE_INTERNAL}/` });
    try {
      const r = await run(podOn(AZURE_INTERNAL));
      expect(originOf(r.advertised)).toBe(GATE);
      // ...and the Railway host is then NOT ours, because membership follows configuration
      // rather than a guess about how a provider spells its private network.
      const other = await run(podOn(RAILWAY_INTERNAL));
      expect(originOf(other.advertised)).toBe(RAILWAY_INTERNAL);
    } finally {
      configureStoreSpelling({ publicPodUrl: TENANT, internalPodUrl: `${RAILWAY_INTERNAL}/` });
    }
  });

  it('is a no-op when this deployment has no public pod name at all', async () => {
    configureStoreSpelling({ publicPodUrl: '', internalPodUrl: `${RAILWAY_INTERNAL}/` });
    try {
      const r = await run(podOn(RAILWAY_INTERNAL));
      expect(r.advertised).toBe(r.holonWrittenTo);
    } finally {
      configureStoreSpelling({ publicPodUrl: TENANT, internalPodUrl: `${RAILWAY_INTERNAL}/` });
    }
  });

  it('re-spells nothing when the store has only one name — the unconfigured, fail-closed case', async () => {
    configureStoreSpelling({ publicPodUrl: TENANT });
    try {
      const r = await run(podOn(RAILWAY_INTERNAL));
      // The in-env host is not known to be ours, so the link names the host it was written to.
      expect(r.advertised).toBe(r.holonWrittenTo);
      const onGate = await run(podOn(GATE));
      expect(originOf(onGate.advertised)).toBe(GATE);
    } finally {
      configureStoreSpelling({ publicPodUrl: TENANT, internalPodUrl: `${RAILWAY_INTERNAL}/` });
    }
  });
});
