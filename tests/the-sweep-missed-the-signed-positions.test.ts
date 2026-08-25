/**
 * The IRI positions the escaping sweep walked past — and what each one does with a value it
 * cannot emit.
 *
 * ★ THE DEFECT. Round-21 put `iescIri()` on the hand-built graph/manifest/affordance lines in
 * `packages/solid/src/client.ts`, and the round-19 fix covered the core serializer's facet IRIs.
 * Four raw `<${...}>` interpolations survived both passes, in the block whose entire purpose is
 * that a reader can trust it — `buildAuthorshipProofBlock`. Two more survived elsewhere: the
 * `iep:renderView` affordance target (the relay base half was never encoded) and the CAS
 * supersession witness, which is a `#` COMMENT and therefore a Turtle position whose terminator
 * is a newline. `packages/core/src/rdf/system-ontology.ts` had the same hole in
 * `systemDcatCatalog`, the one function in that module whose IRIs are not namespace constants.
 *
 * The relay reaches three of the authorship fields straight off the wire: `owner_webid`,
 * `descriptor_id` and `agent_id` are read as strings and passed through, and the comment beside
 * `descId` in deploy/mcp-relay/server.ts already calls it "caller-chosen".
 *
 * ★ WHAT THIS FILE ACTUALLY PINS, AND WHY IT IS NOT ONE ASSERTION REPEATED. `turtleIriRef()`
 * returns null; it neither throws nor sanitises, so every site had to DECIDE. The decisions are
 * deliberately not the same, and the tests below assert the difference:
 *
 *   authorship proof   THROW  — the caller asked for a signed record; publishing it unsigned and
 *                              reporting success is the record quietly saying less than it should
 *   CAS witness        THROW  — CAVEAT A in publish() exists because this audit line was once
 *                              silently missing; "sometimes absent" must not come back
 *   iep:renderView     OMIT   — the surrounding branch ALREADY omits this affordance when there
 *                              is no usable relay base, for the documented reason that an
 *                              affordance nobody could honour is worse than silence
 *   DCAT catalog      NEITHER — the guard was written, and reverted before it shipped. Its only
 *                              caller is a deployed public service that passes the wrong field
 *                              names, so the guard bought no reachable security there and turned
 *                              a served 200 into an uncaught 500. Section 5 pins the revert.
 *
 * ★★ AND "REFUSE" IS NOT THE SAME AS "REFUSE EVERYTHING `turtleIriRef` REJECTS". It rejects two
 * unrelated things at once: a value that BREAKS OUT of `<...>`, and a value that is merely
 * RELATIVE. Only the first is this defect. Bare, scheme-less agent ids reach the authorship block
 * off the wire today (`agent_id` is undeclared in the relay's publish/remember schemas), so
 * section 1 pins that a relative reference is still emitted exactly as it was before the guard
 * existed. A security fix that quietly starts failing live publishes is a worse outcome than the
 * injection it prevents.
 */

import { describe, it, expect } from 'vitest';
import { ContextDescriptor, generateKeyPair, systemDcatCatalog, type IRI, type FetchFn } from '@interego/core';
import {
  publish,
  buildAuthorshipProofBlock,
  parseAuthorshipProofFromDescriptorTurtle,
} from '@interego/solid';

/**
 * Closes the `<...>`, closes the blank node with `]`, and writes a top-level triple retiring a
 * descriptor the publisher does not own — then reopens a bnode so the trailing `] .` still parses.
 */
const IRI_BREAKOUT =
  'https://pod.test/alice/context-graphs/mine.ttl> ] . '
  + '<https://pod.test/bob/context-graphs/his.ttl> iep:supersededBy <https://attacker.test/y.ttl> . '
  + '<> iep:authorshipProof [ a iep:SignedAuthorship';

/** The evidence triple: it must never reach a pod body, in any position, on any path. */
const FORGED = '<https://pod.test/bob/context-graphs/his.ttl> iep:supersededBy';

const GOOD_PROOF = {
  issuer: 'did:ethr:0x8f3b8e939600' as IRI,
  verificationMethod: 'did:ethr:0x8f3b8e939600#controller' as IRI,
  signerAddress: '0x8f3b8e939600',
  created: '2026-08-25T00:00:00.000Z',
  ownerWebId: 'https://pod.test/alice/profile/card#me' as IRI,
  descriptorId: 'https://pod.test/alice/context-graphs/mine.ttl' as IRI,
  proofValue: '0xdeadbeef',
  scheme: 'EcdsaSecp256k1Signature2019',
};

