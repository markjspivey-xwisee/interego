/**
 * LTI-X: the 1EdTech LTI 1.3 specification, decorated. Its parts are the launch's claims and the
 * services they hand a tool, each named by the claim's own URI. Its controls act through Foxxi, which
 * is both an LTI Tool and an LTI Platform. Its proposals say how each claim reads as xAPI, which is
 * how a launch from another LMS is recorded in Foxxi's LRS: the learner as an account on the
 * platform's issuer, the course as the statement's grouping activity.
 */
import type { DecorationSpec } from './kit.js';

const LTI = 'https://www.imsglobal.org/spec/lti/v1p3';
const AGS = 'https://www.imsglobal.org/spec/lti-ags/v2p0';
const NRPS = 'https://www.imsglobal.org/spec/lti-nrps/v2p0';
const DL = 'https://www.imsglobal.org/spec/lti-dl/v2p0';
const SEC = 'https://www.imsglobal.org/spec/security/v1p1';
const CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/';
const I2 = 'https://id.i2idl.org/concepts/';
const FX = 'https://foxxi-bridge.interego.xwisee.com/ns/xapi#';
const SIGNED = 'a request signed by the caller\'s own key (sign_request), as every signed Foxxi affordance takes';

export const LTI_X: DecorationSpec = {
  id: 'lti-x',
  title: 'LTI-X',
  version: '0.1.0',
  summary: 'The LTI 1.3 specification, decorated: each launch claim and service named by its own URI, controls that act through Foxxi as an LTI Tool and an LTI Platform, and proposals for how each claim reads as xAPI, which is how a launch from another LMS is recorded.',
  decorates: {
    name: 'the LTI 1.3 specification and LTI Advantage',
    kind: 'specification',
    publisher: '1EdTech',
    specification: { title: '1EdTech Learning Tools Interoperability Core 1.3, with Deep Linking 2.0, Assignment and Grade Services 2.0 and Names and Role Provisioning Services 2.0', url: LTI, version: '1.3' },
  },
  parts: [
    { id: 'message-type', label: 'Message type', identifier: `${CLAIM}message_type`, description: 'What a launch asks the tool to do: open a resource (LtiResourceLinkRequest) or let the user pick content (LtiDeepLinkingRequest).', cites: 'LTI 1.3 Core, message type claim', citeUrl: LTI },
    { id: 'version', label: 'LTI version', identifier: `${CLAIM}version`, description: 'The LTI version the message is written in: 1.3.0.', cites: 'LTI 1.3 Core, version claim', citeUrl: LTI },
    { id: 'deployment', label: 'Deployment', identifier: `${CLAIM}deployment_id`, description: 'Which installation of the tool on the platform the launch is for.', cites: 'LTI 1.3 Core, deployment ID claim', citeUrl: LTI },
    { id: 'resource-link', label: 'Resource link', identifier: `${CLAIM}resource_link`, description: 'The placement of the tool in a course that the learner followed: its id, and optionally its title.', cites: 'LTI 1.3 Core, resource link claim', citeUrl: LTI },
    { id: 'context', label: 'Context', identifier: `${CLAIM}context`, description: 'The course the launch came from: its id, label, title and type.', cites: 'LTI 1.3 Core, context claim', citeUrl: LTI },
    { id: 'roles', label: 'Roles', identifier: `${CLAIM}roles`, description: 'The roles the user holds, in the system, the institution and the context, as role URIs.', cites: 'LTI 1.3 Core, roles claim', citeUrl: LTI },
    { id: 'user', label: 'User identifier', identifier: 'sub', description: 'The user, as the platform\'s stable identifier for them (the OpenID sub), meaningful together with the issuer.', cites: 'LTI 1.3 Core, user identity claims', citeUrl: LTI },
    { id: 'custom', label: 'Custom parameters', identifier: `${CLAIM}custom`, description: 'Name-value pairs the platform passes as configured for the placement, such as which course to open.', cites: 'LTI 1.3 Core, custom properties claim', citeUrl: LTI },
    { id: 'ags-endpoint', label: 'Assignment and Grade Services endpoint', identifier: 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint', description: 'Where the tool may read and write the course\'s gradebook, and with which scopes.', cites: 'Assignment and Grade Services 2.0, endpoint claim', citeUrl: AGS },
    { id: 'nrps', label: 'Names and Role Provisioning Services', identifier: 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice', description: 'Where the tool may read who is in the course.', cites: 'Names and Role Provisioning Services 2.0, claim', citeUrl: NRPS },
    { id: 'deep-linking', label: 'Deep linking settings', identifier: 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings', description: 'Where and how the tool returns the content items the user picked.', cites: 'Deep Linking 2.0, settings claim', citeUrl: DL },
    { id: 'security', label: 'Security framework', identifier: 'id_token', description: 'How a launch is trusted: a third-party-initiated OpenID login, a signed id_token checked against the platform\'s key set, and client assertions for the services.', cites: '1EdTech Security Framework 1.1', citeUrl: SEC },
  ],
  controls: [
    { id: 'tool-keys', part: 'security', title: 'Read Foxxi\'s Tool key set', method: 'GET', target: '{+bridge}/lti/.well-known/jwks.json', accept: 'application/json', readOnly: true, cites: 'Security Framework, key set' },
    { id: 'tool-login', part: 'security', title: 'Start a launch at Foxxi\'s Tool (third-party-initiated login)', method: 'GET', target: '{+bridge}/lti/login{?iss,login_hint,target_link_uri,lti_message_hint,client_id,lti_deployment_id}', readOnly: true, cites: 'Security Framework, OpenID third-party initiated login' },
    { id: 'platform-configuration', part: 'security', title: 'Read Foxxi\'s Platform configuration', method: 'GET', target: '{+bridge}/lti/platform/.well-known/openid-configuration', accept: 'application/json', readOnly: true, cites: 'Dynamic Registration, platform configuration' },
    { id: 'platform-keys', part: 'security', title: 'Read Foxxi\'s Platform key set', method: 'GET', target: '{+bridge}/lti/platform/jwks.json', accept: 'application/json', readOnly: true, cites: 'Security Framework, key set' },
    { id: 'resource-launch', part: 'message-type', title: 'Have Foxxi\'s own LMS send you a resource link launch', method: 'POST', target: '{+bridge}/agent/lti/launch', contentType: 'application/json', auth: SIGNED, readOnly: false, cites: 'LTI 1.3 Core, resource link launch request' },
    { id: 'deep-link', part: 'deep-linking', title: 'Open Foxxi\'s content picker', method: 'GET', target: '{+bridge}/lti/deeplink', readOnly: true, cites: 'Deep Linking 2.0' },
    { id: 'gradebook', part: 'ags-endpoint', title: 'Read your grades in Foxxi\'s own LMS', method: 'POST', target: '{+bridge}/agent/lti/gradebook', contentType: 'application/json', auth: SIGNED, readOnly: true, cites: 'Assignment and Grade Services 2.0, result service' },
  ],
  alignments: [
    { part: 'user', relation: 'closeMatch', target: `${FX}Account`, targetLabel: 'Account', rationale: 'A launch\'s sub, with the platform\'s issuer as the home page, is an xAPI account: the identity Foxxi records another LMS\'s learner under.' },
    { part: 'context', relation: 'relatedMatch', target: `${FX}ContextActivities`, targetLabel: 'Context Activities', rationale: 'The course a launch came from is recorded as the statement\'s grouping activity, of type course.' },
    { part: 'resource-link', relation: 'relatedMatch', target: `${FX}Activity`, targetLabel: 'Activity', rationale: 'What the learner launched is the activity the statements are about.' },
    { part: 'message-type', relation: 'relatedMatch', target: `${I2}interoperability`, targetLabel: 'Interoperability', rationale: 'LTI is how a platform and a tool interoperate without a custom integration.' },
  ],
  enactments: [
    { part: 'message-type', action: 'urn:iep:action:foxxi:lti-launch-signed', role: 'realizes', rationale: 'Foxxi\'s own LMS sends a resource link launch to Foxxi\'s Tool.' },
    { part: 'ags-endpoint', action: 'urn:iep:action:foxxi:lti-gradebook-signed', role: 'realizes', rationale: 'Foxxi\'s own LMS keeps the gradebook its Tool posts grades to.' },
    { part: 'custom', action: 'urn:iep:action:foxxi:scorm-launch-signed', role: 'operationalizes', rationale: 'A placement\'s custom foxxi_course_id names the course Foxxi\'s SCORM engine plays.' },
  ],
  gaps: [
    { part: 'message-type', vocabulary: 'the I2IDL glossary (v0.0.86)', note: 'It has no term for LTI or for a learning tool launch.' },
    { part: 'roles', vocabulary: 'Foxxi\'s xAPI ontology', note: 'xAPI has no place for a user\'s role in a course; Foxxi does not record it.' },
  ],
};
