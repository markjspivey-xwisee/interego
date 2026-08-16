/**
 * READING A PRIVATE WORKSPACE — THE HALF THAT RUNS ON THIS SIDE.
 *
 * Encrypting a workspace is only useful if its members can still read it. `WorkspaceClient`
 * overrides `descriptor()` so that a sealed payload is fetched and opened at the ONE place every
 * reader in the package already goes through — the workspace record, the canvas, the seats, the
 * acceptances, presence, and the entry chain all call `client.descriptor(url)`.
 *
 * ── ★★ THE FAILURES THIS PINS ARE ALL SILENT ────────────────────────────────
 *
 * Nothing here throws when it goes wrong. A missed decryption reads as an empty workspace; a
 * decryption that should not have happened reads as a workspace that was never private; and
 * treating "not addressed to me" as damage tells a member their workspace is corrupt when they
 * simply were not invited. All three look like ordinary data to every caller.
 */

import { describe, it, expect } from 'vitest';
import { WorkspaceClient } from '../packages/workspace-client/src/substrate.js';

const URL_ = 'https://css.example/u-a/context-graphs/1.ttl';

/** A transport that answers whatever the test hands it, and records what was asked. */
function transportOf(answers: Record<string, unknown>): { tx: never; asked: string[] } {
  const asked: string[] = [];
  const tx = {
    callTool: (name: string, _input: Record<string, unknown>) => {
      asked.push(name);
      if (!(name in answers)) throw new Error('no tool named ' + name + ' is granted here');
      return Promise.resolve(answers[name]);
    },
  };
  return { tx: tx as never, asked };
}

const SEALED = { url: URL_, graph: { url: URL_ + '.jose', encrypted: true, content: null } };

describe('a client holding a key opens what the relay would not', () => {
  it('★★ fetches the sealed envelope and returns the opened payload as ordinary content', async () => {
    const { tx, asked } = transportOf({
      get_descriptor: SEALED,
      get_encrypted_graph: { encrypted: true, envelope: '{"sealed":true}' },
    });
    const client = new WorkspaceClient('https://relay.example', tx);
    client.setGraphOpener((sealed) => {
      // The host's opener sees exactly what the tool returned, and nothing else.
      expect((sealed as { envelope?: string }).envelope).toBe('{"sealed":true}');
      return { kind: 'opened', content: '<urn:g> <p> "o" .' };
    });

    const d = await client.descriptor(URL_);
    expect((d['graph'] as { content?: string }).content).toBe('<urn:g> <p> "o" .');
    expect(asked).toEqual(['get_descriptor', 'get_encrypted_graph']);
    // ★ Evidence that this was decrypted HERE rather than served in the clear. Without it no
    // reader can honestly distinguish end-to-end encryption from a relay that simply had the key.
    expect(d['openedWithOwnKey']).toBe(true);
  });

  it('★ leaves the record withheld when the envelope is not addressed to this key', async () => {
    const { tx } = transportOf({
      get_descriptor: SEALED,
      get_encrypted_graph: { encrypted: true, envelope: '{"sealed":true}' },
    });
    const client = new WorkspaceClient('https://relay.example', tx);
    client.setGraphOpener(() => ({ kind: 'not-for-you' }));   // a permission, not a fault

    const d = await client.descriptor(URL_);
    expect((d['graph'] as { content?: string | null }).content).toBeNull();
    expect(d['openedWithOwnKey']).toBeUndefined();
  });

  it('★★ does not call the sealed read at all when no key is installed', async () => {
    /**
     * The artifact runs in a browser and installs no opener. It must behave exactly as it does
     * today — one call, a withheld record — rather than reaching for a tool its grant may not
     * carry and reporting the resulting refusal as a broken workspace.
     */
    const { tx, asked } = transportOf({ get_descriptor: SEALED });
    const client = new WorkspaceClient('https://relay.example', tx);
    expect(client.canOpenSealed).toBe(false);

    const d = await client.descriptor(URL_);
    expect(asked).toEqual(['get_descriptor']);
    expect((d['graph'] as { content?: string | null }).content).toBeNull();
  });

  it('★ never re-fetches a payload the relay already answered in the clear', async () => {
    // The relay serves the caller's OWN pod as plaintext. Asking for an envelope that is not
    // there would spend a round trip per read and answer `no_envelope_url` every time.
    const { tx, asked } = transportOf({
      get_descriptor: { url: URL_, graph: { url: URL_, encrypted: false, content: '<urn:g> <p> "plain" .' } },
    });
    const client = new WorkspaceClient('https://relay.example', tx);
    client.setGraphOpener(() => ({ kind: 'opened', content: 'SHOULD NOT BE CALLED' }));

    const d = await client.descriptor(URL_);
    expect(asked).toEqual(['get_descriptor']);
    expect((d['graph'] as { content?: string }).content).toBe('<urn:g> <p> "plain" .');
  });

  it('★★ a grant without the sealed-read tool degrades to withheld rather than failing the read', async () => {
    /**
     * `get_encrypted_graph` is deliberately outside `REQUIRED_TOOLS` — a twelfth required tool
     * would invalidate every grant already issued against the eleven, so a client that has not
     * been re-granted must read LESS, not stop working. The reason is carried so the UI can say
     * which of the two happened.
     */
    const { tx } = transportOf({ get_descriptor: SEALED });   // the sealed read is not granted
    const client = new WorkspaceClient('https://relay.example', tx);
    client.setGraphOpener(() => ({ kind: 'opened', content: 'SHOULD NOT BE REACHED' }));

    const d = await client.descriptor(URL_);
    expect((d['graph'] as { content?: string | null }).content).toBeNull();
    expect(String(d['sealedReadFailed'])).toContain('get_encrypted_graph');
  });
});

