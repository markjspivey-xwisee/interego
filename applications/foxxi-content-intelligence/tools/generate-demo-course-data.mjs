#!/usr/bin/env node
/**
 * Generate the bundled demo course data from the Golf Explained SCORM
 * sample. Produces three files into a target directory:
 *
 *   admin_payload.json   — tenant catalog + users + groups + policies + events + audit + coverage + connections
 *   dashboard_data.json  — course concept graph (slides, scenes, concepts, prereq edges)
 *   transcripts.json     — per-slide synthetic transcripts (one sentence per slide)
 *
 * The demo tenant is now a generic Acme Training Co; the course is the
 * SCORM Cloud "Golf Explained" sample. No client-specific content.
 *
 * Usage:  node tools/generate-demo-course-data.mjs <out-dir>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = process.argv[2] || resolve(import.meta.dirname, '../imported');
mkdirSync(outDir, { recursive: true });

// ── Demo identity surface ──
// Tenant identity is rooted at a real Azure Container App (interego-acme-id)
// hosting the DID document at /.well-known/did.json and per-user WebID
// profile cards at /users/<slug>/profile/card . No synthetic .example
// domains: every URL below resolves over HTTPS against a live service.
const ID_HOST = 'interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const TENANT_DID = `did:web:${ID_HOST}`;
const ID_BASE = `https://${ID_HOST}`;
function webId(slug) { return `${ID_BASE}/users/${slug}/profile/card#me`; }
function mailbox(slug) { return `${slug}@${ID_HOST}`; }

// ── Course structure (mirrors the imsmanifest.xml of the Golf Explained SCO) ──

const SCENES = [
  {
    id: 'scene-etiquette',
    title: 'Etiquette',
    slides: [
      { id: 'etq-course',      title: 'On the course',                blurb: 'How to behave on the golf course — pace of play and respect for other players.' },
      { id: 'etq-distracting', title: 'Avoiding distractions',        blurb: 'Stay still and silent when others are taking their shot.' },
      { id: 'etq-play',        title: 'Order of play',                blurb: 'Player furthest from the hole plays first; honor goes to the previous hole\'s low scorer.' },
    ],
  },
  {
    id: 'scene-handicapping',
    title: 'Handicapping',
    slides: [
      { id: 'hcp-overview',    title: 'Handicapping overview',        blurb: 'A handicap is a numerical measure of a golfer\'s playing ability.' },
      { id: 'hcp-calc-score',  title: 'Calculating your score',       blurb: 'Strokes per hole are tallied and adjusted by stroke index.' },
      { id: 'hcp-calc-handi',  title: 'Calculating your handicap',    blurb: 'Average of best differentials, multiplied by 0.96.' },
      { id: 'hcp-example',     title: 'Worked example',               blurb: 'Step-through of a handicap calculation across 20 rounds.' },
    ],
  },
  {
    id: 'scene-fun',
    title: 'Having Fun',
    slides: [
      { id: 'fun-howto',       title: 'How to have fun',              blurb: 'Don\'t take it too seriously — relax, enjoy the course, breathe.' },
      { id: 'fun-friends',     title: 'Making friends',               blurb: 'Conversation between shots, compliments after good play, shared lunch after.' },
    ],
  },
  {
    id: 'scene-playing',
    title: 'Playing',
    slides: [
      { id: 'play-rules',      title: 'Rules of golf',                blurb: 'The USGA Rules of Golf govern competitive play.' },
      { id: 'play-par',        title: 'What is par?',                 blurb: 'Par is the expected number of strokes for a scratch golfer to complete a hole.' },
      { id: 'play-scoring',    title: 'Scoring',                      blurb: 'Stroke play counts every stroke; match play counts holes won.' },
      { id: 'play-other-scoring', title: 'Other scoring methods',     blurb: 'Stableford, scramble, best-ball — alternatives to stroke and match play.' },
      { id: 'play-playing',    title: 'Playing a hole',               blurb: 'Tee shot, fairway shots, approach to green, putting.' },
    ],
  },
];

// Concepts — synthetic flat list spanning the four scenes. Tier 1 = foundational, Tier 2 = derived.
const CONCEPTS = [
  // Etiquette
  { id: 'pace-of-play',         label: 'pace of play',        tier: 1, taught_in_slides: ['etq-course'],      confidence: 0.92, total_freq: 4 },
  { id: 'silent-still',         label: 'silent and still',    tier: 2, taught_in_slides: ['etq-distracting'], confidence: 0.88, total_freq: 3 },
  { id: 'order-of-play',        label: 'order of play',       tier: 1, taught_in_slides: ['etq-play'],        confidence: 0.95, total_freq: 5 },
  { id: 'honor',                label: 'honor on the tee',    tier: 2, taught_in_slides: ['etq-play'],        confidence: 0.78, total_freq: 2 },
  // Handicapping
  { id: 'handicap',             label: 'handicap',            tier: 1, taught_in_slides: ['hcp-overview', 'hcp-calc-handi'], confidence: 0.97, total_freq: 12 },
  { id: 'score',                label: 'score',               tier: 1, taught_in_slides: ['hcp-calc-score'],  confidence: 0.96, total_freq: 11 },
  { id: 'stroke-index',         label: 'stroke index',        tier: 2, taught_in_slides: ['hcp-calc-score'],  confidence: 0.83, total_freq: 4 },
  { id: 'differential',         label: 'score differential',  tier: 2, taught_in_slides: ['hcp-calc-handi', 'hcp-example'], confidence: 0.85, total_freq: 5 },
  // Having Fun
  { id: 'relaxation',           label: 'relaxation on course', tier: 1, taught_in_slides: ['fun-howto'],       confidence: 0.71, total_freq: 2 },
  { id: 'sportsmanship',        label: 'sportsmanship',       tier: 1, taught_in_slides: ['fun-friends'],     confidence: 0.80, total_freq: 3 },
  // Playing
  { id: 'rules-of-golf',        label: 'rules of golf',       tier: 1, taught_in_slides: ['play-rules'],      confidence: 0.94, total_freq: 8 },
  { id: 'par',                  label: 'par',                 tier: 1, taught_in_slides: ['play-par'],        confidence: 0.96, total_freq: 9 },
  { id: 'scratch-golfer',       label: 'scratch golfer',      tier: 2, taught_in_slides: ['play-par'],        confidence: 0.82, total_freq: 3 },
  { id: 'stroke-play',          label: 'stroke play',         tier: 1, taught_in_slides: ['play-scoring'],    confidence: 0.89, total_freq: 6 },
  { id: 'match-play',           label: 'match play',          tier: 1, taught_in_slides: ['play-scoring'],    confidence: 0.87, total_freq: 5 },
  { id: 'stableford',           label: 'stableford',          tier: 2, taught_in_slides: ['play-other-scoring'], confidence: 0.74, total_freq: 2 },
  { id: 'scramble',             label: 'scramble format',     tier: 2, taught_in_slides: ['play-other-scoring'], confidence: 0.72, total_freq: 2 },
  { id: 'tee-shot',             label: 'tee shot',            tier: 1, taught_in_slides: ['play-playing'],    confidence: 0.88, total_freq: 4 },
  { id: 'putting',              label: 'putting',             tier: 1, taught_in_slides: ['play-playing'],    confidence: 0.86, total_freq: 4 },
];

// Prereq edges — what a learner needs to know to fully grasp a concept.
const PREREQ_EDGES = [
  { from: 'score', to: 'handicap', confidence: 0.95 },
  { from: 'stroke-index', to: 'score', confidence: 0.82 },
  { from: 'differential', to: 'handicap', confidence: 0.91 },
  { from: 'score', to: 'differential', confidence: 0.84 },
  { from: 'par', to: 'score', confidence: 0.78 },
  { from: 'rules-of-golf', to: 'stroke-play', confidence: 0.81 },
  { from: 'rules-of-golf', to: 'match-play', confidence: 0.81 },
  { from: 'stroke-play', to: 'stableford', confidence: 0.70 },
  { from: 'stroke-play', to: 'scramble', confidence: 0.65 },
  { from: 'par', to: 'scratch-golfer', confidence: 0.87 },
  { from: 'order-of-play', to: 'honor', confidence: 0.83 },
  { from: 'tee-shot', to: 'order-of-play', confidence: 0.62 },
  { from: 'pace-of-play', to: 'silent-still', confidence: 0.55 },
  { from: 'sportsmanship', to: 'relaxation', confidence: 0.60 },
];

// ── Build per-slide transcripts from the blurbs (1-2 sentences each) ──

const transcripts = {};
for (const scene of SCENES) {
  for (const slide of scene.slides) {
    const path = `audio/${scene.id}/${slide.id}.mp3`;
    transcripts[path] = {
      duration: 30,
      language: 'en',
      text: slide.blurb,
    };
  }
}

// Wire transcripts into slides
const allSlides = [];
let seq = 0;
for (const scene of SCENES) {
  for (const slide of scene.slides) {
    const path = `audio/${scene.id}/${slide.id}.mp3`;
    const concept_ids = CONCEPTS.filter(c => (c.taught_in_slides ?? []).includes(slide.id)).map(c => c.id);
    allSlides.push({
      id: slide.id,
      title: slide.title,
      scene_id: scene.id,
      sequence_index: seq++,
      lms_id: slide.id,
      audio_count: 1,
      transcript_segments: [{ path, duration: 30, text: slide.blurb, language: 'en' }],
      transcript_combined: slide.blurb,
      concept_ids,
      alt_text_corpus: slide.title,
    });
  }
}

// ── dashboard_data.json ──

const dashboardData = {
  package: {
    id: 'com.scorm.golfsamples.contentpackaging.singlesco.20043rd',
    title: 'Golf Explained',
    standard: 'SCORM_2004_3',
    authoring_tool: 'Rustici Software Sample',
    authoring_version: '1.0',
    parser_version: '0.2.0',
  },
  stats: {
    manifest_items: 1,
    manifest_resources: 1,
    scenes: SCENES.length,
    slides: allSlides.length,
    audio_files: allSlides.length,
    transcripts: allSlides.length,
    audio_seconds: allSlides.length * 30,
    concepts: CONCEPTS.length,
    prereq_edges: PREREQ_EDGES.length,
  },
  scenes: SCENES.map((s, i) => ({
    id: s.id,
    title: s.title,
    scene_number: i + 1,
    slide_ids: s.slides.map(sl => sl.id),
  })),
  slides: allSlides,
  concepts: CONCEPTS,
  prereq_edges: PREREQ_EDGES,
};

// ── admin_payload.json — generic demo tenant (Acme Training Co) ──

const AUDIENCE_TAGS = [
  'new-hires', 'all-employees', 'managers', 'compliance-required', 'sales',
  'engineering', 'support', 'customer-success', 'product', 'operations',
];

// Users — 80 synthetic learners + 1 admin + 5 managers
const FIRST_NAMES = ['Alex', 'Jordan', 'Sam', 'Casey', 'Riley', 'Quinn', 'Avery', 'Morgan', 'Drew', 'Cameron', 'Taylor', 'Skyler', 'Reese', 'Rowan', 'Sage', 'Hayden', 'Parker', 'Charlie', 'Finley', 'Emerson'];
const LAST_NAMES = ['Smith', 'Johnson', 'Lee', 'Patel', 'Garcia', 'Martin', 'Nguyen', 'Brown', 'Davis', 'Wilson', 'Anderson', 'Taylor', 'Moore', 'Jackson', 'Martinez', 'White', 'Thompson', 'Harris', 'Clark', 'Lewis'];
const DEPTS = ['Engineering', 'Sales', 'Support', 'People Ops', 'Operations', 'Product'];
const JOB_TITLES = ['Engineer', 'Senior Engineer', 'Account Executive', 'Support Specialist', 'People Ops Partner', 'Operations Analyst', 'Product Manager'];

const users = [];
// Admin
users.push({
  user_id: 'u-admin',
  web_id: webId('admin'),
  name: 'Jordan Doe',
  email: mailbox('admin'),
  department: 'People Ops',
  job_title: 'L&D Administrator',
  manager_user_id: null,
  location: 'Remote',
  audience_tags: ['all-employees', 'managers'],
  status: 'active',
  employee_id: 'EMP-0001',
  hire_date: '2024-01-15',
});
// Learning engineer
users.push({
  user_id: 'u-le',
  web_id: webId('le'),
  name: 'Ngozi Kowalski',
  email: mailbox('le'),
  department: 'Learning Engineering',
  job_title: 'Learning Engineer',
  manager_user_id: 'u-admin',
  location: 'Remote',
  audience_tags: ['all-employees', 'managers', 'learning-engineering', 'engineering'],
  status: 'active',
  employee_id: 'EMP-0002',
  hire_date: '2024-03-01',
});
// Featured learner
users.push({
  user_id: 'u-joshua',
  web_id: webId('jliu'),
  name: 'Joshua Liu',
  email: mailbox('jliu'),
  department: 'Engineering',
  job_title: 'Engineer',
  manager_user_id: 'u-mgr1',
  location: 'Remote',
  audience_tags: ['all-employees', 'engineering', 'new-hires'],
  status: 'active',
  employee_id: 'EMP-0067',
  hire_date: '2025-12-20',
});
// 5 managers
for (let i = 0; i < 5; i++) {
  users.push({
    user_id: `u-mgr${i + 1}`,
    web_id: webId(`mgr${i + 1}`),
    name: `${FIRST_NAMES[i]} ${LAST_NAMES[i]}`,
    email: mailbox(`mgr${i + 1}`),
    department: DEPTS[i % DEPTS.length],
    job_title: 'Manager',
    manager_user_id: 'u-admin',
    location: 'Remote',
    audience_tags: ['all-employees', 'managers'],
    status: 'active',
    employee_id: `EMP-${100 + i}`,
    hire_date: '2023-06-01',
  });
}
// 80 regular learners
for (let i = 0; i < 80; i++) {
  const fn = FIRST_NAMES[i % FIRST_NAMES.length];
  const ln = LAST_NAMES[(i * 3) % LAST_NAMES.length];
  const dept = DEPTS[i % DEPTS.length];
  const slug = `${fn.toLowerCase()}${ln.toLowerCase()}${i}`;
  users.push({
    user_id: `u-${(i + 10).toString().padStart(4, '0')}`,
    web_id: webId(slug),
    name: `${fn} ${ln}`,
    email: mailbox(`${fn.toLowerCase()}.${ln.toLowerCase()}`),
    department: dept,
    job_title: JOB_TITLES[i % JOB_TITLES.length],
    manager_user_id: `u-mgr${(i % 5) + 1}`,
    location: i % 3 === 0 ? 'Remote' : i % 3 === 1 ? 'Atlanta, GA' : 'Denver, CO',
    audience_tags: ['all-employees', dept.toLowerCase().split(' ')[0], i < 30 ? 'new-hires' : 'compliance-required'].filter(Boolean),
    status: 'active',
    employee_id: `EMP-${200 + i}`,
    hire_date: '2024-09-01',
  });
}

// Groups — departments + audience-tag groups
const groups = [];
for (const dept of DEPTS) {
  const members = users.filter(u => u.department === dept).map(u => u.user_id);
  groups.push({
    group_id: `dept-${dept.toLowerCase().replace(/\s+/g, '-')}`,
    name: dept,
    kind: 'department',
    member_count: members.length,
    member_ids: members,
    description: `All members of ${dept}`,
  });
}
for (const tag of AUDIENCE_TAGS) {
  const members = users.filter(u => u.audience_tags?.includes(tag)).map(u => u.user_id);
  if (members.length === 0) continue;
  groups.push({
    group_id: `tag-${tag}`,
    name: tag.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join(' '),
    kind: 'audience',
    member_count: members.length,
    member_ids: members,
    description: `Members with audience tag "${tag}"`,
  });
}

// Catalog — Golf Explained + 8 stub LMS-synced courses
const catalog = [
  {
    course_id: 'golf-explained',
    title: 'Golf Explained',
    category: 'Onboarding / Demo',
    audience_tags: ['all-employees', 'new-hires'],
    owner: 'L&D Demo Library',
    authoring_tool: 'Rustici Software Sample',
    standard: 'SCORM_2004_3',
    concept_count: CONCEPTS.length,
    slide_count: allSlides.length,
    audio_seconds: allSlides.length * 30,
    modifier_count: 0,
    prereq_count: PREREQ_EDGES.length,
    parse_status: 'clean',
    shacl_violations: 0,
    last_modified: '2026-05-18',
    last_parsed: '2026-05-18',
    is_real: true,
    lms_source: 'SCORM Cloud (sample)',
  },
];
const STUB_COURSES = [
  ['stub-001', 'Phishing Awareness',                'Security',       ['all-employees', 'compliance-required']],
  ['stub-002', 'Code of Conduct',                   'Compliance',     ['all-employees']],
  ['stub-003', 'Data Classification & Handling',    'Security',       ['all-employees', 'engineering']],
  ['stub-004', 'New Hire Orientation',              'Onboarding',     ['new-hires']],
  ['stub-005', 'Company Overview & Values',         'Onboarding',     ['new-hires']],
  ['stub-006', 'Manager Foundations',               'Leadership',     ['managers']],
  ['stub-007', 'Customer Empathy in Support',       'Skills',         ['support', 'customer-success']],
  ['stub-008', 'Sales Discovery Conversations',     'Sales',          ['sales']],
];
for (const [id, title, category, tags] of STUB_COURSES) {
  catalog.push({
    course_id: id,
    title,
    category,
    audience_tags: tags,
    owner: 'LMS-synced (SCORM Cloud)',
    authoring_tool: 'Various',
    standard: 'SCORM/xAPI',
    concept_count: 0, slide_count: 0, audio_seconds: 0,
    modifier_count: 0, prereq_count: 0,
    parse_status: 'sync-stub',
    shacl_violations: 0,
    last_modified: '2026-04-12',
    last_parsed: undefined,
    is_real: false,
    lms_source: 'SCORM Cloud',
  });
}

// Policies
const policies = [];
let polCounter = 0;
function makePolicy(course, audienceTag, audienceLabel, requirement, trigger, dueDays) {
  const group = groups.find(g => g.group_id === `tag-${audienceTag}`);
  if (!group) return;
  polCounter++;
  policies.push({
    policy_id: `pol-${polCounter.toString().padStart(3, '0')}`,
    course_id: course.course_id,
    course_title: course.title,
    audience_group_id: group.group_id,
    audience_label: audienceLabel,
    audience_member_count: group.member_count,
    requirement_type: requirement,
    trigger,
    due_relative_days: dueDays,
    created_at: '2025-08-01',
    created_by_user_id: 'u-admin',
    created_by_name: 'Jordan Doe',
    enabled: true,
  });
}
makePolicy(catalog[0], 'new-hires',           'New Hires',          'required',    'on-hire', 14);
makePolicy(catalog[0], 'all-employees',       'All Employees',      'recommended', 'open',    365);
makePolicy(catalog.find(c => c.course_id === 'stub-001'), 'all-employees',       'All Employees',       'required',    'on-hire', 30);
makePolicy(catalog.find(c => c.course_id === 'stub-002'), 'all-employees',       'All Employees',       'required',    'on-hire', 14);
makePolicy(catalog.find(c => c.course_id === 'stub-003'), 'engineering',         'Engineering',         'required',    'on-hire', 60);
makePolicy(catalog.find(c => c.course_id === 'stub-004'), 'new-hires',           'New Hires',           'required',    'on-hire', 7);
makePolicy(catalog.find(c => c.course_id === 'stub-005'), 'new-hires',           'New Hires',           'required',    'on-hire', 7);
makePolicy(catalog.find(c => c.course_id === 'stub-006'), 'managers',            'Managers',            'recommended', 'open',    180);
makePolicy(catalog.find(c => c.course_id === 'stub-007'), 'support',             'Support',             'required',    'on-hire', 30);
makePolicy(catalog.find(c => c.course_id === 'stub-008'), 'sales',               'Sales',               'required',    'on-hire', 45);

// Events — synthetic enrolment records per (policy × audience-member)
const events = [];
let evCounter = 0;
for (const policy of policies) {
  const grp = groups.find(g => g.group_id === policy.audience_group_id);
  if (!grp) continue;
  for (const uid of grp.member_ids.slice(0, 40)) {
    evCounter++;
    const r = Math.random();
    const status = r < 0.55 ? 'completed' : r < 0.75 ? 'pending' : r < 0.92 ? 'overdue' : 'in_progress';
    events.push({
      event_id: `evt-${evCounter.toString().padStart(6, '0')}`,
      user_id: uid,
      course_id: policy.course_id,
      policy_id: policy.policy_id,
      assigned_at: '2025-12-20',
      due_at: '2026-01-19',
      status,
      completed_at: status === 'completed' ? '2026-01-15' : null,
      requirement_type: policy.requirement_type,
    });
  }
}

// Audit log — ~80 entries
const AUDIT_ACTIONS = [
  ['course.view', 'allowed'],
  ['course.complete', 'allowed'],
  ['policy.create', 'allowed'],
  ['policy.update', 'allowed'],
  ['policy.delete', 'denied'],
  ['credential.issue', 'allowed'],
  ['credential.revoke', 'denied'],
  ['audience.assign', 'allowed'],
  ['coverage.query', 'allowed'],
  ['admin.login', 'allowed'],
];
const audit = [];
for (let i = 0; i < 80; i++) {
  const [action, result] = AUDIT_ACTIONS[i % AUDIT_ACTIONS.length];
  const actor = users[Math.floor(Math.random() * users.length)];
  audit.push({
    audit_id: `aud-${i.toString().padStart(6, '0')}`,
    timestamp: `2026-${(3 + (i % 3)).toString().padStart(2, '0')}-${(1 + (i % 27)).toString().padStart(2, '0')}T${(8 + (i % 10)).toString().padStart(2, '0')}:${(15 + (i % 40)).toString().padStart(2, '0')}:00`,
    actor_user_id: actor.user_id,
    actor_web_id: actor.web_id,
    action,
    target_type: 'course',
    target_id: catalog[i % catalog.length].course_id,
    result,
    reason: action.startsWith('policy.') ? `policy:${policies[i % policies.length]?.policy_id ?? 'pol-001'}` : undefined,
  });
}

// Coverage — per-concept aggregate (only Golf Explained has real concepts)
const coverage = CONCEPTS.map(c => ({
  concept_label: c.label,
  taught_in_courses: ['golf-explained'],
  taught_count: 1,
  mentioned_in_courses: ['golf-explained'],
  mentioned_count: 1,
  only_mentioned_count: 0,
  categories: ['Onboarding / Demo'],
}));

// Connections — SCORM Cloud only
const connections = [
  {
    id: 'scorm-cloud-prod',
    kind: 'LMS',
    product: 'SCORM Cloud',
    instance: 'cloud.scorm.com',
    status: 'connected',
    auth_method: 'OAuth 2.0',
    last_sync: '2026-05-18T18:00:00',
    sync_frequency: 'every 6 hours',
    courses_contributed: STUB_COURSES.length,
    auth_warning: null,
  },
  {
    id: 'okta-prod',
    kind: 'IDP',
    product: 'Okta',
    instance: 'acme.okta.com',
    status: 'connected',
    auth_method: 'SAML 2.0',
    last_sync: '2026-05-18T18:00:00',
    sync_frequency: 'realtime',
    courses_contributed: 0,
    auth_warning: null,
  },
  {
    id: 'workday-hris',
    kind: 'HRIS',
    product: 'Workday',
    instance: 'acme.workday.com',
    status: 'connected',
    auth_method: 'OAuth 2.0',
    last_sync: '2026-05-18T06:00:00',
    sync_frequency: 'daily',
    courses_contributed: 0,
    auth_warning: null,
  },
  {
    id: 'lrs-watershed',
    kind: 'LRS',
    product: 'Watershed',
    instance: 'acme.watershedlrs.com',
    status: 'degraded',
    auth_method: 'Basic',
    last_sync: '2026-05-17T18:00:00',
    sync_frequency: 'every 15 minutes',
    courses_contributed: 0,
    auth_warning: 'Credential rotates 2026-06-30 — schedule reauth before expiry.',
  },
];

const adminPayload = {
  meta: {
    tenant: 'Acme Training Co (demo)',
    tenant_pod: 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/foxxi/',
    tenant_did: TENANT_DID,
    tenant_did_document_url: `${ID_BASE}/.well-known/did.json`,
    admin_user_web_id: users[0].web_id,
    admin_user_name: users[0].name,
    admin_user_role: 'L&D Administrator',
    tenant_id: 'acme-training-demo',
  },
  catalog,
  users,
  groups,
  policies,
  events,
  audit,
  coverage,
  connections,
};

writeFileSync(resolve(outDir, 'admin_payload.json'), JSON.stringify(adminPayload, null, 2));
writeFileSync(resolve(outDir, 'dashboard_data.json'), JSON.stringify(dashboardData, null, 2));
writeFileSync(resolve(outDir, 'transcripts.json'), JSON.stringify(transcripts, null, 2));

console.log('Wrote:');
console.log(`  ${resolve(outDir, 'admin_payload.json')}  (${users.length} users, ${groups.length} groups, ${catalog.length} catalog entries, ${events.length} events, ${audit.length} audit, ${connections.length} connections)`);
console.log(`  ${resolve(outDir, 'dashboard_data.json')} (${SCENES.length} scenes, ${allSlides.length} slides, ${CONCEPTS.length} concepts, ${PREREQ_EDGES.length} prereq edges)`);
console.log(`  ${resolve(outDir, 'transcripts.json')}   (${Object.keys(transcripts).length} transcripts)`);
