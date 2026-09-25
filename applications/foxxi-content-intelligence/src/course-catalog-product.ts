/**
 * A tenant's courses as federated data products: the HyprCat catalog a pod publishes, and the
 * reading of any pod's catalog back, so content is discoverable across tenants and pods without
 * a central marketplace.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * HyprCat (docs/ns/hyprcat.ttl) has said since it was written how a catalog federates: a
 * `FederatedCatalog` of `FederatedDataProduct`s, each issued by an identity, placed in one of
 * three worlds, with distributions that are affordances an agent can follow. On 2026-09-24
 * nothing in any vertical instantiated it. Foxxi's course catalog was one JSON blob in a pod
 * section, typed only inside its payload, so no manifest could say "this pod publishes a
 * catalog" and no peer could find a course without already holding the pod and the section's
 * name. This module renders the tenant's catalog as HyprCat Turtle whose descriptor conforms to
 * `hyprcat:FederatedCatalog`, so a manifest walk finds it by type; and reads any such graph
 * back into products, so a learner or an agent can discover courses across the pods it knows.
 * The vertical uses the Layer 2 pattern as written and adds no term to it.
 */
import { parseTrig, findSubjectsOfType, readStringValue, readStringValues, readIriValue, type IRI, type ParsedSubject } from '@interego/core';
import { dateTime, int, iri, lit, prefixLine } from '../../_shared/judgment-kit/index.js';

export const HYPRCAT_NS = 'https://markjspivey-xwisee.github.io/interego/ns/hyprcat#';
const DCAT = 'http://www.w3.org/ns/dcat#';
const DCT = 'http://purl.org/dc/terms/';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const IEH = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/** The descriptor type a federated course catalog conforms to; a manifest walk finds catalogs by it. */
export const FEDERATED_CATALOG_TYPE = `${HYPRCAT_NS}FederatedCatalog`;

export interface CourseProductInput {
  readonly courseId: string;
  readonly title: string;
  readonly courseIri: string;
  readonly category?: string;
  readonly description?: string;
  readonly audienceTags?: readonly string[];
  readonly standard?: string;
  readonly slideCount?: number;
  readonly conceptCount?: number;
}

export interface CatalogProductInput {
  /** The catalog's IRI: one per tenant pod, fixed, so a republish supersedes. */
  readonly catalogIri: string;
  readonly tenantDid: string;
  readonly tenantName: string;
  readonly courses: readonly CourseProductInput[];
  /** Catalogs on other pods this one federates with, by IRI. */
  readonly federatedWith?: readonly string[];
  readonly publishedAt: string;
}

const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '-');

/** The IRI a course's data product carries inside the catalog graph. */
export const productIri = (catalogIri: string, courseId: string): string => `${catalogIri}/product/${slug(courseId)}`;

/** A course the bridge's SCORM engine grades, as authoring stores it. */
export interface AuthoredCourse {
  readonly courseId: string;
  readonly title?: string;
  readonly authoredBy?: string;
  readonly masteryScore?: number;
  readonly scos?: readonly { readonly assessment?: readonly unknown[] }[];
}

/**
 * The courses `authorDid` authored, as products of its catalog: once each, skipping any already
 * `listed`. The candidates come from every place a course is kept (the process's cache and the
 * author's own pod), so one course can arrive more than once; reading only the cache would publish
 * an empty catalog after every restart. A did:ethr compares without case, since its checksummed
 * and lower-case spellings name the same key.
 */
export function authoredCourseProducts(
  candidates: readonly (AuthoredCourse | null | undefined)[],
  authorDid: string,
  listed: ReadonlySet<string>,
  iriOf: (courseId: string) => string,
): CourseProductInput[] {
  const author = authorDid.toLowerCase();
  if (!author) return [];
  const seen = new Set(listed);
  const out: CourseProductInput[] = [];
  for (const c of candidates) {
    if (!c?.courseId || !Array.isArray(c.scos) || String(c.authoredBy ?? '').toLowerCase() !== author || seen.has(c.courseId)) continue;
    seen.add(c.courseId);
    const assessed = c.scos.filter((s) => (s.assessment?.length ?? 0) > 0).length;
    out.push({
      courseId: c.courseId, title: c.title ?? c.courseId, courseIri: iriOf(c.courseId), category: 'SCORM 2004, graded by this bridge', audienceTags: [], standard: 'scorm-2004',
      description: `${c.scos.length} sections, ${assessed} assessed${c.masteryScore !== undefined ? `; mastery ${c.masteryScore}` : ''}; authored by ${c.authoredBy}.`, slideCount: c.scos.length,
    });
  }
  return out;
}

/**
 * The catalog as Turtle: a `hyprcat:FederatedCatalog` in the service world, issued by the
 * tenant, listing one `hyprcat:FederatedDataProduct` per course whose output port is a
 * followable distribution targeting the course's own IRI.
 */
