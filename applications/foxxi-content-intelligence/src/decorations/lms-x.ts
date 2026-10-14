/**
 * LMS-X: a learning management system an organization already runs, decorated through the 1EdTech
 * interfaces it exposes: its LTI 1.3 platform configuration and keys, the Assignment and Grade
 * Services and Names and Role Provisioning Services a launch hands a tool, and OneRoster 1.2. Bound
 * to an instance by the URLs the LMS publishes or a launch carries, it gives an agent a control for
 * each, the scope each asks for, and proposals tying each to the I2IDL glossary and to the Foxxi
 * capabilities that work with it.
 */
import type { DecorationSpec } from './kit.js';

const LTI = 'https://www.imsglobal.org/spec/lti/v1p3';
const AGS = 'https://www.imsglobal.org/spec/lti-ags/v2p0';
const NRPS = 'https://www.imsglobal.org/spec/lti-nrps/v2p0';
const DR = 'https://www.imsglobal.org/spec/lti-dr/v1p0';
const SEC = 'https://www.imsglobal.org/spec/security/v1p1';
const OR = 'https://www.imsglobal.org/spec/oneroster/v1p2';
const I2 = 'https://id.i2idl.org/concepts/';
const TOKEN = 'an OAuth 2.0 access token from the LMS\'s token endpoint, got with a signed JWT client assertion (client_credentials) for the scope';
const AGS_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope';
const ROSTER = 'an OAuth 2.0 access token for a OneRoster rostering scope: https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly, or roster.readonly';

