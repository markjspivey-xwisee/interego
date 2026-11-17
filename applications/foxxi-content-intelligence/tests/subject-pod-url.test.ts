/**
 * Whose pod is it — the resolver that decides every self-sovereign read and write.
 *
 * ── ★★ WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * The agent self-enrolment path shipped, and the live abuse test written to attack it found that
 * EVERY agent enrolling itself enrolled the shared Foxxi tenant pod instead. Cause: the signature
 * layer returns the recovered ADDRESS, the resolver only understood `did:ethr:<addr>`, and an
 * unrecognized identity form fell through to the tenant-pod FALLBACK rather than failing. So the
 * first caller poisoned the projector's sweep set with the tenant pod, and every caller after was
 * answered `alreadyEnrolled: true` while its own pod was read by nothing — the same invisible state
 * the enrolment path was built to remove.
 *
 * It was untestable where it lived (private to a 7,700-line server module that listens on import),
 * which is most of why it went unnoticed. These tests pin the fallback: a resolver that answers a
 * SHARED pod for an identity it does not recognize must be caught by a test, not by production.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { ownPodSegment } from '@interego/core';
import {
  resolveSubjectPodUrlPure, hasControlChars, explicitPodRoot, identityUserIdOf, isIdentityUserDid,
  isGeneralGuestDid, guardSubjectPod, IDENTITY_SUBJECT_MAX_LENGTH,
} from '../src/subject-pod-url.js';
import { safePublicUrlOrUndefined } from '../src/ssrf-guard.js';

const TENANT = 'https://gate.example.test/foxxi/';
const resolve = (identity: string | undefined, explicit?: string): string =>
  resolveSubjectPodUrlPure({ tenantPodUrl: TENANT, identity, explicit, safeUrl: safePublicUrlOrUndefined });

describe('subject pod resolution — the identity forms that must NOT land on the tenant pod', () => {
  it('★ a bare 0x address resolves to its own pod, not the shared tenant pod', () => {
    const addr = '0x2c3ec2978973680f890c0609c6a8cee382f3c80c';
    expect(resolve(addr)).toBe('https://gate.example.test/eth-2c3ec2978973/');
    expect(resolve(addr)).not.toBe(TENANT);
  });

  it('a bare address and its did:ethr spelling resolve to the SAME pod', () => {
    const addr = '0x3f9f70225074408cdbaac2866881d844abf96236';
    expect(resolve(addr)).toBe(resolve(`did:ethr:${addr}`));
  });

  it('an address without the 0x prefix, and mixed case, resolve identically', () => {
    const lower = '2c3ec2978973680f890c0609c6a8cee382f3c80c';
    expect(resolve(lower)).toBe('https://gate.example.test/eth-2c3ec2978973/');
    expect(resolve(lower.toUpperCase())).toBe('https://gate.example.test/eth-2c3ec2978973/');
  });

  it('a did:ethr identity resolves to its eth- pod', () => {
    expect(resolve('did:ethr:0x8f3b8e9396001111222233334444555566667777'))
      .toBe('https://gate.example.test/eth-8f3b8e939600/');
  });

  it('an embedded agent pod id wins over path-segment derivation', () => {
    // An identity-service WebID must map to the agent id, not to "users".
    expect(resolve('https://id.example.test/users/u-pk-00181cd5dbee/profile#me'))
      .toBe('https://gate.example.test/u-pk-00181cd5dbee/');
    expect(resolve('did:web:example.test:agents:codex-u-pk-b03a054d6915'))
      .toBe('https://gate.example.test/u-pk-b03a054d6915/');
  });

  it('a WebID with no embedded pod id resolves to its account root', () => {
    expect(resolve('https://id.example.test/jliu/profile#me')).toBe('https://id.example.test/jliu/');
  });

  it('only a genuinely unresolvable identity falls back to the tenant pod', () => {
    expect(resolve(undefined)).toBe(TENANT);
    expect(resolve('')).toBe(TENANT);
    expect(resolve('   ')).toBe(TENANT);
    // Too short to be an address, no pod id, not a URL — nothing to derive from.
    expect(resolve('0xdeadbeef')).toBe(TENANT);
  });
});

describe('identity strings must be a single line of printable text', () => {
  /**
   * ★ WHY A BOUNDARY CHECK AND NOT PER-SINK ESCAPING. In DELEGATED mode the caller-supplied
   * `agent_id` becomes `callerDid`, which is interpolated into a Turtle literal on a PUBLIC register
   * AND persisted as a pod row. A raw newline inside a Turtle short-string literal is a syntax error,
   * so one such identity makes the whole register unparseable for every consumer — and once the row
   * is durable it stays broken across restarts, with no in-band way to remove it.
   *
   * Characters are built by code point rather than written as literals: a source file containing a
   * raw NUL is itself a hazard (tooling treats it as binary), and a hand-typed escape for exactly
   * this class is easy to get silently wrong — which is how it was got wrong while writing this.
   */
  const ch = (code: number): string => String.fromCharCode(code);

  it('accepts the identity forms the system actually issues', () => {
    for (const id of [
      'did:ethr:0x2c3ec2978973680f890c0609c6a8cee382f3c80c',
      'did:web:example.test:agents:codex-u-pk-b03a054d6915',
      'https://id.example.test/jliu/profile#me',
      'u-pk-00181cd5dbee',
    ]) expect(hasControlChars(id)).toBe(false);
  });

  it('★ rejects the characters that would break a Turtle literal', () => {
    expect(hasControlChars(`eth-abc123def456${ch(0x0a)}X`)).toBe(true); // LF — terminates the literal
    expect(hasControlChars(`eth-abc123def456${ch(0x0d)}X`)).toBe(true); // CR — same
    expect(hasControlChars(`eth-abc${ch(0x09)}def`)).toBe(true);        // TAB
    expect(hasControlChars(`eth-abc${ch(0x00)}def`)).toBe(true);        // NUL
    expect(hasControlChars(`eth-abc${ch(0x7f)}def`)).toBe(true);        // DEL
  });

  it('rejects Unicode line and paragraph separators, which a plain newline check misses', () => {
    expect(hasControlChars(`eth-abc${ch(0x2028)}def`)).toBe(true);
    expect(hasControlChars(`eth-abc${ch(0x2029)}def`)).toBe(true);
  });

  it('does not reject ordinary non-ASCII text — this is a control-character check, not an ASCII one', () => {
    expect(hasControlChars('did:web:xn--exmple-cua.test:agents:agent')).toBe(false);
    expect(hasControlChars(`did:web:ex${ch(0xe4)}mple.test`)).toBe(false);
  });
});

