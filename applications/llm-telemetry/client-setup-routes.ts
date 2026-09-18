import type { Express, Request, Response } from 'express';
import { nativeIntegrations } from './native-integrations.js';
import { telemetryPluginPackage } from './plugin-package.js';
import { telemetryClientSetup } from './client-setup.js';
import { clientSetupView } from './view.js';

/** Read-only setup on the existing application authority; no credentials or settings are written. */
export function mountTelemetryClientSetup(app: Express, base: string) {
  const handle = (download: boolean, markdown: boolean) => (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const input: unknown = req.method === 'POST' ? req.body : req.query;
      // The existing bridge enriches POST bodies with transport metadata. Neither
      // field is setup input; never reflect an injected caller token in the result.
      const options = req.method === 'POST' && input && typeof input === 'object' && !Array.isArray(input)
        ? Object.fromEntries(Object.entries(input).filter(([key]) => !['__client_ip', '__caller_token'].includes(key)))
        : input;
      const setup = telemetryClientSetup(options);
      if (download) {
        if (!setup.configuration) { res.status(409).json({ ok: false, status: setup.status, error: 'Configuration requires a supported client and its existing MCP connection name.' }); return; }
        res.setHeader('Content-Disposition', `attachment; filename="interego-${setup.client}-hooks.json"`);
        res.type('application/json').send(JSON.stringify(setup.configuration, null, 2) + '\n');
        return;
      }
      const view = clientSetupView(base, setup);
      if (markdown) res.type('text/markdown').send(view.hmd);
      else res.json({ ...setup, view });
    } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Invalid setup request' }); }
  };
  app.get('/llm-telemetry/native-integrations', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(nativeIntegrations(base)); });
  app.get('/llm-telemetry/setup/plugin', (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try { const setup = telemetryClientSetup(req.query); const archive = telemetryPluginPackage(setup);
      res.setHeader('Content-Disposition', 'attachment; filename="interego-activity.zip"'); res.type('application/zip').send(archive);
    } catch { res.status(400).json({ error: 'Select a supported host and exact existing MCP connection name' }); }
  });
  app.get('/llm-telemetry/setup', handle(false, true));
  app.get('/llm-telemetry/setup/config', handle(true, false));
  app.post('/agent/llm-telemetry/client-setup', handle(false, false));
}
