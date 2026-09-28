/**
 * SCORM packages this bridge hosts, for a learner to play.
 *
 * The list is the bridge's own (its entry point links it) and needs no signature. A launch is the
 * signed cmi5 launch every published course takes, for the signer, so what the package reports
 * lands in the learner's own record, as experience. The package then opens in a tab of its own:
 * each of its documents runs in a sandbox of its own on the bridge, not framed on this page.
 */
import React, { useEffect, useState } from 'react';
import { Button, Card, Pill } from './common.js';
import { linkOf, useAffordance, useHypermedia } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import { signerAsks, signerFor } from '../auth/signer.js';
import { postSigned } from '../auth/signed-request.js';
import { hostedPackagesFrom, launchUrlFrom, unlistedFrom, type HostedPackage } from '../learn/hosted-packages.js';

type Launch = { state: 'launching' } | { state: 'ready'; url: string } | { state: 'failed'; error: string };

const row: React.CSSProperties = {
  display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px',
  border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel-2)', marginBottom: 6,
};

export function HostedPackagesCard({ session }: { session: FoxxiSession }) {
  const { entry } = useHypermedia();
  const listHref = linkOf(entry, 'scorm-packages');
  const launcher = useAffordance('foxxi.cmi5_launch_signed');
  const asks = signerAsks(session);
  const [packages, setPackages] = useState<HostedPackage[] | null>(null);
  const [unlisted, setUnlisted] = useState(0);
  const [listError, setListError] = useState<string | null>(null);
  const [launches, setLaunches] = useState<Record<string, Launch>>({});

  useEffect(() => {
    if (!listHref) return;
    let cancel = false;
    fetch(listHref, { headers: { Accept: 'application/json' } })
      .then(r => { if (!r.ok) throw new Error(`the bridge answered ${r.status}`); return r.json() as Promise<unknown>; })
      .then(body => { if (!cancel) { setPackages(hostedPackagesFrom(body)); setUnlisted(unlistedFrom(body)); } })
      .catch((e: unknown) => { if (!cancel) setListError((e as Error).message); });
    return () => { cancel = true; };
  }, [listHref]);

  async function launch(p: HostedPackage): Promise<void> {
    if (!launcher) return;
    setLaunches(l => ({ ...l, [p.packageSha256]: { state: 'launching' } }));
    try {
      const url = launchUrlFrom(await postSigned(launcher.href, signerFor(session), { course_id: p.course.id }));
      setLaunches(l => ({ ...l, [p.packageSha256]: url ? { state: 'ready', url } : { state: 'failed', error: 'the launch answered with no URL to open' } }));
    } catch (e) {
      setLaunches(l => ({ ...l, [p.packageSha256]: { state: 'failed', error: (e as Error).message } }));
    }
  }

  if (!entry || !listHref) return null;
  return (
    <Card title="SCORM packages hosted here">
      <div style={{ color: 'var(--text-dim)', fontSize: 14, marginBottom: 10 }}>
        Packages uploaded to this bridge, each played as a cmi5 course. A launch is signed as you
        {asks ? ' (your wallet asks first)' : ''}, and the package opens in a tab of its own; what it
        reports lands in your record as experience.
      </div>
      {listError && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>The packages could not be listed: {listError}</div>}
      {!packages && !listError && <div style={{ color: 'var(--text-dim)' }}>Listing the packages…</div>}
      {packages && packages.length === 0 && !unlisted && <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>No packages are hosted here yet.</div>}
      {unlisted > 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 6 }}>
          {unlisted === 1 ? '1 more package is' : `${unlisted} more packages are`} kept here but not listed yet: the bridge is
          still reading {unlisted === 1 ? 'it' : 'them'}. Reload in a moment to see {unlisted === 1 ? 'it' : 'them'}.
        </div>
      )}
      {packages?.map(p => {
        const l = launches[p.packageSha256];
        return (
          <div key={p.packageSha256} style={row}>
            <span style={{ fontSize: 16 }}>{p.course.title}</span>
            <Pill>{p.aus.length === 1 ? '1 part' : `${p.aus.length} parts`}</Pill>
            {l?.state === 'ready'
              ? <a href={l.url} target="_blank" rel="noopener noreferrer">Open it in a new tab</a>
              : <Button small primary disabled={!launcher || l?.state === 'launching'} onClick={() => { void launch(p); }}>
                  {l?.state === 'launching' ? (asks ? 'Approve in your wallet…' : 'Launching…') : 'Launch'}
                </Button>}
            {l?.state === 'failed' && <span role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>{l.error}</span>}
          </div>
        );
      })}
      {!launcher && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>This bridge offers no signed cmi5 launch (foxxi.cmi5_launch_signed).</div>}
    </Card>
  );
}