describe('subject pod resolution — the explicit override is an SSRF choke point', () => {
  it('a safe public override is honoured, canonicalized to a single-segment pod root', () => {
    expect(resolve('did:ethr:0x2c3ec2978973680f890c0609c6a8cee382f3c80c', 'https://pod.example.test/mine/sub/deeper'))
      .toBe('https://pod.example.test/mine/');
  });

  it('★ a multi-segment override collapses to its FIRST segment', () => {
    // Returning it verbatim let a caller pass a last-segment actor check while a first-segment
    // consumer acted on a different segment — a cross-agent write.
    expect(resolve('did:ethr:0x2c3ec2978973680f890c0609c6a8cee382f3c80c', 'https://pod.example.test/eth-victim/eth-2c3ec2978973/'))
      .toBe('https://pod.example.test/eth-victim/');
  });

  it('★ a private or loopback override is IGNORED, and the identity is used instead', () => {
    const addr = 'did:ethr:0x2c3ec2978973680f890c0609c6a8cee382f3c80c';
    const own = 'https://gate.example.test/eth-2c3ec2978973/';
    for (const bad of [
      'http://127.0.0.1/pod/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/pod/',
      'http://localhost:3000/pod/',
      'file:///etc/passwd',
      'not-a-url',
    ]) {
      expect(resolve(addr, bad)).toBe(own);
    }
  });

  it('an override cannot smuggle the tenant pod onto an unresolvable identity', () => {
    // No identity to derive from, so the override is all there is — it must still be a safe public
    // target, and must still collapse to a pod root.
    expect(resolve(undefined, 'http://127.0.0.1/foxxi/')).toBe(TENANT);
  });
});

