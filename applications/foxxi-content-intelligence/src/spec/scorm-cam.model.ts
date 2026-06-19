/**
 * SCORM 2004 3rd Edition — Content Aggregation Model (CAM) — the single source.
 *
 * Transcribes the two normative XSDs that bind the SCORM 2004 3rd Ed CAM:
 *   - IMS Content Packaging 1.1.3  (imscp_v1p1.xsd, namespace
 *     http://www.imsglobal.org/xsd/imscp_v1p1): manifest, metadata,
 *     organizations, organization, item, resources, resource, file,
 *     dependency, schema, schemaversion, title.
 *   - ADL CP extensions 1.3        (adlcp_v1p3.xsd, namespace
 *     http://www.adlnet.org/xsd/adlcp_v1p3): scormType (on resource),
 *     location, dataFromLMS, timeLimitAction, completionThreshold.
 *
 * Composed into the PGSL lattice (composeSpecOntology) and projected to OWL/SHACL/
 * JSON-LD on dereference at <bridge>/ns/scorm-cam. The Foxxi LMS/SCORM importer
 * validates a parsed imsmanifest.xml against the SHACL shapes this model publishes
 * (validateAgainstShape) — so a content package is checked against THIS ontology,
 * and every conformance result cites its shape IRI.
 */
import type { OntologyModel } from '../spec-ontology.js';

