import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LISTING_BYTES, PASS_RESOURCES, deleteGameData, isPlayGameData, playGameDataResidue, purgeProvisionalPlayPod } from '../provisional-play-cleanup.js';
const userId = `u-try-play-${'a'.repeat(32)}`;
const cssUrl = 'https://css.example/';
const root = `${cssUrl}${userId}/`;
const anchor = `${root}auth-methods.jsonld`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** A game save's path, as the css-gate names it (a lowercase sha256), and the write budget's. */
const save = `hallowmarch/checkpoints/${sha('save')}.json`;
const budget = 'play-budget.json';

/**
 * A Play pod as CSS 7.2 with the PGSL accessor answered the same requests when probed (the identity
 * route tests' stand-in pod, S0, checks the same answers): a listing names a container's children
 * by name, sorted; a document's ETag is strong and new at every write; a container is created with
 * a document written in it and stays when emptied, until its own DELETE (409 while it holds
 * anything); a native head (written as a native commit, as the css-gate writes a guest's saves and
 * budget) answers every plain DELETE with 409; OPTIONS advertises `Interego-Native-Delete: 1`; and a
 * DELETE with that header and `If-Match` is the native delete: 400 for a container or a missing,
 * `*`, weak or listed validator, 412 for a missing document or another ETag, 409 for a document
 * that is not a native head, 205 once the exact revision is deleted. `events` logs each request
 * with its answer (a native delete as NATIVE-DELETE), by path relative to the pod.
 */
function fakePod(documents: Record<string, 'native' | 'plain'>, options: { advertise?: string | null; optionsStatus?: number } = {}) {
  const docs = new Map<string, { native: boolean; revision: number }>();
  const containers = new Set<string>(['']);
  let revision = 0;
  const write = (path: string, kind: 'native' | 'plain') => {
    docs.set(path, { native: kind === 'native', revision: ++revision });
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) containers.add(`${segments.slice(0, i).join('/')}/`);
  };
  for (const [path, kind] of Object.entries(documents)) write(path, kind);
  const etag = (path: string) => `"sha256:${sha(`${path}#${docs.get(path)!.revision}`)}-${'0'.repeat(16)}"`;
  const children = (prefix: string) => [...new Set([...docs.keys(), ...containers].filter(p => p !== prefix && p.startsWith(prefix))
    .map(p => { const rest = p.slice(prefix.length); const slash = rest.indexOf('/'); return slash < 0 ? rest : rest.slice(0, slash + 1); }))].sort();
  const events: string[] = [];
  const hooks: { answer?: (label: string) => number | undefined; after?: (label: string, status: number) => void } = {};
  const fetcher = (async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith(root), `a request outside the pod: ${url}`);
    const path = url.slice(root.length);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const native = method === 'DELETE' && headers.get('interego-native-delete') === '1';
    const label = `${native ? 'NATIVE-DELETE' : method} ${path}`;
    const answer: { status: number; headers: Record<string, string>; body?: string } = { status: 405, headers: {} };
    const forced = hooks.answer?.(label);
    if (forced !== undefined) answer.status = forced;
    else if (method === 'OPTIONS') {
      answer.status = options.optionsStatus ?? 204;
      if (options.advertise !== null) answer.headers['Interego-Native-Delete'] = options.advertise ?? '1';
    } else if (path === '' || path.endsWith('/')) {
      const exists = containers.has(path);
      if (method === 'GET') {
        answer.status = exists ? 200 : 404;
        const named = children(path);
        answer.body = `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> a ldp:BasicContainer${named.length ? ` ; ldp:contains ${named.map(c => `<${c}>`).join(', ')}` : ''} .\n`;
      } else if (method === 'DELETE') {
        answer.status = native ? 400 : !exists ? 404 : children(path).length > 0 ? 409 : 205;
        if (answer.status === 205) containers.delete(path);
      }
    } else if (method === 'GET' || method === 'HEAD') {
      answer.status = docs.has(path) ? 200 : 404;
      if (docs.has(path)) answer.headers['ETag'] = etag(path);
    } else if (method === 'DELETE') {
      const ifMatch = headers.get('if-match');
      if (native && (!ifMatch || ifMatch === '*' || ifMatch.startsWith('W/') || ifMatch.includes(','))) answer.status = 400;
      else if (native) answer.status = !docs.has(path) || ifMatch !== etag(path) ? 412 : docs.get(path)!.native ? 205 : 409;
      else answer.status = !docs.has(path) ? 404 : docs.get(path)!.native ? 409 : 205;
      if (answer.status === 205) docs.delete(path);
    }
    events.push(`${label} ${answer.status}`);
    hooks.after?.(label, answer.status);
    return new Response(method === 'GET' ? answer.body ?? null : null, { status: answer.status, headers: answer.headers });
  }) as typeof fetch;
  return { fetcher, events, hooks, write, remove: (path: string) => { docs.delete(path); },
    has: (path: string) => docs.has(path) || containers.has(path),
    /** The requests that are not listings (GETs), in order. */
    changes: () => events.filter(e => !e.startsWith('GET ')) };
}
const purge = (pod: ReturnType<typeof fakePod>, close: (listed: readonly string[], whole: boolean) => Promise<'purge' | 'closed' | 'kept'> = async () => 'purge') =>
  purgeProvisionalPlayPod({ userId, cssUrl, close, fetcher: pod.fetcher });