// ── Identity user DIDs: did:web:<identity host>:users:<id> ─────────────────────────────────────

const HOST = 'identity.example.test';
const ORIGIN = 'https://gate.example.test';
const withHost = (identity: string | undefined, explicit?: string, identityHost: string = HOST): string =>
  resolveSubjectPodUrlPure({ tenantPodUrl: TENANT, identity, explicit, safeUrl: safePublicUrlOrUndefined, identityHost });
const hex = (seed: string, n: number): string => createHash('sha256').update(seed).digest('hex').slice(0, n);
const userDid = (id: string, host: string = HOST): string => `did:web:${host}:users:${id}`;

/**
 * The resolver as it stood on master before the identity-host rule, kept here line for line as the
 * reference: "unchanged" below means "answers what this answers".
 */
function resolveBefore(identity: string | undefined, explicit?: string): string {
  const tenantPodUrl = TENANT, safeUrl = safePublicUrlOrUndefined;
  if (explicit) {
    const root = explicitPodRoot(explicit, safeUrl);
    if (root) return root;
  }
  const id = (identity ?? '').trim();
  if (!id) return tenantPodUrl;
  const tenantOrigin = (() => { try { return new URL(tenantPodUrl).origin; } catch { return ''; } })();
  const seg = ownPodSegment(id);
  if (seg && tenantOrigin) return `${tenantOrigin}/${seg}/`;
  if (/^https?:\/\//.test(id)) {
    try {
      const u = new URL(id);
      const first = u.pathname.split('/').filter(Boolean)[0];
      if (first) return `${u.origin}/${first}/`;
    } catch { /* fall through */ }
  }
  return tenantPodUrl;
}

