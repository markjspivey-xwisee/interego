/**
 * SCORM 2004 4th Edition — Content Aggregation Model: content packaging — the single source.
 *
 * Composed into the PGSL lattice (composeSpecOntology) and projected to OWL/SHACL/JSON-LD on
 * dereference at <bridge>/ns/scorm-cam. A parsed imsmanifest.xml is checked against the SHACL shapes
 * this model publishes at POST /ns/scorm-cam/validate (validateAgainstShape), and every result cites
 * the shape it came from.
 *
 * ★ THE EDITION IS THE CURRENT ONE. SCORM 2004 4th Edition (ADL, 2009) is the latest SCORM. This
 * model used to say 3rd Edition because the sample package in deploy/foxxi-scorm-player ships the
 * 3rd Edition schemas. The 4th Edition keeps every namespace and every 3rd Edition construct and
 * adds: the completion threshold's attributes (completedByMeasure, minProgressMeasure,
 * progressWeight), shared data (adlcp:data / adlcp:map, adlcp:sharedDataGlobalToSystem), and IMS
 * Content Packaging 1.1.4, under which an organization holds at least one item. A 3rd Edition
 * package uses none of the additions, so it conforms.
 *
 * ★ XML TEXT IS A VALUE, NOT A NODE. <schema>, <schemaversion> and <title> hold text. They were
 * object properties pointing at classes with no properties, so a package's title could not be
 * recorded at all. They are datatype properties now; the three classes are deprecated, not deleted.
 *
 * ★ CITED BY SCHEMA TYPE AND ELEMENT NAME, which a reader can check against the XSDs, not by
 * section numbers of a book the repository does not hold.
 */
import type { OntologyModel } from '../spec-ontology.js';

const CP = 'IMS Content Packaging 1.1.4 (imscp_v1p1.xsd)';
const ADLCP = 'ADL content packaging extensions, SCORM 2004 4th Edition (adlcp_v1p3.xsd)';
const CAM = 'SCORM 2004 4th Edition Content Aggregation Model';
/** What a JSON number becomes in RDF (JSON-LD 1.1 §8.6): an integer or a double; or a decimal. */
const NUMBER = ['xsd:integer', 'xsd:decimal', 'xsd:double'];

/** The <schemaversion> a SCORM 2004 manifest declares, by edition (4th, 3rd, 2nd). */
export const SCORM_2004_SCHEMA_VERSIONS = ['2004 4th Edition', '2004 3rd Edition', 'CAM 1.3'] as const;
const TIME_LIMIT_ACTIONS = ['exit,message', 'exit,no message', 'continue,message', 'continue,no message'];