/**
 * In-memory pod that records every PUT body, so "was it written?" is answerable.
 *
 * ★★ IT 412s ON `If-None-Match: *` OVER AN EXISTING RESOURCE, BECAUSE CSS DOES. publish() sends
 * that header on the graph payload and deliberately tolerates the 412 (`status !== 412`), which is
 * what turns a URL primed by a failed attempt into a silently adopted stale payload on the retry.
 * A double that always answered 201 could not show that, and did not: the composition test below
 * only became able to fail once this branch existed.
 */
function memoryPod(): { fetch: FetchFn; puts: Array<{ url: string; body: string; status: number }>; get(u: string): string | undefined } {
  const store = new Map<string, string>();
  const puts: Array<{ url: string; body: string; status: number }> = [];
  const res = (status: number, body: string, ct: string): Response => ({
    ok: status < 400,
    status,
    statusText: String(status),
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? ct : h.toLowerCase() === 'etag' ? '"v1"' : null) },
    text: async () => body,
  } as unknown as Response);
  const fetchFn = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      if ((init?.headers?.['If-None-Match'] ?? '') === '*' && store.has(url)) {
        puts.push({ url, body: String(init?.body ?? ''), status: 412 });
        return res(412, '', 'text/turtle');
      }
      puts.push({ url, body: String(init?.body ?? ''), status: 201 });
      store.set(url, String(init?.body ?? ''));
      return res(201, '', 'text/turtle');
    }
    const body = store.get(url);
    if (body === undefined) return res(404, '', 'text/turtle');
    const ct = url.endsWith('.envelope.jose.json') ? 'application/jose+json'
      : url.endsWith('.trig') ? 'application/trig' : 'text/turtle';
    return res(200, body, ct);
  }) as unknown as FetchFn;
  return { fetch: fetchFn, puts, get: (u: string) => store.get(u) };
}