test('cleanup closes the account once the tree is checked, then deletes the other resources, the game data by native delete and the containers after their children; the record and its container stay', async () => {
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', agents: 'plain', 'resources/checkpoint.with.dots.json': 'plain', [save]: 'native', [budget]: 'native' });
  let closedAt = -1;
  const result = await purge(pod, async () => { closedAt = pod.events.length; return 'purge'; });
  assert.deepEqual(result, { outcome: 'purged', retained: [] });
  assert.ok(closedAt > 0 && pod.events.slice(0, closedAt).every(e => e.startsWith('GET ')),
    `the tree is listed, and nothing else is asked (no OPTIONS, no HEAD) or changed, before the account is closed: ${pod.events}`);
  assert.deepEqual(pod.changes(), [
    'DELETE agents 205',
    // The store's capability is asked once, at the first game data, and each document is read for its ETag first.
    `OPTIONS ${save} 204`, `HEAD ${save} 200`, `NATIVE-DELETE ${save} 205`,
    'DELETE hallowmarch/checkpoints/ 205', 'DELETE hallowmarch/ 205',
    `HEAD ${budget} 200`, `NATIVE-DELETE ${budget} 205`,
    'DELETE resources/checkpoint.with.dots.json 205', 'DELETE resources/ 205',
  ], 'children before their containers; the game data by native delete, and the containers that held it afterwards');
  // The closure fence: the pod is listed once more after the deletions.
  assert.equal(pod.events.at(-1), 'GET  200');
  // The record stays, as the tombstone close() wrote: a write still pending from before the purge
  // is conditional on its ETag, which CSS 7.2 would apply to a missing document. It used to be
  // deleted last but the root. Nothing is sent to it or to the pod's root but listings.
  assert.deepEqual(pod.changes().filter(e => ['', 'auth-methods.jsonld'].includes(e.split(' ')[1]!)), []);
  assert.ok(pod.has('auth-methods.jsonld') && !pod.has(save) && !pod.has(budget) && !pod.has('hallowmarch/'));
});

test('only the game data is sent a native delete: a native head outside it gets a plain DELETE, is kept on its 409, holds its containers, and does not hold the purge open', async () => {
  // A native head the css-gate does not write: a save's name with an upper-case, short or long
  // digest, with something after its `.json` or in place of its dot, or under another container;
  // another name; the budget's name in another container, with another extension, in place of its
  // dot, or in upper case. Nothing here expects one, and no plain request deletes it, so a purge kept
  // open for it would never finish.
  const digest = sha('save');
  const unexpected = [`hallowmarch/checkpoints/${digest.toUpperCase()}.json`, `hallowmarch/checkpoints/${digest.slice(1)}.json`,
    `hallowmarch/checkpoints/${digest}0.json`, `hallowmarch/checkpoints/${digest}.json.bak`, `hallowmarch/checkpoints/${digest}_json`,
    `saves/hallowmarch/checkpoints/${digest}.json`,
    'hallowmarch/notes.json', 'saves/play-budget.json', 'play-budget.json.bak', 'play-budget_json', 'PLAY-BUDGET.json'];
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', [save]: 'native', [budget]: 'native', ...Object.fromEntries(unexpected.map(p => [p, 'native' as const])) });
  const result = await purge(pod);
  assert.equal(result.outcome, 'purged');
  assert.deepEqual(result.retained.map(url => url.slice(root.length)).sort(), [...unexpected].sort());
  for (const path of unexpected) {
    assert.deepEqual(pod.changes().filter(e => e.split(' ')[1] === path), [`DELETE ${path} 409`], `${path}: one plain DELETE, nothing else`);
    assert.ok(pod.has(path));
  }
  assert.ok(pod.changes().includes(`NATIVE-DELETE ${save} 205`) && pod.changes().includes(`NATIVE-DELETE ${budget} 205`), `${pod.changes()}`);
  assert.equal(pod.changes().filter(e => e.startsWith('NATIVE-DELETE ')).length, 2);
  // The containers of a kept head are not sent a DELETE (CSS refuses one that is not empty).
  assert.deepEqual(pod.changes().filter(e => e.split(' ')[1]!.endsWith('/')), [], 'no container here is empty');
  for (const path of unexpected) assert.equal(isPlayGameData(new URL(root), `${root}${path}`), false, path);
  assert.equal(isPlayGameData(new URL(root), `${root}${save}`) && isPlayGameData(new URL(root), `${root}${budget}`), true);
  assert.equal(isPlayGameData(new URL(root), `${cssUrl}u-try-play-${'b'.repeat(32)}/${budget}`), false, 'another pod\'s');
  assert.equal(isPlayGameData(new URL(root), `${root}${budget}?x=1`), false);
});

