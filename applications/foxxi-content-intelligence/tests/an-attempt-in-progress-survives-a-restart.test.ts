/**
 * A SCORM attempt in progress survives a restart.
 *
 * ★ WHY. Two of the ten memory-only stores in docs/operations/primary-state-rollout-hold.md were a
 * learner's place in a course: the sequencing engine's sessions, and the attempts agents play
 * through it. Neither was ever kept. The sessions' snapshot was collected with JSON.stringify of a
 * structure that is cyclic (each activity names its parent), so collecting threw and nothing was
 * published; and its restore discarded every entry. An attempt was a Map entry. A restart told a
 * learner half-way through to launch again.
 *
 * `sessionToJson` and `sessionFromJson` are what was missing. The test that matters is that a
 * session taken through them in the middle of a course goes on exactly as one that was not.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commitTracking, createSession, parseManifest, processNavigation, sessionFromJson, sessionToJson, sessionView, type SeqSession } from '../src/scorm-sequencing.js';
import type { TenantId } from '../src/tenant-context.js';

const MANIFEST = `<?xml version="1.0"?>
<manifest identifier="m1" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:imsss="http://www.imsglobal.org/xsd/imsss">
  <organizations default="org">
    <organization identifier="org">
      <title>Three units</title>
      <item identifier="i1" identifierref="r1"><title>One</title></item>
      <item identifier="block">
        <title>A block</title>
        <item identifier="i2" identifierref="r2"><title>Two</title></item>
        <item identifier="i3" identifierref="r3"><title>Three</title></item>
        <imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>
      </item>
      <imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>
    </organization>
  </organizations>
  <resources>
    <resource identifier="r1" type="webcontent" adlcp:scormType="sco" href="one.html"/>
    <resource identifier="r2" type="webcontent" adlcp:scormType="sco" href="two.html"/>
    <resource identifier="r3" type="webcontent" adlcp:scormType="sco" href="three.html"/>
  </resources>
</manifest>`;

const fresh = (): SeqSession => createSession('tenant-a' as TenantId, parseManifest(MANIFEST));
/** A session as another process would have it: through JSON text and back. */
const restarted = (s: SeqSession): SeqSession => {
  const back = sessionFromJson(JSON.parse(JSON.stringify(sessionToJson(s))));
  if (!back) throw new Error('the kept session could not be rebuilt');
  return back;
};
const pass = (s: SeqSession): void => { expect(commitTracking(s, { completion: 'completed', success: 'passed', scoreScaled: 0.9 }).ok).toBe(true); };

describe('a sequencing session, kept and rebuilt', () => {
  it('can be written as JSON at all: the tree it holds is cyclic', () => {
    const s = fresh();
    expect(() => JSON.stringify(s)).toThrow();
    expect(() => JSON.stringify(sessionToJson(s))).not.toThrow();
  });

  it('comes back the same session', () => {
    const s = fresh();
    processNavigation(s, 'start'); pass(s); processNavigation(s, 'continue');
    const r = restarted(s);
    expect(sessionView(r)).toEqual(sessionView(s));
    expect(sessionToJson(r)).toEqual(sessionToJson(s));
    expect(r.current?.id).toBe(s.current?.id);
    // The tree is rewired, not copied: a child's parent is the rebuilt parent.
    const two = r.tree.preorder.find(a => a.id === 'i2')!;
    expect(two.parent).toBe(r.tree.preorder.find(a => a.id === 'block'));
    expect(r.tree.root.parent).toBeUndefined();
    expect(r.tree.preorder.map(a => [a.id, a.order, a.subtreeSize])).toEqual(s.tree.preorder.map(a => [a.id, a.order, a.subtreeSize]));
  });

  it('goes on, after a restart in the middle, exactly as one that was never interrupted', () => {
    const steps: Array<(s: SeqSession) => unknown> = [
      s => processNavigation(s, 'start'),
      s => { pass(s); return processNavigation(s, 'continue'); },
      s => processNavigation(s, 'previous'),
      s => processNavigation(s, 'choice', 'i3'),
      s => { pass(s); return processNavigation(s, 'choice', 'i2'); },
      s => { pass(s); return processNavigation(s, 'continue'); },
      s => processNavigation(s, 'exitAll'),
    ];
    const strip = (r: unknown): unknown => JSON.parse(JSON.stringify(r));
    const straight = fresh(), expected = steps.map(step => strip(step(straight)));
    // Restarted before every step, and it still answers each one the same and ends in the same place.
    for (let cut = 0; cut <= steps.length; cut++) {
      let s = fresh();
      const got: unknown[] = [];
      steps.forEach((step, i) => { if (i === cut) s = restarted(s); got.push(strip(step(s))); });
      const withIds = (rs: unknown[], id: string): string => JSON.stringify(rs).split(id).join('SESSION');
      expect(withIds(got, s.id), `restart before step ${cut}`).toBe(withIds(expected, straight.id));
      expect({ ...sessionToJson(s), id: '', createdAt: '' }, `state after a restart before step ${cut}`).toEqual({ ...sessionToJson(straight), id: '', createdAt: '' });
    }
  });

  it('keeps a suspended session suspended, and resumes it where it was', () => {
    const s = fresh();
    processNavigation(s, 'start'); pass(s); processNavigation(s, 'continue');
    const at = s.current!.id;
    expect(processNavigation(s, 'suspendAll').ok).toBe(true);
    const r = restarted(s);
    expect(r.suspended?.id).toBe(at);
    const resumed = processNavigation(r, 'resumeAll');
    expect(resumed.ok).toBe(true);
    expect(r.current?.id).toBe(at);
  });

  it('is refused, not half-built, when what was kept is not a session', () => {
    const good = JSON.parse(JSON.stringify(sessionToJson(fresh())));
    expect(sessionFromJson(null)).toBeNull();
    expect(sessionFromJson({})).toBeNull();
    expect(sessionFromJson({ ...good, current: 'not-in-the-tree' })).toBeNull();
    expect(sessionFromJson({ ...good, states: [['not-in-the-tree', {}]] })).toBeNull();
    // An activity id twice would make two activities one state.
    const twice = JSON.parse(JSON.stringify(good)); twice.root.children[0].id = twice.root.children[1].id;
    expect(sessionFromJson(twice)).toBeNull();
    // Deeper than any manifest: not walked to the bottom.
    let deep = { id: 'x', title: 'x', sequencing: good.root.sequencing, children: [] as unknown[] };
    for (let i = 0; i < 200; i++) deep = { id: `x${i}`, title: 'x', sequencing: good.root.sequencing, children: [deep] };
    expect(sessionFromJson({ ...good, root: deep, states: [], current: undefined })).toBeNull();
  });

  it('gives an activity the kept states do not mention a fresh state, as a new session would', () => {
    const good = JSON.parse(JSON.stringify(sessionToJson(fresh())));
    const s = sessionFromJson({ ...good, states: [] })!;
    expect(s.states.size).toBe(s.tree.preorder.length);
    expect(processNavigation(s, 'start').ok).toBe(true);
  });
});

