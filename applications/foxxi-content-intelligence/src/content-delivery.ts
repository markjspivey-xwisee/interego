/**
 * Foxxi content delivery — publishing generated content into the live
 * LMS / CMS, and serving the runnable artifacts.
 *
 * This closes the loop. The Performance & Knowledge Architecture
 * composes a Course; `content-package.ts` turns it into a cmi5 package +
 * a SCORM `.zip`; this module:
 *
 *   · POST /content/publish-course  — generates the package, registers
 *     the course structure on the cmi5 LMS (so it is launchable +
 *     trackable + rolls up), and stores the runnable artifacts.
 *   · GET  /content/au/:pub/:idx    — serves a runnable cmi5 AU (the
 *     lesson HTML the learner actually completes).
 *   · GET  /content/package/:pub/cmi5.xml | scorm.zip — the artifacts.
 *   · POST /content/job-aid         — publishes an in-the-flow job aid.
 *   · GET  /content/job-aid/:id     — serves it; a view by a learner is
 *     instrumented straight into the LRS as an xAPI `experienced`
 *     statement.
 *
 * A published cmi5 course is launched through the EXISTING cmi5 LMS
 * surface (`GET /cmi5/launch`) — this module only generates the package
 * and registers it; launch, moveOn, satisfaction rollup and the LRS are
 * already wired.
 *
 * Layer: L3 vertical. Composes the substrate; no L1/L2/L3 ontology change.
 */

import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { DEFAULT_TENANT, tenantIdOf, type TenantId } from './tenant-context.js';
import { registerCmi5Course } from './cmi5-lms.js';
import { parseCmi5Course } from './cmi5-course.js';
import type { Course } from './emergent-content.js';
import {
  flattenCourse, generateCmi5Xml, generateAuHtml, generateScormZip, auLessonView,
} from './content-package.js';
import {
  renderForChannel, DELIVERY_CHANNELS, type ContentUnit, type DeliveryChannel,
} from './content-channels.js';
import {
  deliverThroughChannel, type ChannelWebhook, type TransportResult,
} from './content-transport.js';

const EXPERIENCED = 'http://adlnet.gov/expapi/verbs/experienced';

export interface ContentDeliveryConfig {
  selfBaseUrl: string;
  /** The authoritative source — the xAPI Agent account homePage. */
  authoritativeSource: string;
  /** Persist a statement into the tenant LRS (wired to the bridge's
   *  internal statement store). When absent, job-aid views are not
   *  instrumented. */
  emitStatement?: (statement: Record<string, unknown>, tenant: TenantId) => void;
  /** Channel transport — when set, `POST /content/deliver` actually
   *  sends: a per-channel webhook, or the Interego-native pod-descriptor
   *  publish. Absent → the rendering is produced + recorded, not sent. */
  transport?: {
    webhooks?: Partial<Record<DeliveryChannel, ChannelWebhook>>;
    podUrl?: string;
  };
}

interface PublishedCourse {
  publishId: string;
  courseId: string;
  title: string;
  tenant: TenantId;
  cmi5Xml: string;
  scormZip: Buffer;
  /** The source emergent Course — retained so the Context Companion can
   *  ground answers in its fragments with full provenance. */
  course: Course;
  /** Runnable AUs, in course order. */
  aus: Array<{ index: number; lessonId: string; title: string; competency: string; html: string; blocks: Array<{ label: string; text: string }> }>;
}

interface PublishedJobAid {
  id: string;
  competencyPoint: string;
  body: string;
  triggerContext: string;
  html: string;
  tenant: TenantId;
}

const published = new Map<string, PublishedCourse>();
const jobAids = new Map<string, PublishedJobAid>();