describe('★★ a read that FAILED is not a statement about membership', () => {
  /**
   * ── WHAT THIS COST BEFORE THERE WERE THREE ANSWERS ──────────────────────────
   *
   * `openerFor` returned `null` for BOTH "not addressed to me" and "the bytes could not be
   * opened", violating the contract written on `GraphOpener` itself. So a CSS 502 during a
   * redeploy, a damaged envelope, or a descriptor naming no distribution all became `withheld`,
   * and `verifyGrantIri` refused a member's own Accept with "this workspace is private and this
   * identity is not among them" — the exact sentence re-sealing was introduced to stop anybody
   * seeing, said to somebody who IS a recipient, because a transport hiccup was reported as a
   * permission.
   */
  it('records WHY, instead of leaving it indistinguishable from a refusal', async () => {
    const { tx } = transportOf({
      get_descriptor: SEALED,
      get_encrypted_graph: { error: 'envelope_fetch_failed', message: 'the envelope could not be retrieved' },
    });
    const client = new WorkspaceClient('https://relay.example', tx);
    // The real opener's behaviour for that payload: `openGraph` answers `unreadable`.
    client.setGraphOpener(() => ({ kind: 'unreadable', why: 'the envelope could not be retrieved' }));

    const d = await client.descriptor(URL_);
    expect((d['graph'] as { content?: string | null }).content).toBeNull();
    expect(String(d['sealedReadFailed'])).toContain('could not be retrieved');
  });

  it('★ and a genuine refusal still records NOTHING, so the two stay distinguishable', () => {
    // The whole point of three answers. If both set `sealedReadFailed`, the reader is back to one
    // sentence for two situations.
    return (async (): Promise<void> => {
      const { tx } = transportOf({
        get_descriptor: SEALED,
        get_encrypted_graph: { encrypted: true, envelope: '{"sealed":true}' },
      });
      const client = new WorkspaceClient('https://relay.example', tx);
      client.setGraphOpener(() => ({ kind: 'not-for-you' }));
      const d = await client.descriptor(URL_);
      expect(d['sealedReadFailed']).toBeUndefined();
    })();
  });
});

