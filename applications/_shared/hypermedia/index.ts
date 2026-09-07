/** Shared HMD projection for vertical discovery and resource documents. */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { renderHypermediaMarkdown, HMD_PROFILE_LINK_HEADER, actionUrl,
  type HypermediaControl, type HypermediaLink } from '@interego/core';
import { affordanceToMcpToolSchema, type Affordance } from '../affordance-mcp/index.js';

export const HMD_MEDIA_TYPE = 'text/markdown; charset=UTF-8; variant=CommonMark';

export function wantsHmd(req: Request): boolean {
  const format = String(req.query.format ?? '').toLowerCase();
  if (format) return ['markdown', 'md', 'hmd'].includes(format);
  return req.accepts(['application/ld+json', 'text/turtle', 'text/markdown']) === 'text/markdown';
}

export function sendHmd(res: Response, body: string): void {
  res.vary('Accept');
  res.append('Link', HMD_PROFILE_LINK_HEADER);
  res.type(HMD_MEDIA_TYPE).send(body);
}

/** Content remains prose; only the renderer may emit executable control fences. */
export function hmdProse(text: string): string {
  return text.replace(/^(:{3,})/gm, '\\$1').replace(/^(- \[.*\]\(.*\)\{)/gm, '\\$1');
}

export function inputSchemaIri(base: string, a: Affordance): string {
  return `${base.replace(/\/$/, '')}/affordances/${encodeURIComponent(a.toolName)}/input`;
}

export function affordanceControl(a: Affordance, base: string, source = `${base}/affordances`): HypermediaControl {
  return { action: actionUrl(a.action), method: a.method, source,
    expects: inputSchemaIri(base, a), mediaType: a.mediaType,
    returns: a.returns, whenToUse: a.description };
}

export function renderAffordanceManifestHmd(id: string, title: string,
  affordances: readonly Affordance[], base: string, links: readonly HypermediaLink[] = []): string {
  const manifest = `${base}/affordances`;
  return renderHypermediaMarkdown({ id, type: 'hydra:ApiDocumentation', descriptorUrl: manifest,
    title, fields: { 'hydra:totalItems': affordances.length },
    body: hmdProse(`# ${title}\n\nDiscover the declared action, read its input schema, and follow its control through Interego.\n\n`
      + affordances.map(a => `## ${a.title}\n\n${a.description}\n\n`
        + `Input contract: [${a.toolName}](${inputSchemaIri(base, a)})\n\n`
        + '```json\n' + JSON.stringify(affordanceToMcpToolSchema(a).inputSchema, null, 2) + '\n```').join('\n\n')),
    links: [{ label: 'Affordance authority', href: manifest, rel: 'describedby', type: 'text/turtle' },
      ...links],
    controls: affordances.map(a => affordanceControl(a, base, manifest)),
  });
}

/** An immutable response snapshot, not a public URL to a learner's private state.
 * Keep the native payload lossless as JSON text; controls remain typed HMD.
 * Inline encoding also reaches MCP clients that cannot set an Accept header. */
export function sendActionResult(req: Request, res: Response, payload: Record<string, unknown>,
  base: string, title: string, next: readonly Affordance[], links: readonly HypermediaLink[] = []): void {
  const md = renderHypermediaMarkdown({ id: `urn:uuid:${randomUUID()}`, type: 'schema:DigitalDocument',
    descriptorUrl: `${base}/affordances`, title,
    fields: { 'schema:encodingFormat': 'application/json', 'schema:text': JSON.stringify(payload) },
    body: hmdProse(`# ${title}\n\nResponse snapshot. Follow the controls through the declared authority.\n\n`
      + '```json\n' + JSON.stringify(payload, null, 2) + '\n```'),
    links: [{ label: 'Available actions', href: `${base}/affordances?format=markdown`, rel: 'related', type: 'text/markdown' }, ...links],
    controls: next.map(a => affordanceControl(a, base)),
  });
  res.vary('Accept');
  res.setHeader('Cache-Control', 'no-store');
  if (wantsHmd(req)) { sendHmd(res, md); return; }
  res.json({ ...payload, 'https://schema.org/encoding': {
    '@type': 'https://schema.org/MediaObject', 'https://schema.org/encodingFormat': 'text/markdown',
    'https://schema.org/text': md,
  } });
}