export const SCORM_CAM_MODEL: OntologyModel = {
  module: 'scorm-cam',
  title: 'SCORM 2004 3rd Ed — Content Aggregation Model',
  description: 'OWL + SHACL ontology of the SCORM 2004 3rd Edition Content Aggregation Model (the edition whose normative XSDs ship in this repo): the IMS Content Packaging 1.1.3 manifest structure (Manifest, Metadata, Organizations, Organization, Item, Resources, Resource, File, Dependency, Schema, SchemaVersion, Title) plus the ADL CP 1.3 extensions (scormType, location, dataFromLMS, timeLimitAction, completionThreshold). Composed into PGSL and projected here; the Foxxi SCORM importer validates imsmanifest.xml against the shapes below.',
  version: '1.0.0',
  spec: 'https://adlnet.gov/projects/scorm-2004-3rd-edition/',
  derivedFrom: 'deploy/foxxi-scorm-player/site/course/imscp_v1p1.xsd ; deploy/foxxi-scorm-player/site/course/adlcp_v1p3.xsd',
  prefixes: {
    imscp: 'http://www.imsglobal.org/xsd/imscp_v1p1#',
    adlcp: 'http://www.adlnet.org/xsd/adlcp_v1p3#',
  },
  classes: [
    // --- IMS Content Packaging 1.1.3 (imscp_v1p1.xsd) ---
    { name: 'Manifest', label: 'Manifest', comment: 'The root <manifest> element describing a content package; a reusable unit of instruction carrying metadata, organizations and resources. May nest sub-manifests (imscp manifestType).' },
    { name: 'Metadata', label: 'Metadata', comment: 'A <metadata> element binding the package/element to its metadata schema and version (imscp metadataType).' },
    { name: 'Organizations', label: 'Organizations', comment: 'The <organizations> container holding zero or more organizations and naming the default one (imscp organizationsType).' },
    { name: 'Organization', label: 'Organization', comment: 'An <organization> — one hierarchical content structure (a tree of items) for a package (imscp organizationType).' },
    { name: 'Item', label: 'Item', comment: 'An <item> — a node in an organization tree; a leaf item references a resource, a cluster item nests child items (imscp itemType).' },
    { name: 'Resources', label: 'Resources', comment: 'The <resources> container holding zero or more resources (imscp resourcesType).' },
    { name: 'Resource', label: 'Resource', comment: 'A <resource> — a referenceable set of files (a SCO or an asset) with an entry-point href (imscp resourceType + adlcp:scormType).' },
    { name: 'File', label: 'File', comment: 'A <file> — a single physical file belonging to a resource (imscp fileType).' },
    { name: 'Dependency', label: 'Dependency', comment: 'A <dependency> — a reference from a resource to another resource whose files it also requires (imscp dependencyType).' },
    { name: 'Schema', label: 'Schema', comment: 'The <schema> element naming the metadata schema (imscp schemaType, e.g. "ADL SCORM").' },
    { name: 'SchemaVersion', label: 'Schema Version', comment: 'The <schemaversion> element naming the metadata schema version (imscp schemaversionType, e.g. "2004 3rd Edition").' },
    { name: 'Title', label: 'Title', comment: 'A <title> element giving a human-readable label to an organization or item (imscp titleType).' },
  ],
  properties: [
    // --- imscp common attributes ---
    { name: 'identifier', kind: 'datatype', label: 'identifier', comment: 'xsd:ID uniquely identifying the manifest/organization/item/resource within the package (imscp attr.identifier.req / attr.identifier).', range: 'xsd:string' },
    { name: 'identifierref', kind: 'datatype', label: 'identifierref', comment: 'A reference: on an item, the identifier of the Resource it launches; on a dependency, the identifier of the depended-on Resource (imscp attr.identifierref / attr.identifierref.req).', range: 'xsd:string' },
    { name: 'version', kind: 'datatype', label: 'version', comment: 'Free-text version of the manifest (imscp attr.version).', domain: 'Manifest', range: 'xsd:string' },
    { name: 'isvisible', kind: 'datatype', label: 'isvisible', comment: 'Whether the item is displayed in the organization tree presented to the learner (imscp attr.isvisible).', domain: 'Item', range: 'xsd:boolean' },
    { name: 'parameters', kind: 'datatype', label: 'parameters', comment: 'Static parameters appended to the launched resource for this item (imscp attr.parameters).', domain: 'Item', range: 'xsd:string' },
    { name: 'structure', kind: 'datatype', label: 'structure', comment: 'The structure of the organization; default "hierarchical" (imscp attr.structure.req).', domain: 'Organization', range: 'xsd:string' },
    { name: 'href', kind: 'datatype', label: 'href', comment: 'A URI: the entry-point of a resource, or the location of a file, relative to the resource/manifest base (imscp attr.href.req on file / attr.href on resource).', range: 'xsd:anyURI' },
    { name: 'type', kind: 'datatype', label: 'type', comment: 'The (required) type of the resource, e.g. "webcontent" (imscp attr.resourcetype.req).', domain: 'Resource', range: 'xsd:string' },
    { name: 'base', kind: 'datatype', label: 'xml:base', comment: 'xml:base — a base URI offsetting all relative URIs within this element (imscp attr.base on resources/resource; xml:base on manifest).', range: 'xsd:anyURI' },
    { name: 'defaultOrganization', kind: 'datatype', label: 'default', comment: 'xsd:IDREF naming which Organization is the default for the package (imscp attr.default on organizations).', domain: 'Organizations', range: 'xsd:string' },
    // --- imscp containment / structure ---
    { name: 'metadata', kind: 'object', label: 'metadata', comment: 'The metadata bound to the manifest/organization/item/resource/file (imscp metadata element).', range: 'Metadata' },
    { name: 'organizations', kind: 'object', label: 'organizations', comment: 'The organizations container of the manifest (imscp organizations element).', domain: 'Manifest', range: 'Organizations' },
    { name: 'resources', kind: 'object', label: 'resources', comment: 'The resources container of the manifest (imscp resources element).', domain: 'Manifest', range: 'Resources' },
    { name: 'subManifest', kind: 'object', label: 'manifest', comment: 'A nested sub-manifest within a manifest (imscp manifest element, 0..*).', domain: 'Manifest', range: 'Manifest' },
    { name: 'organization', kind: 'object', label: 'organization', comment: 'An organization within the organizations container (imscp organization element, 0..*).', domain: 'Organizations', range: 'Organization' },
    { name: 'item', kind: 'object', label: 'item', comment: 'A child item within an organization or a parent item (imscp item element, 0..*).', range: 'Item' },
    { name: 'resource', kind: 'object', label: 'resource', comment: 'A resource within the resources container (imscp resource element, 0..*).', domain: 'Resources', range: 'Resource' },
    { name: 'file', kind: 'object', label: 'file', comment: 'A file belonging to a resource (imscp file element, 0..*).', domain: 'Resource', range: 'File' },
    { name: 'dependency', kind: 'object', label: 'dependency', comment: 'A dependency of a resource on another resource (imscp dependency element, 0..*).', domain: 'Resource', range: 'Dependency' },
    { name: 'title', kind: 'object', label: 'title', comment: 'The title of an organization or item (imscp title element).', range: 'Title' },
    { name: 'schema', kind: 'object', label: 'schema', comment: 'The metadata schema name element (imscp schema element).', domain: 'Metadata', range: 'Schema' },
    { name: 'schemaversion', kind: 'object', label: 'schemaversion', comment: 'The metadata schema version element (imscp schemaversion element).', domain: 'Metadata', range: 'SchemaVersion' },
    // --- ADL CP 1.3 extensions (adlcp_v1p3.xsd) ---
    { name: 'scormType', kind: 'datatype', label: 'adlcp:scormType', comment: 'ADL extension attribute on a resource declaring whether it is a "sco" (launchable, RTE-communicating) or an "asset" (static) (adlcp scormType attribute).', domain: 'Resource', range: 'xsd:string' },
    { name: 'dataFromLMS', kind: 'datatype', label: 'adlcp:dataFromLMS', comment: 'ADL launch data initialised into cmi.launch_data for the SCO/item at launch (adlcp dataFromLMS element).', domain: 'Item', range: 'xsd:string' },
    { name: 'timeLimitAction', kind: 'datatype', label: 'adlcp:timeLimitAction', comment: 'ADL action the SCO should take when its time limit is exceeded (adlcp timeLimitAction element).', domain: 'Item', range: 'xsd:string' },
    { name: 'completionThreshold', kind: 'datatype', label: 'adlcp:completionThreshold', comment: 'ADL progress-measure threshold (0.0..1.0) at/above which the activity is considered completed (adlcp completionThreshold element).', domain: 'Item', range: 'xsd:decimal' },
    { name: 'location', kind: 'datatype', label: 'adlcp:location', comment: 'ADL location (URI) of an external metadata record for the element (adlcp location element).', domain: 'Metadata', range: 'xsd:anyURI' },
  ],
  vocabularies: [
    {
      name: 'ScormType', label: 'adlcp:scormType values', comment: 'The scormType attribute vocabulary on a resource (adlcp scormType restriction).',
      members: [
        { name: 'sco', label: 'sco', comment: 'A Sharable Content Object: launchable, communicates with the LMS RTE.' },
        { name: 'asset', label: 'asset', comment: 'A static asset: launchable content with no LMS RTE communication.' },
      ],
    },
    {
      name: 'TimeLimitAction', label: 'adlcp:timeLimitAction values', comment: 'The timeLimitAction element vocabulary (adlcp timeLimitActionType restriction).',
      members: [
        { name: 'exit,message', label: 'exit,message', comment: 'Exit the SCO and display a message.' },
        { name: 'exit,no message', label: 'exit,no message', comment: 'Exit the SCO without a message.' },
        { name: 'continue,message', label: 'continue,message', comment: 'Continue and display a message.' },
        { name: 'continue,no message', label: 'continue,no message', comment: 'Continue without a message.' },
      ],
    },
    {
      name: 'Structure', label: 'imscp structure values', comment: 'The organization structure attribute; SCORM 2004 mandates the default (imscp attr.structure.req).',
      members: [
        { name: 'hierarchical', label: 'hierarchical', comment: 'The default and SCORM-required organization structure.' },
      ],
    },
  ],
  shapes: [
    {
      name: 'ManifestShape', targetClass: 'Manifest', label: 'Manifest conformance',
      comment: 'imscp manifestType: a manifest MUST carry a required identifier (xsd:ID) and exactly one organizations element and exactly one resources element; version and xml:base are optional.',
      constraints: [
        { path: 'identifier', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required xsd:ID (imscp attr.identifier.req)' },
        { path: 'organizations', minCount: 1, maxCount: 1, comment: 'exactly one <organizations> (imscp manifestType)' },
        { path: 'resources', minCount: 1, maxCount: 1, comment: 'exactly one <resources> (imscp manifestType)' },
        { path: 'metadata', maxCount: 1, comment: 'optional <metadata> (imscp manifestType)' },
        { path: 'version', maxCount: 1, datatype: 'xsd:string', comment: 'optional version (imscp attr.version)' },
        { path: 'base', maxCount: 1, datatype: 'xsd:anyURI', comment: 'optional xml:base (imscp manifestType)' },
      ],
    },
    {
      name: 'MetadataShape', targetClass: 'Metadata', label: 'Metadata conformance',
      comment: 'imscp metadataType: optional schema and schemaversion children. For SCORM 2004 a package-level metadata SHOULD declare schema "ADL SCORM" and schemaversion "2004 3rd Edition".',
      constraints: [
        { path: 'schema', maxCount: 1, comment: 'optional <schema> (imscp metadataType)' },
        { path: 'schemaversion', maxCount: 1, comment: 'optional <schemaversion> (imscp metadataType)' },
        { path: 'location', maxCount: 1, datatype: 'xsd:anyURI', comment: 'optional adlcp:location of external metadata (adlcp locationType)' },
      ],
    },
    {
      name: 'OrganizationsShape', targetClass: 'Organizations', label: 'Organizations conformance',
      comment: 'imscp organizationsType: holds 0..* organizations; the optional default attribute is an xsd:IDREF pointing at one of those organizations. A conformant SCORM package SHOULD provide at least one organization.',
      constraints: [
        { path: 'defaultOrganization', maxCount: 1, datatype: 'xsd:string', comment: 'optional default org IDREF (imscp attr.default)' },
        { path: 'organization', minCount: 1, comment: 'at least one <organization> for a usable package (imscp organizationsType)' },
      ],
    },
    {
      name: 'OrganizationShape', targetClass: 'Organization', label: 'Organization conformance',
      comment: 'imscp organizationType: a required identifier (xsd:ID); a structure attribute defaulting to "hierarchical"; an optional title; 0..* items.',
      constraints: [
        { path: 'identifier', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required xsd:ID (imscp attr.identifier.req)' },
        { path: 'structure', maxCount: 1, in: ['hierarchical'], comment: 'structure default "hierarchical" (imscp attr.structure.req)' },
        { path: 'title', maxCount: 1, comment: 'optional <title> (imscp organizationType)' },
      ],
    },
    {
      name: 'ItemShape', targetClass: 'Item', label: 'Item conformance',
      comment: 'imscp itemType: a required identifier (xsd:ID); an optional identifierref pointing at the launched Resource (a leaf item) — the adlcp:completionThreshold (if present) is 0.0..1.0 and timeLimitAction (if present) is from the ADL vocabulary.',
      constraints: [
        { path: 'identifier', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required xsd:ID (imscp attr.identifier.req)' },
        { path: 'identifierref', maxCount: 1, datatype: 'xsd:string', comment: 'optional ref to a Resource identifier (imscp attr.identifierref)' },
        { path: 'isvisible', maxCount: 1, datatype: 'xsd:boolean', comment: 'optional isvisible (imscp attr.isvisible)' },
        { path: 'parameters', maxCount: 1, datatype: 'xsd:string', comment: 'optional launch parameters (imscp attr.parameters)' },
        { path: 'title', maxCount: 1, comment: 'optional <title> (imscp itemType)' },
        { path: 'timeLimitAction', maxCount: 1, in: ['exit,message', 'exit,no message', 'continue,message', 'continue,no message'], comment: 'adlcp:timeLimitAction vocabulary (adlcp timeLimitActionType)' },
        { path: 'completionThreshold', maxCount: 1, datatype: 'xsd:decimal', minInclusive: 0, maxInclusive: 1, comment: 'adlcp:completionThreshold ∈ [0.0,1.0] (adlcp completionThresholdType)' },
        { path: 'dataFromLMS', maxCount: 1, datatype: 'xsd:string', comment: 'optional adlcp:dataFromLMS launch data (adlcp dataFromLMSType)' },
      ],
    },
    {
      name: 'ResourcesShape', targetClass: 'Resources', label: 'Resources conformance',
      comment: 'imscp resourcesType: holds 0..* resources; an optional xml:base offsetting their relative URIs.',
      constraints: [
        { path: 'base', maxCount: 1, datatype: 'xsd:anyURI', comment: 'optional xml:base (imscp attr.base)' },
      ],
    },
    {
      name: 'ResourceShape', targetClass: 'Resource', label: 'Resource conformance',
      comment: 'imscp resourceType + adlcp:scormType: a required identifier (xsd:ID) and a required type; scormType (if present) is "sco" or "asset". SCORM rule: a resource whose adlcp:scormType is "sco" MUST have an href entry-point.',
      constraints: [
        { path: 'identifier', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required xsd:ID (imscp attr.identifier.req)' },
        { path: 'type', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required type, e.g. "webcontent" (imscp attr.resourcetype.req)' },
        { path: 'scormType', maxCount: 1, in: ['sco', 'asset'], comment: 'adlcp:scormType ∈ {sco,asset} (adlcp scormType restriction)' },
        { path: 'href', maxCount: 1, datatype: 'xsd:anyURI', comment: 'entry-point href — REQUIRED when scormType="sco" (enforced by the importer) (imscp attr.href)' },
        { path: 'base', maxCount: 1, datatype: 'xsd:anyURI', comment: 'optional xml:base (imscp attr.base)' },
      ],
    },
    {
      name: 'FileShape', targetClass: 'File', label: 'File conformance',
      comment: 'imscp fileType: a required href locating the physical file.',
      constraints: [
        { path: 'href', minCount: 1, maxCount: 1, datatype: 'xsd:anyURI', comment: 'required href (imscp attr.href.req)' },
        { path: 'metadata', maxCount: 1, comment: 'optional <metadata> (imscp fileType)' },
      ],
    },
    {
      name: 'DependencyShape', targetClass: 'Dependency', label: 'Dependency conformance',
      comment: 'imscp dependencyType: a required identifierref naming the depended-on Resource.',
      constraints: [
        { path: 'identifierref', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required ref to a Resource identifier (imscp attr.identifierref.req)' },
      ],
    },
  ],
};
