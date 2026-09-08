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
import type { IRI } from '@interego/core';
import type { Express, Request, Response } from 'express';
import { DEFAULT_TENANT, type TenantId } from './tenant-context.js';
import { trustedTenantOf, type OperatorAuthConfig } from './operator-auth.js';
import { registerCmi5Course } from './cmi5-lms.js';
import { parseCmi5Course } from './cmi5-course.js';
import { sendServerError } from './http-errors.js';
import type { Course } from './emergent-content.js';
import {
  flattenCourse, generateCmi5Xml, generateAuHtml, generateScormZip, auLessonView,
} from './content-package.js';
import {
  renderForChannel, DELIVERY_CHANNELS, type ContentUnit, type DeliveryChannel,
} from './content-channels.js';
import { CONTENT_FORMS, type ContentForm } from './content-forms.js';
import { PodKeyValueStore } from './pod-kv-store.js';
import {
  deliverThroughChannel, type ChannelWebhook, type TransportResult,
} from './content-transport.js';

const EXPERIENCED = 'http://adlnet.gov/expapi/verbs/experienced';

export interface ContentDeliveryConfig extends OperatorAuthConfig {
  publicationStore?: ContentPublicationStore;
  selfBaseUrl: string;
  /** The authoritative source — the xAPI Agent account homePage. */
  authoritativeSource: string;
  /** Persist a statement into the tenant LRS (wired to the bridge's
   *  internal statement store). When absent, job-aid views are not
   *  instrumented. */
  emitStatement?: (statement: Record<string, unknown>, tenant: TenantId) => void;
  /** Authorize instrumenting an xAPI statement attributed to `learner`.
   *  MUST return false for an anonymous caller — otherwise anyone can inject
   *  an LRS record attributed to any agent identity (attribution forgery that
   *  can poison proficiency rollups). Returns true only for a verified
   *  operator or a signer who proved control of the learner DID. When absent,
   *  no delivery is instrumented (fail-closed). */
  authorizeInstrumentation?: (req: Request, learner: string) => boolean;
  /** Channel transport — when set, `POST /content/deliver` actually
   *  sends: a per-channel webhook, or the Interego-native pod-descriptor
   *  publish. Absent → rendering only; no delivery or experience is claimed. */
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

export type ContentPublicationSource =
  | { kind: 'course'; publishId: string; tenant: TenantId; base: string; course: Course }
  | { kind: 'job-aid'; aid: PublishedJobAid };
export interface ContentPublicationStore {
  get(key: string): Promise<ContentPublicationSource | null>;
  put(key: string, source: ContentPublicationSource): Promise<{ descriptorUrl?: string }>;
}
let activePublicationStore: ContentPublicationStore | undefined;
function defaultPublicationStore(): ContentPublicationStore | undefined {
  const podUrl = process.env.FOXXI_TENANT_POD_URL;
  const owner = process.env.FOXXI_AUTHORITATIVE_SOURCE;
  if (!podUrl || !owner) return undefined;
  return new PodKeyValueStore<ContentPublicationSource>({ podUrl, authoritativeSource: owner as IRI,
    typeIri: 'https://schema.org/CreativeWork' as IRI, containerPath: 'foxxi/published-content/',
    iriPrefix: 'urn:foxxi:published-content:', strictReads: true });
}
const coursePublicationKey = (tenant: TenantId, courseId: string): string => JSON.stringify([tenant, courseId]);

/** Rehydrate both artifacts and the LMS registration from the persisted source. */
function restorePublication(source: ContentPublicationSource): void {
  if (source.kind === 'job-aid') { retainInMap(jobAids, source.aid.id, source.aid); return; }
  const { course, publishId, tenant, base } = source;
  const flat = flattenCourse(course);
  const scormZip = generateScormZip(course);
  const indices = new Map(flat.map((fl, i) => [fl.lesson.id, i]));
  const cmi5Xml = generateCmi5Xml(course, id => `${base}/content/au/${publishId}/${indices.get(id)}`);
  const parsed = parseCmi5Course(cmi5Xml);
  const aus = flat.map((fl, index) => ({ index, lessonId: fl.lesson.id, title: fl.lesson.title,
    competency: fl.lesson.competency, html: generateAuHtml(course.title, auLessonView(fl)),
    blocks: fl.fragments.map(f => ({ label: f.modality, text: f.body })) }));
  retainInMap(published, publishId, { publishId, courseId: course.id, title: course.title, tenant, course, cmi5Xml, scormZip, aus });
  registerCmi5Course(tenant, parsed);
}
export async function restorePublishedCourse(tenant: TenantId, courseId: string): Promise<void> {
  const source = await activePublicationStore?.get(coursePublicationKey(tenant, courseId));
  if (source?.kind === 'course' && source.tenant === tenant && source.course.id === courseId) restorePublication(source);
}
async function readPublishedCourse(id: string, store?: ContentPublicationStore): Promise<PublishedCourse | undefined> {
  if (!published.has(id)) { const source = await store?.get(id); if (source?.kind === 'course' && source.publishId === id) restorePublication(source); }
  return published.get(id);
}
async function readPublishedAid(id: string, store?: ContentPublicationStore): Promise<PublishedJobAid | undefined> {
  if (!jobAids.has(id)) { const source = await store?.get(id); if (source?.kind === 'job-aid' && source.aid.id === id) restorePublication(source); }
  return jobAids.get(id);
}
const contentRead = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response): void => {
  void handler(req, res).catch(error => { if (!res.headersSent) { console.error('[published-content]', error); res.status(503).json({ error: 'Published content storage is unavailable.' }); } });
};