/** Every subject form the resolver is given today, with the pod each resolves to on master. */
const RESOLVING_TODAY: ReadonlyArray<readonly [form: string, identity: string | undefined, pod: string]> = [
  ['did:ethr', 'did:ethr:0x2c3ec2978973680f890c0609c6a8cee382f3c80c', `${ORIGIN}/eth-2c3ec2978973/`],
  ['did:ethr without 0x', 'did:ethr:2c3ec2978973680f890c0609c6a8cee382f3c80c', `${ORIGIN}/eth-2c3ec2978973/`],
  ['bare 0x address', '0x2C3EC2978973680F890C0609C6A8CEE382F3C80C', `${ORIGIN}/eth-2c3ec2978973/`],
  ['bare address without 0x', '2c3ec2978973680f890c0609c6a8cee382f3c80c', `${ORIGIN}/eth-2c3ec2978973/`],
  ['bare pod id u-pk', 'u-pk-00181cd5dbee', `${ORIGIN}/u-pk-00181cd5dbee/`],
  ['bare pod id eth-', 'eth-2c3ec2978973', `${ORIGIN}/eth-2c3ec2978973/`],
  ['agent did:web with an embedded pod id', 'did:web:example.test:agents:codex-u-pk-b03a054d6915', `${ORIGIN}/u-pk-b03a054d6915/`],
  ['identity account did, u-pk', userDid('u-pk-123456789abc'), `${ORIGIN}/u-pk-123456789abc/`],
  ['identity account did, u-eth', userDid('u-eth-c0ac4ed0aaaa'), `${ORIGIN}/u-eth-c0ac4ed0aaaa/`],
  ['identity account did, u-did', userDid('u-did-0123456789ab'), `${ORIGIN}/u-did-0123456789ab/`],
  ['identity account did, uppercase id', userDid('U-PK-123456789ABC'), `${ORIGIN}/u-pk-123456789abc/`],
  ['identity account did on another host', userDid('u-pk-123456789abc', 'other.example.test'), `${ORIGIN}/u-pk-123456789abc/`],
  ['identity WebID', `https://${HOST}/users/u-pk-00181cd5dbee/profile#me`, `${ORIGIN}/u-pk-00181cd5dbee/`],
  ['WebID with no pod id', 'https://id.example.test/jliu/profile#me', 'https://id.example.test/jliu/'],
  ['identity WebID of a guest (its first path segment)', `https://${HOST}/users/u-try-guest-${hex('w', 32)}/profile#me`, `https://${HOST}/users/`],
  ['surrounding whitespace', '  did:ethr:0x2c3ec2978973680f890c0609c6a8cee382f3c80c  ', `${ORIGIN}/eth-2c3ec2978973/`],
  ['agent did:web with no pod id', 'did:web:example.test:agents:plain-agent', TENANT],
  ['a seeded legacy account did (an alias, no shape)', userDid('markj'), TENANT],
  ['the tenant\'s own segment as a user id', userDid('foxxi'), TENANT],
  ['did:key', 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', TENANT],
  ['a short hex string', '0xdeadbeef', TENANT],
  ['a plain name', 'jliu', TENANT],
  ['empty', '', TENANT],
  ['undefined', undefined, TENANT],
];

/** The only subjects the identity-host rule moves: identity's `u-try-…` ids under the configured host. */
const MOVED_BY_THE_RULE: ReadonlyArray<readonly [form: string, id: string]> = [
  ['general guest', `u-try-guest-${hex('guest', 32)}`],
  ['per-application guest', `u-try-play-${hex('play', 32)}`],
  ['evaluation account', `u-try-${hex('try', 12)}`],
];

describe('identity user DIDs — every form that resolves today resolves the same', () => {
  it.each(RESOLVING_TODAY)('%s: master\'s answer, without and with an identity host', (_form, identity, pod) => {
    expect(resolveBefore(identity)).toBe(pod);           // the table states master's behaviour
    expect(resolve(identity)).toBe(pod);                 // no identity host: nothing differs
    expect(withHost(identity)).toBe(pod);                // with one: these forms still do not move
  });

  it('with no identity host the resolver answers as master does for the subjects the rule would move', () => {
    for (const [, id] of MOVED_BY_THE_RULE) {
      expect(resolveBefore(userDid(id))).toBe(TENANT);
      expect(resolve(userDid(id))).toBe(TENANT);
      expect(withHost(userDid(id), undefined, '')).toBe(TENANT);
    }
  });

  it('an explicit override is handled before the rule, exactly as before', () => {
    const guestId = MOVED_BY_THE_RULE[0]![1], guest = userDid(guestId);
    for (const explicit of ['https://pod.example.test/mine/sub', 'http://127.0.0.1/pod/', 'not-a-url']) {
      for (const [, identity] of RESOLVING_TODAY) expect(withHost(identity, explicit)).toBe(resolveBefore(identity, explicit));
    }
    expect(withHost(guest, 'https://pod.example.test/mine/sub')).toBe('https://pod.example.test/mine/');
    expect(withHost(guest, 'http://127.0.0.1/pod/')).toBe(`${ORIGIN}/${guestId}/`);
  });

  it('over many generated subjects, no answer differs from master unless it is an identity u-try id under the configured host', () => {
    const shapes = [
      (s: string) => `did:ethr:0x${hex(s, 40)}`, (s: string) => `0x${hex(s, 40)}`, (s: string) => `u-pk-${hex(s, 12)}`,
      (s: string) => userDid(`u-eth-${hex(s, 12)}`), (s: string) => userDid(`u-did-${hex(s, 12)}`, 'other.example.test'),
      (s: string) => `did:web:example.test:agents:agent-${hex(s, 8)}`, (s: string) => `https://id.example.test/${hex(s, 6)}/profile#me`,
      (s: string) => userDid(hex(s, 10)), (s: string) => userDid(`u-try-guest-${hex(s, 32)}`, 'other.example.test'),
      (s: string) => hex(s, 20), (s: string) => `did:key:z${hex(s, 30)}`,
    ];
    let compared = 0;
    for (let i = 0; i < 300; i++) for (const [k, shape] of shapes.entries()) {
      const identity = shape(`${k}:${i}`);
      expect(withHost(identity), identity).toBe(resolveBefore(identity));
      compared++;
    }
    expect(compared).toBe(3300);
  });
});

describe('identity user DIDs — a guest and a linked account each resolve to their own pod', () => {
  it.each(MOVED_BY_THE_RULE)('a %s resolves to <pod origin>/<userId>/', (_form, id) => {
    expect(withHost(userDid(id))).toBe(`${ORIGIN}/${id}/`);
    expect(withHost(`  ${userDid(id)}  `)).toBe(`${ORIGIN}/${id}/`);
  });

  it('a guest linked to an account is given as that account\'s DID, and resolves to the account\'s pod', () => {
    // Identity states `linkedTo`; the application attributes to it (canonicalSubject). The account's
    // pod is `<pod origin>/<userId>/`, the same address identity and the css-gate use for it.
    for (const account of ['u-eth-c0ac4ed0aaaa', 'u-pk-123456789abc', 'u-did-0123456789ab']) {
      expect(withHost(userDid(account))).toBe(`${ORIGIN}/${account}/`);
      expect(guardSubjectPod({ subject: userDid(account), podUrl: withHost(userDid(account)), tenantPodUrl: TENANT, identityHost: HOST })).toEqual({ ok: true });
    }
  });

  it('the host is compared whole and case-insensitively, in either spelling of a port', () => {
    const id = `u-try-guest-${hex('port', 32)}`;
    expect(withHost(`did:web:IDENTITY.Example.TEST:users:${id}`)).toBe(`${ORIGIN}/${id}/`);
    expect(withHost(userDid(id), undefined, 'Identity.Example.Test')).toBe(`${ORIGIN}/${id}/`);
    // Identity writes URL.host as it is; Foxxi's learning sign-in writes the did:web percent form.
    expect(withHost(`did:web:${HOST}:8443:users:${id}`, undefined, `${HOST}:8443`)).toBe(`${ORIGIN}/${id}/`);
    expect(withHost(`did:web:${HOST}%3A8443:users:${id}`, undefined, `${HOST}:8443`)).toBe(`${ORIGIN}/${id}/`);
    expect(withHost(`did:web:${HOST}%3a8443:users:${id}`, undefined, `${HOST}:8443`)).toBe(`${ORIGIN}/${id}/`);
    // Another port, or a port where none is configured, is another host.
    expect(withHost(`did:web:${HOST}%3A8444:users:${id}`, undefined, `${HOST}:8443`)).toBe(TENANT);
    expect(withHost(`did:web:${HOST}%3A8443:users:${id}`)).toBe(TENANT);
    expect(withHost(userDid(id), undefined, `${HOST}:8443`)).toBe(TENANT);
  });

  it('identityUserIdOf answers the id for identity\'s own shapes only', () => {
    for (const id of [`u-pk-${hex('a', 12)}`, `u-eth-${hex('b', 12)}`, `u-did-${hex('c', 12)}`, `u-try-${hex('d', 12)}`, `u-try-play-${hex('e', 32)}`, `u-try-guest-${hex('f', 32)}`]) {
      expect(identityUserIdOf(userDid(id), HOST)).toBe(id);
    }
    for (const id of ['markj', 'foxxi', 'u-pk-123', `u-try-guest-${hex('g', 31)}`, `u-try-guest-${hex('g', 32)}0`, `u-try-other-${hex('g', 32)}`]) {
      expect(identityUserIdOf(userDid(id), HOST)).toBeUndefined();
      expect(isIdentityUserDid(userDid(id), HOST)).toBe(true);   // still a DID under that host's :users:
    }
    expect(identityUserIdOf(userDid(`u-try-guest-${hex('f', 32)}`), undefined)).toBeUndefined();
  });
});

describe('identity user DIDs — none resolves to the tenant pod, over many generated ids', () => {
  it('3,000 generated guest, per-application guest, evaluation and account ids each resolve to their own segment', () => {
    const kinds: ReadonlyArray<readonly [prefix: string, length: number]> = [
      ['u-try-guest-', 32], ['u-try-play-', 32], ['u-try-', 12], ['u-pk-', 12], ['u-eth-', 12], ['u-did-', 12],
    ];
    const hosts = [HOST, `${HOST}:8443`];
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) for (const [prefix, length] of kinds) {
      const id = prefix + hex(`${prefix}${i}`, length), host = hosts[i % 2]!;
      const subject = i % 3 === 0 && host.includes(':') ? `did:web:${host.replace(/:/g, '%3A')}:users:${id}` : userDid(id, host);
      const pod = withHost(subject, undefined, host);
      expect(pod, subject).toBe(`${ORIGIN}/${id}/`);
      expect(pod).not.toBe(TENANT);
      expect(new URL(pod).pathname.split('/').filter(Boolean)).toEqual([id]);
      expect(guardSubjectPod({ subject, podUrl: pod, tenantPodUrl: TENANT, identityHost: host })).toEqual({ ok: true });
      seen.add(pod);
    }
    expect(seen.size).toBe(3000);   // no two ids share a pod
  });

  it('two different guests never share a pod, and neither shares one with an account', () => {
    const a = `u-try-guest-${hex('one', 32)}`, b = `u-try-guest-${hex('two', 32)}`;
    expect(withHost(userDid(a))).not.toBe(withHost(userDid(b)));
    expect(withHost(userDid(a))).not.toBe(withHost(userDid('u-eth-c0ac4ed0aaaa')));
  });
});