test('the native delete refuses the pod and its sign-in record, and anything outside the game data, before it sends anything', async () => {
  const requests: string[] = [];
  const del = deleteGameData(new URL(root), async (url, init) => { requests.push(`${init?.method} ${url}`); return new Response(null, { status: 500 }); });
  for (const url of [root, anchor, `${root}auth%2Dmethods.jsonld`, `${root}./auth-methods.jsonld`])
    await assert.rejects(del(url), /Refusing a native delete of the pod or its sign-in record/, url);
  // The budget's path on another origin, or with a user name or password in its URL, is not this pod's.
  const elsewhere = [`https://other.example/${userId}/${budget}`, `https://u:p@css.example/${userId}/${budget}`,
    `https://u@css.example/${userId}/${budget}`, `https://:p@css.example/${userId}/${budget}`];
  for (const url of [`${root}agents`, `${root}profile/card`, `${root}hallowmarch/checkpoints/`, `${cssUrl}u-try-play-${'b'.repeat(32)}/${budget}`, `${root}${budget}#x`, ...elsewhere])
    await assert.rejects(del(url), /Refusing a native delete outside the Play game data/, url);
  for (const url of elsewhere) assert.equal(isPlayGameData(new URL(root), url), false, url);
  assert.deepEqual(requests, []);
  // The game data itself: the capability, the ETag, then the exact delete on it.
  const sent: Array<{ method: string; headers: Headers }> = [];
  const native = deleteGameData(new URL(root), async (_url, init) => {
    sent.push({ method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    if (init?.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Interego-Native-Delete': '1' } });
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { ETag: '"sha256:1-2"' } });
    return new Response(null, { status: 205 });
  });
  await native(`${root}${budget}`);
  assert.deepEqual(sent.map(s => s.method), ['OPTIONS', 'HEAD', 'DELETE']);
  assert.equal(sent[2]!.headers.get('interego-native-delete'), '1');
  assert.equal(sent[2]!.headers.get('if-match'), '"sha256:1-2"');
});

test('a store that does not advertise native delete is sent none: the purge stops, and stays open for the next pass', async () => {
  // An OPTIONS answered 5xx says nothing of it (the header it carries here included), and is not taken for a store without it.
  const stores: Array<Parameters<typeof fakePod>[1]> = [{ advertise: null }, { advertise: '2' }, { optionsStatus: 405 }, { optionsStatus: 500 }, { optionsStatus: 503, advertise: null }];
  for (const options of stores) {
    const pod = fakePod({ 'auth-methods.jsonld': 'plain', [save]: 'native', [budget]: 'native' }, options);
    await assert.rejects(purge(pod), (options.optionsStatus ?? 0) >= 500 ? new RegExp(`the store's OPTIONS was answered ${options.optionsStatus}`)
      : /does not advertise native delete/, JSON.stringify(options));
    assert.deepEqual(pod.changes().filter(e => !e.startsWith('OPTIONS ')), [], `${JSON.stringify(options)}: nothing but OPTIONS is sent: ${pod.changes()}`);
    assert.ok(pod.has(save) && pod.has(budget));
  }
  // The capability is asked once a purge, however much game data there is.
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', [save]: 'native', [budget]: 'native' });
  assert.equal((await purge(pod)).outcome, 'purged');
  assert.equal(pod.changes().filter(e => e.startsWith('OPTIONS ')).length, 1);
});

test('game data that changed since its ETag was read (412), or is not a native head (409), stops the purge, which stays open; after a 412 the next pass reads it again and deletes it, and a 409 is met again at every pass', async () => {
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', agents: 'plain', [budget]: 'native' });
  // A write the gate authorized before the tombstone lands between the budget's HEAD and its DELETE.
  let raced = false;
  pod.hooks.after = label => { if (label === `HEAD ${budget}` && !raced) { raced = true; pod.write(budget, 'native'); } };
  await assert.rejects(purge(pod), /native delete of play-budget\.json was answered 412/);
  assert.ok(pod.has(budget), 'the budget, written again, stays');
  assert.equal(pod.changes().includes('DELETE agents 205'), true);
  assert.equal((await purge(pod)).outcome, 'purged', 'the next pass reads its ETag again, and deletes it');
  assert.equal(pod.has(budget), false);
  // A document under the game data's name that is not a native head (the css-gate writes none) is
  // never sent a plain DELETE: every pass meets the same 409, and the purge stays open.
  const legacy = fakePod({ 'auth-methods.jsonld': 'plain', [budget]: 'plain' });
  for (let pass = 1; pass <= 2; pass++) await assert.rejects(purge(legacy), /native delete of play-budget\.json was answered 409/, `pass ${pass}`);
  const refused = [`OPTIONS ${budget} 204`, `HEAD ${budget} 200`, `NATIVE-DELETE ${budget} 409`];
  assert.deepEqual(legacy.changes(), [...refused, ...refused]);
  assert.ok(legacy.has(budget));
  // Any other answer, to the read or to the delete, stops it the same way.
  for (const [label, status] of [[`HEAD ${budget}`, 500], [`NATIVE-DELETE ${budget}`, 500], [`NATIVE-DELETE ${budget}`, 404]] as const) {
    const failing = fakePod({ 'auth-methods.jsonld': 'plain', [budget]: 'native' });
    failing.hooks.answer = l => (l === label ? status : undefined);
    await assert.rejects(purge(failing), /Provisional cleanup/, `${label} ${status}`);
    assert.ok(failing.has(budget));
  }
  // A weak ETag (or none) is no validator for the exact delete.
  const weak = fakePod({ 'auth-methods.jsonld': 'plain', [budget]: 'native' });
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, close: async () => 'purge', fetcher: (async (input, init) => {
    const r = await weak.fetcher(input, init);
    return init?.method === 'HEAD' ? new Response(null, { status: 200, headers: { ETag: `W/${r.headers.get('etag')}` } }) : r;
  }) as typeof fetch }), /no strong ETag/);
  assert.equal(weak.changes().some(e => e.startsWith('NATIVE-DELETE ')), false, 'no delete is sent on a weak ETag');
  // A read that is not a 2xx is no read of the document, whatever strong ETag it carries.
  const unread = fakePod({ 'auth-methods.jsonld': 'plain', [budget]: 'native' });
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, close: async () => 'purge', fetcher: (async (input, init) => {
    const r = await unread.fetcher(input, init);
    return init?.method === 'HEAD' ? new Response(null, { status: 500, headers: { ETag: r.headers.get('etag')! } }) : r;
  }) as typeof fetch }), /the read of play-budget\.json was answered 500/);
  assert.equal(unread.changes().some(e => e.startsWith('NATIVE-DELETE ')), false, 'no delete is sent on a failed read');
  assert.ok(unread.has(budget));
});