const published = new Map<string, PublishedCourse>();
const jobAids = new Map<string, PublishedJobAid>();
// BOUNDED: publish-course / publish-job-aid are unauthenticated and each stores a full package
// (cmi5 XML + SCORM zip), so cap the stores and evict the oldest — otherwise an attacker exhausts
// memory. A real catalog is small.
const CONTENT_STORE_MAX = 2000;
function retainInMap<V>(m: Map<string, V>, id: string, v: V): void {
  while (m.size >= CONTENT_STORE_MAX) { const oldest = m.keys().next().value; if (oldest === undefined) break; m.delete(oldest); }
  m.set(id, v);
}

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
  const store = config.publicationStore ?? defaultPublicationStore();
  activePublicationStore = store;

  // ── POST /content/publish-course — generate + register + store. ───
  app.post('/content/publish-course', contentRead(async (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const course = body.course as Course | undefined;
    if (!course || typeof course !== 'object' || !Array.isArray(course.syntagm)) {
      res.status(400).json({ error: 'a "course" object (from POST /content/compose-course) is required' });
      return;
    }
    // trustedTenantOf pins an anonymous caller to DEFAULT_TENANT — a raw
    // ?tenant_pod_url let an unauthenticated caller register a course into
    // ANY named tenant's registry (cross-tenant write). Only a verified
    // operator may target another tenant.
    const tenant = trustedTenantOf(req, config);
    const publishId = `pub-${randomUUID().slice(0, 12)}`;
    const flat = flattenCourse(course);
    if (flat.length === 0) { res.status(400).json({ error: 'the course has no lessons to publish' }); return; }

    // The AU url for lesson index i.
    const lessonIndex = new Map(flat.map((fl, i) => [fl.lesson.id, i]));
    const auUrl = (lessonId: string) => `${base}/content/au/${publishId}/${lessonIndex.get(lessonId) ?? 0}`;

    let cmi5Xml: string;
    try { cmi5Xml = generateCmi5Xml(course, auUrl); }
    catch (e) { sendServerError(res, e, 'cmi5-generation'); return; }

    // Parse it back (validates the generated XML round-trips) and register.
    try {
      const parsed = parseCmi5Course(cmi5Xml);
      // Registration follows successful artifact creation and persistence.
      void parsed;
    } catch (e) {
      sendServerError(res, e, 'cmi5-course-registration');
      return;
    }

    let scormZip: Buffer;
    try { scormZip = generateScormZip(course); }
    catch (e) { sendServerError(res, e, 'scorm-package-generation'); return; }

    const aus = flat.map((fl, i) => ({
      index: i, lessonId: fl.lesson.id, title: fl.lesson.title, competency: fl.lesson.competency,
      html: generateAuHtml(course.title, auLessonView(fl)),
      blocks: fl.fragments.map(f => ({ label: f.modality, text: f.body })),
    }));
    const source: ContentPublicationSource = { kind: 'course', publishId, tenant, base, course };
    const receipt = await store?.put(publishId, source);
    if (store) await store.put(coursePublicationKey(tenant, course.id), source);
    registerCmi5Course(tenant, parseCmi5Course(cmi5Xml));
    retainInMap(published, publishId, { publishId, courseId: course.id, title: course.title, tenant, cmi5Xml, scormZip, course, aus });

    res.json({
      published: true, persisted: !!store, storage: store ? 'pod' : 'process',
      ...(receipt?.descriptorUrl ? { descriptorUrl: receipt.descriptorUrl } : {}),
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
  }));

  // ── GET /content/au/:pub/:idx — the runnable cmi5 AU. ─────────────
  app.get('/content/au/:pub/:idx', contentRead(async (req: Request, res: Response) => {
    const pub = await readPublishedCourse(String(req.params.pub ?? ''), store);
    const au = pub?.aus[Number(req.params.idx)];
    if (!au) { res.status(404).type('html').send('<p>No such Assignable Unit.</p>'); return; }
    res.type('html').send(au.html);
  }));

  // ── GET /content/package/:pub/cmi5.xml | scorm.zip — artifacts. ──
  app.get('/content/package/:pub/cmi5.xml', contentRead(async (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const pub = await readPublishedCourse(String(req.params.pub ?? ''), store);
    if (!pub) { res.status(404).json({ error: 'no such published course' }); return; }
    res.type('application/xml').send(pub.cmi5Xml);
  }));
  app.get('/content/package/:pub/scorm.zip', contentRead(async (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const pub = await readPublishedCourse(String(req.params.pub ?? ''), store);
    if (!pub) { res.status(404).json({ error: 'no such published course' }); return; }
    res.type('application/zip')
      .setHeader('Content-Disposition', `attachment; filename="${pub.publishId}-scorm.zip"`);
    res.send(pub.scormZip);
  }));

  // ── POST /content/job-aid — publish an in-the-flow job aid. ───────
  app.post('/content/job-aid', contentRead(async (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.competencyPoint !== 'string' || typeof b.body !== 'string' || !b.body) {
      res.status(400).json({ error: 'competencyPoint and body (strings) are required' });
      return;
    }
    // Pin an anonymous caller to DEFAULT_TENANT (no cross-tenant write).
    const tenant = trustedTenantOf(req, config);
    const id = `aid-${randomUUID().slice(0, 12)}`;
    const aid: PublishedJobAid = {
      id,
      competencyPoint: b.competencyPoint,
      body: b.body,
      triggerContext: typeof b.triggerContext === 'string' ? b.triggerContext : 'the point of work',
      tenant,
      html: jobAidHtml({ competencyPoint: b.competencyPoint, body: b.body, triggerContext: typeof b.triggerContext === 'string' ? b.triggerContext : 'the point of work' }),
    };
    const receipt = await store?.put(id, { kind: 'job-aid', aid });
    retainInMap(jobAids, id, aid);
    res.json({
      published: true, persisted: !!store, storage: store ? 'pod' : 'process', id,
      ...(receipt?.descriptorUrl ? { descriptorUrl: receipt.descriptorUrl } : {}),
      url: `${base}/content/job-aid/${id}`,
      note: 'Performance support is available at the advertised URL. A learner view is recorded only when the caller proves authority for that learner.',
    });
  }));

  // ── GET /content/job-aid/:id — serve + instrument with xAPI. ──────
  app.get('/content/job-aid/:id', contentRead(async (req: Request, res: Response) => {
    const aid = await readPublishedAid(String(req.params.id ?? ''), store);
    if (!aid) { res.status(404).type('html').send('<p>No such job aid.</p>'); return; }
    const learner = req.query.learner as string | undefined;
    // Only instrument (write an LRS statement attributed to `learner`) when
    // the caller is authorized to speak for that learner — otherwise an
    // anonymous ?learner=<victim> forges attribution into the LRS. Unauthorized
    // callers still get the job-aid HTML; the view just isn't recorded.
    if (learner && config.emitStatement && (config.authorizeInstrumentation?.(req, learner) ?? false)) {
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
  }));

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
    // Pin an anonymous caller to DEFAULT_TENANT (no cross-tenant write); a
    // jobAidId/publishId path below overrides with the artifact's own tenant.
    let tenant: TenantId = trustedTenantOf(req, config);
    let objectId = `${base}/content/delivered`;
    if (typeof b.jobAidId === 'string') {
      const aid = await readPublishedAid(b.jobAidId, store);
      if (!aid) { res.status(404).json({ error: 'no such job aid' }); return; }
      unit = { title: `Job aid — ${aid.competencyPoint}`, kind: 'job-aid', competency: aid.competencyPoint,
        blocks: [{ text: aid.body }], link: `${base}/content/job-aid/${aid.id}` };
      tenant = aid.tenant;
      objectId = `${base}/content/job-aid/${aid.id}`;
    } else if (typeof b.publishId === 'string') {
      const pub = await readPublishedCourse(b.publishId, store);
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

    // The text form — plain / markdown / html / interactive — is chosen
    // for the situation, or named explicitly by the caller.
    const form: ContentForm | undefined = CONTENT_FORMS.includes(b.form as ContentForm)
      ? (b.form as ContentForm) : undefined;
    const audience = b.audience === 'agent' ? 'agent' as const
      : b.audience === 'human' ? 'human' as const : undefined;
    const rendering = renderForChannel(unit, channel, {
      ...(form ? { form } : {}), ...(audience ? { audience } : {}),
    });
    const learner = b.learner as string | undefined;
    const recipient = typeof b.recipient === 'string' ? b.recipient : undefined;

    // Actually deliver it — a configured webhook send, or the Interego-
    // native pod-descriptor publish, or rendering only when none is configured.
    let transport: TransportResult = { mode: 'none', sent: false, detail: 'no transport configured on this bridge — rendering only; no delivery occurred' };
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
        // Don't reflect the raw transport/fetch error (it can carry internal URLs or
        // upstream text) into the caller-visible `detail`; log it, surface a generic note.
        // eslint-disable-next-line no-console
        console.error('[foxxi:content-deliver:transport]', e instanceof Error ? (e.stack ?? e.message) : e);
        transport = { mode: 'none', sent: false, detail: 'transport error' };
      }
    }

    let instrumented = false;
    // Instrument only a delivery that occurred, with authority to speak for `learner`
    // (verified operator or a signer who proved control of the learner DID) —
    // never attribute an LRS statement to an unauthenticated caller-named actor.
    if (transport.sent && learner && config.emitStatement && (config.authorizeInstrumentation?.(req, learner) ?? false)) {
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
            [`${base}/ns/foxxi#contentForm`]: rendering.form,
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
      delivered: transport.sent, rendered: true, channel, rendering, instrumented, transport,
      note: transport.sent && instrumented
        ? `Rendered for ${channel}; ${transport.detail}; recorded in the LRS.`
        : transport.sent
          ? `Rendered for ${channel}; ${transport.detail}. No LRS statement was recorded.`
          : `Rendered for ${channel}. Delivery did not occur: ${transport.detail}. No LRS statement was recorded.`,
    });
    })().catch((e: unknown) => {
      if (!res.headersSent) sendServerError(res, e, 'content-deliver');
    });
  });
}

/** Test/inspection helper — the live published-course registry. */
export function _publishedCourses(): Map<string, PublishedCourse> { return published; }
/** Test/inspection helper — the live published job-aid registry. */
export function _publishedJobAids(): Map<string, PublishedJobAid> { return jobAids; }
void DEFAULT_TENANT;