export const SCORM_CAM_MODEL: OntologyModel = {
  module: 'scorm-cam',
  title: 'SCORM 2004 4th Edition — Content Aggregation Model (content packaging)',
  description: 'An OWL 2 DL ontology and SHACL shapes for content packaging in the SCORM 2004 4th Edition Content Aggregation Model: the manifest of IMS Content Packaging 1.1.4 (manifest, metadata, organizations, organization, item, resources, resource, file, dependency) and ADL\'s extensions to it — the SCORM type of a resource, launch data, the time limit action, the completion threshold with its 4th Edition attributes, and shared data maps. A SCORM 2004 3rd Edition package conforms, since the 4th Edition additions are optional.',
  version: '2026.10.0',
  spec: 'https://adlnet.gov/past-projects/scorm',
  standards: [
    { title: 'SCORM 2004 4th Edition (ADL, 2009): Content Aggregation Model', url: 'https://adlnet.gov/past-projects/scorm' },
    { title: 'IMS Content Packaging 1.1.4 (1EdTech, formerly IMS Global Learning Consortium)', url: 'https://www.imsglobal.org/content/packaging/index.html' },
  ],
  bodies: ['ADL', '1EdTech'],
  derivedFrom: 'imscp_v1p1.xsd (IMS Content Packaging 1.1.4) and adlcp_v1p3.xsd, as distributed with SCORM 2004 4th Edition',
  notes: [
    'The sample package in deploy/foxxi-scorm-player/site/course is a SCORM 2004 3rd Edition package and ships the 3rd Edition schemas; it conforms to this ontology.',
    'Since 2026.10.0, schema, schemaversion and title are datatype properties holding the element\'s text, and the classes Schema, SchemaVersion and Title they pointed at are deprecated.',
    'The shapes select nodes by class (sh:targetClass): an RDF producer types the nodes it describes with this ontology\'s classes. A parsed instance as JSON is checked against the same shapes at POST /ns/scorm-cam/validate, which routes it by its declared type; every result cites its shape.',
  ],
  classes: [
    { name: 'Manifest', label: 'Manifest', comment: 'The <manifest> of a content package: its identifier, its metadata, the organizations of its content and the resources that content is made of, and any manifests nested in it.', source: `${CP}: manifestType` },
    { name: 'Metadata', label: 'Metadata', comment: 'A <metadata> element: metadata about the package or one of its parts — the schema it follows, its version, and the location of any metadata record kept outside the manifest.', source: `${CP}: metadataType` },
    { name: 'Organizations', label: 'Organizations', comment: 'The <organizations> element: the organizations of a package\'s content, and which of them is the default.', source: `${CP}: organizationsType` },
    { name: 'Organization', label: 'Organization', comment: 'An <organization>: one structure of a package\'s content — a titled tree of items — that can be presented to a learner. In SCORM it is the root of an activity tree.', source: `${CP}: organizationType` },
    { name: 'Item', label: 'Item', comment: 'An <item>: a node of an organization\'s tree, standing for a learning activity. An item that references a resource launches it; an item with child items aggregates them.', source: `${CP}: itemType` },
    { name: 'Resources', label: 'Resources', comment: 'The <resources> element: the resources of a package.', source: `${CP}: resourcesType` },
    { name: 'Resource', label: 'Resource', comment: 'A <resource>: a set of files delivered together, with the file that launches it — a sharable content object (SCO), which communicates with the LMS at run time, or an asset, which does not.', source: `${CP}: resourceType; ${ADLCP}: scormType` },
    { name: 'File', label: 'File', comment: 'A <file>: one file a resource is made of.', source: `${CP}: fileType` },
    { name: 'Dependency', label: 'Dependency', comment: 'A <dependency>: a resource\'s reference to another resource whose files it also needs.', source: `${CP}: dependencyType` },
    { name: 'SharedDataMap', label: 'Shared data map', notation: 'adlcp:map', comment: 'An <adlcp:map> in an item\'s <adlcp:data>: access, for the content the item launches, to a shared data store named by its target ID — to read it, to write it, or both. The content reaches the store through the adl.data run-time data model. Added in the 4th Edition.', source: `${ADLCP}: mapType` },
    // Deprecated in 2026.10.0. Kept so data that used them still resolves.
    { name: 'Schema', label: 'Schema', comment: 'Formerly the class of the <schema> element, which holds text; the text is now the value of the datatype property schema.', deprecated: true, replacedBy: 'schema' },
    { name: 'SchemaVersion', label: 'Schema version', comment: 'Formerly the class of the <schemaversion> element, which holds text; the text is now the value of the datatype property schemaversion.', deprecated: true, replacedBy: 'schemaversion' },
    { name: 'Title', label: 'Title', comment: 'Formerly the class of the <title> element, which holds text; the text is now the value of the datatype property title.', deprecated: true, replacedBy: 'title' },
  ],
  datatypes: [
    { name: 'UnitInterval', label: 'Unit interval', comment: 'A number from 0 to 1 inclusive: a decimal as the schema writes it, or a double, which is what JSON-LD 1.1 (§8.6) makes of a JSON number with a fraction.', base: 'xsd:decimal', alsoBases: ['xsd:double'], minInclusive: 0, maxInclusive: 1, source: `${ADLCP}: minProgressMeasureType, progressWeightType` },
  ],
  properties: [
    // ── IMS CP attributes ──
    { name: 'identifier', kind: 'datatype', label: 'identifier', comment: 'The identifier of a manifest, organization, item or resource: an XML ID, unique within the manifest. xsd:ID is outside the OWL 2 datatype map, so the range is xsd:string.', domain: ['Manifest', 'Organization', 'Item', 'Resource'], range: 'xsd:string', functional: true, source: `${CP}: attr.identifier.req` },
    { name: 'identifierref', kind: 'datatype', label: 'identifier reference', notation: 'identifierref', comment: 'A resource\'s identifier: on an item, the resource the item launches; on a dependency, the resource depended on.', domain: ['Item', 'Dependency'], range: 'xsd:string', functional: true, source: `${CP}: attr.identifierref, attr.identifierref.req` },
    { name: 'version', kind: 'datatype', label: 'version', comment: 'The version of a manifest, as its author writes it.', domain: 'Manifest', range: 'xsd:string', functional: true, source: `${CP}: attr.version` },
    { name: 'isvisible', kind: 'datatype', label: 'is visible', notation: 'isvisible', comment: 'Whether an item is shown to the learner when its organization is presented. Default true.', domain: 'Item', range: 'xsd:boolean', functional: true, source: `${CP}: attr.isvisible` },
    { name: 'parameters', kind: 'datatype', label: 'parameters', comment: 'A query string an item adds to the URL of the resource it launches.', domain: 'Item', range: 'xsd:string', functional: true, source: `${CP}: attr.parameters` },
    { name: 'structure', kind: 'datatype', label: 'structure', comment: 'The shape of an organization. Default "hierarchical".', domain: 'Organization', range: 'xsd:string', functional: true, source: `${CP}: attr.structure.req` },
    { name: 'href', kind: 'datatype', label: 'href', comment: 'A URL: on a resource, the file that launches it; on a file, the file. Relative URLs resolve against the XML base in effect.', domain: ['Resource', 'File'], range: 'xsd:anyURI', functional: true, source: `${CP}: attr.href, attr.href.req` },
    { name: 'type', kind: 'datatype', label: 'type', comment: 'The type of a resource, such as "webcontent".', domain: 'Resource', range: 'xsd:string', functional: true, source: `${CP}: attr.resourcetype.req` },
    { name: 'base', kind: 'datatype', label: 'XML base', notation: 'xml:base', comment: 'The base URL that relative URLs inside the element resolve against.', domain: ['Manifest', 'Resources', 'Resource'], range: 'xsd:anyURI', functional: true, source: `${CP}: attr.base` },
    { name: 'defaultOrganization', kind: 'datatype', label: 'default organization', notation: 'default', comment: 'The identifier of the organization presented by default (an XML IDREF).', domain: 'Organizations', range: 'xsd:string', functional: true, source: `${CP}: attr.default` },
    // ── IMS CP elements ──
    { name: 'metadata', kind: 'object', label: 'metadata', comment: 'The metadata of a manifest, organization, item, resource or file.', domain: ['Manifest', 'Organization', 'Item', 'Resource', 'File'], range: 'Metadata', functional: true, source: `${CP}: metadata` },
    { name: 'organizations', kind: 'object', label: 'organizations', comment: 'The organizations of a manifest.', domain: 'Manifest', range: 'Organizations', functional: true, source: `${CP}: manifestType` },
    { name: 'resources', kind: 'object', label: 'resources', comment: 'The resources of a manifest.', domain: 'Manifest', range: 'Resources', functional: true, source: `${CP}: manifestType` },
    { name: 'subManifest', kind: 'object', label: 'sub-manifest', notation: 'manifest', comment: 'A manifest nested in a manifest.', domain: 'Manifest', range: 'Manifest', source: `${CP}: manifestType` },
    { name: 'organization', kind: 'object', label: 'organization', comment: 'An organization of the package.', domain: 'Organizations', range: 'Organization', source: `${CP}: organizationsType` },
    { name: 'item', kind: 'object', label: 'item', comment: 'A child item: of an organization, one of its top-level items; of an item, one of the items it aggregates.', domain: ['Organization', 'Item'], range: 'Item', source: `${CP}: organizationType, itemType` },
    // Document order carries meaning here — it is the order sequencing takes a cluster's children in
    // (flow and choice navigation) — and RDF keeps no order of its own, so a reading states it.
    { name: 'position', kind: 'datatype', label: 'position', comment: 'The position of an item among the children of its organization or parent item, counting from 1 in document order: the order SCORM sequencing takes them in. An RDF reading of a manifest states it, since RDF keeps no order of its own.', domain: 'Item', range: 'xsd:positiveInteger', functional: true, source: `${CP}: organizationType, itemType (the order of the item elements)` },
    { name: 'resource', kind: 'object', label: 'resource', comment: 'A resource of the package.', domain: 'Resources', range: 'Resource', source: `${CP}: resourcesType` },
    { name: 'file', kind: 'object', label: 'file', comment: 'A file a resource is made of.', domain: 'Resource', range: 'File', source: `${CP}: resourceType` },
    { name: 'dependency', kind: 'object', label: 'dependency', comment: 'A dependency of a resource on another resource.', domain: 'Resource', range: 'Dependency', source: `${CP}: resourceType` },
    { name: 'title', kind: 'datatype', label: 'title', comment: 'The title of an organization or item, shown to the learner. (Until 2026.10.0 an object property pointing at the deprecated class Title.)', domain: ['Organization', 'Item'], range: 'xsd:string', functional: true, source: `${CP}: titleType` },
    { name: 'schema', kind: 'datatype', label: 'schema', comment: 'The schema the metadata follows: "ADL SCORM" for a SCORM package. (Until 2026.10.0 an object property pointing at the deprecated class Schema.)', domain: 'Metadata', range: 'xsd:string', functional: true, source: `${CP}: schemaType` },
    { name: 'schemaversion', kind: 'datatype', label: 'schema version', notation: 'schemaversion', comment: 'The version of that schema: for SCORM 2004, "2004 4th Edition", "2004 3rd Edition", or "CAM 1.3" for the 2nd Edition. (Until 2026.10.0 an object property pointing at the deprecated class SchemaVersion.)', domain: 'Metadata', range: 'xsd:string', functional: true, source: `${CP}: schemaversionType` },
    // ── ADL extensions ──
    { name: 'scormType', kind: 'datatype', label: 'SCORM type', notation: 'adlcp:scormType', comment: 'Whether a resource is a SCO, which communicates with the LMS at run time, or an asset, which does not. Every SCORM resource has one.', domain: 'Resource', oneOf: ['sco', 'asset'], functional: true, source: `${ADLCP}: scormType` },
    { name: 'location', kind: 'datatype', label: 'location', notation: 'adlcp:location', comment: 'The URL of a metadata record kept outside the manifest.', domain: 'Metadata', range: 'xsd:anyURI', functional: true, source: `${ADLCP}: locationType` },
    { name: 'dataFromLMS', kind: 'datatype', label: 'data from LMS', notation: 'adlcp:dataFromLMS', comment: 'Data an item gives the content it launches, which the content reads as cmi.launch_data.', domain: 'Item', range: 'xsd:string', functional: true, source: `${ADLCP}: dataFromLMSType` },
    { name: 'timeLimitAction', kind: 'datatype', label: 'time limit action', notation: 'adlcp:timeLimitAction', comment: 'What the content an item launches should do when the learner exceeds the time allowed; the content reads it as cmi.time_limit_action.', domain: 'Item', oneOf: TIME_LIMIT_ACTIONS, functional: true, source: `${ADLCP}: timeLimitActionType` },
    { name: 'completionThreshold', kind: 'datatype', label: 'completion threshold', notation: 'adlcp:completionThreshold', comment: 'An item\'s completion threshold as SCORM 2004 3rd Edition writes it: the content of the element, a number from 0 to 1. The 4th Edition expresses the threshold as minProgressMeasure; its schema still admits the content, so 3rd Edition packages remain valid.', domain: 'Item', range: 'UnitInterval', functional: true, source: `${ADLCP}: completionThresholdType (3rd Edition content)` },
    { name: 'completedByMeasure', kind: 'datatype', label: 'completed by measure', notation: 'adlcp:completionThreshold/@completedByMeasure', comment: 'Whether an item\'s completion is decided by comparing its progress measure with its minimum progress measure. Default false. Added in the 4th Edition.', domain: 'Item', range: 'xsd:boolean', functional: true, source: `${ADLCP}: completionThresholdType` },
    { name: 'minProgressMeasure', kind: 'datatype', label: 'minimum progress measure', notation: 'adlcp:completionThreshold/@minProgressMeasure', comment: 'The progress measure, from 0 to 1, at or above which an item whose completion is decided by measure is complete. Default 1.0. The content reads it as cmi.completion_threshold. Added in the 4th Edition.', domain: 'Item', range: 'UnitInterval', functional: true, source: `${ADLCP}: completionThresholdType` },
    { name: 'progressWeight', kind: 'datatype', label: 'progress weight', notation: 'adlcp:completionThreshold/@progressWeight', comment: 'The weight, from 0 to 1, that an item\'s progress measure carries when its parent\'s progress measure is rolled up. Default 1.0. Added in the 4th Edition.', domain: 'Item', range: 'UnitInterval', functional: true, source: `${ADLCP}: completionThresholdType` },
    { name: 'dataMap', kind: 'object', label: 'shared data', notation: 'adlcp:data', comment: 'A shared data store the content an item launches has access to: one for each <adlcp:map> in the item\'s <adlcp:data>. Added in the 4th Edition.', domain: 'Item', range: 'SharedDataMap', source: `${ADLCP}: dataType` },
    { name: 'targetID', kind: 'datatype', label: 'target ID', notation: 'targetID', comment: 'The identifier of a shared data store. Required.', domain: 'SharedDataMap', range: 'xsd:anyURI', functional: true, source: `${ADLCP}: mapType` },
    { name: 'readSharedData', kind: 'datatype', label: 'read shared data', notation: 'readSharedData', comment: 'Whether the content can read the store. Default true.', domain: 'SharedDataMap', range: 'xsd:boolean', functional: true, source: `${ADLCP}: mapType` },
    { name: 'writeSharedData', kind: 'datatype', label: 'write shared data', notation: 'writeSharedData', comment: 'Whether the content can write the store. Default false.', domain: 'SharedDataMap', range: 'xsd:boolean', functional: true, source: `${ADLCP}: mapType` },
    { name: 'sharedDataGlobalToSystem', kind: 'datatype', label: 'shared data global to system', notation: 'adlcp:sharedDataGlobalToSystem', comment: 'Whether the shared data stores an organization\'s items map are global to the LMS, so other packages can reach them for the same learner (true, the default), or belong to this package (false). Added in the 4th Edition.', domain: 'Organization', range: 'xsd:boolean', functional: true, source: `${ADLCP}: sharedDataGlobalToSystem` },
  ],
  vocabularies: [
    {
      name: 'ScormType', label: 'SCORM types', comment: 'The values of adlcp:scormType on a resource.',
      members: [
        { name: 'sco', label: 'SCO', notation: 'sco', comment: 'A sharable content object: launched by the LMS, it communicates with the LMS through the run-time API.' },
        { name: 'asset', label: 'asset', notation: 'asset', comment: 'Content the LMS can launch that does not communicate with the LMS.' },
      ],
    },
    {
      name: 'TimeLimitAction', label: 'Time limit actions', comment: 'The values of adlcp:timeLimitAction, and so of cmi.time_limit_action.',
      // `name` is the IRI's local part and stays Turtle-safe (no comma or space); the token the
      // standard uses, which has them, is the skos:notation.
      members: [
        { name: 'exit-message', label: 'exit with a message', notation: 'exit,message', comment: 'Leave the SCO, and tell the learner why.' },
        { name: 'exit-no-message', label: 'exit without a message', notation: 'exit,no message', comment: 'Leave the SCO without telling the learner.' },
        { name: 'continue-message', label: 'continue with a message', notation: 'continue,message', comment: 'Stay in the SCO, and tell the learner the time is up.' },
        { name: 'continue-no-message', label: 'continue without a message', notation: 'continue,no message', comment: 'Stay in the SCO without telling the learner.' },
      ],
    },
    {
      name: 'Structure', label: 'Organization structures', comment: 'The values of an organization\'s structure attribute that SCORM uses.',
      members: [
        { name: 'hierarchical', label: 'hierarchical', notation: 'hierarchical', comment: 'A tree of items: the default structure, and the one SCORM content uses.' },
      ],
    },
  ],
  disjoint: [
    ['Manifest', 'Metadata', 'Organizations', 'Organization', 'Item', 'Resources', 'Resource', 'File', 'Dependency', 'SharedDataMap'],
  ],
  shapes: [
    {
      name: 'ManifestShape', targetClass: 'Manifest', label: 'Manifest conformance',
      comment: `A manifest has an identifier, exactly one <organizations> and exactly one <resources> (${CP}: manifestType), and, as SCORM requires, exactly one <metadata> declaring the schema "ADL SCORM" and a SCORM 2004 schema version (${CAM}).`,
      constraints: [
        { path: 'identifier', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required (attr.identifier.req)' },
        { path: 'organizations', minCount: 1, maxCount: 1, comment: 'exactly one <organizations>' },
        { path: 'resources', minCount: 1, maxCount: 1, comment: 'exactly one <resources>' },
        { path: 'metadata', minCount: 1, maxCount: 1, comment: 'SCORM requires the manifest\'s <metadata>' },
        { path: 'metadata.schema', rdfPath: ['metadata', 'schema'], minCount: 1, maxCount: 1, datatype: 'xsd:string', in: ['ADL SCORM'], comment: '<schema>ADL SCORM</schema>' },
        { path: 'metadata.schemaversion', rdfPath: ['metadata', 'schemaversion'], minCount: 1, maxCount: 1, datatype: 'xsd:string', in: [...SCORM_2004_SCHEMA_VERSIONS], comment: 'a SCORM 2004 schema version (4th, 3rd or 2nd Edition)' },
        { path: 'version', maxCount: 1, datatype: 'xsd:string', comment: 'optional (attr.version)' },
        { path: 'base', maxCount: 1, datatype: 'xsd:anyURI', comment: 'optional xml:base' },
      ],
    },
    {
      name: 'MetadataShape', targetClass: 'Metadata', label: 'Metadata conformance',
      comment: `Metadata names at most one schema and schema version, and at most one external record (${CP}: metadataType; ${ADLCP}: locationType).`,
      constraints: [
        { path: 'schema', maxCount: 1, datatype: 'xsd:string', comment: 'at most one <schema>' },
        { path: 'schemaversion', maxCount: 1, datatype: 'xsd:string', comment: 'at most one <schemaversion>' },
        { path: 'location', maxCount: 1, datatype: 'xsd:anyURI', comment: 'at most one adlcp:location' },
      ],
    },
    {
      name: 'OrganizationsShape', targetClass: 'Organizations', label: 'Organizations conformance',
      comment: `Organizations name at most one default organization. A content aggregation package — one a learner can take as a course — has at least one organization (${CAM}); a package of resources alone has none, and is not launchable.`,
      constraints: [
        { path: 'defaultOrganization', maxCount: 1, datatype: 'xsd:string', comment: 'at most one default (attr.default)' },
        { path: 'organization', minCount: 1, comment: 'at least one <organization> in a launchable package' },
      ],
    },
    {
      name: 'OrganizationShape', targetClass: 'Organization', label: 'Organization conformance',
      comment: `An organization has an identifier, a title (which SCORM requires) and at least one item (${CP}: organizationType); its structure is hierarchical; sharedDataGlobalToSystem is a boolean.`,
      constraints: [
        { path: 'identifier', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required (attr.identifier.req)' },
        { path: 'title', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'SCORM requires a <title>' },
        { path: 'item', minCount: 1, comment: 'at least one <item> (IMS CP 1.1.4)' },
        { path: 'structure', maxCount: 1, datatype: 'xsd:string', in: ['hierarchical'], comment: 'hierarchical, the default' },
        { path: 'sharedDataGlobalToSystem', maxCount: 1, datatype: 'xsd:boolean', comment: 'adlcp:sharedDataGlobalToSystem' },
      ],
    },
    {
      name: 'ItemShape', targetClass: 'Item', label: 'Item conformance',
      comment: `An item has an identifier and a title (which SCORM requires), and references at most one resource (${CP}: itemType). Its completion threshold attributes are numbers from 0 to 1 and its time limit action is one of the four ADL values (${ADLCP}).`,
      constraints: [
        { path: 'identifier', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required (attr.identifier.req)' },
        { path: 'title', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'SCORM requires a <title>' },
        { path: 'identifierref', maxCount: 1, datatype: 'xsd:string', comment: 'the resource it launches (attr.identifierref)' },
        { path: 'position', maxCount: 1, datatype: 'xsd:positiveInteger', minInclusive: 1, comment: 'its place among its siblings, in document order' },
        { path: 'isvisible', maxCount: 1, datatype: 'xsd:boolean', comment: 'attr.isvisible' },
        { path: 'parameters', maxCount: 1, datatype: 'xsd:string', comment: 'attr.parameters' },
        { path: 'timeLimitAction', maxCount: 1, datatype: 'xsd:string', in: TIME_LIMIT_ACTIONS, comment: 'adlcp:timeLimitAction' },
        { path: 'dataFromLMS', maxCount: 1, datatype: 'xsd:string', comment: 'adlcp:dataFromLMS' },
        { path: 'completionThreshold', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'the 3rd Edition threshold, from 0 to 1' },
        { path: 'completedByMeasure', maxCount: 1, datatype: 'xsd:boolean', comment: 'adlcp:completionThreshold/@completedByMeasure' },
        { path: 'minProgressMeasure', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'adlcp:completionThreshold/@minProgressMeasure, from 0 to 1' },
        { path: 'progressWeight', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'adlcp:completionThreshold/@progressWeight, from 0 to 1' },
      ],
    },
    {
      name: 'SharedDataMapShape', targetClass: 'SharedDataMap', label: 'Shared data map conformance',
      comment: `A shared data map names its store and says whether the content may read and write it (${ADLCP}: mapType).`,
      constraints: [
        { path: 'targetID', minCount: 1, maxCount: 1, datatype: 'xsd:anyURI', comment: 'required' },
        { path: 'readSharedData', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
        { path: 'writeSharedData', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
      ],
    },
    {
      name: 'ResourcesShape', targetClass: 'Resources', label: 'Resources conformance',
      comment: `Resources may set an XML base for their relative URLs (${CP}: resourcesType).`,
      constraints: [
        { path: 'base', maxCount: 1, datatype: 'xsd:anyURI', comment: 'attr.base' },
      ],
    },
    {
      name: 'ResourceShape', targetClass: 'Resource', label: 'Resource conformance',
      comment: `A resource has an identifier and a type (${CP}: resourceType) and, in SCORM, a SCORM type: sco or asset. A SCO also needs an href to launch it, which the importer checks.`,
      constraints: [
        { path: 'identifier', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required (attr.identifier.req)' },
        { path: 'type', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required (attr.resourcetype.req)' },
        { path: 'scormType', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: ['sco', 'asset'], comment: 'adlcp:scormType, required in SCORM' },
        { path: 'href', maxCount: 1, datatype: 'xsd:anyURI', comment: 'the launching file (attr.href)' },
        { path: 'base', maxCount: 1, datatype: 'xsd:anyURI', comment: 'attr.base' },
      ],
    },
    {
      name: 'FileShape', targetClass: 'File', label: 'File conformance',
      comment: `A file has exactly one href (${CP}: fileType).`,
      constraints: [
        { path: 'href', minCount: 1, maxCount: 1, datatype: 'xsd:anyURI', comment: 'required (attr.href.req)' },
        { path: 'metadata', maxCount: 1, comment: 'at most one <metadata>' },
      ],
    },
    {
      name: 'DependencyShape', targetClass: 'Dependency', label: 'Dependency conformance',
      comment: `A dependency names exactly one resource (${CP}: dependencyType).`,
      constraints: [
        { path: 'identifierref', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required (attr.identifierref.req)' },
      ],
    },
  ],
};
