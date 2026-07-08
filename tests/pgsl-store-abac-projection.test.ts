import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb,
  openStore,
  publicAtomAddress,
  clearancePdp,
  projectHolonFor,
  CLASSIFICATION,
  type StoredNode,
} from '../packages/pgsl-store/src/index.js';

function atom(value: string): StoredNode {
  return { uri: publicAtomAddress(value), kind: 'atom', level: 0, value };
}

describe('pgsl-store: mediator-side ABAC-filtered project-on-read (composes @interego/abac)', () => {
  const name = atom('Ada Lovelace'); // public: no AA row
  const ssn = atom('123-45-6789'); // marked secret via edge-scoped AA
  const frag: StoredNode = {
    uri: 'urn:pgsl:fragment:' + 'e'.repeat(40),
    kind: 'fragment',
    level: 1,
    items: [name.uri, ssn.uri],
  };
  const POD = 'https://pod/u1/';
  const RES = 'ctx/person';

  async function seed() {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    await store.compose([name, ssn, frag], { pod: POD, resource: RES });
    // edge-scoped: ssn is SECRET *inside this holon* (scope = the fragment).
    await store.putAtomAttributes(frag.uri, ssn.uri, { classification: CLASSIFICATION.secret });
    return store;
  }

  it('THE SAME HOLON PROJECTS DIFFERENT BYTES PER REQUESTER, with structure intact', async () => {
    const store = await seed();

    const high = await projectHolonFor(store, frag.uri, clearancePdp(CLASSIFICATION.secret)); // clearance 3
    const low = await projectHolonFor(store, frag.uri, clearancePdp(CLASSIFICATION.internal)); // clearance 1

    // High clearance sees everything.
    expect(high.partial).toBe(false);
    expect(high.withheldCount).toBe(0);
    expect(high.items).toEqual([
      { uri: name.uri, position: 0, redacted: false, value: 'Ada Lovelace' },
      { uri: ssn.uri, position: 1, redacted: false, value: '123-45-6789' },
    ]);

    // Low clearance: the secret ssn is value-redacted; the public name stays.
    expect(low.partial).toBe(true);
    expect(low.withheldCount).toBe(1);
    expect(low.items[0]).toEqual({ uri: name.uri, position: 0, redacted: false, value: 'Ada Lovelace' });
    expect(low.items[1]).toEqual({ uri: ssn.uri, position: 1, redacted: true });
    expect(low.items[1]!.value).toBeUndefined();

    // STRUCTURE IS IDENTICAL across requesters (arity, positions, level, uris):
    // disclosure is monotone — only values differ, never the shape.
    expect(low.items.map((i) => i.uri)).toEqual(high.items.map((i) => i.uri));
    expect(low.items.map((i) => i.position)).toEqual(high.items.map((i) => i.position));
    expect(low.level).toBe(high.level);
    expect(low.items.length).toBe(high.items.length);

    // Different bytes per requester = atom-granular selective disclosure.
    expect(JSON.stringify(low)).not.toBe(JSON.stringify(high));
  });

  it('clearance is >= classification (boundary), and public/unclassified atoms are always visible', async () => {
    const store = await seed();

    // clearance == classification (3 >= 3) discloses the secret.
    const exact = await projectHolonFor(store, frag.uri, clearancePdp(CLASSIFICATION.secret));
    expect(exact.items[1]!.redacted).toBe(false);

    // clearance just below (2 < 3) redacts it.
    const below = await projectHolonFor(store, frag.uri, clearancePdp(CLASSIFICATION.confidential));
    expect(below.items[1]!.redacted).toBe(true);

    // the public name (no AA row) is visible even at clearance 0.
    const anon = await projectHolonFor(store, frag.uri, clearancePdp(CLASSIFICATION.public));
    expect(anon.items[0]).toEqual({ uri: name.uri, position: 0, redacted: false, value: 'Ada Lovelace' });
    expect(anon.items[1]!.redacted).toBe(true); // secret withheld
  });
});