test('game data whose read is a 404 (gone since the listing) is gone: the purge goes on and finishes', async () => {
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', [save]: 'native', [budget]: 'native' });
  // The other instance's purge removed the save after this one listed it.
  pod.hooks.answer = label => { if (label === `HEAD ${save}`) pod.remove(save); return undefined; };
  assert.deepEqual(await purge(pod), { outcome: 'purged', retained: [] });
  assert.equal(pod.changes().some(e => e.startsWith(`NATIVE-DELETE ${save}`)), false, 'no delete is sent for it');
  assert.ok(pod.changes().includes(`NATIVE-DELETE ${budget} 205`));
});

test('closure fence: game data a write authorized before the tombstone puts back after its deletion holds the purge open, and the next pass deletes it', async () => {
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', agents: 'plain', [save]: 'native', [budget]: 'native' });
  // The gate let a save through while the guest's token was valid; it reaches the pod once the
  // purge has deleted the budget (the last of the game data), into the containers it deleted.
  const late = `hallowmarch/checkpoints/${sha('late')}.json`;
  let landed = false;
  pod.hooks.after = (label, status) => { if (label === `NATIVE-DELETE ${budget}` && status === 205 && !landed) { landed = true; pod.write(late, 'native'); } };
  await assert.rejects(purge(pod), /game data is on the pod again after its deletion \(hallowmarch\/checkpoints\/[0-9a-f]{64}\.json\)/);
  assert.ok(pod.has(late));
  const result = await purge(pod);
  assert.deepEqual(result, { outcome: 'purged', retained: [] });
  assert.equal(pod.has(late) || pod.has('hallowmarch/'), false);
  // A resource outside the game data written meanwhile (the relay's, say) does not hold it open.
  const relay = fakePod({ 'auth-methods.jsonld': 'plain', agents: 'plain', [budget]: 'native' });
  relay.hooks.after = (label, status) => { if (label === `NATIVE-DELETE ${budget}` && status === 205) relay.write('agents', 'plain'); };
  assert.equal((await purge(relay)).outcome, 'purged');
});

test('close() is given the pod\'s tree as checked, children before their containers: the URLs the purge then deletes, but the root and the record; a close that keeps the account deletes nothing', async () => {
  const documents = { 'auth-methods.jsonld': 'plain', agents: 'plain', [save]: 'native', [budget]: 'native' } as const;
  const pod = fakePod(documents);
  let given: readonly string[] = [];
  assert.equal((await purge(pod, async listed => { given = listed; return 'purge'; })).outcome, 'purged');
  const paths = given.map(url => url.slice(root.length));
  assert.deepEqual(paths, ['agents', 'auth-methods.jsonld', save, 'hallowmarch/checkpoints/', 'hallowmarch/', budget, '']);
  assert.ok(given.every(url => url.startsWith(root)));
  assert.deepEqual(pod.changes().filter(e => /^(NATIVE-)?DELETE /.test(e)).map(e => e.split(' ')[1]),
    paths.filter(path => path !== '' && path !== 'auth-methods.jsonld'), 'the deletions are those URLs, in that order');
  for (const answer of ['kept', 'closed'] as const) {
    const other = fakePod(documents);
    let seen: readonly string[] = [];
    assert.equal((await purge(other, async listed => { seen = listed; return answer; })).outcome, answer);
    assert.deepEqual(seen.map(url => url.slice(root.length)), paths, answer);
    assert.deepEqual(other.changes(), [], `${answer}: nothing but the listing`);
  }
});

