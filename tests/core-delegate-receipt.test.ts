/**
 * A delegate's own signed receipt: what admitting one establishes, and what it refuses.
 *
 * Everything here is fictional and local. The keys are made in the test, the pods are maps in
 * memory, and the registry port answers from a table. Nothing is sent anywhere, so none of this
 * shows a deployed relay, identity service or pod doing any of it.
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  DELEGATE_RECEIPT_FORMAT, MemoryReceiptLedger, addressStatedBy, admitDelegateReceipt,
  delegateReceiptBody, digestOf, receiptBodyProblem, receiptText, signDelegateReceipt,
  type AdmitReceiptArgs, type DelegateReceiptBody, type SignedDelegateReceipt,
} from '@interego/core/delegate-receipt';
import { checkDelegation, delegateLabel, type DelegateRegistryPort } from '@interego/core/delegate';
import { createEncryptedEnvelope, generateKeyPair, openEncryptedEnvelope } from '@interego/core/crypto';

const PRINCIPAL_POD = 'u-pk-aaaaaaaaaaaa';
const PRINCIPAL = 'https://identity.example.test/users/' + PRINCIPAL_POD + '/profile#me';
const NOW = new Date('2026-11-19T12:00:00.000Z');
const ISSUED = '2026-11-19T11:59:00.000Z';
const NONCE = 'fictional-nonce-0001';

const worker = ethers.Wallet.createRandom();
const stranger = ethers.Wallet.createRandom();
const WORKER = 'did:ethr:' + worker.address;
const WORKER_POD = 'eth-' + worker.address.slice(2, 14).toLowerCase();

const recover: AdmitReceiptArgs['recover'] = (text, signature) => ethers.verifyMessage(text, signature);

interface Row { agentId: string; label?: string; scope: string; validFrom: string; validUntil?: string; revoked?: boolean }
const seated = (over: Partial<Row> = {}): Row =>
  ({ agentId: WORKER, label: delegateLabel('factory worker'), scope: 'ReadOnly', validFrom: '2026-11-01T00:00:00.000Z', ...over });

/** A registry port that answers `get_pod_status` from a table and records what it was asked. */
function registry(rows: readonly Row[] | 'unreadable', owner: string = PRINCIPAL) {
  const asked: string[] = [];
  const port: DelegateRegistryPort = {
    tool: async (name, args) => {
      asked.push(name + ':' + String(args['pod_name'] ?? args['agent_id'] ?? ''));
      if (name !== 'get_pod_status') throw new Error('unexpected tool ' + name);
      if (rows === 'unreadable') throw new Error('The relay did not answer');
      return { delegationRegistry: { owner, rows } };
    },
  };
  return { port, asked };
}

async function receipt(over: Partial<Parameters<typeof delegateReceiptBody>[0]> = {}, signer = worker): Promise<SignedDelegateReceipt> {
  const body = delegateReceiptBody({
    signer: WORKER,
    footing: { kind: 'on-behalf-of', principal: PRINCIPAL },
    assignmentDigest: await digestOf({ owner: 'fictional', kind: 'read-only-check', id: 'job-1', version: 1, inputHash: 'a'.repeat(64) }),
    resultDigest: await digestOf({ status: 'done' }),
    custodian: WORKER_POD,
    nonce: NONCE,
    issuedAt: ISSUED,
    ...over,
  });
  return signDelegateReceipt(body, (text) => signer.signMessage(text));
}

async function admit(r: unknown, over: Partial<AdmitReceiptArgs> = {}, rows: readonly Row[] | 'unreadable' = [seated()]) {
  const expectDigest = await digestOf({ owner: 'fictional', kind: 'read-only-check', id: 'job-1', version: 1, inputHash: 'a'.repeat(64) });
  return admitDelegateReceipt({
    receipt: r,
    storedOn: WORKER_POD,
    expect: { assignmentDigest: expectDigest, principal: PRINCIPAL, principalPod: PRINCIPAL_POD },
    now: NOW,
    registry: registry(rows).port,
    recover,
    ledger: new MemoryReceiptLedger(() => NOW.getTime()),
    ...over,
  });
}

