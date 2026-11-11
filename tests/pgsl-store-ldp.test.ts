import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb,
  openStore,
  CodecRegistry,
  rdfCodec,
  LdpStore,
} from '../packages/pgsl-store/src/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function setup() {
  const store = openStore(new InMemoryFdb());
  const codecs = new CodecRegistry().register(rdfCodec);
  return { store, ldp: new LdpStore(store, codecs) };
}

const POD = 'https://pod/u1/';

describe('pgsl-store: LDP resource CRUD over the PGSL store (S2 core, no CSS)', () => {
  it('writes + reads an RDF resource byte-faithfully with its content-type', async () => {
    const { ldp } = setup();
    const turtle = '@prefix ex: <http://ex/> .\nex:s ex:p "exact  bytes" .\n';
    await ldp.writeResource(POD, 'ctx/doc.ttl', enc.encode(turtle), 'text/turtle');

    const got = await ldp.readResource(POD, 'ctx/doc.ttl');
    expect(got).not.toBeNull();
    expect(dec.decode(got!.bytes)).toBe(turtle); // byte-identical (opaque path)
    expect(got!.contentType).toBe('text/turtle');
  });

  it('stores a non-RDF (binary) resource as an opaque atom, byte-faithfully', async () => {
    const { ldp } = setup();
    const bin = new Uint8Array([0, 1, 2, 250, 255, 42]);
    await ldp.writeResource(POD, 'blobs/x.bin', bin, 'application/octet-stream');
    const got = await ldp.readResource(POD, 'blobs/x.bin');
    expect(got!.contentType).toBe('application/octet-stream');
    expect([...got!.bytes]).toEqual([...bin]);
  });

  it('PUT overwrite returns the new bytes (mutable record over grow-only nodes)', async () => {
    const { ldp } = setup();
    await ldp.writeResource(POD, 'ctx/a.ttl', enc.encode('ex:s ex:p ex:v1 .\n'), 'text/turtle');
    await ldp.writeResource(POD, 'ctx/a.ttl', enc.encode('ex:s ex:p ex:v2 .\n'), 'text/turtle');
    const got = await ldp.readResource(POD, 'ctx/a.ttl');
    expect(dec.decode(got!.bytes)).toBe('ex:s ex:p ex:v2 .\n');
  });

  it('DELETE removes the resource', async () => {
    const { ldp } = setup();
    await ldp.writeResource(POD, 'ctx/gone.ttl', enc.encode('ex:s ex:p ex:o .\n'), 'text/turtle');
    expect(await ldp.deleteResource(POD, 'ctx/gone.ttl')).toBe(true);
    expect(await ldp.readResource(POD, 'ctx/gone.ttl')).toBeNull();
    expect(await ldp.deleteResource(POD, 'ctx/gone.ttl')).toBe(false); // idempotent
  });

  it('lists a container’s direct children (resources + sub-containers)', async () => {
    const { ldp } = setup();
    await ldp.writeResource(POD, 'ctx/a.ttl', enc.encode('ex:s ex:p ex:o .\n'), 'text/turtle');
    await ldp.writeResource(POD, 'ctx/b.ttl', enc.encode('ex:s ex:p ex:o .\n'), 'text/turtle');
    await ldp.writeResource(POD, 'ctx/sub/c.ttl', enc.encode('ex:s ex:p ex:o .\n'), 'text/turtle');
    await ldp.writeResource(POD, 'other/d.ttl', enc.encode('ex:s ex:p ex:o .\n'), 'text/turtle');

    const children = await ldp.listContainer(POD, 'ctx/');
    expect(children).toEqual(['ctx/a.ttl', 'ctx/b.ttl', 'ctx/sub/']); // one level deep only
  });

  it('lets many writers replace one resource at once: a lost compare-and-set is retried, not refused', async () => {
    // What an LDP server does to a container when documents are created in it together: every
    // request rewrites the container's marker and its metadata, with no lock on the container.
    // One of N such writers can lose N - 1 times in a row; eight used to exhaust the retries.
    const { ldp } = setup();
    const writers = Array.from({ length: 24 }, (_, i) => i);
    await Promise.all(writers.flatMap(i => [
      ldp.writeResource(POD, 'shared/', new Uint8Array(0), 'internal/container', {}, `<urn:writer> <urn:n> "${i}" .`),
      ldp.setMeta(POD, 'shared/', `<urn:meta> <urn:n> "${i}" .`, 'internal/container'),
    ]));
    const marker = await ldp.stat(POD, 'shared/');
    expect(marker?.contentType).toBe('internal/container');
    expect(marker?.meta).toMatch(/^<urn:(writer|meta)> <urn:n> "\d+" \.$/);
  });

  it('survives restart: a fresh LdpStore over the same backing still reads', async () => {
    const fdb = new InMemoryFdb();
    const codecs = new CodecRegistry().register(rdfCodec);
    const turtle = 'ex:s ex:p ex:o .\n';
    await new LdpStore(openStore(fdb), codecs).writeResource(POD, 'ctx/keep.ttl', enc.encode(turtle), 'text/turtle');

    const restarted = new LdpStore(openStore(fdb), codecs);
    const got = await restarted.readResource(POD, 'ctx/keep.ttl');
    expect(dec.decode(got!.bytes)).toBe(turtle);
  });
});
