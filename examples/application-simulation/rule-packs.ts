/** L3 domain fixtures. Builders emit only signed-domain/v1 JSON, never callbacks. */
import {
  SIGNED_DOMAIN_RUNTIME, type ApplicationAction, type ApplicationContract, type Json,
} from '../../integrations/application-runtime/application-lab-runtime.js';

export interface RulePack {
  readonly contract: ApplicationContract;
  readonly initialData: Record<string, Json>;
}

const all = (...guards: Json[]): Json => ({ op: 'all', guards });
const eq = (left: Json, right: Json): Json => ({ op: 'eq', left, right });
const not = (guard: Json): Json => ({ op: 'not', guard });
const exists = (path: string, where: Json): Json => ({ op: 'exists', path, where });
const action = (id: string, local: string, fields: Omit<ApplicationAction, 'actionIri'>): ApplicationAction => ({
  actionIri: `${id}:${local}`, method: 'POST', target: SIGNED_DOMAIN_RUNTIME, ...fields,
});
const contract = (applicationId: string, actions: ApplicationAction[]): ApplicationContract => ({
  schema: 'interego.application.contract/v1', version: '1.0.0', applicationId, runtimeIri: SIGNED_DOMAIN_RUNTIME, actions,
});

export function ticTacToe(): RulePack {
  const id = 'urn:example:simulation:tic-tac-toe';
  const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  const wins = (mark: string): Json => ({ op: 'any', guards: lines.map(line => all(
    ...line.map(position => exists('$state.cells', all(eq('$item.position', position), eq('$item.mark', mark)))),
  )) });
  const playing = eq('$state.status', 'playing');
  const noWinner = all(not(wins('X')), not(wins('O')));
  const actions = ['X', 'O'].map(mark => action(id, `place-${mark}`, {
    label: `Place ${mark}`, inputs: [{ name: 'cell', type: 'number', required: true, options: Array.from({ length: 9 }, (_, i) => i) }],
    guard: all(playing, noWinner, eq('$state.nextMark', mark),
      exists('$state.cells', all(eq('$item.position', '$payload.cell'), eq('$item.mark', '')))),
    effects: [
      { op: 'updateAllWhere', path: '$state.cells', where: { itemPath: 'position', eq: '$payload.cell' }, set: { mark } },
      { op: 'set', path: '$state.nextMark', value: mark === 'X' ? 'O' : 'X' },
    ],
  }));
  actions.push(action(id, 'declare-winner', {
    label: 'Declare winner', inputs: [{ name: 'player', type: 'string', required: true, options: ['X', 'O'] }],
    guard: all(playing, wins('$payload.player')),
    effects: [{ op: 'set', path: '$state.status', value: 'finished' }, { op: 'set', path: '$state.winner', value: '$payload.player' }],
  }), action(id, 'declare-draw', {
    label: 'Declare draw', guard: all(playing, noWinner, not(exists('$state.cells', eq('$item.mark', '')))),
    effects: [{ op: 'set', path: '$state.status', value: 'draw' }],
  }));
  return { contract: contract(id, actions), initialData: {
    cells: Array.from({ length: 9 }, (_, position) => ({ position, mark: '' })), nextMark: 'X', status: 'playing', winner: null,
  } };
}

export function releaseControl(): RulePack {
  const id = 'urn:example:simulation:release-control';
  const reviewing = eq('$state.status', 'review');
  return { contract: contract(id, [
    action(id, 'approve', {
      label: 'Approve release', guard: all(reviewing, not(exists('$state.approvals', eq('$item.approver', '$actor')))),
      effects: [{ op: 'appendUnique', path: '$state.approvals', by: 'approver', value: { approver: '$actor', at: '$now' } }],
    }),
    action(id, 'deploy', {
      label: 'Record deployment', guard: all(reviewing, eq('$state.releaseReady', true), eq('$state.deployed', false),
        { op: 'countDistinct', path: '$state.approvals', itemPath: 'approver', gte: 2 }),
      effects: [{ op: 'set', path: '$state.status', value: 'deployed' }, { op: 'set', path: '$state.deployed', value: true },
        { op: 'set', path: '$state.deployedBy', value: '$actor' }, { op: 'set', path: '$state.deployedAt', value: '$now' }],
    }),
    action(id, 'cancel', {
      label: 'Cancel release', inputs: [{ name: 'reason', type: 'string', required: true }], guard: reviewing,
      effects: [{ op: 'set', path: '$state.status', value: 'cancelled' }, { op: 'set', path: '$state.reason', value: '$payload.reason' }],
    }),
  ]), initialData: { status: 'review', releaseReady: true, deployed: false, approvals: [] } };
}