describe('a delegate signs its own receipt', () => {
  it('signs the canonical text, whatever order the fields were written in', async () => {
    const r = await receipt();
    const shuffled = Object.fromEntries(Object.entries(r.body).reverse()) as unknown as DelegateReceiptBody;
    expect(receiptText(shuffled)).toBe(receiptText(r.body));
    expect(ethers.verifyMessage(receiptText(shuffled), r.signature)).toBe(worker.address);
    expect(r.body.format).toBe(DELEGATE_RECEIPT_FORMAT);
  });

  it('digests a value by its sorted-key JSON, keeping array order', async () => {
    expect(await digestOf({ b: 1, a: [2, 1] })).toBe(await digestOf({ a: [2, 1], b: 1 }));
    expect(await digestOf({ a: [2, 1] })).not.toBe(await digestOf({ a: [1, 2] }));
    expect(await digestOf('')).toBe(ethers.sha256(ethers.toUtf8Bytes('""')).slice(2));
  });

  it('will not write a receipt that leaves its footing unsaid, or carries a field the format does not define', async () => {
    const r = await receipt();
    expect(receiptBodyProblem(r.body)).toBeNull();
    expect(receiptBodyProblem({ ...r.body, footing: { kind: 'not-stated', why: 'x' } })).toMatch(/footing/);
    expect(receiptBodyProblem({ ...r.body, footing: undefined })).toMatch(/footing|fields/);
    expect(receiptBodyProblem({ ...r.body, extra: 1 })).toMatch(/exactly these fields/);
    expect(receiptBodyProblem({ ...r.body, footing: { kind: 'own-account', principal: PRINCIPAL } })).toMatch(/only a kind/);
    expect(receiptBodyProblem({ ...r.body, assignmentDigest: 'A'.repeat(64) })).toMatch(/assignmentDigest/);
    expect(receiptBodyProblem({ ...r.body, issuedAt: 'yesterday' })).toMatch(/issuedAt/);
    expect(() => delegateReceiptBody({ ...r.body, nonce: 'short' })).toThrow(/nonce/);
  });

  it('reads an address only from an id that states one', () => {
    expect(addressStatedBy(WORKER)).toBe(worker.address.toLowerCase());
    expect(addressStatedBy('did:pkh:eip155:1:' + worker.address)).toBe(worker.address.toLowerCase());
    expect(addressStatedBy('did:key:' + worker.address)).toBe(worker.address.toLowerCase());
    expect(addressStatedBy('did:web:identity.example.test:agents:interego-delegate-u-eth-111111111111')).toBeNull();
  });
});