export const LMS_X: DecorationSpec = {
  id: 'lms-x',
  title: 'LMS-X',
  version: '0.1.0',
  summary: 'A learning management system, decorated for agents through the 1EdTech interfaces it exposes: its LTI 1.3 configuration and keys, the gradebook and roster services a launch hands a tool, and OneRoster 1.2. Each control names the scope it asks for; proposals tie each interface to the I2IDL glossary and to the Foxxi capabilities that work with it.',
  decorates: {
    name: 'a learning management system that speaks LTI 1.3 Advantage and OneRoster 1.2',
    kind: 'instance',
    publisher: '1EdTech',
    alsoNotEndorsedBy: 'the vendor of any LMS it is bound to',
    specification: { title: '1EdTech LTI 1.3 Core, LTI Advantage (Assignment and Grade Services 2.0, Names and Role Provisioning Services 2.0, Dynamic Registration 1.0) and OneRoster 1.2', url: LTI, version: 'LTI 1.3, OneRoster 1.2' },
    bindings: {
      configuration: { description: 'the URL of the LMS\'s OpenID configuration, which LTI Dynamic Registration hands a tool.', example: 'https://lms.example.com/.well-known/openid-configuration' },
      jwks: { description: 'the LMS\'s public key set URL (jwks_uri in its configuration).', example: 'https://lms.example.com/lti/keys' },
      lineitems: { description: 'the line-items container URL a launch\'s AGS endpoint claim carries.', example: 'https://lms.example.com/courses/42/lineitems' },
      lineitem: { description: 'one line item\'s URL, from the container or a launch\'s AGS endpoint claim.', example: 'https://lms.example.com/courses/42/lineitems/7' },
      memberships: { description: 'the context memberships URL a launch\'s NRPS claim carries.', example: 'https://lms.example.com/courses/42/memberships' },
      oneroster: { description: 'the LMS\'s OneRoster 1.2 base URL, the root the rostering service hangs off.', example: 'https://lms.example.com' },
    },
  },
  parts: [
    { id: 'lms', label: 'Learning management system', description: 'The system that enrols learners in courses, launches what they take, and keeps their grades.', cites: 'LTI 1.3 Core, terminology (platform)', citeUrl: LTI },
    { id: 'configuration', label: 'Platform configuration', identifier: 'https://purl.imsglobal.org/spec/lti-platform-configuration', description: 'The LMS\'s OpenID configuration with its LTI platform configuration: its issuer, authorization and token endpoints, key set, and the messages it can send.', cites: 'LTI Dynamic Registration 1.0, platform configuration', citeUrl: DR },
    { id: 'keys', label: 'Platform key set', identifier: 'jwks_uri', description: 'The public keys a tool checks the LMS\'s signed launches against.', cites: '1EdTech Security Framework 1.1, key set URL', citeUrl: SEC },
    { id: 'line-items', label: 'Line items', identifier: 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint', description: 'The columns of the LMS\'s gradebook a tool may read, add or change.', cites: 'Assignment and Grade Services 2.0, line item service', citeUrl: AGS },
    { id: 'scores', label: 'Scores', identifier: 'application/vnd.ims.lis.v1.score+json', description: 'A learner\'s score for one line item, as a tool posts it.', cites: 'Assignment and Grade Services 2.0, score publish service', citeUrl: AGS },
    { id: 'results', label: 'Results', identifier: 'application/vnd.ims.lis.v2.resultcontainer+json', description: 'The grades the LMS holds for a line item, as a tool reads them.', cites: 'Assignment and Grade Services 2.0, result service', citeUrl: AGS },
    { id: 'memberships', label: 'Course memberships', identifier: 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice', description: 'Who is in the course a launch came from, with their roles.', cites: 'Names and Role Provisioning Services 2.0', citeUrl: NRPS },
    { id: 'roster', label: 'Roster', identifier: '/ims/oneroster/rostering/v1p2', description: 'The LMS\'s organizations, courses, classes, users and enrollments, as OneRoster 1.2 rostering serves them.', cites: 'OneRoster 1.2, rostering service', citeUrl: OR },
  ],
  controls: [
    { id: 'configuration', part: 'configuration', title: 'Read the LMS\'s OpenID and LTI configuration', method: 'GET', target: '{+configuration}', accept: 'application/json', readOnly: true, cites: 'Dynamic Registration, platform configuration' },
    { id: 'keys', part: 'keys', title: 'Read the LMS\'s public keys', method: 'GET', target: '{+jwks}', accept: 'application/json', readOnly: true, cites: 'Security Framework, key set' },
    { id: 'line-items-read', part: 'line-items', title: 'List the gradebook\'s line items', method: 'GET', target: '{+lineitems}{?resource_link_id,resource_id,tag,limit}', accept: 'application/vnd.ims.lis.v2.lineitemcontainer+json', auth: `${TOKEN} ${AGS_SCOPE}/lineitem.readonly or ${AGS_SCOPE}/lineitem`, readOnly: true, cites: 'AGS, line item service' },
    { id: 'line-items-add', part: 'line-items', title: 'Add a line item', method: 'POST', target: '{+lineitems}', contentType: 'application/vnd.ims.lis.v2.lineitem+json', auth: `${TOKEN} ${AGS_SCOPE}/lineitem`, readOnly: false, cites: 'AGS, line item service' },
    { id: 'score-post', part: 'scores', title: 'Post a learner\'s score', method: 'POST', target: '{+lineitem}/scores', contentType: 'application/vnd.ims.lis.v1.score+json', auth: `${TOKEN} ${AGS_SCOPE}/score`, readOnly: false, cites: 'AGS, score publish service' },
    { id: 'results-read', part: 'results', title: 'Read a line item\'s results', method: 'GET', target: '{+lineitem}/results{?user_id,limit}', accept: 'application/vnd.ims.lis.v2.resultcontainer+json', auth: `${TOKEN} ${AGS_SCOPE}/result.readonly`, readOnly: true, cites: 'AGS, result service' },
    { id: 'memberships-read', part: 'memberships', title: 'Read the course\'s members and their roles', method: 'GET', target: '{+memberships}{?role,limit}', accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json', auth: `${TOKEN} https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly`, readOnly: true, cites: 'NRPS, membership service' },
    { id: 'roster-users', part: 'roster', title: 'List users', method: 'GET', target: '{+oneroster}/ims/oneroster/rostering/v1p2/users{?limit,offset,sort,filter,fields}', accept: 'application/json', auth: ROSTER, readOnly: true, cites: 'OneRoster 1.2, getAllUsers' },
    { id: 'roster-classes', part: 'roster', title: 'List classes', method: 'GET', target: '{+oneroster}/ims/oneroster/rostering/v1p2/classes{?limit,offset,sort,filter,fields}', accept: 'application/json', auth: ROSTER, readOnly: true, cites: 'OneRoster 1.2, getAllClasses' },
    { id: 'roster-enrollments', part: 'roster', title: 'List enrollments', method: 'GET', target: '{+oneroster}/ims/oneroster/rostering/v1p2/enrollments{?limit,offset,sort,filter,fields}', accept: 'application/json', auth: ROSTER, readOnly: true, cites: 'OneRoster 1.2, getAllEnrollments' },
    { id: 'roster-courses', part: 'roster', title: 'List courses', method: 'GET', target: '{+oneroster}/ims/oneroster/rostering/v1p2/courses{?limit,offset,sort,filter,fields}', accept: 'application/json', auth: ROSTER, readOnly: true, cites: 'OneRoster 1.2, getAllCourses' },
  ],
  alignments: [
    { part: 'roster', relation: 'relatedMatch', target: `${I2}interoperability`, targetLabel: 'Interoperability', rationale: 'OneRoster exists so roster data moves between systems without re-entry.' },
    { part: 'line-items', relation: 'relatedMatch', target: `${I2}interoperability`, targetLabel: 'Interoperability', rationale: 'The gradebook service lets a tool and an LMS exchange grades through one interface.' },
    { part: 'configuration', relation: 'relatedMatch', target: `${I2}endpoint`, targetLabel: 'Endpoint', rationale: 'The configuration names the LMS\'s endpoints.' },
  ],
  enactments: [
    { part: 'lms', action: 'urn:iep:action:foxxi:connect-lms', role: 'operationalizes', rationale: 'Registers an LMS with a Foxxi tenant as a connector.' },
    { part: 'lms', action: 'urn:iep:action:foxxi:scorm-dispatch-signed', role: 'operationalizes', rationale: 'Plays a Foxxi course inside the LMS through a SCORM stub the LMS imports.' },
    { part: 'results', action: 'urn:iep:action:foxxi:lti-gradebook-signed', role: 'realizes', rationale: 'Foxxi\'s own LMS keeps a gradebook a learner reads their results from.' },
  ],
  gaps: [
    { part: 'lms', vocabulary: 'the I2IDL glossary (v0.0.86)', note: 'It has no term for a learning management system.' },
  ],
};
