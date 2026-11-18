/**
 * A trajectory step can be Quoted: someone else's claim, repeated and not endorsed. It is kept in
 * the native trajectory under its own status, and it is never projected to xAPI as work the agent
 * performed. Before this status existed the Foxxi projector had to record such a step as Asserted.
 *
 * Every name and identifier is made up.
 */
import { describe, it, expect } from 'vitest';
import { buildStep, buildTrajectory, projectTrajectoryToXapi, trajectoryShape, type TrajectoryStepInput } from '../src/agent-trajectory.js';

const AGENT = 'did:web:example:agents:fictional-agent';
const step = (more: Partial<TrajectoryStepInput>): TrajectoryStepInput => ({
  modalStatus: 'Asserted', granularity: 'tool-call', verb: 'made-up-tool',
  objectId: 'https://example.org/tasks/made-up', objectName: 'A made-up task', ...more,
});

describe('a Quoted trajectory step', () => {
  it('keeps its status on the step and in the descriptor built for it', () => {
    const built = buildStep(AGENT, step({ modalStatus: 'Quoted' }));
    expect(built.modalStatus).toBe('Quoted');
    expect(JSON.stringify(built)).toContain('"modalStatus":"Quoted"');
    expect(JSON.stringify(built)).not.toContain('"modalStatus":"Asserted"');
  });

  it('is counted as Quoted, apart from what the agent did, planned or rejected', () => {
    const t = buildTrajectory(AGENT, 'Fictional Agent', [
      step({}), step({ modalStatus: 'Quoted' }), step({ modalStatus: 'Quoted', granularity: 'task' }),
      step({ modalStatus: 'Hypothetical' }), step({ modalStatus: 'Counterfactual' }),
    ]);
    expect(trajectoryShape(t).byModalStatus).toEqual({ Hypothetical: 1, Asserted: 1, Counterfactual: 1, Quoted: 2 });
  });

  it('is not projected to xAPI as performed work, and is reported among the steps kept natively only', () => {
    const t = buildTrajectory(AGENT, 'Fictional Agent', [step({}), step({ modalStatus: 'Quoted', result: { success: true } })]);
    const projected = projectTrajectoryToXapi(t, { authoritativeSource: 'https://pod.example/fictional-agent/' });
    expect(projected.statements).toHaveLength(1);
    expect(projected.retainedNativeOnly.modalStepsDropped).toBe(1);
  });
});