describe('admitting a receipt keeps signature, standing, footing and custody apart', () => {
  it('admits a current delegate\'s receipt for the expected assignment, on the principal\'s behalf', async () => {
    const a = await admit(await receipt());
    expect(a.why).toBeNull();
    expect(a.ok).toBe(true);
    expect(a.signedBy).toBe(worker.address.toLowerCase());
    expect(a.row?.agentId).toBe(WORKER);
    expect(a.checks.every((c) => c.mark === 'y')).toBe(true);
  });

  it('admits a delegate that holds no write on the principal\'s pod, where the write verdict says no', async () => {
    // The standing gate is the roster, not `checkDelegation`: that one answers whether the agent
    // may WRITE to the principal's pod, and for a ReadOnly delegate it correctly says no.
    for (const scope of ['ReadOnly', 'DiscoverOnly']) {
      const a = await admit(await receipt(), {}, [seated({ scope })]);
      expect(a.ok, scope).toBe(true);
      expect(a.row?.writeEligible, scope).toBe(false);
    }
    const write = await checkDelegation({
      tool: async (name) => name === 'verify_agent'
        ? { verified: true, subject_pod_name: PRINCIPAL_POD, enforcement: { writeEligible: false, scope: 'ReadOnly' } }
        : { delegationRegistry: { owner: PRINCIPAL, rows: [seated()] } },
    }, { agentId: WORKER, podName: PRINCIPAL_POD, podOfUrl: () => null });
    expect(write.ok).toBe(false);
  });

  it('reads standing from the principal\'s own pod and nowhere else', async () => {
    const reg = registry([seated()]);
    await admit(await receipt(), { registry: reg.port });
    expect(reg.asked).toEqual(['get_pod_status:' + PRINCIPAL_POD]);
  });

  it('refuses a signer the principal never seated', async () => {
    const a = await admit(await receipt(), {}, []);
    expect(a.ok).toBe(false);
    expect(a.why).toMatch(/not listed among/);
    expect(a.row).toBeNull();
  });

  it('refuses an agent that is listed on the pod but not as a delegate', async () => {
    const a = await admit(await receipt(), {}, [seated({ label: 'discord conduit' })]);
    expect(a.why).toMatch(/not as a delegate/);
  });

  it('refuses a revoked, expired or not-yet-started delegation', async () => {
    expect((await admit(await receipt(), {}, [seated({ revoked: true })])).why).toMatch(/revoked/);
    expect((await admit(await receipt(), {}, [seated({ validUntil: '2026-11-19T11:00:00.000Z' })])).why).toMatch(/expired/);
    expect((await admit(await receipt(), {}, [seated({ validFrom: '2026-12-01T00:00:00.000Z' })])).why).toMatch(/not in force/);
    expect((await admit(await receipt(), {}, [seated({ validFrom: '' })])).why).toMatch(/not in force/);
  });

  it('does not read a roster it could not read as an empty one', async () => {
    const a = await admit(await receipt(), {}, 'unreadable');
    expect(a.ok).toBe(false);
    expect(a.checks.find((c) => c.mark === 'q')?.text).toMatch(/standing is not established/);
    expect(a.checks.some((c) => /not listed among/.test(c.text))).toBe(false);
  });

  it('refuses a roster on a pod that is not the principal\'s own', async () => {
    const a = await admit(await receipt(), { registry: registry([seated()], 'https://identity.example.test/users/u-pk-bbbbbbbbbbbb/profile#me').port });
    expect(a.why).toMatch(/not established as/);
  });

  it('refuses a receipt signed by a key other than the named agent\'s', async () => {
    const a = await admit(await receipt({}, stranger));
    expect(a.ok).toBe(false);
    expect(a.why).toMatch(/signed by a different key/);
    expect(a.signedBy).toBe(stranger.address.toLowerCase());
  });

  it('refuses a receipt whose body was changed after signing', async () => {
    const r = await receipt();
    const a = await admit({ body: { ...r.body, resultDigest: 'b'.repeat(64) }, signature: r.signature });
    expect(a.why).toMatch(/signed by a different key/);
  });

  it('does not guess a key for an id that states none, and holds a resolved one to the signature', async () => {
    const DID = 'did:web:identity.example.test:agents:interego-delegate-' + WORKER_POD;
    const r = await receipt({ signer: DID });
    const rows = [seated({ agentId: DID })];
    const unbound = await admit(r, {}, rows);
    expect(unbound.ok).toBe(false);
    expect(unbound.checks.find((c) => c.mark === 'q')?.text).toMatch(/Which key belongs to/);
    expect((await admit(r, { resolveAddress: () => worker.address }, rows)).ok).toBe(true);
    expect((await admit(r, { resolveAddress: () => stranger.address }, rows)).why).toMatch(/different key/);
    expect((await admit(r, { resolveAddress: () => { throw new Error('offline'); } }, rows)).ok).toBe(false);
  });

  it('refuses own-account work, and work on somebody else\'s behalf', async () => {
    expect((await admit(await receipt({ footing: { kind: 'own-account' } }))).why).toMatch(/on its own account/);
    const other = 'https://identity.example.test/users/u-pk-cccccccccccc/profile#me';
    expect((await admit(await receipt({ footing: { kind: 'on-behalf-of', principal: other } }))).why).toMatch(/somebody other than/);
  });

  it('refuses a receipt read from a pod other than the one it says it is kept on', async () => {
    const a = await admit(await receipt(), { storedOn: PRINCIPAL_POD });
    expect(a.why).toMatch(/was read from pod/);
  });

  it('refuses a receipt for a different assignment', async () => {
    const a = await admit(await receipt({ assignmentDigest: 'c'.repeat(64) }));
    expect(a.why).toMatch(/different assignment/);
  });

  it('refuses a receipt that is too old or dated ahead', async () => {
    expect((await admit(await receipt({ issuedAt: '2026-11-01T00:00:00.000Z' }))).why).toMatch(/older than/);
    expect((await admit(await receipt({ issuedAt: '2026-11-19T12:10:00.000Z' }))).why).toMatch(/future/);
    expect((await admit(await receipt({ issuedAt: '2026-11-19T12:01:00.000Z' }))).ok).toBe(true);
  });

  it('admits a receipt once', async () => {
    const ledger = new MemoryReceiptLedger(() => NOW.getTime());
    const r = await receipt();
    expect((await admit(r, { ledger })).ok).toBe(true);
    const again = await admit(r, { ledger });
    expect(again.ok).toBe(false);
    expect(again.why).toMatch(/already admitted once/);
  });

  it('does not use up a nonce on a receipt it refused for another reason', async () => {
    const ledger = new MemoryReceiptLedger(() => NOW.getTime());
    const r = await receipt();
    expect((await admit(r, { ledger }, [seated({ revoked: true })])).ok).toBe(false);
    expect((await admit(r, { ledger })).ok).toBe(true);
  });

  it('reports every failing line, not only the first', async () => {
    const a = await admit(await receipt({ footing: { kind: 'own-account' }, assignmentDigest: 'c'.repeat(64) }, stranger), { storedOn: 'elsewhere' }, []);
    expect(a.checks.filter((c) => c.mark === 'n')).toHaveLength(5);
  });

  it('refuses anything that is not a body with a signature', async () => {
    for (const bad of [null, 'receipt', {}, { body: {}, signature: '0x' }, { body: (await receipt()).body }]) {
      const a = await admit(bad);
      expect(a.ok).toBe(false);
      expect(a.body).toBeNull();
    }
  });
});

