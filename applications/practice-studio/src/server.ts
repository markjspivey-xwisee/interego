/**
 * HTTP surface. Affordances come from the shared vertical bridge. The player
 * is the hosted role-play player, opened through a cmi5 launch. Statements
 * the player writes are stored for that launch and read back with Practice
 * Evidence. Creating a scenario, opening a launch and reading progress are
 * signed requests.
 */
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { verifyAgentSignedRequest } from '../../foxxi-content-intelligence/src/auth.js';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { studioAffordances } from '../affordances.js';
import { Studio } from './studio.js';

const UI_DIR = new URL('../../../docs/applications/practice-studio/', import.meta.url);
const PLAYER_DIR = new URL('../../../docs/applications/practice-evidence/roleplay-player/', import.meta.url);

function caller(args: Record<string, unknown>): { ok: true; callerDid: string; payload: Record<string, unknown> } | { ok: false; body: Record<string, unknown> } {
  const signed = verifyAgentSignedRequest(args);
  if (!signed.ok) {
    return { ok: false, body: { kind: 'refusal', 'iep:refusalStatus': 401, error: signed.reason } };
  }
  return signed;
}

function send(res: Response, answered: { status: number; body: unknown }): void {
  if (answered.status === 204) {
    res.status(204).end();
    return;
  }
  res.status(answered.status).json(answered.body);
}

export function createStudioApp(studio: Studio = new Studio(), deploymentUrl?: string, originOf: () => string = () => 'http://127.0.0.1:6120'): Express {
  const app = createVerticalBridge({
    verticalName: 'practice-studio',
    affordances: studioAffordances,
    deploymentUrl,
    handlers: {
      'studio.list_scenarios': async () => studio.listScenarios(),
      'studio.create_scenario': async (args) => {
        const who = caller(args);
        if (!who.ok) return who.body;
        return studio.createScenario(who.payload, who.callerDid);
      },
      'studio.start_session': async (args) => {
        const who = caller(args);
        if (!who.ok) return who.body;
        return studio.startSession(who.payload, who.callerDid, originOf());
      },
      'studio.list_progress': async (args) => {
        const who = caller(args);
        if (!who.ok) return who.body;
        const registration = typeof who.payload['registration'] === 'string' ? who.payload['registration'] : '';
        return studio.readProgress(who.callerDid, registration);
      },
    },
    middleware: (mounted) => {
      mounted.get('/ui', (_req, res) => { res.redirect(302, '/ui/'); });
      mounted.use('/ui', express.static(fileURLToPath(UI_DIR)));
      mounted.use('/player', express.static(fileURLToPath(PLAYER_DIR)));
      mounted.get('/studio/scenarios/:key/document', (req, res) => {
        const doc = studio.scenario(req.params['key'] ?? '');
        if (!doc) {
          res.status(404).json({ kind: 'refusal', 'iep:refusalStatus': 404, error: 'no such scenario' });
          return;
        }
        res.json(doc);
      });
      mounted.get('/studio/snapshots/:id', (req, res) => {
        const doc = studio.snapshot(req.params['id'] ?? '');
        if (!doc) {
          res.status(404).json({ kind: 'refusal', 'iep:refusalStatus': 404, error: 'no such launch' });
          return;
        }
        res.json(doc);
      });
      mounted.post('/cmi5/fetch/:token', (req, res) => {
        send(res, studio.launches.redeem(req.params['token'] ?? ''));
      });
      mounted.get('/cmi5/reviewed', (_req, res) => {
        res.status(409).json({ error: 'registration_not_under_review' });
      });
      mounted.get('/xapi/activities/state', (req: Request, res: Response) => {
        const registration = typeof req.query['registration'] === 'string' ? req.query['registration'] : '';
        send(res, studio.launches.state(req.get('authorization'), registration));
      });
      mounted.post('/xapi/statements', (req, res) => {
        send(res, studio.launches.acceptStatement(req.get('authorization'), req.body));
      });
      mounted.get('/xapi/statements', (req, res) => {
        const registration = typeof req.query['registration'] === 'string' ? req.query['registration'] : '';
        const statementId = typeof req.query['statementId'] === 'string' ? req.query['statementId'] : null;
        send(res, studio.launches.listStatements(req.get('authorization'), registration, statementId));
      });
    },
  });
  return app;
}
