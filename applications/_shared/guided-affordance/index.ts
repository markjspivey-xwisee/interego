/**
 * Shared performance-support-in-the-flow primitive.
 *
 * Affordances tell an agent WHAT it can do (hydra:method/target/expects). This
 * adds WHAT IT MEANS, WHEN to reach for it, the CAPABILITY/COMPETENCY it builds,
 * its PREREQUISITES, HOW TO LEARN it, and WHERE TO GO NEXT — delivered IN THE FLOW
 * (attached to every response and served as a discoverable catalog), so an agent
 * gets performance support without leaving the flow of work / the flow of
 * hypermedia. Self-descriptive: the guidance travels with the affordance and with
 * each result. Generalized: any vertical (or the substrate surface) uses it.
 *
 * This is the connective tissue for "a skill/capability/competency agents discover,
 * learn, and teach each other": guidance names the competency + how to learn it,
 * and the catalog turns a bag of endpoints into a learnable capability surface.
 */
import type { Express, Request, Response } from 'express';
import { sameAction, renderHypermediaMarkdown } from '@interego/core';
import type { Affordance } from '../affordance-mcp/index.js';
import { wantsHmd, sendHmd, hmdProse, affordanceControl } from '../hypermedia/index.js';

export interface NextAffordanceHint {
  /** iep:action IRI of the suggested next affordance. */
  readonly action: string;
  /** Link relation in the flow (e.g. 'then', 'learn', 'verify', 'teach', 'undo'). */
  readonly rel: string;
  /** Why an agent would follow it here. */
  readonly why?: string;
}

export interface AffordanceGuidance {
  /** One line: what this affordance does. */
  readonly summary: string;
  /** When/why to reach for it — the performance-support cue. */
  readonly whenToUse?: string;
  /** The competency/capability exercising this builds or demonstrates (IRI or label). */
  readonly teaches?: string;
  /** Prerequisite capabilities/affordances an agent should hold/do first. */
  readonly requires?: readonly string[];
  /** How to LEARN this capability: a teaching-package IRI, doc URL, or a learn affordance. */
  readonly howToLearn?: string;
  /** A worked example input — self-descriptive, copy-adaptable in the flow. */
  readonly example?: Record<string, unknown>;
  /** Suggested next affordances (HATEOAS continuation). */
  readonly nextAffordances?: readonly NextAffordanceHint[];
}

/** A guided affordance = an affordance reference + its in-flow guidance. */
export interface GuidedAffordanceEntry {
  readonly action: string;
  readonly toolName: string;
  readonly guidance: AffordanceGuidance;
}

/** Attach self-descriptive guidance to a handler result — performance support
 *  delivered in the flow (every response also teaches how to go further). */
export function withGuidance<T extends Record<string, unknown>>(
  result: T,
  guidance: AffordanceGuidance,
): T & { _guidance: AffordanceGuidance } {
  return { ...result, _guidance: guidance };
}

/** A self-descriptive capability/skill catalog: what each affordance teaches +
 *  how to learn it, so agents discover CAPABILITIES, not just endpoints. */
export function capabilityCatalog(entries: readonly GuidedAffordanceEntry[]): Record<string, unknown> {
  return {
    '@type': ['iep:CapabilityCatalog', 'PerformanceSupport'],
    summary: 'Capabilities this surface affords, each with the competency it builds and how to learn it. Discover, learn, then teach.',
    capabilities: entries.map(e => ({
      affordance: e.action,
      tool: e.toolName,
      summary: e.guidance.summary,
      whenToUse: e.guidance.whenToUse,
      teaches: e.guidance.teaches,
      requires: e.guidance.requires ?? [],
      howToLearn: e.guidance.howToLearn,
      next: e.guidance.nextAffordances ?? [],
    })),
  };
}

/** Serve performance support in the flow: GET <mount> (the whole capability
 *  catalog) and GET <mount>/:tool (guidance for one affordance). Mirrors the
 *  ontology-serve shape; wire via a bridge `middleware` hook. */
export function attachGuidanceServing(app: Express, mountPath: string, entries: readonly GuidedAffordanceEntry[],
  hmd?: { base: string; affordances: readonly Affordance[] }): void {
  const mount = mountPath.replace(/\/$/, '');
  const cors = (res: Response) => res.setHeader('Access-Control-Allow-Origin', '*');
  app.get(mount, (req: Request, res: Response) => {
    cors(res);
    res.vary('Accept');
    if (hmd && wantsHmd(req)) {
      sendHmd(res, renderHypermediaMarkdown({ id: `${hmd.base}${mount}`, type: 'hydra:Collection',
        title: 'Performance guidance', descriptorUrl: `${hmd.base}/affordances`,
        fields: { 'hydra:totalItems': entries.length },
        body: '# Performance guidance\n\nFollow a capability to learn when and how to use it.',
        links: entries.map(e => ({ label: e.toolName, href: `${hmd.base}${mount}/${encodeURIComponent(e.toolName)}?format=markdown`, rel: 'item', type: 'text/markdown' })),
        controls: [],
      }));
      return;
    }
    res.type('application/ld+json').json(capabilityCatalog(entries));
  });
  app.get(`${mount}/:tool`, (req: Request, res: Response) => {
    cors(res);
    const tool = String(req.params.tool);
    const e = entries.find(x => x.toolName === tool || sameAction(x.action, tool));
    res.vary('Accept');
    if (hmd && wantsHmd(req)) {
      if (!e) { res.status(404).json({ error: 'Guidance not found' }); return; }
      const a = hmd.affordances.find(a => sameAction(a.action, e.action));
      const g = e.guidance;
      sendHmd(res, renderHypermediaMarkdown({ id: `${hmd.base}${mount}/${encodeURIComponent(e.toolName)}`,
        type: 'skos:Concept', title: g.summary, descriptorUrl: `${hmd.base}/affordances`,
        body: hmdProse(`# ${g.summary}\n\n${g.whenToUse ?? ''}\n\n`
          + (g.teaches ? `Capability: ${g.teaches}\n\n` : '')
          + (g.example ? 'Example input:\n\n```json\n' + JSON.stringify(g.example, null, 2) + '\n```' : '')),
        links: [{ label: 'Guidance catalog', href: `${hmd.base}${mount}?format=markdown`, rel: 'collection', type: 'text/markdown' },
          ...(g.howToLearn && /^https?:/.test(g.howToLearn) ? [{ label: 'Learn', href: g.howToLearn, rel: 'help' }] : [])],
        controls: [
          ...(a ? [{ ...affordanceControl(a, hmd.base), whenToUse: g.whenToUse ?? a.description, requires: g.requires }] : []),
          ...(g.nextAffordances ?? []).flatMap(n => hmd.affordances.filter(a => sameAction(a.action, n.action))
            .map(a => ({ ...affordanceControl(a, hmd.base), whenToUse: n.why ?? a.description }))),
        ],
      }));
      return;
    }
    res.type('application/ld+json').json(e
      ? { '@type': 'PerformanceSupport', affordance: e.action, tool: e.toolName, guidance: e.guidance }
      : { '@type': 'PerformanceSupport', tool: req.params.tool, note: 'No guidance registered for this tool on this surface.', catalog: `${mount}` });
  });
}