describe('a local two-party run: sealed assignment out, signed receipt back, no grant either way', () => {
  it('each side writes only to its own pod and the coordinator admits the worker\'s receipt', async () => {
    // Two pods as maps. `put` refuses a writer that is not the pod's owner, which is the only
    // access rule in play: nobody is granted anything on the other's pod. Reads are open, as the
    // storage gate's are, so everything private is sealed.
    const pods = new Map<string, Map<string, string>>([[PRINCIPAL_POD, new Map()], [WORKER_POD, new Map()]]);
    const put = (writer: string, pod: string, path: string, text: string): void => {
      if (writer !== pod) throw new Error(writer + ' may not write to ' + pod);
      pods.get(pod)!.set(path, text);
    };
    const get = (pod: string, path: string): string => {
      const text = pods.get(pod)?.get(path);
      if (text === undefined) throw new Error('nothing at ' + pod + '/' + path);
      return text;
    };
    const coordinatorKeys = generateKeyPair();
    const workerKeys = generateKeyPair();

    // 1. The coordinator seals the assignment to the worker and itself, on its own pod.
    const assignment = { owner: 'fictional', kind: 'read-only-check', id: 'job-7', version: 1, input: { path: 'fixtures/a.txt' } };
    const assignmentDigest = await digestOf(assignment);
    put(PRINCIPAL_POD, PRINCIPAL_POD, 'assignments/job-7', JSON.stringify(
      createEncryptedEnvelope(JSON.stringify(assignment), [workerKeys.publicKey, coordinatorKeys.publicKey], coordinatorKeys)));
    // What a notification would carry: the digest and where to look, and nothing else.
    const note = { assignmentDigest, pod: PRINCIPAL_POD, path: 'assignments/job-7' };

    // 2. The worker reads the ciphertext, opens it with its own key, and checks what it was told.
    const sealed = get(note.pod, note.path);
    expect(sealed).not.toContain('fixtures/a.txt');
    const opened = JSON.parse(openEncryptedEnvelope(JSON.parse(sealed), workerKeys)!) as typeof assignment;
    expect(await digestOf(opened)).toBe(note.assignmentDigest);
    expect(openEncryptedEnvelope(JSON.parse(sealed), generateKeyPair())).toBeNull();

    // 3. The worker does the work, signs a receipt with its own key, and keeps it on its own pod.
    const result = { status: 'done', lines: 3 };
    const signed = await signDelegateReceipt(delegateReceiptBody({
      signer: WORKER,
      footing: { kind: 'on-behalf-of', principal: PRINCIPAL },
      assignmentDigest: note.assignmentDigest,
      resultDigest: await digestOf(result),
      custodian: WORKER_POD,
      nonce: 'fictional-nonce-job-7',
      issuedAt: ISSUED,
    }), (text) => worker.signMessage(text));
    put(WORKER_POD, WORKER_POD, 'receipts/job-7', JSON.stringify(
      createEncryptedEnvelope(JSON.stringify({ receipt: signed, result }), [coordinatorKeys.publicKey, workerKeys.publicKey], workerKeys)));
    expect(() => put(WORKER_POD, PRINCIPAL_POD, 'receipts/job-7', 'x')).toThrow(/may not write/);

    // 4. The coordinator reads it from the worker's pod, opens it, and decides.
    const back = JSON.parse(openEncryptedEnvelope(JSON.parse(get(WORKER_POD, 'receipts/job-7')), coordinatorKeys)!) as
      { receipt: SignedDelegateReceipt; result: typeof result };
    const ledger = new MemoryReceiptLedger(() => NOW.getTime());
    const args: AdmitReceiptArgs = {
      receipt: back.receipt,
      storedOn: WORKER_POD,
      expect: { assignmentDigest, principal: PRINCIPAL, principalPod: PRINCIPAL_POD },
      now: NOW,
      registry: registry([seated()]).port,
      recover,
      ledger,
    };
    const admitted = await admitDelegateReceipt(args);
    expect(admitted.why).toBeNull();
    expect(admitted.ok).toBe(true);
    expect(await digestOf(back.result)).toBe(admitted.body!.resultDigest);
    // Custody is reported as where the record is, and it is not the principal's pod.
    const custody = admitted.checks.find((c) => /kept on/.test(c.text))!.text;
    expect(custody).toContain(WORKER_POD);
    expect(custody).not.toMatch(/principal's pod/);

    // The same receipt a second time, and the same receipt after the principal revokes the worker.
    expect((await admitDelegateReceipt(args)).why).toMatch(/already admitted once/);
    const revoked = await admitDelegateReceipt({ ...args, ledger: new MemoryReceiptLedger(() => NOW.getTime()), registry: registry([seated({ revoked: true })]).port });
    expect(revoked.why).toMatch(/revoked/);
    // The principal's pod holds the assignment and nothing the worker wrote.
    expect([...pods.get(PRINCIPAL_POD)!.keys()]).toEqual(['assignments/job-7']);
  });
});
