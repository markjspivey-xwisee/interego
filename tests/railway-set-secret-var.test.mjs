// tools/railway-set-secret-var.mjs, the by-hand path in deploy/identity/AUTH-ARCHITECTURE.md
// ("Rollback, floors and rotation"), never prints the value it writes, whatever Railway answers.
//
// The tool runs as a child process with fetch replaced before it loads by a stand-in Railway
// API, so it cannot reach the network. The stand-in can refuse the variableUpsert the way
// graphql-js reports an input it cannot coerce (the message quotes the whole input object,
// value included), fail the request with an error whose message and cause hold the request
// body, or answer 502 with a body that starts with the value. Each answer has to reach the
// operator as one fixed line that names the step, and the value must not appear in stdout or
// stderr, in whole or in part.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL = fileURLToPath(new URL('../tools/railway-set-secret-var.mjs', import.meta.url));
const VAR = 'IDENTITY_INTROSPECTION_SECRET';
// Letters outside hex, so no 12-hex fingerprint the tool prints can contain a piece of it.
const VALUE = `zq-${'kx7'.repeat(20)}-wv`;
const OTHER = 'other-variable-of-the-service-zzzz';

const dir = mkdtempSync(join(tmpdir(), 'set-secret-var-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const valueFile = join(dir, 'value');
writeFileSync(valueFile, `${VALUE}\n`, { mode: 0o600 });

// The stand-in. FAKE_MODE picks how the variableUpsert is answered; FAKE_STORED is what Railway
// holds before the run. Every other request the tool makes is answered as Railway would.
const fake = join(dir, 'fake-railway.mjs');
writeFileSync(fake, `
const mode = process.env.FAKE_MODE;
let stored = process.env.FAKE_STORED || undefined;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'https://backboard.railway.com/graphql/v2') throw new Error('unexpected url in this test');
  const { query, variables } = JSON.parse(init.body);
  if (mode === 'bad-token') return json({ errors: [{ message: 'Not Authorized' }] });
  if (query.includes('projectToken')) return json({ data: { projectToken: { projectId: 'p-1', environmentId: 'e-1' } } });
  if (query.includes('project(id')) return json({ data: { project: { services: { edges: [{ node: { id: 's-relay', name: 'relay' } }] } } } });
  if (query.includes('variables(')) return json({ data: { variables: { OTHER: ${JSON.stringify(OTHER)}, ...(stored === undefined ? {} : { ${JSON.stringify(VAR)}: stored }) } } });
  if (query.includes('variableUpsert')) {
    const input = variables.input;
    if (mode === 'echo') return json({ errors: [{ message: 'Variable "$input" got invalid value ' + JSON.stringify(input) + '; Field "value" is invalid' }] });
    if (mode === 'throw') throw new Error('fetch failed: ' + init.body, { cause: new Error(init.body) });
    if (mode === 'bad-gateway') return new Response(input.value + ' was not accepted upstream', { status: 502 });
    if (mode === 'lost') return json({ data: { variableUpsert: true } });
    stored = input.value;
    return json({ data: { variableUpsert: true } });
  }
  throw new Error('unexpected query in this test');
};
`);

function run(mode, { stored, apply = true } = {}) {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(fake).href, TOOL, 'relay', VAR, valueFile, ...(apply ? ['--apply'] : [])], {
    env: { PATH: process.env.PATH, RAILWAY_PROJECT_TOKEN: 'not-a-token', FAKE_MODE: mode, ...(stored ? { FAKE_STORED: stored } : {}) },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

/** No piece of the value, eight characters or longer, anywhere in what the tool printed. */
function assertNoValue(out, label) {
  for (let i = 0; i + 8 <= VALUE.length; i++) {
    const piece = VALUE.slice(i, i + 8);
    assert.equal(out.includes(piece), false, `${label}: printed part of the value (${JSON.stringify(piece)})`);
  }
  assert.equal(out.includes(OTHER), false, `${label}: printed another variable of the service`);
}

for (const [mode, message] of [
  ['echo', 'GraphQL: Railway refused the request'],
  ['throw', 'network: the request failed'],
  ['bad-gateway', 'network: Railway answered HTTP 502'],
]) {
  test(`a failed write (${mode}) prints one fixed line and no part of the value`, () => {
    const r = run(mode);
    assert.equal(r.status, 1, r.out);
    assertNoValue(r.out, mode);
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 1, `one line on stderr, got:\n${r.stderr}`);
    assert.equal(
      lines[0],
      `FAILED while writing ${VAR} on relay: ${message}. Whether the write landed is unknown; rerun the same command without --apply to compare what Railway holds with the file. Railway's own error text is not printed, because it can quote the value.`,
    );
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
  });
}

test('a refusal before the write names the step and does not mention the write', () => {
  const r = run('bad-token');
  assert.equal(r.status, 1, r.out);
  assert.equal(r.stdout, '');
  assert.equal(
    r.stderr.trim(),
    "FAILED while reading the project token: GraphQL: Railway refused the request. Railway's own error text is not printed, because it can quote the value.",
  );
});

test('a write that does not read back fails without printing the value', () => {
  const r = run('lost');
  assert.equal(r.status, 1, r.out);
  assertNoValue(r.out, 'lost');
  assert.match(r.stderr, /VERIFY FAILED — reads back as \(unset\)/);
});

test('a write that lands is verified, and prints a length and fingerprint only', () => {
  const r = run('ok');
  assert.equal(r.status, 0, r.out);
  assertNoValue(r.out, 'ok');
  assert.match(r.stdout, /before {2}: \(unset\)/);
  assert.match(r.stdout, new RegExp(`after {3}: ${VALUE.length} chars, sha256:[0-9a-f]{12}`));
  assert.match(r.stdout, /written and verified/);
  assert.equal(r.stderr, '');
});

test('a dry run writes nothing, and a stored value equal to the file needs no write', () => {
  const dry = run('echo', { apply: false });
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.stdout, /DRY RUN — nothing written/);
  assertNoValue(dry.out, 'dry run');
  const same = run('echo', { stored: VALUE });
  assert.equal(same.status, 0, same.out);
  assert.match(same.stdout, /no change needed/);
  assertNoValue(same.out, 'already stored');
});