export function courseCatalogProductTurtle(input: CatalogProductInput): string {
  const lines: string[] = [
    prefixLine('hyprcat', HYPRCAT_NS), prefixLine('dcat', DCAT), prefixLine('dct', DCT), prefixLine('hydra', HYDRA),
    prefixLine('iep', IEP), prefixLine('ieh', IEH), prefixLine('xsd', XSD), '',
  ];
  const catalog = iri(input.catalogIri);
  const tenant = iri(input.tenantDid);
  const products = input.courses.map((c) => productIri(input.catalogIri, c.courseId));
  lines.push(`${catalog} a hyprcat:FederatedCatalog, dcat:Catalog ;`);
  lines.push(`  dct:title ${lit(`${input.tenantName}: courses`)} ;`);
  lines.push(`  dct:publisher ${tenant} ;`);
  lines.push(`  hyprcat:issuedBy ${tenant} ;`);
  lines.push('  hyprcat:world hyprcat:ServiceWorld ;');
  lines.push(`  dct:modified ${dateTime(input.publishedAt)} ;`);
  for (const peer of input.federatedWith ?? []) lines.push(`  hyprcat:federatedWith ${iri(peer)} ;`);
  lines.push(products.length > 0 ? `  dcat:dataset ${products.map(iri).join(', ')} .` : '  dct:description "no courses yet" .');
  lines.push('');
  for (const c of input.courses) {
    const product = iri(productIri(input.catalogIri, c.courseId));
    const port = iri(`${productIri(input.catalogIri, c.courseId)}#port`);
    lines.push(`${product} a hyprcat:FederatedDataProduct, dcat:Dataset ;`);
    lines.push(`  dct:identifier ${lit(c.courseId)} ;`);
    lines.push(`  dct:title ${lit(c.title)} ;`);
    if (c.description) lines.push(`  dct:description ${lit(c.description)} ;`);
    if (c.category) lines.push(`  dct:subject ${lit(c.category)} ;`);
    if (c.standard) lines.push(`  dct:type ${lit(c.standard)} ;`);
    for (const tag of c.audienceTags ?? []) lines.push(`  dcat:keyword ${lit(tag)} ;`);
    if (c.slideCount !== undefined) lines.push(`  dct:extent ${int(c.slideCount)} ;`);
    lines.push(`  dcat:landingPage ${iri(c.courseIri)} ;`);
    lines.push(`  hyprcat:issuedBy ${tenant} ;`);
    lines.push('  hyprcat:world hyprcat:ServiceWorld ;');
    lines.push(`  hyprcat:outputPort ${port} .`);
    lines.push(`${port} a hyprcat:PortAffordance, hyprcat:FederatedDistribution, dcat:Distribution, hydra:Operation, iep:Affordance, ieh:Affordance ;`);
    lines.push(`  dct:title ${lit(`Fetch ${c.title}`)} ;`);
    lines.push('  iep:action iep:canFetchPayload ;');
    lines.push('  hydra:method "GET" ;');
    lines.push(`  hydra:target ${iri(c.courseIri)} ;`);
    lines.push(`  dcat:accessURL ${iri(c.courseIri)} ;`);
    lines.push('  dcat:mediaType "application/json" .');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export interface CatalogPort {
  readonly iri: string;
  readonly target?: string;
  readonly method?: string;
  readonly mediaType?: string;
}

export interface CatalogProduct {
  readonly iri: string;
  readonly courseId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly category?: string;
  readonly standard?: string;
  readonly keywords: readonly string[];
  readonly landingPage?: string;
  readonly issuedBy?: string;
  readonly world?: string;
  readonly ports: readonly CatalogPort[];
}

export interface FederatedCourseCatalog {
  readonly iri: string;
  readonly title?: string;
  readonly issuedBy?: string;
  readonly world?: string;
  readonly modified?: string;
  readonly federatedWith: readonly string[];
  readonly products: readonly CatalogProduct[];
}

const irisOf = (s: ParsedSubject, predicate: string): string[] => (s.properties.get(predicate as IRI) ?? []).filter((t) => t.kind === 'iri').map((t) => String((t as { iri: string }).iri));
const subjectIri = (s: ParsedSubject): string | undefined => (typeof s.subject === 'string' ? String(s.subject) : undefined);

/** The catalogs a graph holds, with their products and ports; an empty list when it holds none. */
export function parseCourseCatalogProducts(turtle: string): FederatedCourseCatalog[] {
  const doc = parseTrig(turtle);
  const byIri = new Map<string, ParsedSubject>();
  for (const s of doc.subjects) { const id = subjectIri(s); if (id) byIri.set(id, s); }
  const port = (id: string): CatalogPort => {
    const s = byIri.get(id);
    return {
      iri: id,
      ...(s && readIriValue(s, `${HYDRA}target` as IRI) ? { target: String(readIriValue(s, `${HYDRA}target` as IRI)) } : {}),
      ...(s && readStringValue(s, `${HYDRA}method` as IRI) ? { method: readStringValue(s, `${HYDRA}method` as IRI) } : {}),
      ...(s && readStringValue(s, `${DCAT}mediaType` as IRI) ? { mediaType: readStringValue(s, `${DCAT}mediaType` as IRI) } : {}),
    };
  };
  const product = (id: string): CatalogProduct | undefined => {
    const s = byIri.get(id);
    if (!s) return undefined;
    const optional = (key: string, value: string | undefined): Record<string, string> => (value ? { [key]: value } : {});
    return {
      iri: id,
      ...optional('courseId', readStringValue(s, `${DCT}identifier` as IRI)),
      ...optional('title', readStringValue(s, `${DCT}title` as IRI)),
      ...optional('description', readStringValue(s, `${DCT}description` as IRI)),
      ...optional('category', readStringValue(s, `${DCT}subject` as IRI)),
      ...optional('standard', readStringValue(s, `${DCT}type` as IRI)),
      keywords: readStringValues(s, `${DCAT}keyword` as IRI),
      ...optional('landingPage', irisOf(s, `${DCAT}landingPage`)[0]),
      ...optional('issuedBy', irisOf(s, `${HYPRCAT_NS}issuedBy`)[0]),
      ...optional('world', irisOf(s, `${HYPRCAT_NS}world`)[0]),
      ports: irisOf(s, `${HYPRCAT_NS}outputPort`).map(port),
    };
  };
  return findSubjectsOfType(doc, FEDERATED_CATALOG_TYPE as IRI).flatMap((s) => {
    const id = subjectIri(s);
    if (!id) return [];
    const optional = (key: string, value: string | undefined): Record<string, string> => (value ? { [key]: value } : {});
    return [{
      iri: id,
      ...optional('title', readStringValue(s, `${DCT}title` as IRI)),
      ...optional('issuedBy', irisOf(s, `${HYPRCAT_NS}issuedBy`)[0]),
      ...optional('world', irisOf(s, `${HYPRCAT_NS}world`)[0]),
      ...optional('modified', readStringValue(s, `${DCT}modified` as IRI)),
      federatedWith: irisOf(s, `${HYPRCAT_NS}federatedWith`),
      products: irisOf(s, `${DCAT}dataset`).map(product).filter((p): p is CatalogProduct => p !== undefined),
    }];
  });
}

export interface DiscoveredCatalog extends FederatedCourseCatalog {
  readonly pod: string;
  readonly descriptorUrl: string;
  /** The identity the manifest attributes the descriptor to, when it says. */
  readonly attributedTo?: string;
  /** Whether the catalog's issuer is the identity the descriptor is attributed to; null when the manifest does not say. */
  readonly issuerMatches: boolean | null;
}

export interface CatalogDiscoveryReads {
  /** A pod's manifest entries: descriptorUrl, conformsTo, and the issuer when known. */
  readonly entries: (pod: string) => Promise<readonly { readonly descriptorUrl: string; readonly conformsTo?: readonly string[]; readonly issuer?: string }[]>;
  /** The Turtle of the graph a descriptor describes. */
  readonly graph: (descriptorUrl: string) => Promise<string | undefined>;
}

export interface CatalogDiscovery {
  readonly catalogs: readonly DiscoveredCatalog[];
  readonly pods: readonly { readonly pod: string; readonly entries: number; readonly catalogs: number; readonly unreachable?: true }[];
}

/**
 * Every federated course catalog the given pods publish, found by the descriptor type in each
 * manifest, read back and checked against the identity the manifest attributes it to. No
 * registry: the pods are the ones the caller already knows, or that this deployment federates with.
 */
export async function discoverCourseCatalogs(pods: readonly string[], reads: CatalogDiscoveryReads): Promise<CatalogDiscovery> {
  const catalogs: DiscoveredCatalog[] = [];
  const summary: { pod: string; entries: number; catalogs: number; unreachable?: true }[] = [];
  for (const pod of [...new Set(pods)]) {
    let entries: Awaited<ReturnType<CatalogDiscoveryReads['entries']>>;
    try { entries = await reads.entries(pod); } catch { summary.push({ pod, entries: 0, catalogs: 0, unreachable: true }); continue; }
    let found = 0;
    for (const e of entries) {
      if (!(e.conformsTo ?? []).includes(FEDERATED_CATALOG_TYPE)) continue;
      let turtle: string | undefined;
      try { turtle = await reads.graph(e.descriptorUrl); } catch { turtle = undefined; }
      if (!turtle) continue;
      for (const c of parseCourseCatalogProducts(turtle)) {
        found += 1;
        catalogs.push({ ...c, pod, descriptorUrl: e.descriptorUrl, ...(e.issuer ? { attributedTo: e.issuer } : {}), issuerMatches: e.issuer && c.issuedBy ? e.issuer === c.issuedBy : null });
      }
    }
    summary.push({ pod, entries: entries.length, catalogs: found });
  }
  return { catalogs, pods: summary };
}

/** The rdf:type IRI, for callers that filter subjects themselves. */
export const RDF_TYPE = `${RDF}type`;
