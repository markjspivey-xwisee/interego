/** Native IPC + actual peer HTTP routes; the second peer/provider is an isolated simulator. */
import type { FederationService, FederationStatus } from '@interego/pod-federation';
import type { LocalNote } from './types.js';
import type { BridgeSmokeOptions } from './bridge-smoke.js';

export interface FederationSmokeJournal { readonly identity: string; readonly peer: string; readonly note: string; readonly received: string }
interface Options extends BridgeSmokeOptions {
  readonly expectPrevious: boolean;
  readonly peer: FederationService;
  approve(id: string, code: string): Promise<unknown>;
  save(value: FederationSmokeJournal): Promise<void>;
  load(): Promise<FederationSmokeJournal>;
}
function insist(value: unknown, message: string): asserts value { if (!value) throw new Error(`Packaged federation verification failed: ${message}`); }

export async function verifyFederation(options: Options): Promise<void> {
  const initial = await options.invoke<FederationStatus>('federationStatus');
  insist(!initial.enabled, 'off on fresh app process');
  if (options.expectPrevious) {
    const journal = await options.load();
    insist(initial.profile?.id === journal.identity && initial.peers.some(peer => peer.id === journal.peer), 'protected identity and peer retained');
    const copy = await options.invoke<{ content: string }>('readFederation', journal.received);
    insist(copy.content === 'A peer snapshot retained across native process restarts.', 'received copy readable while off');
    insist(!(await options.peer.status()).enabled, 'simulated independent peer also starts off');
    await options.invoke('resumeBridge');
    await options.invoke('enableFederation', 'Packaged federation check');
    await options.peer.setEnabled(true);
    await options.invoke('shareFederation', { peerId: journal.peer, noteIds: [journal.note] });
    insist((await options.peer.status()).received.length === 2, 'retained approval sends without a new invite');
    await options.invoke('revokeFederation', journal.peer);
    let refused = false;
    try { await options.peer.share(journal.identity, [{ iri: 'urn:test:must-not-arrive', mediaType: 'text/plain', content: 'Rejected after native disconnect.' }]); }
    catch { refused = true; }
    insist(refused && (await options.invoke<FederationStatus>('federationStatus')).received.length === 1, 'native disconnect blocks peer delivery');
    await options.invoke('removeFederationSnapshot', journal.received);
    await options.invoke('clearFederationHistory');
    const forgotten = await options.invoke<FederationStatus>('forgetFederation');
    insist(!forgotten.enabled && !forgotten.configured && !forgotten.peers.length && !forgotten.received.length, 'confirmed sharing reset');
  } else {
    await options.invoke('resumeBridge');
    const enabled = await options.invoke<FederationStatus>('enableFederation', 'Packaged federation check');
    insist(enabled.enabled && enabled.profile, 'explicit native enable');
    await options.peer.configure({ name: 'Independent simulated peer', endpoint: 'https://packaged-peer.example/pod-federation', kind: 'local' });
    await options.peer.setEnabled(true);
    const invite = await options.invoke<{ code: string }>('createFederationInvite');
    await options.peer.acceptInvite(invite.code);
    const pending = (await options.invoke<FederationStatus>('federationStatus')).pending[0];
    insist(pending && pending.verificationCode === (await options.peer.status()).joining[0]?.verificationCode, 'native matching comparison code');
    await options.approve(pending.id, pending.verificationCode); await options.peer.refresh();
    const own = await options.invoke<LocalNote>('saveNote', { title: 'Native selected federation note', body: 'Only this chosen snapshot is shared with the simulated peer.' });
    await options.invoke('shareFederation', { peerId: pending.peer.id, noteIds: [own.id] });
    insist((await options.peer.status()).received.length === 1, 'selected source delivered');
    await options.peer.share(enabled.profile.id, [{ iri: 'urn:test:packaged-peer-snapshot', mediaType: 'text/plain', content: 'A peer snapshot retained across native process restarts.' }]);
    const received = (await options.invoke<FederationStatus>('federationStatus')).received;
    insist(received.length === 1, 'peer sends through actual bridge route');
    await options.save({ identity: enabled.profile.id, peer: pending.peer.id, note: own.id, received: received[0]!.id });
  }
  await options.invoke('disableFederation'); await options.invoke('stopBridge'); await options.peer.setEnabled(false);
  insist(!(await options.invoke<FederationStatus>('federationStatus')).enabled && !options.loopback(), 'pause closes remote route');
}
