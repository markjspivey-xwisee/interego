#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { canonicalApplicationActorId } from '../application-actor.js';

const ID = 'https://identity.interego.xwisee.com';

assert.equal(
  canonicalApplicationActorId('chatgpt-u-pk-f2a9c751075a', ID),
  'did:web:identity.interego.xwisee.com:agents:chatgpt-u-pk-f2a9c751075a',
  'identity-token slugs canonicalize into the identity server did:web namespace',
);
assert.equal(
  canonicalApplicationActorId('did:web:identity.interego.xwisee.com:agents:chatgpt-u-pk-f2a9c751075a', ID),
  'did:web:identity.interego.xwisee.com:agents:chatgpt-u-pk-f2a9c751075a',
  'native MCP full DIDs are preserved byte-for-byte',
);
assert.equal(
  canonicalApplicationActorId('did:ethr:0x276E11D2229D3a96Dc96356C15C03c7F83201eBc', ID),
  'did:ethr:0x276E11D2229D3a96Dc96356C15C03c7F83201eBc',
  'signed-request DIDs are preserved',
);
assert.equal(canonicalApplicationActorId(undefined, ID), undefined);
assert.equal(canonicalApplicationActorId('   ', ID), undefined);
assert.throws(
  () => canonicalApplicationActorId('../victim', ID),
  /not an IRI or identity-agent slug/,
  'path-shaped identities fail closed',
);

console.log('application actor canonicalization checks passed');