describe('the bridge', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = (path: string): string => { const i = src.indexOf(`app.post('${path}'`); return src.slice(i, src.indexOf('\n});', i)); };
  const seq = readFileSync(new URL('../src/scorm-sequencing.ts', import.meta.url), 'utf8');

  it('keeps an attempt before it hands out its session id', () => {
    const launch = route('/agent/scorm/launch');
    const kept = launch.indexOf('await keptScormPlays.put(SCORM_ATTEMPTS, seq.id, playToKeep(launchedPlay))');
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(launch.indexOf('sendActionResult(req, res, { ok: true, sessionId: seq.id'));
    expect(launch).toContain("if (attemptKept === 'failed') { agentScormPlays.delete(seq.id); res.status(503)");
  });

  it('finds an attempt this process does not hold, and refuses one it cannot read', () => {
    const submit = route('/agent/scorm/submit');
    expect(submit).toContain('const play = await scormPlayFor(sessionId);');
    expect(submit).toContain("if (play === 'unreadable') { res.status(503)");
    // Still the launcher's alone, whichever process it was launched in.
    expect(submit.indexOf('if (play.learnerDid !== callerDid)')).toBeLessThan(submit.indexOf('await advanceScormPlay(play, p.answers)'));
  });

  it('keeps where the attempt stands after each step, before it answers', () => {
    const submit = route('/agent/scorm/submit');
    const kept = submit.indexOf('await keptScormPlays.put(SCORM_ATTEMPTS, sessionId, playToKeep(play))');
    expect(kept).toBeGreaterThan(submit.indexOf('await advanceScormPlay(play, p.answers)'));
    expect(kept).toBeLessThan(submit.indexOf('if (!step.ok) { res.status(step.status).json('));
    expect(submit.indexOf('if (!step.ok) { res.status(step.status).json(')).toBeGreaterThan(0);
    // A step the pod did not take is not undone (it was graded, and may be recorded): it is said.
    expect(submit).toContain("if (stepKept === 'failed') stepNotKept =");
    expect(submit).toContain("...(stepNotKept ? { stepNotKept } : {})");
    // The attempt is dropped from this process in one place only: after its outcome is recorded.
    expect(submit.match(/agentScormPlays\.delete\(sessionId\)/g)).toHaveLength(1);
    // Removed once its outcome is in the learner's record, and not before.
    expect(submit.indexOf('keptScormPlays.remove(SCORM_ATTEMPTS, sessionId)')).toBeGreaterThan(submit.indexOf('if (!step.recorded) {'));
  });

  it('collects and restores the engine\'s own sessions with the same two functions', () => {
    expect(seq).toContain('return { sessions: [...sessions].map(([id, s]) => [id, sessionToJson(s)]) };');
    expect(seq).toContain('const s = sessionFromJson(kept);');
    expect(seq).not.toContain('void id; void sJson;');
  });
});