describe('identity user DIDs — hostile ids and hosts never resolve into a segment of their own choosing', () => {
  const guest = `u-try-guest-${hex('victim', 32)}`;
  const ch = (code: number): string => String.fromCharCode(code);
  /** Subjects that must answer exactly what master answers (the tenant pod, for all of these). */
  const HOSTILE: ReadonlyArray<readonly [what: string, subject: string]> = [
    ['path traversal', userDid('..')],
    ['path traversal into a pod', userDid(`../${guest}`)],
    ['traversal after a valid id', userDid(`${guest}/../foxxi`)],
    ['a slash', userDid(`${guest}/extra`)],
    ['an encoded slash', userDid(`${guest}%2Fextra`)],
    ['an encoded slash before', userDid(`x%2F${guest}`)],
    ['an encoded backslash', userDid(`${guest}%5Cextra`)],
    ['an encoded dot segment', userDid('%2e%2e')],
    ['dots only', userDid('...')],
    ['a single dot', userDid('.')],
    ['a trailing dot on the id', userDid(`${guest}.`)],
    ['a further did:web path element', userDid(`${guest}:profile`)],
    ['a query', userDid(`${guest}?x=1`)],
    ['a fragment', userDid(`${guest}#me`)],
    ['an empty id', userDid('')],
    ['the tenant segment', userDid('foxxi')],
    ['an uppercase guest id', userDid(guest.toUpperCase())],
    ['uppercase hex', userDid(`u-try-guest-${hex('victim', 32).toUpperCase()}`)],
    ['one hex character short', userDid(guest.slice(0, -1))],
    ['one hex character long', userDid(`${guest}a`)],
    ['a non-hex character', userDid(`${guest.slice(0, -1)}g`)],
    ['another host', userDid(guest, 'evil.example.test')],
    ['a look-alike host (suffix)', userDid(guest, `${HOST}.evil.example`)],
    ['a look-alike host (prefix)', userDid(guest, `evil-${HOST}`)],
    ['a subdomain of the host', userDid(guest, `www.${HOST}`)],
    ['a trailing dot on the host', userDid(guest, `${HOST}.`)],
    ['a homoglyph host', userDid(guest, HOST.replace('i', ch(0x0456)))],
    ['a port the config does not name', `did:web:${HOST}%3A8443:users:${guest}`],
    ['userinfo before the host', `did:web:evil@${HOST}:users:${guest}`],
    ['an uppercase method', `DID:WEB:${HOST}:users:${guest}`],
    ['an uppercase :USERS:', `did:web:${HOST}:USERS:${guest}`],
    ['the :agents: path', `did:web:${HOST}:agents:${guest}`],
    ['another did method', `did:example:${HOST}:users:${guest}`],
    ['a prefix before the DID', `x did:web:${HOST}:users:${guest}`],
    ['a control character inside the id', userDid(`${guest.slice(0, 20)}${ch(0x0a)}${guest.slice(21)}`)],
    ['a NUL inside the id', userDid(`${guest.slice(0, 20)}${ch(0)}${guest.slice(21)}`)],
    ['a line separator after the id', userDid(`${guest}${ch(0x2028)}x`)],
    ['a subject past the length bound', `${userDid(guest)}${'a'.repeat(IDENTITY_SUBJECT_MAX_LENGTH)}`],
  ];

  it.each(HOSTILE)('%s: left at master\'s behaviour, never the guest\'s pod', (_what, subject) => {
    const pod = withHost(subject);
    expect(pod).toBe(resolveBefore(subject));
    expect(pod).toBe(TENANT);
    expect(pod).not.toBe(`${ORIGIN}/${guest}/`);
    expect(identityUserIdOf(subject, HOST)).toBeUndefined();
  });

  it('surrounding whitespace is trimmed first, as for every identity, and then it is the plain DID', () => {
    expect(withHost(`${userDid(guest)}   `)).toBe(`${ORIGIN}/${guest}/`);
  });

  it('no hostile subject resolves to a path of more than one segment, or to another origin', () => {
    for (const [, subject] of HOSTILE) {
      const u = new URL(withHost(subject));
      expect(u.origin).toBe(ORIGIN);
      expect(u.pathname.split('/').filter(Boolean).length).toBe(1);
      expect(u.pathname).not.toContain('..');
    }
  });

  it('an unusable configured host turns the rule off rather than matching loosely', () => {
    for (const bad of ['', ' ', '*', 'identity.example.test.', '.identity.example.test', 'identity.example.test:', 'identity.example.test:port',
      'https://identity.example.test', 'identity.example.test/users', '[::1]:3000', 'a:b:c', 'identity.example.test:8443:9']) {
      expect(withHost(userDid(guest, bad.trim()), undefined, bad), bad).toBe(TENANT);
      expect(withHost(userDid(guest), undefined, bad), bad).toBe(TENANT);
    }
  });

  it('KNOWN, unchanged from master: a pod id embedded anywhere wins, including inside a host name', () => {
    // `ownPodSegment` runs first and reads the first `eth-…`/`u-pk-…` anywhere in the string. This
    // rule does not alter that; the guard is what refuses the result for an identity user.
    const odd = 'seth-01.example.test', subject = userDid(guest, odd);
    expect(withHost(subject, undefined, odd)).toBe(resolveBefore(subject));
    expect(withHost(subject, undefined, odd)).toBe(`${ORIGIN}/eth-01/`);
    expect(guardSubjectPod({ subject, podUrl: withHost(subject, undefined, odd), tenantPodUrl: TENANT, identityHost: odd }))
      .toMatchObject({ ok: false, reason: 'not-own-pod' });
  });
});

