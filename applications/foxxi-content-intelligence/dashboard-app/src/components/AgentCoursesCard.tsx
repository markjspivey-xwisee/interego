import React, { useEffect, useState } from 'react';
import { Card, Pill } from './common.js';

/**
 * Courses an AGENT authored — a different kind of object from the tenant
 * catalog, so it gets its own card rather than being flattened into one.
 *
 * A tenant catalog entry describes content that was synced or ingested: it has
 * an owner, a category, audience tags, an LMS source. An agent-authored course
 * has none of those — it has a DID that signed it into existence and a manifest
 * the sequencing engine will parse. Mapping one onto the other would mean
 * inventing an owner and a category that nobody set, so these stay side by side.
 *
 * Read-only dereference of the bridge's course read views. Launching is a signed
 * capability and happens in the player, never from here.
 */

const BRIDGE = ((import.meta.env.VITE_FOXXI_BRIDGE_URL as string | undefined)
  ?? 'https://foxxi-bridge.interego.xwisee.com').replace(/\/$/, '');

interface AgentCourse {
  courseId: string;
  title: string;
  masteryScore: number;
  authoredBy: string;
  scoCount: number;
  href: string;
  manifest: string;
  hmd: string;
  launch?: { player?: string };
}

export function AgentCoursesCard() {
  const [courses, setCourses] = useState<readonly AgentCourse[]>([]);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    fetch(`${BRIDGE}/agent/scorm/courses`)
      .then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then(j => { if (live) { setCourses(j.courses ?? []); setState('ok'); } })
      .catch((e: Error) => { if (live) { setError(e.message); setState('error'); } });
    return () => { live = false; };
  }, []);

  return (
    <Card title="Agent-authored courses" right={<Pill tone="accent">foxxi.scorm_author</Pill>}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12, lineHeight: 1.55 }}>
        Real SCORM 2004 courses an agent authored by signing them into existence — the bridge
        generated a conformant <code>imsmanifest.xml</code> and the sequencing engine parsed it.
        Each one is addressable: read it as prose, fetch the manifest an LMS would import, or
        launch a real attempt.
      </div>

      {state === 'loading' && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading…</div>}

      {state === 'error' && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          Could not reach the course catalog: {error}
        </div>
      )}

      {state === 'ok' && courses.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          No agent-authored courses in the catalog right now. The catalog is held in memory, so it
          starts empty after a bridge restart — a course reappears when an agent authors it (its
          durable copy lives on the author's pod and stays launchable).
        </div>
      )}

      {state === 'ok' && courses.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }}>
          {courses.map(c => (
            <div
              key={c.courseId}
              style={{
                border: '1px solid var(--border)', borderRadius: 6,
                padding: '12px 14px', background: 'var(--panel-2)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 14 }}>{c.title}</strong>
                <span style={{ fontSize: 11, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                  {c.scoCount} SCO{c.scoCount === 1 ? '' : 's'} · mastery {c.masteryScore}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 10px', wordBreak: 'break-all' }}>
                authored by <code>{c.authoredBy}</code>
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
                {c.launch?.player && (
                  <a href={c.launch.player} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                    Launch an attempt →
                  </a>
                )}
                <a href={c.hmd} target="_blank" rel="noreferrer" style={{ color: 'var(--text-dim)' }}>read as HyperMarkdown</a>
                <a href={c.manifest} target="_blank" rel="noreferrer" style={{ color: 'var(--text-dim)' }}>imsmanifest.xml</a>
                <a href={c.href} target="_blank" rel="noreferrer" style={{ color: 'var(--text-dim)' }}>catalog record</a>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