test('playGameDataResidue: what a listing holds besides the root, the record and the game data\'s two containers', () => {
  const at = (...paths: string[]) => paths.map(path => `${root}${path}`);
  const second = `hallowmarch/checkpoints/${sha('second')}.json`;
  // What a purge finished before the native delete left: the root, the record (its tombstone), the
  // budget, two saves and the containers that hold them.
  const leftover = at('', 'auth-methods.jsonld', budget, 'hallowmarch/', 'hallowmarch/checkpoints/', save, second);
  assert.deepEqual(playGameDataResidue(new URL(root), leftover), { gameData: [budget, save, second], outside: [], record: true });
  // A guest's deletion keeps the relay's bootstrap writes beside them.
  assert.deepEqual(playGameDataResidue(new URL(root), [...leftover, ...at('profile/card', 'profile/', 'context-graphs/')]),
    { gameData: [budget, save, second], outside: ['profile/card', 'profile/', 'context-graphs/'], record: true });
  // A save's name in upper case, with a short digest or under another container, a budget in another
  // container, another container of the game, and another spelling of the record are no game data,
  // nor the record.
  const digest = sha('save');
  for (const path of [`hallowmarch/checkpoints/${digest.toUpperCase()}.json`, `hallowmarch/checkpoints/${digest.slice(1)}.json`,
    `saves/hallowmarch/checkpoints/${digest}.json`, 'saves/play-budget.json', 'hallowmarch/notes/', 'auth%2Dmethods.jsonld']) {
    assert.deepEqual(playGameDataResidue(new URL(root), at(path)), { gameData: [], outside: [path], record: false }, path);
  }
  assert.equal(playGameDataResidue(new URL(root), leftover.filter(url => url !== anchor)).record, false, 'a listing without the record');
  const elsewhere = `${cssUrl}u-try-play-${'b'.repeat(32)}/${budget}`;
  assert.deepEqual(playGameDataResidue(new URL(root), [elsewhere]), { gameData: [], outside: [elsewhere], record: false }, 'another pod\'s, whole');
});

test('cleanup discovers foreign references and refuses all deletes', async () => {
  const deleted: string[] = [];
  let closed = 0;
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, close: async () => { closed++; return 'purge'; },
    fetcher: (async (input, init) => {
      if (init?.method === 'DELETE') deleted.push(String(input));
      return new Response('ldp:contains <https://css.example/victim/secret.json> .');
    }) as typeof fetch }), /foreign/);
  assert.equal(deleted.length, 0);
  assert.equal(closed, 0, 'the account is not closed either');
});
// ── A pod that holds more than one pass lists (PlayPurgeProgress) ──

