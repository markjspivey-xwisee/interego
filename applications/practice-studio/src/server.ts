/**
 * HTTP surface. Affordances come from the shared vertical bridge. The player
 * and the studio page are static files beside it, so a practice session is the
 * existing role-play player and the page that frames it.
 */
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { studioAffordances } from '../affordances.js';
import { Studio, type StudioRecord } from './studio.js';

const UI_DIR = new URL('../../../docs/applications/practice-studio/', import.meta.url);
const PLAYER_DIR = new URL('../../../docs/applications/practice-evidence/roleplay-player/', import.meta.url);

export function createStudioApp(studio: Studio = new Studio(), deploymentUrl?: string): Express {
  const app = createVerticalBridge({
    verticalName: 'practice-studio',
    affordances: studioAffordances,
    deploymentUrl,
    handlers: {
      'studio.list_scenarios': async () => studio.listScenarios(),
      'studio.create_scenario': async (args) => studio.createScenario(args),
      'studio.start_session': async (args) => studio.startSession(args),
      'studio.score_attempt': async (args) => studio.scoreAttempt(args),
      'studio.list_progress': async (args) => studio.listProgress(typeof args['learner'] === 'string' ? args['learner'] : ''),
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
    },
  });
  return app;
}

export type { StudioRecord };
