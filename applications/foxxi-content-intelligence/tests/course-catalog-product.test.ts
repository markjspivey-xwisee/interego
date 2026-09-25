/**
 * Courses as federated data products: the HyprCat catalog a tenant publishes renders as Turtle
 * that parses back to the same products, an owner's catalog lists each course they authored once,
 * and a discovery over pods finds catalogs by their descriptor type, checks the issuer against the
 * attribution, and survives an unreachable pod.
 */
import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { authoredCourseProducts, courseCatalogProductTurtle, discoverCourseCatalogs, FEDERATED_CATALOG_TYPE, HYPRCAT_NS, parseCourseCatalogProducts, productIri } from '../src/course-catalog-product.js';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';

const TENANT = 'did:web:acme.example';
const CATALOG = 'https://pod.example/acme/foxxi/course-catalog-product';
const input = {
  catalogIri: CATALOG, tenantDid: TENANT, tenantName: 'Acme L&D', publishedAt: '2026-09-24T12:00:00.000Z',
  federatedWith: ['https://pod.example/other/foxxi/course-catalog-product'],
  courses: [
    { courseId: 'golf-explained', title: 'Golf "Explained"', courseIri: 'https://bridge.example/agent/scorm/course/golf-explained', category: 'Sports', description: 'Rules, etiquette and handicaps.', audienceTags: ['new-hires', 'sales'], standard: 'scorm-2004', slideCount: 42, conceptCount: 9 },
    { courseId: 'safety 101', title: 'Safety 101', courseIri: 'https://bridge.example/agent/scorm/course/safety-101' },
  ],
};

describe('the catalog as Turtle', () => {
  const turtle = courseCatalogProductTurtle(input);
  it('parses, and types the catalog, its products and their ports as HyprCat says', () => {
    const quads = new Parser().parse(turtle);
    const types = (s: string): string[] => quads.filter((q) => q.subject.value === s && q.predicate.value.endsWith('#type')).map((q) => q.object.value);
    expect(types(CATALOG)).toEqual([FEDERATED_CATALOG_TYPE, 'http://www.w3.org/ns/dcat#Catalog']);
    const golf = productIri(CATALOG, 'golf-explained');
    expect(types(golf)).toEqual([`${HYPRCAT_NS}FederatedDataProduct`, 'http://www.w3.org/ns/dcat#Dataset']);
    expect(types(`${golf}#port`)).toEqual([`${HYPRCAT_NS}PortAffordance`, `${HYPRCAT_NS}FederatedDistribution`, 'http://www.w3.org/ns/dcat#Distribution', 'http://www.w3.org/ns/hydra/core#Operation', 'https://markjspivey-xwisee.github.io/interego/ns/iep#Affordance', 'https://markjspivey-xwisee.github.io/interego/ns/harness#Affordance']);
    expect(quads.some((q) => q.subject.value === CATALOG && q.predicate.value === `${HYPRCAT_NS}world` && q.object.value === `${HYPRCAT_NS}ServiceWorld`)).toBe(true);
    expect(quads.filter((q) => q.subject.value === CATALOG && q.predicate.value === 'http://www.w3.org/ns/dcat#dataset')).toHaveLength(2);
    expect(productIri(CATALOG, 'safety 101')).toBe(`${CATALOG}/product/safety-101`);
  });
  it('reads back to the same products, with ports that target the course', () => {
    const [catalog] = parseCourseCatalogProducts(turtle);
    expect(catalog).toMatchObject({ iri: CATALOG, title: 'Acme L&D: courses', issuedBy: TENANT, world: `${HYPRCAT_NS}ServiceWorld`, modified: '2026-09-24T12:00:00.000Z', federatedWith: input.federatedWith });
    expect(catalog?.products.map((p) => p.courseId)).toEqual(['golf-explained', 'safety 101']);
    expect(catalog?.products[0]).toMatchObject({ title: 'Golf "Explained"', description: 'Rules, etiquette and handicaps.', category: 'Sports', standard: 'scorm-2004', keywords: ['new-hires', 'sales'], landingPage: 'https://bridge.example/agent/scorm/course/golf-explained', issuedBy: TENANT });
    expect(catalog?.products[0]?.ports).toEqual([{ iri: `${productIri(CATALOG, 'golf-explained')}#port`, target: 'https://bridge.example/agent/scorm/course/golf-explained', method: 'GET', mediaType: 'application/json' }]);
    expect(catalog?.products[1]?.keywords).toEqual([]);
  });
  it('an empty catalog still says what it is', () => {
    const [empty] = parseCourseCatalogProducts(courseCatalogProductTurtle({ ...input, courses: [], federatedWith: [] }));
    expect(empty).toMatchObject({ iri: CATALOG, products: [], federatedWith: [] });
    expect(parseCourseCatalogProducts('@prefix ex: <http://example/> . ex:a ex:b ex:c .')).toEqual([]);
  });
});