/** `count` documents under `prefix`, plain unless `kind` says otherwise. */
const many = (prefix: string, count: number, kind: 'native' | 'plain' = 'plain') =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${String(i).padStart(4, '0')}.json`, kind]));
/** A pod an application filled: 300 records eleven levels down, 200 beside the root's own, a registry, and the guest's game data. */
const filled = () => fakePod({ 'auth-methods.jsonld': 'plain', agents: 'plain', [save]: 'native', [budget]: 'native',
  ...many('records/a/b/c/d/e/f/g/h/i/j/', 300), ...many('workbench/', 200) });
/** What one pass asked of the pod: its listings, and its deletions. */
const passWork = (pod: ReturnType<typeof fakePod>, from: number) => {
  const events = pod.events.slice(from);
  return { listings: events.filter(e => e.startsWith('GET ')).length, deletions: events.filter(e => /^(NATIVE-)?DELETE /.test(e)).length };
};

test('a pod past 128 resources and eight levels is closed at its first pass and purged over the passes after it, each bounded, none leaving the pod', async () => {
  for (const carried of [true, false]) {
    const pod = filled();
    // `carried`: the passes of one process. Without it every pass is a new process's first.
    const progress = { retained: new Set<string>() };
    const closes: boolean[] = [];
    let closedAt = -1;
    const outcomes: string[] = [];
    for (let pass = 1; pass <= 12 && outcomes.at(-1) !== 'purged'; pass++) {
      const from = pod.events.length;
      const result = await purgeProvisionalPlayPod({ userId, cssUrl, fetcher: pod.fetcher, ...(carried ? { progress } : {}),
        close: async (_listed, whole) => { closes.push(whole); if (closedAt < 0) closedAt = pod.events.length; return 'purge'; } });
      outcomes.push(result.outcome);
      const work = passWork(pod, from);
      // A pass lists at most 128 resources, and the last one lists what is left once more (the closure fence).
      assert.ok(work.listings <= 2 * 128 && work.deletions <= 128, `pass ${pass}: ${JSON.stringify(work)}`);
      if (result.outcome === 'partial') assert.ok(result.deleted! > 0, `pass ${pass} deleted something`);
    }
    // 504 documents and 15 containers besides the record and the root: four passes, and one that lists the rest whole and finishes.
    assert.deepEqual(outcomes, ['partial', 'partial', 'partial', 'partial', 'purged'], `carried ${carried}`);
    assert.deepEqual(closes, [false, false, false, false, true], 'close() is told when the listing is not the whole pod');
    assert.ok(closedAt > 0 && pod.events.slice(0, closedAt).every(e => e.startsWith('GET ')), 'the account is closed at the first pass, before anything is deleted');
    assert.ok(pod.has('auth-methods.jsonld'), 'the record stays, as the tombstone');
    for (const gone of ['agents', save, budget, 'records/', 'workbench/', 'hallowmarch/', 'records/a/b/c/d/e/f/g/h/i/j/0299.json', 'workbench/0199.json'])
      assert.equal(pod.has(gone), false, gone);
    // fakePod's fetcher fails any request outside `<pod origin>/<userId>/`; nothing is sent to the record or the root but listings.
    assert.deepEqual(pod.changes().filter(e => ['', 'auth-methods.jsonld'].includes(e.split(' ')[1]!)), []);
  }
});

test('a pod within the bound is listed whole and purged in one pass, as before; one resource more makes it two', async () => {
  // The root and 127 more: the record, the registry and 125 records.
  const within = fakePod({ 'auth-methods.jsonld': 'plain', agents: 'plain', ...many('w', 125) });
  let whole: boolean | undefined;
  assert.equal((await purge(within, async (_listed, all) => { whole = all; return 'purge'; })).outcome, 'purged');
  assert.equal(whole, true);
  const over = fakePod({ 'auth-methods.jsonld': 'plain', agents: 'plain', ...many('w', 126) });
  assert.deepEqual((await purge(over)).outcome, 'partial');
  assert.equal((await purge(over)).outcome, 'purged');
  // Eight levels was a limit of its own: a small pod deeper than that was never closed either.
  const deep = fakePod({ 'auth-methods.jsonld': 'plain', 'a/b/c/d/e/f/g/h/i/j/k/record.json': 'plain' });
  assert.deepEqual(await purge(deep), { outcome: 'purged', retained: [] });
  assert.equal(deep.has('a/'), false);
});

test('a guest that was claimed, or whose account close() otherwise keeps, loses nothing of a pod of any size', async () => {
  for (const answer of ['kept', 'closed'] as const) {
    const pod = filled();
    assert.deepEqual(await purge(pod, async () => answer), { outcome: answer, retained: [] });
    assert.deepEqual(pod.changes(), [], `${answer}: nothing but listings`);
    assert.ok(passWork(pod, 0).listings <= 128, 'and no more of those than a pass lists');
  }
});

test('a pass that is interrupted is taken up by the next: what it deleted is not listed again, and the purge finishes', async () => {
  const pod = filled();
  const progress = { retained: new Set<string>() };
  const run = () => purgeProvisionalPlayPod({ userId, cssUrl, fetcher: pod.fetcher, progress, close: async () => 'purge' });
  // The store stops answering at the 41st deletion of the first pass.
  let deletions = 0;
  pod.hooks.answer = label => (label.startsWith('DELETE ') && ++deletions === 41 ? 503 : undefined);
  await assert.rejects(run(), /deletion incomplete/);
  const deletedFirst = pod.changes().filter(e => e.endsWith(' 205')).map(e => e.split(' ')[1]!);
  assert.ok(deletedFirst.length >= 40 && deletedFirst.length < 128, `${deletedFirst.length} deleted before the pass stopped`);
  pod.hooks.answer = undefined;
  const outcomes: string[] = [];
  for (let pass = 1; pass <= 12 && outcomes.at(-1) !== 'purged'; pass++) outcomes.push((await run()).outcome);
  assert.equal(outcomes.at(-1), 'purged');
  for (const path of deletedFirst) assert.equal(pod.changes().filter(e => /^(NATIVE-)?DELETE /.test(e) && e.split(' ')[1] === path).length, 1, `${path} is sent one DELETE in all`);
  assert.equal(pod.has('records/') || pod.has('workbench/') || pod.has(save), false);
});

test('documents the store refuses to delete (409) do not hold a large pod open: later passes neither count nor send them again, and the purge finishes without them', async () => {
  // 200 native heads no cleanup expects come first in the listing, then 200 documents it can delete.
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', ...many('a-heads/', 200, 'native'), ...many('b-records/', 200) });
  const progress = { retained: new Set<string>() };
  const outcomes: string[] = [];
  let retained: string[] = [];
  for (let pass = 1; pass <= 12 && outcomes.at(-1) !== 'purged'; pass++) {
    const result = await purgeProvisionalPlayPod({ userId, cssUrl, fetcher: pod.fetcher, progress, close: async () => 'purge' });
    outcomes.push(result.outcome);
    retained = result.retained;
  }
  assert.equal(outcomes.at(-1), 'purged', outcomes.join(' '));
  assert.ok(outcomes.length <= 5, outcomes.join(' '));
  assert.equal(retained.length, 200);
  assert.ok(retained.every(url => url.startsWith(`${root}a-heads/`)));
  assert.equal(pod.changes().filter(e => e.startsWith('DELETE a-heads/') && e.endsWith(' 409')).length, 200, 'each is sent one DELETE in all');
  assert.equal(pod.changes().some(e => e.startsWith('DELETE a-heads/ ')), false, 'the container that holds them is not sent one');
  assert.ok(pod.has('a-heads/') && !pod.has('b-records/'));
});

test('a chain of containers deeper than a pass lists is walked down over the passes of one process, and then deleted from its end', async () => {
  const chain = Array.from({ length: 300 }, (_, i) => `c${i}`).join('/');
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', [`${chain}/record.json`]: 'plain' });
  const progress: { retained: Set<string>; resume?: string } = { retained: new Set<string>() };
  const outcomes: string[] = [];
  for (let pass = 1; pass <= 12 && outcomes.at(-1) !== 'purged'; pass++) {
    const from = pod.events.length;
    outcomes.push((await purgeProvisionalPlayPod({ userId, cssUrl, fetcher: pod.fetcher, progress, close: async () => 'purge' })).outcome);
    assert.ok(progress.resume === undefined || progress.resume.startsWith(root), 'where the next pass starts is inside the pod');
    const work = passWork(pod, from);
    assert.ok(work.listings <= 2 * 128 + 1 && work.deletions <= 128, `pass ${pass}: ${JSON.stringify(work)}`);
  }
  assert.equal(outcomes.at(-1), 'purged', outcomes.join(' '));
  assert.equal(pod.has('c0/'), false);
});

test('where a pass starts is never outside the pod: a `resume` that names another pod, the root, a document or no URL is ignored', async () => {
  for (const resume of [`${cssUrl}u-try-play-${'b'.repeat(32)}/records/`, 'https://other.example/records/', root, `${root}agents`, `${root}records/?x=1`, 'not a url']) {
    const pod = fakePod({ 'auth-methods.jsonld': 'plain', agents: 'plain', 'records/one.json': 'plain' });
    const progress: { retained: Set<string>; resume?: string } = { retained: new Set<string>(), resume };
    assert.equal((await purgeProvisionalPlayPod({ userId, cssUrl, fetcher: pod.fetcher, progress, close: async () => 'purge' })).outcome, 'purged', resume);
    assert.equal(pod.events[0], 'GET  200', `${resume}: the pass lists from the root`);
    assert.equal(pod.has('records/'), false);
  }
  // One that names a container of the pod that is gone: from the root, in the same pass.
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', agents: 'plain' });
  const progress: { retained: Set<string>; resume?: string } = { retained: new Set<string>(), resume: `${root}gone/` };
  assert.equal((await purgeProvisionalPlayPod({ userId, cssUrl, fetcher: pod.fetcher, progress, close: async () => 'purge' })).outcome, 'purged');
  assert.deepEqual(pod.events.slice(0, 2), ['GET gone/ 404', 'GET  200']);
});

test('a listing longer than a pass reads is cut there: the pass deletes what it read of it, and no more than a pass deletes', async () => {
  // One container whose listing is over LISTING_BYTES: 6,000 children with names of 1,000 characters.
  assert.equal(LISTING_BYTES, 4 * 1024 * 1024);
  const names = Array.from({ length: 6000 }, (_, i) => `${String(i).padStart(5, '0')}${'n'.repeat(995)}`);
  const gone = new Set<string>();
  let whole: boolean | undefined;
  const requests: string[] = [];
  const result = await purgeProvisionalPlayPod({ userId, cssUrl, close: async (_listed, all) => { whole = all; return 'purge'; },
    fetcher: (async (input, init) => {
      const url = String(input);
      assert.ok(url.startsWith(root), url);
      requests.push(`${init?.method ?? 'GET'} ${url.slice(root.length, root.length + 12)}`);
      if (init?.method === 'DELETE') { gone.add(url); return new Response(null, { status: 205 }); }
      return new Response(`<> ldp:contains ${names.filter(n => !gone.has(`${root}${n}`)).map(n => `<${n}>`).join(', ')} .\n`);
    }) as typeof fetch });
  assert.equal(whole, false);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.deleted, PASS_RESOURCES - 1, 'the root counts as one of the resources a pass lists');
  assert.deepEqual(requests.filter(r => r.startsWith('GET ')), ['GET '], 'one listing');
  assert.equal(gone.has(`${root}${names[0]}`), true);
});

test('an account close() keeps (an enrolment landed, or its anchor has not expired) keeps every resource, its game data included', async () => {
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', checkpoint: 'plain', [save]: 'native', [budget]: 'native' });
  assert.deepEqual(await purge(pod, async () => 'kept'), { outcome: 'kept', retained: [] });
  assert.deepEqual(pod.changes(), [], 'nothing but the listing: no OPTIONS, HEAD or DELETE');
});
test('a record that is a tombstone no purge marked (a deletion\'s, whose owner may be provisioned again) keeps every resource, its game data included', async () => {
  // The other instance's provisioning does not wait for this server's lock, and may put the owner
  // back over a deletion's tombstone until its guest deadline: deleting now could delete the
  // resources of an owner provisioned again meanwhile. It used to be purged like any other.
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', checkpoint: 'plain', [save]: 'native', [budget]: 'native' });
  assert.deepEqual(await purge(pod, async () => 'closed'), { outcome: 'closed', retained: [] });
  assert.deepEqual(pod.changes(), [], 'nothing but the listing: no OPTIONS, HEAD or DELETE');
});
test('a deletion that fails after the close throws, so its caller keeps the purge for another pass, and one sent again finishes it', async () => {
  const deleted: string[] = [];
  let failing = 1;
  const run = () => purgeProvisionalPlayPod({ userId, cssUrl, close: async () => 'purge',
    fetcher: (async (input, init) => {
      if (init?.method !== 'DELETE') return new Response('ldp:contains <auth-methods.jsonld>, <checkpoint>, <agents> .');
      if (String(input).endsWith('/checkpoint') && failing-- > 0) return new Response(null, { status: 500 });
      deleted.push(String(input));
      return new Response(null, { status: deleted.length > 1 ? 404 : 205 });
    }) as typeof fetch });
  await assert.rejects(run(), /deletion incomplete/);
  assert.deepEqual(deleted, []);
  assert.equal((await run()).outcome, 'purged');
  assert.deepEqual(deleted, [`${root}checkpoint`, `${root}agents`]);
});
test('a 409 on a container that holds nothing kept fails the pass, as any refused deletion does', async () => {
  // Something written in it since the listing: the next pass lists it again.
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, close: async () => 'purge',
    fetcher: (async (input, init) => {
      const url = String(input);
      if (init?.method === 'DELETE') return new Response(null, { status: url.endsWith('/') ? 409 : 205 });
      return new Response(url === root ? 'ldp:contains <auth-methods.jsonld>, <resources/> .' : 'ldp:contains <a.json> .');
    }) as typeof fetch }), /deletion incomplete/);
});
test('a close that fails changes nothing more', async () => {
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', checkpoint: 'plain', [budget]: 'native' });
  await assert.rejects(purge(pod, async () => { throw new Error('pod unavailable'); }), /pod unavailable/);
  assert.deepEqual(pod.changes(), []);
});
test('cleanup never accepts non-Play owner identifiers', async () => {
  await assert.rejects(purgeProvisionalPlayPod({ userId: 'canonical-owner', cssUrl, close: async () => 'purge' }), /non-Play/);
});

test('a second application\'s guest is cleaned up as the first\'s: its saves and budget by native delete, then its two containers', async () => {
  const foxxi = `foxxi/checkpoints/${sha('save')}.json`;
  const index = `foxxi/checkpoints/${sha('index')}.json`;
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', agents: 'plain', [foxxi]: 'native', [index]: 'native', [budget]: 'native' });
  const purge = await purgeProvisionalPlayPod({ userId, cssUrl, fetcher: pod.fetcher, close: async () => 'purge' });
  assert.deepEqual(purge, { outcome: 'purged', retained: [] });
  assert.ok(pod.has('auth-methods.jsonld'));
  for (const gone of [foxxi, index, budget, 'foxxi/', 'foxxi/checkpoints/', 'agents']) assert.equal(pod.has(gone), false, gone);
  assert.deepEqual(pod.events.filter(event => event.startsWith('NATIVE-DELETE')).map(event => event.split(' ')[1]).sort(), [foxxi, index, budget].sort());
});

test('game data is an application namespace\'s checkpoints only: a name a guest pod uses for something else, or a malformed one, is none', () => {
  const digest = sha('save');
  const at = (...paths: string[]) => paths.map(path => `${root}${path}`);
  for (const namespace of ['hallowmarch', 'foxxi', 'foxxi-learning', 'a1']) {
    assert.equal(isPlayGameData(new URL(root), `${root}${namespace}/checkpoints/${digest}.json`), true, namespace);
    assert.deepEqual(playGameDataResidue(new URL(root), at(`${namespace}/`, `${namespace}/checkpoints/`, `${namespace}/checkpoints/${digest}.json`)),
      { gameData: [`${namespace}/checkpoints/${digest}.json`], outside: [], record: false }, namespace);
  }
  for (const namespace of ['context-graphs', 'agents', 'profile', 'play-limits', 'Foxxi', 'f', '1foxxi', 'foxxi_x', 'a'.repeat(33), 'fo%78xi']) {
    const path = `${namespace}/checkpoints/${digest}.json`;
    assert.equal(isPlayGameData(new URL(root), `${root}${path}`), false, namespace);
    assert.deepEqual(playGameDataResidue(new URL(root), at(`${namespace}/`, `${namespace}/checkpoints/`, path)),
      { gameData: [], outside: [`${namespace}/`, `${namespace}/checkpoints/`, path], record: false }, namespace);
  }
});

test('the native delete is refused under a name that is no application namespace, before anything is sent', async () => {
  const digest = sha('save');
  const pod = fakePod({ 'auth-methods.jsonld': 'plain', [`context-graphs/checkpoints/${digest}.json`]: 'native' });
  const request = (url: string, init?: RequestInit) => pod.fetcher(url, init);
  await assert.rejects(deleteGameData(new URL(root), request)(`${root}context-graphs/checkpoints/${digest}.json`), /outside the Play game data/);
  assert.deepEqual(pod.events, []);
});