describe('guardSubjectPod — a guest or identity account is never kept on the shared tenant pod', () => {
  const guestId = `u-try-guest-${hex('guard', 32)}`, guest = userDid(guestId);
  const guard = (subject: string, podUrl: string, identityHost: string | undefined = HOST) =>
    guardSubjectPod({ subject, podUrl, tenantPodUrl: TENANT, identityHost });

  it('refuses a general guest whose pod is the tenant pod, with or without a configured host', () => {
    expect(guard(guest, TENANT)).toMatchObject({ ok: false, reason: 'shared-tenant-pod' });
    expect(guard(guest, TENANT, undefined)).toMatchObject({ ok: false, reason: 'shared-tenant-pod' });
    // The state today: no host is configured, so the resolver falls back, and the guard catches it.
    expect(guard(guest, resolve(guest), undefined)).toMatchObject({ ok: false, reason: 'shared-tenant-pod' });
    expect(guard(userDid(guestId, 'evil.example.test'), TENANT)).toMatchObject({ ok: false, reason: 'shared-tenant-pod' });
    expect(guard(userDid(guestId.toUpperCase()), TENANT)).toMatchObject({ ok: false, reason: 'shared-tenant-pod' });
  });

  it('refuses any DID under the identity host\'s :users: whose pod is the tenant pod', () => {
    for (const id of ['markj', 'foxxi', '..', 'u-pk-123', `u-try-play-${hex('p', 32)}`, 'u-eth-c0ac4ed0aaaa']) {
      expect(guard(userDid(id), TENANT), id).toMatchObject({ ok: false, reason: 'shared-tenant-pod' });
    }
  });

  it('recognises the tenant pod however it is spelled', () => {
    for (const spelled of ['https://gate.example.test/foxxi', 'https://GATE.example.test/foxxi/', 'https://gate.example.test:443/foxxi/',
      'https://gate.example.test/foxxi/profile/card', 'https://gate.example.test/FOXXI/', 'https://gate.example.test/%66oxxi/', 'https://gate.example.test//foxxi/']) {
      expect(guard(guest, spelled), spelled).toMatchObject({ ok: false, reason: 'shared-tenant-pod' });
    }
  });

  it('refuses a pod it cannot read, and the resolver\'s answer when no tenant pod is configured', () => {
    for (const bad of ['', 'not-a-url', 'file:///foxxi/', 'urn:pod:foxxi']) expect(guard(guest, bad), bad).toMatchObject({ ok: false, reason: 'pod-unreadable' });
    const unconfigured = resolveSubjectPodUrlPure({ tenantPodUrl: '', identity: guest, safeUrl: safePublicUrlOrUndefined, identityHost: HOST });
    expect(unconfigured).toBe('');
    expect(guardSubjectPod({ subject: guest, podUrl: unconfigured, tenantPodUrl: '', identityHost: HOST })).toMatchObject({ ok: false });
  });

  it('refuses an identity user id on any pod but <pod origin>/<its own id>/', () => {
    expect(guard(guest, `${ORIGIN}/u-try-guest-${hex('someone-else', 32)}/`)).toMatchObject({ ok: false, reason: 'not-own-pod' });
    expect(guard(guest, `https://elsewhere.example.test/${guestId}/`)).toMatchObject({ ok: false, reason: 'not-own-pod' });
    expect(guard(userDid('u-eth-c0ac4ed0aaaa'), `${ORIGIN}/u-eth-c0ac4ed0bbbb/`)).toMatchObject({ ok: false, reason: 'not-own-pod' });
  });

  it('allows a guest and an account on their own pods', () => {
    expect(guard(guest, withHost(guest))).toEqual({ ok: true });
    expect(guard(userDid('u-eth-c0ac4ed0aaaa'), withHost(userDid('u-eth-c0ac4ed0aaaa')))).toEqual({ ok: true });
    expect(guard(userDid('u-pk-123456789abc'), resolve(userDid('u-pk-123456789abc')))).toEqual({ ok: true });
  });

  it('is not a general check: every other subject is answered ok, the tenant pod included', () => {
    for (const subject of ['did:ethr:0x2c3ec2978973680f890c0609c6a8cee382f3c80c', 'did:web:example.test:agents:plain-agent',
      `did:web:${HOST}:agents:service`, 'https://id.example.test/jliu/profile#me', 'jliu', '']) {
      expect(guard(subject, TENANT), subject).toEqual({ ok: true });
      expect(isGeneralGuestDid(subject)).toBe(false);
    }
  });

  it('for every generated guest, the pod resolved without an identity host is refused and the one resolved with it is allowed', () => {
    for (let i = 0; i < 500; i++) {
      const subject = userDid(`u-try-guest-${hex(`g${i}`, 32)}`);
      expect(isGeneralGuestDid(subject)).toBe(true);
      expect(guard(subject, resolve(subject))).toMatchObject({ ok: false, reason: 'shared-tenant-pod' });
      expect(guard(subject, withHost(subject))).toEqual({ ok: true });
    }
  });
});