function descriptorFor(id: string, opts?: { supersedes?: string }): ReturnType<ReturnType<typeof ContextDescriptor.create>['build']> {
  const b = ContextDescriptor.create(id as IRI)
    .describes('urn:graph:alice:demo:v1' as IRI)
    .temporal({ validFrom: '2026-08-25T00:00:00.000Z' })
    .semiotic({ modalStatus: 'Asserted', epistemicConfidence: 1.0 })
    .version(1);
  if (opts?.supersedes) b.supersedes(opts.supersedes as IRI);
  return b.build();
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. buildAuthorshipProofBlock — REFUSE, naming the field
// ═══════════════════════════════════════════════════════════════════════════

describe('the authorship proof block refuses an IRI it cannot hold', () => {
  const FIELDS = ['issuer', 'verificationMethod', 'ownerWebId', 'descriptorId'] as const;

  it('throws for a breakout value in each of the four IRI positions, and names the field', () => {
    for (const field of FIELDS) {
      const hostile = { ...GOOD_PROOF, [field]: IRI_BREAKOUT as IRI };
      expect(() => buildAuthorshipProofBlock(hostile), `${field} must be refused`).toThrow(
        `buildAuthorshipProofBlock: ${field} cannot be serialised as a Turtle IRI reference`,
      );
    }
  });

  it('EMITS a relative reference — refusing one is a strictness change, not this fix', () => {
    /**
     * ★★ THE REGRESSION THIS PINS IS THE FIX ITSELF. `turtleIriRef` refuses a relative reference
     * as well as an injecting one, so the first version of this guard turned every scheme-less
     * value into a hard publish failure. Those values are live: the relay carries `principalIri()`
     * ("the relay's userId is a bare slug"), `canonicalSurfaceAgentDid()` and a `did:web:` branch
     * precisely because bare agent ids occur, `agent_id` is undeclared in the `publish_context` /
     * `remember` / `record_trajectory_step` schemas, and `handleRemember` reads it off the wire
     * verbatim and publishes with `sign_authorship: true` hard-coded. `chatgpt-u-pk-b03a054d6915`
     * holds no `<`, no `>` and no space — it cannot inject, and it must still publish.
     *
     * A relative IRI resolving against the reader's base IS a real bug, and escape.ts says so. It
     * is a different one, and it needs its own change, with its own measurement of what stops
     * working. It does not get to ride in on an injection fix.
     */
    const relative = buildAuthorshipProofBlock({ ...GOOD_PROOF, issuer: 'chatgpt-u-pk-b03a054d6915' as IRI });
    expect(relative).toContain('iep:issuer <chatgpt-u-pk-b03a054d6915>');
    const slug = buildAuthorshipProofBlock({ ...GOOD_PROOF, descriptorId: 'context-graphs/mine.ttl' as IRI });
    expect(slug).toContain('iep:descriptorId <context-graphs/mine.ttl>');
    // ★ AND THE TOLERANCE STOPS AT THE FORBIDDEN SET, not at the missing scheme: a relative value
    // that still breaks out of `<...>` is refused like any other.
    expect(() => buildAuthorshipProofBlock({ ...GOOD_PROOF, issuer: 'a/b> ] . <urn:x> a <urn:y' as IRI }))
      .toThrow('issuer cannot be serialised as a Turtle IRI reference');
    expect(() => buildAuthorshipProofBlock({ ...GOOD_PROOF, issuer: 'has a space' as IRI }))
      .toThrow('issuer cannot be serialised as a Turtle IRI reference');
    expect(() => buildAuthorshipProofBlock({ ...GOOD_PROOF, issuer: '' as IRI }))
      .toThrow('issuer cannot be serialised as a Turtle IRI reference');
  });

  it('emits nothing at all on refusal — not a partial block a verifier would read as tampered', () => {
    // The emitter builds the array eagerly, so a refusal cannot leave a half-written bnode
    // behind; there is no return value to inspect, only the throw.
    let out: string | undefined;
    try { out = buildAuthorshipProofBlock({ ...GOOD_PROOF, issuer: IRI_BREAKOUT as IRI }); } catch { /* expected */ }
    expect(out).toBeUndefined();
  });

  it('a legitimate proof is unchanged and still round-trips through the parser', () => {
    const block = buildAuthorshipProofBlock(GOOD_PROOF);
    expect(block).toContain(`iep:issuer <${GOOD_PROOF.issuer}>`);
    expect(block).toContain(`iep:ownerWebId <${GOOD_PROOF.ownerWebId}>`);
    const parsed = parseAuthorshipProofFromDescriptorTurtle(block);
    expect(parsed).not.toBeNull();
    expect(parsed!.issuer).toBe(GOOD_PROOF.issuer);
    expect(parsed!.verificationMethod).toBe(GOOD_PROOF.verificationMethod);
    expect(parsed!.ownerWebId).toBe(GOOD_PROOF.ownerWebId);
    expect(parsed!.descriptorId).toBe(GOOD_PROOF.descriptorId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. The composition — through the real publish(), not through the emitter alone
// ═══════════════════════════════════════════════════════════════════════════

describe('publish() never writes a descriptor carrying an injected authorship IRI', () => {
  it('rejects the publish, and no pod body anywhere contains the forged triple', async () => {
    const pod = memoryPod();
    const descriptor = descriptorFor('https://pod.test/alice/context-graphs/mine.ttl');
    await expect(publish(descriptor, '<urn:s> <urn:p> "v" .', 'https://pod.test/alice/', {
      fetch: pod.fetch,
      authorshipProof: { ...GOOD_PROOF, ownerWebId: IRI_BREAKOUT as IRI },
    })).rejects.toThrow('ownerWebId cannot be serialised as a Turtle IRI reference');
    for (const { url, body } of pod.puts) {
      expect(body.includes(FORGED), `forged triple reached ${url}`).toBe(false);
    }
    /**
     * ★★ ZERO PUTs — AND THIS ONE ASSERTION IS WHERE THE FIX LIVES. The first version of this
     * test asserted only that no descriptor and no manifest entry landed, and its comment said
     * "the graph payload is PUT before the authorship block is built, so a byte may have landed".
     * That was accurate, and it was the defect being written down rather than caught: the four
     * new throws were the FIRST deterministic, caller-value-triggered abort anywhere between step
     * 1 (the payload PUT) and step 2 (the descriptor PUT) — every other abort in that window is
     * transient network failure, which `withTransientRetry` owns. A refused publish therefore
     * left a payload on the pod with no descriptor pointing at it.
     *
     * publish() now builds the authorship block BEFORE step 1, so a refusal writes nothing at
     * all. The next test shows why "nothing at all" and "no descriptor" are not the same thing.
     */
    expect(pod.puts, 'a refused publish must leave nothing behind').toHaveLength(0);
  });

  it('a corrected retry publishes the corrected bytes, not the bytes of the refused attempt', async () => {
    /**
     * ★★ THE HALF-WRITE WAS WORSE THAN A HALF-WRITE. Step 1 sends `If-None-Match: *` and
     * deliberately tolerates the 412, so a URL primed by a refused attempt SURVIVES the retry: the
     * corrected publish writes a descriptor and a manifest entry over the refused attempt's
     * payload and reports success. The authorship proof's contentHash then covers bytes the pod
     * does not serve, so every entitled reader recomputes the digest and gets
     * `contentBinding: 'mismatched'` — the sharpest tampering signal this substrate produces,
     * manufactured by an honest publisher who corrected a value and tried again.
     *
     * Measured through the real publish() against a pod that 412s like CSS, not argued.
     */
    const pod = memoryPod();
    const id = 'https://pod.test/alice/context-graphs/mine.ttl';
    await expect(publish(descriptorFor(id), '<urn:s> <urn:p> "DRAFT-v1" .', 'https://pod.test/alice/', {
      fetch: pod.fetch,
      authorshipProof: { ...GOOD_PROOF, ownerWebId: IRI_BREAKOUT as IRI },
    })).rejects.toThrow('ownerWebId cannot be serialised');
    const result = await publish(descriptorFor(id), '<urn:s> <urn:p> "CORRECTED-v2" .', 'https://pod.test/alice/', {
      fetch: pod.fetch,
      authorshipProof: GOOD_PROOF,
    });
    const graph = pod.get('https://pod.test/alice/context-graphs/mine.ttl-graph.trig');
    expect(graph, 'the graph payload the descriptor points at').toBeDefined();
    expect(graph, 'the pod must serve what publish() reported').toContain('CORRECTED-v2');
    expect(graph, 'the refused attempt must not have primed the URL').not.toContain('DRAFT-v1');
    expect(pod.get(result.descriptorUrl)).toBeDefined();
  });

  it('the same publish with a clean proof succeeds and the proof lands in the descriptor', async () => {
    const pod = memoryPod();
    const descriptor = descriptorFor('https://pod.test/alice/context-graphs/mine.ttl');
    const result = await publish(descriptor, '<urn:s> <urn:p> "v" .', 'https://pod.test/alice/', {
      fetch: pod.fetch,
      authorshipProof: GOOD_PROOF,
    });
    const turtle = pod.get(result.descriptorUrl);
    expect(turtle).toBeDefined();
    expect(parseAuthorshipProofFromDescriptorTurtle(turtle!)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. The CAS supersession witness — a `#` comment is a position, and \n ends it
// ═══════════════════════════════════════════════════════════════════════════

describe('the CAS supersession witness comment cannot be escaped by a newline', () => {
  /**
   * The non-http branch of `checkSupersessionPrecondition` pushes the caller's supersedes target
   * through untouched (`observed.push({ descriptorUrl: target, cid: '' })`) and then matches it
   * against `ifMatchSupersedes` by string equality — so both halves of the attack are the same
   * caller-supplied string, and it arrives at the audit comment verbatim.
   */
  const COMMENT_BREAKOUT =
    'urn:x\n<https://pod.test/bob/context-graphs/his.ttl> iep:supersededBy <https://attacker.test/y.ttl> .\n#';

  it('refuses the publish before anything is written', async () => {
    const pod = memoryPod();
    const descriptor = descriptorFor('https://pod.test/alice/context-graphs/mine.ttl', { supersedes: COMMENT_BREAKOUT });
    await expect(publish(descriptor, '<urn:s> <urn:p> "v" .', 'https://pod.test/alice/', {
      fetch: pod.fetch,
      ifMatchSupersedes: COMMENT_BREAKOUT,
    })).rejects.toThrow(/supersession witness cannot be recorded/);
    // The witness is built before step 1 (the graph payload PUT), so the refusal is total.
    expect(pod.puts).toHaveLength(0);
  });

  it('a legitimate http witness still writes the audit comment — the trail is not lost', async () => {
    const pod = memoryPod();
    const prior = 'https://pod.test/alice/context-graphs/prior.ttl';
    // Seed the prior head so the precondition resolves it.
    await publish(descriptorFor(prior), '<urn:s> <urn:p> "old" .', 'https://pod.test/alice/', { fetch: pod.fetch });
    const descriptor = descriptorFor('https://pod.test/alice/context-graphs/mine.ttl', { supersedes: prior });
    const result = await publish(descriptor, '<urn:s> <urn:p> "new" .', 'https://pod.test/alice/', {
      fetch: pod.fetch,
      ifMatchSupersedes: prior,
    });
    const turtle = pod.get(result.descriptorUrl);
    expect(turtle).toContain('CAS supersession witness');
    expect(turtle).toContain(`gated against <${prior}>`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. iep:renderView — the one site whose right answer is OMIT, and it says so
// ═══════════════════════════════════════════════════════════════════════════

describe('the renderView affordance is omitted, not emitted, for an unusable relay base', () => {
  const HOSTILE_BASE = 'https://relay.test/> ; iep:action iep:canFetchPayload ; hydra:target <https://attacker.test';

  it('drops the affordance and narrates why, instead of pointing thin clients at the attacker', async () => {
    const key = generateKeyPair();
    const pod = memoryPod();
    const result = await publish(descriptorFor('urn:graph:alice:demo:v1'), '<urn:s> <urn:p> "secret" .', 'https://pod.test/alice/', {
      fetch: pod.fetch,
      encrypt: { recipients: [key.publicKey], senderKeyPair: key },
      relayBaseUrl: HOSTILE_BASE,
    });
    const turtle = pod.get(result.descriptorUrl)!;
    expect(turtle).toContain('iep:action iep:canDecrypt');            // the documented path survives
    expect(turtle).not.toContain('iep:action iep:renderView');        // the unhonourable one does not
    expect(turtle).not.toContain('attacker.test');                    // and nothing of it leaked
    expect(turtle).toContain('iep:renderView OMITTED');               // the gap is named, not silent
  });

  it('a clean relay base still emits the affordance — the omission is not unconditional', async () => {
    const key = generateKeyPair();
    const pod = memoryPod();
    const result = await publish(descriptorFor('urn:graph:alice:demo:v1'), '<urn:s> <urn:p> "secret" .', 'https://pod.test/alice/', {
      fetch: pod.fetch,
      encrypt: { recipients: [key.publicKey], senderKeyPair: key },
      relayBaseUrl: 'https://relay.test',
    });
    const turtle = pod.get(result.descriptorUrl)!;
    expect(turtle).toContain('iep:action iep:renderView');
    expect(turtle).toContain('<https://relay.test/render/urn%3Agraph%3Aalice%3Ademo%3Av1>');
    expect(turtle).not.toContain('OMITTED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. systemDcatCatalog — the conversion that was REVERTED, and what pins the revert
// ═══════════════════════════════════════════════════════════════════════════

describe('the federation catalog still serves the shape its only caller passes', () => {
  /**
   * ★★ THIS SECTION PINS AN ABSENCE, DELIBERATELY. `systemDcatCatalog` is the one function in
   * `system-ontology.ts` whose IRIs are not compile-time namespace constants, and it was guarded
   * with `turtleIriRef` / `escapeTurtleLiteral` in this same round. The guard was reverted before
   * shipping, because its only caller in the tree is `examples/pgsl-browser/server.ts` `/catalog`
   * — the public Railway service `pgsl-browser` — and that caller passes `{url, name,
   * descriptorCount}` where `PodInfo` declares `{uri, title, accessUrl}`. Every field the
   * function reads is `undefined` on that path, so:
   *
   *   • the injection the guard defends against is UNREACHABLE there (no body-supplied value
   *     reaches any field the function reads), and
   *   • the guard threw on every request once any pod had been discovered, turning a served 200
   *     into an uncaught express 500 — latent, because an empty registry still rendered.
   *
   * `examples/` sits outside the workspace typecheck (its own tsconfig has `strict: false` and
   * includes only `server.ts`), which is why the mismatch was never compiled and why a test that
   * only exercised the emitter could not see it either. So the pin is on the composition the
   * deployed service actually performs.
   *
   * ★ WHEN THE CALLER IS FIXED, THIS TEST SHOULD BE REPLACED, NOT DELETED. The guard belongs
   * here — at that moment the hole becomes real, since `POST /api/pods/add` pushes a
   * body-supplied url onto `KNOWN_PODS` and the next `GET /api/pods` registers it either way.
   * The rename and the guard are one change.
   */
  it('does not throw for the field shape the deployed /catalog route passes', () => {
    // Exactly what examples/pgsl-browser/server.ts builds, cast the way an untypechecked caller
    // effectively does.
    const asCallerPasses = [
      { url: 'https://pod.test/alice/', name: 'alice', descriptorCount: 3 },
      { url: 'https://pod.test/bob/', name: 'bob', descriptorCount: 0 },
    ] as unknown as Parameters<typeof systemDcatCatalog>[0];
    let out = '';
    expect(() => { out = systemDcatCatalog(asCallerPasses); }).not.toThrow();
    expect(out).toContain('a dcat:Catalog');
    // The output is WRONG — `<undefined>` is a relative IRI resolving against the request base —
    // and saying so here is the point: this test pins "still served", not "correct".
    expect(out).toContain('<undefined>');
  });

  it('an empty registry renders, which is why the break was latent on a cold service', () => {
    expect(systemDcatCatalog([])).toContain('a dcat:Catalog');
  });

  it('a correctly-shaped catalog is unchanged', () => {
    const CLEAN = { uri: 'https://pod.test/alice/', title: 'Alice', accessUrl: 'https://pod.test/alice/.well-known/context-graphs' };
    const out = systemDcatCatalog([CLEAN]);
    expect(out).toContain(`dcat:dataset <${CLEAN.uri}>`);
    expect(out).toContain(`<${CLEAN.uri}> a dcat:Dataset, dprod:DataProduct`);
    expect(out).toContain(`dcat:accessURL <${CLEAN.accessUrl}>`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  6. The sites themselves — a cheap tripwire, and honest about being only that
// ═══════════════════════════════════════════════════════════════════════════

describe('the converted sites in client.ts still call the guard', () => {
  /**
   * ★ WHAT THIS IS NOT. It is not what establishes the property — sections 1-4 do, and they do it
   * site by site: each of the four authorship fields is driven with its own hostile value, the
   * renderView target and the CAS witness each have their own behavioural test, so no site here
   * hides behind another's observable. It is also NOT immune to re-spelling: an earlier version of
   * this guard covered `systemDcatCatalog`, and re-spelling `<${pod.uri}>` as `<${pods[i]!.uri}>`
   * walked past both this regex and `tools/turtle-iri-ratchet.mjs`, whose identifier class does
   * not include `!`. A text pin is worth exactly one spelling and no more.
   *
   * ★ WHAT IT IS FOR. The rest of this suite executes `dist/`, so a raw interpolation
   * reintroduced in SOURCE is invisible to every assertion above until someone rebuilds. This
   * reads the source directly and costs a millisecond.
   */
  const readSrc = async (rel: string): Promise<string> => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    return readFileSync(resolve(repo, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')          // strip block comments — they quote the defect
      .replace(/(^|[^:])\/\/.*$/gm, '$1');       // and line comments, without eating `https://`
  };

  it('the authorship proof, renderView target and CAS witness interpolate no IRI raw', async () => {
    const src = await readSrc('packages/solid/src/client.ts');
    // Plain containment, matching the exact spelling `tools/turtle-iri-ratchet.mjs` counts — a
    // regex tolerant of whitespace would only widen a pin that is honest about being one spelling.
    for (const expr of ['p.issuer', 'p.verificationMethod', 'p.ownerWebId', 'p.descriptorId', 'renderTarget', 'preconditionWitness.matched']) {
      expect(src.includes('<${' + expr + '}>'), `${expr} reaches <...> unmediated`).toBe(false);
    }
  });

  it('publish() builds the authorship block before it writes anything', async () => {
    /**
     * ★ THE ORDERING IS THE ATOMICITY, so it is pinned in source as well as behaviourally. The
     * behavioural pin (section 2) is the real one; this one names the invariant at the place a
     * future edit would break it, by moving the build back down next to its use.
     */
    const src = await readSrc('packages/solid/src/client.ts');
    const built = src.indexOf('const authorshipBlock = options.authorshipProof');
    // Anchored on CODE, not on the `// 1. PUT the graph payload` comment: readSrc strips comments,
    // so a comment anchor would be silently absent and the ordering assertion vacuously odd.
    const firstPut = src.indexOf('const graphResponse = await fetchFn(graphUrl');
    expect(built, 'the authorship block build must still exist').toBeGreaterThan(-1);
    expect(firstPut, 'step 1 must still be findable').toBeGreaterThan(-1);
    expect(built, 'the authorship block must be built BEFORE step 1').toBeLessThan(firstPut);
  });
});