describe('★★ a client whose transport opens for it', () => {
  /**
   * ── THE DEFECT THIS PINS ────────────────────────────────────────────────────
   *
   * The desktop renderer is sandboxed and holds no key, deliberately — the account secret stays in
   * the main process. So it builds its own `WorkspaceClient` over an IPC bridge, and every read it
   * makes arrives in main as a RAW tool call. Main's `descriptor()` override, and the opener inside
   * it, were therefore never reached by anything the app actually does: the whole feature was
   * unreachable from the UI while every test and every live driver passed, because they all drive
   * `WorkspaceClient` directly.
   *
   * Two halves fix it, and both are asserted here: main applies the opening step to the raw
   * response (`openSealedDescriptor`), and the renderer's client says so (`declareSealedReadsUpstream`)
   * rather than reporting itself keyless while displaying decrypted text.
   */
  it('★★ openSealedDescriptor opens a response somebody else fetched', async () => {
    const { tx, asked } = transportOf({ get_encrypted_graph: { encrypted: true, envelope: '{"sealed":true}' } });
    const main = new WorkspaceClient('https://relay.example', tx);
    main.setGraphOpener(() => ({ kind: 'opened', content: '<urn:g> <p> "opened" .' }));

    // Exactly what the IPC bridge does: a raw tool result, handed back for opening.
    const opened = await main.openSealedDescriptor(SEALED as unknown as Record<string, unknown>, URL_);
    expect((opened['graph'] as { content?: string }).content).toBe('<urn:g> <p> "opened" .');
    expect(opened['openedWithOwnKey']).toBe(true);
    expect(asked).toEqual(['get_encrypted_graph']);
  });

  it('★★ a client told its transport opens upstream reports canOpenSealed, without any key', async () => {
    const { tx } = transportOf({ get_descriptor: SEALED });
    const renderer = new WorkspaceClient('https://relay.example', tx);
    expect(renderer.canOpenSealed).toBe(false);

    renderer.declareSealedReadsUpstream();
    expect(renderer.canOpenSealed).toBe(true);
  });

  it('★ and it still does not reach for the sealed read itself, because it has nothing to open with', async () => {
    /**
     * The declaration must not turn into a pretend opener. This client has no key; calling
     * `get_encrypted_graph` here would spend a round trip and then have nothing to do with the
     * bytes — and if its grant lacks the tool it would report a broken workspace.
     */
    const { tx, asked } = transportOf({ get_descriptor: SEALED });
    const renderer = new WorkspaceClient('https://relay.example', tx);
    renderer.declareSealedReadsUpstream();

    await renderer.descriptor(URL_);
    expect(asked).toEqual(['get_descriptor']);
  });
});

describe('what the workspace record says about a payload it could open', () => {
  it('★★ is NOT withheld once this client has decrypted it', async () => {
    /**
     * `withheld` drove the sentence "this workspace is private and you are not one of its
     * members". Keyed on the `encrypted` flag alone — as it was — it says that to the member who
     * just successfully decrypted the record, hiding a workspace from exactly the person entitled
     * to see it.
     */
    const iri = 'https://relay.example/ns/u-a/wsp';
    const region = '<' + iri + '> <https://interego.dev/ns/wsp#convener> <https://id.example/users/u-a/profile#me> .';
    const { tx } = transportOf({
      // The relay's real shape: the pod is asserted from `podUrl` and the head is nested.
      get_current_head: { podUrl: 'https://css.example/u-a/', head: { descriptorUrl: URL_, cid: 'bafy' } },
      get_descriptor: SEALED,
      get_encrypted_graph: { encrypted: true, envelope: '{}' },
    });
    const client = new WorkspaceClient('https://relay.example', tx);
    client.setGraphOpener(() => ({ kind: 'opened', content: region }));

    const r = await client.readWorkspaceRecord(iri, 'u-a');
    expect(r.kind).toBe('record');
    if (r.kind === 'record') expect(r.record.withheld).toBe(false);
  });
});