function jobAidHtml(aid: { competencyPoint: string; body: string; triggerContext: string }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Job aid — ${esc(aid.competencyPoint)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px;line-height:1.55;color:#15151f}
.tag{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#1a73e8}
.ctx{font-size:12px;color:#778;margin-bottom:10px}.body{border:1px solid #e3e3ee;border-radius:8px;padding:14px 16px;white-space:pre-wrap}</style>
</head><body>
<div class="tag">in-the-flow performance support</div>
<h2 style="margin:4px 0">${esc(aid.competencyPoint)}</h2>
<div class="ctx">surfaced when: ${esc(aid.triggerContext)}</div>
<div class="body">${esc(aid.body)}</div>
</body></html>`;
}

/** Attach the content-delivery routes. */
export function attachContentDeliveryRoutes(app: Express, config: ContentDeliveryConfig): void {
  const base = config.selfBaseUrl.replace(/\/+$/, '');

  // ── POST /content/publish-course — generate + register + store. ───
  app.post('/content/publish-course', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const course = body.course as Course | undefined;
    if (!course || typeof course !== 'object' || !Array.isArray(course.syntagm)) {
      res.status(400).json({ error: 'a "course" object (from POST /content/compose-course) is required' });
      return;
    }
    const tenant = tenantIdOf(req.query.tenant_pod_url as string | undefined);
    const publishId = `pub-${randomUUID().slice(0, 12)}`;
    const flat = flattenCourse(course);
    if (flat.length === 0) { res.status(400).json({ error: 'the course has no lessons to publish' }); return; }

    // The AU url for lesson index i.
    const lessonIndex = new Map(flat.map((fl, i) => [fl.lesson.id, i]));
    const auUrl = (lessonId: string) => `${base}/content/au/${publishId}/${lessonIndex.get(lessonId) ?? 0}`;

    let cmi5Xml: string;
    try { cmi5Xml = generateCmi5Xml(course, auUrl); }
    catch (e) { res.status(500).json({ error: `cmi5 generation failed: ${(e as Error).message}` }); return; }

    // Parse it back (validates the generated XML round-trips) and register.
    try {
      const parsed = parseCmi5Course(cmi5Xml);
      registerCmi5Course(tenant, parsed);
    } catch (e) {
      res.status(500).json({ error: `course registration failed: ${(e as Error).message}` });
      return;
    }

    let scormZip: Buffer;
    try { scormZip = generateScormZip(course); }
    catch (e) { res.status(500).json({ error: `SCORM package generation failed: ${(e as Error).message}` }); return; }

    const aus = flat.map((fl, i) => ({
      index: i, lessonId: fl.lesson.id, title: fl.lesson.title, competency: fl.lesson.competency,
      html: generateAuHtml(course.title, auLessonView(fl)),
      blocks: fl.fragments.map(f => ({ label: f.modality, text: f.body })),
    }));
    published.set(publishId, { publishId, courseId: course.id, title: course.title, tenant, cmi5Xml, scormZip, course, aus });

    res.json({
      published: true,
      publishId,
      courseId: course.id,
      title: course.title,
      lms: 'registered on the cmi5 LMS — launchable, trackable, with moveOn + satisfaction rollup',
      aus: aus.map(a => ({ auId: a.lessonId, index: a.index, title: a.title, auUrl: auUrl(a.lessonId) })),
      artifacts: {
        cmi5Xml: `${base}/content/package/${publishId}/cmi5.xml`,
        scormZip: `${base}/content/package/${publishId}/scorm.zip`,
      },
      launch: `GET ${base}/cmi5/launch?course_id=${encodeURIComponent(course.id)}&au_id=<auId>&learner=<learner_did>`,
      note: 'The course is live on the LMS. Launch an AU via /cmi5/launch — the AU runs, emits cmi5 xAPI to the LRS, moveOn auto-evaluates, and satisfaction rolls up.',
    });
  });

  // ── GET /content/au/:pub/:idx — the runnable cmi5 AU. ─────────────
  app.get('/content/au/:pub/:idx', (req: Request, res: Response) => {
    const pub = published.get(String(req.params.pub ?? ''));
    const au = pub?.aus[Number(req.params.idx)];
    if (!au) { res.status(404).type('html').send('<p>No such Assignable Unit.</p>'); return; }
    res.type('html').send(au.html);
  });

  // ── GET /content/package/:pub/cmi5.xml | scorm.zip — artifacts. ──
  app.get('/content/package/:pub/cmi5.xml', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const pub = published.get(String(req.params.pub ?? ''));
    if (!pub) { res.status(404).json({ error: 'no such published course' }); return; }
    res.type('application/xml').send(pub.cmi5Xml);
  });
  app.get('/content/package/:pub/scorm.zip', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const pub = published.get(String(req.params.pub ?? ''));
    if (!pub) { res.status(404).json({ error: 'no such published course' }); return; }
    res.type('application/zip')
      .setHeader('Content-Disposition', `attachment; filename="${pub.publishId}-scorm.zip"`);
    res.send(pub.scormZip);
  });

  // ── POST /content/job-aid — publish an in-the-flow job aid. ───────
  app.post('/content/job-aid', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.competencyPoint !== 'string' || typeof b.body !== 'string' || !b.body) {
      res.status(400).json({ error: 'competencyPoint and body (strings) are required' });
      return;
    }
    const tenant = tenantIdOf(req.query.tenant_pod_url as string | undefined);
    const id = `aid-${randomUUID().slice(0, 12)}`;
    const aid: PublishedJobAid = {
      id,
      competencyPoint: b.competencyPoint,
      body: b.body,
      triggerContext: typeof b.triggerContext === 'string' ? b.triggerContext : 'the point of work',
      tenant,
      html: jobAidHtml({ competencyPoint: b.competencyPoint, body: b.body, triggerContext: typeof b.triggerContext === 'string' ? b.triggerContext : 'the point of work' }),
    };
    jobAids.set(id, aid);
    res.json({
      published: true, id,
      url: `${base}/content/job-aid/${id}`,
      note: 'Performance support is live. A learner view (?learner=<did>) is instrumented into the LRS as an xAPI `experienced` statement.',
    });
  });

  // ── GET /content/job-aid/:id — serve + instrument with xAPI. ──────
  app.get('/content/job-aid/:id', (req: Request, res: Response) => {
    const aid = jobAids.get(String(req.params.id ?? ''));
    if (!aid) { res.status(404).type('html').send('<p>No such job aid.</p>'); return; }
    const learner = req.query.learner as string | undefined;
    if (learner && config.emitStatement) {
      config.emitStatement({
        actor: { objectType: 'Agent', account: { homePage: config.authoritativeSource, name: learner } },
        verb: { id: EXPERIENCED, display: { 'en-US': 'experienced' } },
        object: {
          objectType: 'Activity',
          id: `${base}/content/job-aid/${aid.id}`,
          definition: {
            name: { 'en-US': `Job aid — ${aid.competencyPoint}` },
            type: 'http://adlnet.gov/expapi/activities/performance',
          },
        },
        context: { extensions: { [`${base}/ns/foxxi#contextKind`]: 'performance-support' } },
        timestamp: new Date().toISOString(),
      }, aid.tenant);
    }
    res.type('html').send(aid.html);
  });

  // ── POST /content/deliver — render content for a text channel. ────
  // The content is text; it travels through the channels work actually
  // uses — a chat message, an email, an SMS, a document — not only as a
  // launched LMS page. Each delivery is instrumented into the LRS.
  app.post('/content/deliver', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    void (async () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const channel = b.channel as DeliveryChannel | undefined;
    if (!channel || !DELIVERY_CHANNELS.includes(channel)) {
      res.status(400).json({ error: `channel must be one of: ${DELIVERY_CHANNELS.join(', ')}` });
      return;
    }

    // Resolve the content unit — an explicit unit, a published job aid,
    // or a lesson of a published course.
    let unit: ContentUnit | undefined;
    let tenant: TenantId = tenantIdOf(req.query.tenant_pod_url as string | undefined);
    let objectId = `${base}/content/delivered`;
    if (typeof b.jobAidId === 'string') {
      const aid = jobAids.get(b.jobAidId);
      if (!aid) { res.status(404).json({ error: 'no such job aid' }); return; }
      unit = { title: `Job aid — ${aid.competencyPoint}`, kind: 'job-aid', competency: aid.competencyPoint,
        blocks: [{ text: aid.body }], link: `${base}/content/job-aid/${aid.id}` };
      tenant = aid.tenant;
      objectId = `${base}/content/job-aid/${aid.id}`;
    } else if (typeof b.publishId === 'string') {
      const pub = published.get(b.publishId);
      const au = pub?.aus[Number(b.auIndex ?? 0)];
      if (!pub || !au) { res.status(404).json({ error: 'no such published course / AU' }); return; }
      unit = { title: au.title, kind: 'lesson', competency: au.competency, blocks: au.blocks,
        link: `${base}/content/au/${pub.publishId}/${au.index}` };
      tenant = pub.tenant;
      objectId = au.lessonId;
    } else if (b.unit && typeof b.unit === 'object') {
      const u = b.unit as Record<string, unknown>;
      if (typeof u.title !== 'string' || !Array.isArray(u.blocks)) {
        res.status(400).json({ error: 'unit must be { title, kind, blocks: [{ text }] }' }); return;
      }
      unit = {
        title: u.title, kind: (u.kind as ContentUnit['kind']) ?? 'reference',
        ...(typeof u.competency === 'string' ? { competency: u.competency } : {}),
        blocks: (u.blocks as Array<Record<string, unknown>>).map(x => ({
          ...(typeof x.label === 'string' ? { label: x.label } : {}), text: String(x.text ?? ''),
        })),
        ...(typeof u.link === 'string' ? { link: u.link } : {}),
      };
    } else {
      res.status(400).json({ error: 'supply one of: jobAidId, { publishId, auIndex }, or an explicit unit' });
      return;
    }

    const rendering = renderForChannel(unit, channel);
    const learner = b.learner as string | undefined;
    const recipient = typeof b.recipient === 'string' ? b.recipient : undefined;

    // Actually deliver it — a configured webhook send, or the Interego-
    // native pod-descriptor publish, or an honest recorded-only no-op.
    let transport: TransportResult = { mode: 'none', sent: false, detail: 'transport not wired on this bridge' };
    if (config.transport) {
      try {
        transport = await deliverThroughChannel({
          channel, rendering, title: unit.title, recipient,
          config: {
            selfBaseUrl: base,
            authoritativeSource: config.authoritativeSource,
            ...config.transport,
          },
        });
      } catch (e) {
        transport = { mode: 'none', sent: false, detail: `transport error: ${(e as Error).message}` };
      }
    }

    let instrumented = false;
    if (learner && config.emitStatement) {
      config.emitStatement({
        actor: { objectType: 'Agent', account: { homePage: config.authoritativeSource, name: learner } },
        verb: { id: EXPERIENCED, display: { 'en-US': 'experienced' } },
        object: {
          objectType: 'Activity', id: objectId,
          definition: { name: { 'en-US': unit.title }, type: 'http://adlnet.gov/expapi/activities/performance' },
        },
        context: {
          extensions: {
            [`${base}/ns/foxxi#deliveryChannel`]: channel,
            [`${base}/ns/foxxi#deliveredVia`]: transport.mode,
            ...(recipient ? { [`${base}/ns/foxxi#recipient`]: recipient } : {}),
            ...(transport.artifactUrl ? { [`${base}/ns/foxxi#substrateDescriptorIri`]: transport.artifactUrl } : {}),
          },
        },
        timestamp: new Date().toISOString(),
      }, tenant);
      instrumented = true;
    }
    res.json({
      delivered: true, channel, rendering, instrumented, transport,
      note: transport.sent
        ? `Rendered for ${channel}; ${transport.detail}; recorded in the LRS.`
        : instrumented
          ? `Rendered for ${channel} and recorded in the LRS. ${transport.detail}.`
          : `Rendered for ${channel}. ${transport.detail}. Pass a learner DID to instrument the delivery.`,
    });
    })().catch((e: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
    });
  });
}

/** Test/inspection helper — the live published-course registry. */
export function _publishedCourses(): Map<string, PublishedCourse> { return published; }
/** Test/inspection helper — the live published job-aid registry. */
export function _publishedJobAids(): Map<string, PublishedJobAid> { return jobAids; }
void DEFAULT_TENANT;