describe('an owner\'s authored courses as products', () => {
  const AUTHOR = 'did:ethr:0x42C2FFd7e4c048F2Ee757B26eE16A2c2339882ab';
  const iriOf = (id: string): string => `https://bridge.example/agent/scorm/course/${id}`;
  const course = (courseId: string, authoredBy = AUTHOR) => ({ courseId, title: `Course ${courseId}`, authoredBy, masteryScore: 0.5, scos: [{}, { assessment: [{}] }, { assessment: [{}, {}] }] });
  it('lists a course once when the cache and the pod both hold it, whatever the case of the author\'s address', () => {
    const products = authoredCourseProducts([course('A'), course('A'), course('B')], AUTHOR.toLowerCase(), new Set(), iriOf);
    expect(products.map((p) => p.courseId)).toEqual(['A', 'B']);
    expect(products[0]).toMatchObject({ title: 'Course A', courseIri: iriOf('A'), standard: 'scorm-2004', slideCount: 3, description: `3 sections, 2 assessed; mastery 0.5; authored by ${AUTHOR}.` });
  });
  it('leaves out another author\'s course, one already listed, and anything that is not a course', () => {
    const products = authoredCourseProducts([course('A', 'did:ethr:0x0000000000000000000000000000000000000001'), course('B'), course('C'), null, { courseId: 'D', authoredBy: AUTHOR }], AUTHOR, new Set(['B']), iriOf);
    expect(products.map((p) => p.courseId)).toEqual(['C']);
  });
  it('lists nothing for an owner with no wallet, rather than every course with no author', () => {
    expect(authoredCourseProducts([{ courseId: 'X', scos: [{}] }], '', new Set(), iriOf)).toEqual([]);
  });
});

describe('discovery over pods', () => {
  const turtle = courseCatalogProductTurtle(input);
  const reads = {
    entries: async (pod: string) => {
      if (pod === 'https://pod.example/acme/') return [{ descriptorUrl: `${pod}foxxi/course-catalog-product.ttl`, conformsTo: [FEDERATED_CATALOG_TYPE], issuer: TENANT }, { descriptorUrl: `${pod}foxxi/other.ttl`, conformsTo: ['https://x/Other'] }];
      if (pod === 'https://pod.example/impostor/') return [{ descriptorUrl: `${pod}foxxi/course-catalog-product.ttl`, conformsTo: [FEDERATED_CATALOG_TYPE], issuer: 'did:web:impostor.example' }];
      if (pod === 'https://pod.example/quiet/') return [];
      throw new Error('unreachable');
    },
    graph: async (descriptorUrl: string) => (descriptorUrl.includes('course-catalog-product') ? turtle : undefined),
  };
  it('finds catalogs by descriptor type, checks the issuer against the attribution, and reports every pod', async () => {
    const found = await discoverCourseCatalogs(['https://pod.example/acme/', 'https://pod.example/impostor/', 'https://pod.example/quiet/', 'https://pod.example/down/', 'https://pod.example/acme/'], reads);
    expect(found.catalogs.map((c) => [c.pod, c.issuerMatches, c.products.length])).toEqual([['https://pod.example/acme/', true, 2], ['https://pod.example/impostor/', false, 2]]);
    expect(found.catalogs[0]).toMatchObject({ descriptorUrl: 'https://pod.example/acme/foxxi/course-catalog-product.ttl', attributedTo: TENANT });
    expect(found.pods).toEqual([
      { pod: 'https://pod.example/acme/', entries: 2, catalogs: 1 },
      { pod: 'https://pod.example/impostor/', entries: 1, catalogs: 1 },
      { pod: 'https://pod.example/quiet/', entries: 0, catalogs: 0 },
      { pod: 'https://pod.example/down/', entries: 0, catalogs: 0, unreachable: true },
    ]);
  });
});

describe('the affordances', () => {
  it('publish on the admin surface, discover on the learner surface, both saying what they return', () => {
    const publish = foxxiAdminAffordances.find((a) => a.toolName === 'foxxi.publish_course_catalog_product');
    const discover = foxxiAffordances.find((a) => a.toolName === 'foxxi.discover_course_catalogs');
    expect(publish?.outputs?.properties).toBeDefined();
    expect(discover?.outputs?.properties).toBeDefined();
    expect(foxxiAffordances.some((a) => a.toolName === 'foxxi.publish_course_catalog_product')).toBe(false);
    expect(discover?.inputs.find((i) => i.name === 'pod_urls')).toMatchObject({ type: 'array', required: false });
  });
});
