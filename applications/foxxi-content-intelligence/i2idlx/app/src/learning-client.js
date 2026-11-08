// Cookie-authenticated learning controls. Credentials and CSRF stay in memory.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, max = 512) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const validVersion = value => Number.isSafeInteger(value) && value >= 0 || bounded(value, 256);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = (message, code = 'learning_invalid_response') => Object.assign(new Error(message), { code });
const invalid = () => { throw fail('The learning connection returned an unsupported response. Refresh your learning account.'); };
const id = value => { if (!bounded(value)) invalid(); return value; };
const list = (value, max = 500) => { if (!Array.isArray(value) || value.length > max) invalid(); return value; };
const states = new Set(['pending-admin', 'approved', 'active', 'revoked']);

export function learningSignInUrl(raw, origin) {
  let url;
  try { url = new URL(raw, origin); } catch { invalid(); }
  if (url.origin !== new URL(origin).origin || url.pathname !== '/i2idlx/learning/oauth/start' || url.username || url.password || url.hash) invalid();
  return url.href;
}

export function learningSession(value, origin) {
  if (!object(value) || typeof value.enabled !== 'boolean' || typeof value.authenticated !== 'boolean') invalid();
  const result = { enabled: value.enabled, authenticated: value.authenticated, account: null,
    sign_in_url: value.sign_in_url ? learningSignInUrl(value.sign_in_url, origin) : null };
  if (value.authenticated) {
    if (!value.enabled || !object(value.account) || !bounded(value.csrf, 512) || !date(value.expires_at)) invalid();
    result.account = { id: id(value.account.id), userId: id(value.account.userId), webId: id(value.account.webId) };
    result.expires_at = value.expires_at;
  }
  return result;
}

export function learningLti(value) {
  if (value === undefined || value === null) return null;
  if (!object(value) || !['prepared', 'installing', 'installed', 'ready', 'removing', 'removed', 'cleanup-failed', 'unavailable'].includes(value.state)) invalid();
  const result = { state: value.state };
  if (bounded(value.note, 2000)) result.note = value.note;
  if (object(value.settings)) {
    result.settings = {};
    for (const key of ['login_url', 'launch_url', 'jwks_url']) {
      let url;
      try { url = new URL(value.settings[key]); } catch { invalid(); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443') invalid();
      result.settings[key] = url.href;
    }
    if (typeof value.settings.public_key_pem === 'string' && value.settings.public_key_pem.length <= 16000) result.settings.public_key_pem = value.settings.public_key_pem;
  }
  return result;
}

export function learningConnector(value) {
  if (!object(value) || !bounded(value.label, 200) || !['active', 'revoked'].includes(value.status) ||
      !object(value.policy) || typeof value.policy.allowAiContent !== 'boolean' || typeof value.policy.allowAiProgress !== 'boolean' ||
      value.policy.allowTargetedLaunch !== undefined && typeof value.policy.allowTargetedLaunch !== 'boolean') invalid();
  return { id: id(value.id), label: value.label, status: value.status, policy: {
    allowAiContent: value.policy.allowAiContent, allowAiProgress: value.policy.allowAiProgress, allowTargetedLaunch: value.policy.allowTargetedLaunch === true },
    ...(date(value.created_at) ? { created_at: value.created_at } : {}),
    ...(bounded(value.join_code, 512) ? { join_code: value.join_code } : {}), lti: learningLti(value.lti) };
}

export function learningLink(value) {
  if (!object(value) || !states.has(value.status) || !bounded(value.provider_label, 200)) invalid();
  return { id: id(value.id), connector_id: id(value.connector_id), provider_label: value.provider_label, status: value.status,
    ...(date(value.expires_at) ? { expires_at: value.expires_at } : {}), lti_discovered: value.lti_discovered === true };
}

export function learningResponse(operation, value, expected = {}) {
  if (!object(value)) invalid();
  if (operation === 'owned-connectors') return { connectors: list(value.connectors, 50).map(learningConnector) };
  if (operation === 'my-links') return { links: list(value.links, 50).map(learningLink) };
  if (operation === 'pending-links') return { links: list(value.links, 100).map(item => {
    if (!object(item) || !object(item.account) || !bounded(item.account.id) || !bounded(item.account.webId) || !['pending-admin', 'approved'].includes(item.status)) invalid();
    return { id: id(item.id), account: { id: item.account.id, webId: item.account.webId,
      ...(bounded(item.account.display_name, 200) ? { display_name: item.account.display_name } : {}) }, status: item.status,
      ...(date(item.requested_at) ? { requested_at: item.requested_at } : {}) };
  }) };
  if (operation === 'discover' || operation === 'request-link') {
    const connection = value.connection;
    if (!object(connection) || !bounded(connection.label, 200) || !object(connection.policy) ||
        typeof connection.policy.allowAiContent !== 'boolean' || typeof connection.policy.allowAiProgress !== 'boolean') invalid();
    return { connection: { id: id(connection.id), label: connection.label, lti_discovered: connection.lti_discovered === true,
      policy: { allowAiContent: connection.policy.allowAiContent, allowAiProgress: connection.policy.allowAiProgress } },
      ...(value.link ? { link: learningLink(value.link) } : {}) };
  }
  if (['approve-link', 'confirm-link', 'revoke-link'].includes(operation)) {
    const link = learningLink(value.link);
    if (expected.link_id && link.id !== expected.link_id) invalid();
    return { link };
  }
  if (operation === 'create-connector') return { connector: learningConnector(value.connector) };
  if (operation === 'revoke-connector' || operation === 'set-targeted-launch-policy') {
    const connector = learningConnector(value.connector);
    if (expected.connector_id && connector.id !== expected.connector_id || operation === 'set-targeted-launch-policy' && connector.policy.allowTargetedLaunch !== expected.allowTargetedLaunch) invalid();
    return { connector };
  }
  if (['prepare-lti', 'install-lti', 'remove-lti'].includes(operation)) return { lti: learningLti(value.lti) };
  if (operation === 'courses') {
    if (value.link_id !== expected.link_id || value.prerequisites?.status !== 'unavailable' || value.curriculum?.status !== 'unavailable') invalid();
    return { link_id: value.link_id, courses: list(value.courses).map(course => {
      if (!object(course) || !bounded(course.title, 400) || !validVersion(course.version)) invalid();
      return { id: id(course.id), title: course.title, version: course.version };
    }), prerequisites: { status: 'unavailable' }, curriculum: { status: 'unavailable' } };
  }
  if (operation === 'progress') {
    if (value.link_id !== expected.link_id || !date(value.as_of)) invalid();
    return { link_id: value.link_id, as_of: value.as_of, records: list(value.records).map(record => {
      if (!object(record) || !validVersion(record.version) || record.source !== 'SCORM Cloud' || !date(record.observed_at) ||
          !['UNKNOWN', 'COMPLETED', 'INCOMPLETE'].includes(record.completion) || !['UNKNOWN', 'PASSED', 'FAILED'].includes(record.success) ||
          record.score !== undefined && (typeof record.score !== 'number' || !Number.isFinite(record.score) || record.score < 0 || record.score > 100) ||
          record.total_seconds !== undefined && (typeof record.total_seconds !== 'number' || !Number.isFinite(record.total_seconds) || record.total_seconds < 0)) invalid();
      if (expected.course_id && (record.course_id !== expected.course_id || record.version !== expected.version)) invalid();
      return { course_id: id(record.course_id), version: record.version, source: record.source, completion: record.completion, success: record.success,
        observed_at: record.observed_at, ...(bounded(record.title, 400) ? { title: record.title } : {}),
        ...(record.score !== undefined ? { score: record.score } : {}), ...(record.total_seconds !== undefined ? { total_seconds: record.total_seconds } : {}) };
    }) };
  }
  invalid();
}

const ARGUMENTS = {
  'owned-connectors': [], 'my-links': [], discover: ['join_code'], 'request-link': ['join_code'],
  'pending-links': ['connector_id'], 'approve-link': ['link_id', 'registration_id', 'confirmed'], 'confirm-link': ['link_id'], 'revoke-link': ['link_id'],
  'create-connector': ['label', 'credentials', 'policy', 'intent', 'request_id'], 'revoke-connector': ['connector_id'],
  'set-targeted-launch-policy': ['connector_id', 'allowTargetedLaunch', 'confirmed'],
  courses: ['link_id'], progress: ['link_id', 'course_id', 'version'], 'prepare-lti': ['connector_id'], 'install-lti': ['connector_id'], 'remove-lti': ['connector_id'],
};
function learningArguments(operation, args) {
  if (!Object.hasOwn(ARGUMENTS, operation) || !object(args) || Object.keys(args).some(key => !ARGUMENTS[operation].includes(key))) throw fail('Unsupported learning operation.', 'learning_invalid_request');
  for (const key of ARGUMENTS[operation]) {
    if (operation === 'progress' && ['course_id', 'version'].includes(key) && args[key] === undefined) continue;
    if (['credentials', 'policy', 'confirmed', 'version', 'allowTargetedLaunch'].includes(key)) continue;
    if (!bounded(args[key], key === 'label' ? 200 : 512)) throw fail('The learning request is incomplete.', 'learning_invalid_request');
  }
  if (operation === 'progress' && (args.course_id === undefined) !== (args.version === undefined) || args.version !== undefined && !validVersion(args.version)) throw fail('Select one exact enrolled course version.', 'learning_invalid_request');
  if (operation === 'approve-link' && args.confirmed !== true) throw fail('Confirm the registration against institutional records first.', 'learning_confirmation_required');
  if (operation === 'set-targeted-launch-policy' && (typeof args.allowTargetedLaunch !== 'boolean' || args.confirmed !== true)) throw fail('Explicitly confirm this lesson-launch permission change.', 'learning_confirmation_required');
  if (operation === 'create-connector' && (!object(args.credentials) || Object.keys(args.credentials).some(key => !['app_id', 'secret'].includes(key)) ||
      !bounded(args.credentials.app_id) || !bounded(args.credentials.secret, 8192) || !object(args.policy) ||
      Object.keys(args.policy).some(key => !['allowAiContent', 'allowAiProgress'].includes(key)) ||
      typeof args.policy.allowAiContent !== 'boolean' || typeof args.policy.allowAiProgress !== 'boolean' || args.intent !== 'authorize-enrolled-learners')) throw fail('Provide explicit learning connection permissions.', 'learning_invalid_request');
  return { operation, ...args };
}

export function createLearningClient(options = {}) {
  const fetcher = options.fetch || globalThis.fetch, origin = options.origin || (() => globalThis.location.origin);
  const now = options.now || Date.now;
  let session = null, csrf = '', generation = 0, refreshing = false;
  const requests = new Set(), listeners = new Set();
  const publish = () => { for (const listener of listeners) listener(session); };
  const invalidate = () => { generation++; for (const controller of requests) controller.abort(); requests.clear(); };
  const clear = () => { invalidate(); session = null; csrf = ''; publish(); };
  async function transport(path, init, signal, run) {
    const controller = new AbortController(), stop = () => controller.abort(); requests.add(controller);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const check = () => { if (controller.signal.aborted || run !== generation) throw fail('Cancelled.', 'cancelled'); };
    try {
      check();
      const response = await fetcher(path, { ...init, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      check();
      if (response.redirected || response.url && new URL(response.url, origin()).origin !== new URL(origin()).origin) throw fail('The learning connection refused an unexpected redirect.');
      let value;
      try { value = await response.json(); } catch { throw fail('The learning connection returned an unreadable response.'); }
      check();
      if (!response.ok) {
        const code = bounded(value?.code, 100) ? value.code : typeof value?.error === 'string' && /^learning_[a-z_]+$/.test(value.error) ? value.error : 'learning_unavailable';
        if (['learning_sign_in_required', 'learning_session_expired', 'learning_account_invalid', 'learning_csrf_refused', 'learning_csrf_invalid'].includes(code) ||
            response.status === 401 && !code.startsWith('learning_provider_')) { clear(); throw fail('Sign in to your learning account again.', 'learning_sign_in_required'); }
        const messages = { learning_link_required: 'Activate a verified learning account link first.', learning_enrollment_required: 'Your enrollment could not be confirmed. Refresh your courses.', learning_link_revoked: 'This learning account link ended.', learning_permission_required: 'This learning connection has not authorized the requested sharing.', learning_rate_limited: 'The learning connection is busy. Try again shortly.' };
        throw Object.assign(fail(messages[code] || 'The learning operation could not be completed. Refresh its status before trying again.', code), { status: response.status });
      }
      if (!object(value) || JSON.stringify(value).length > 2 * 1024 * 1024) invalid();
      return value;
    } finally { requests.delete(controller); signal?.removeEventListener('abort', stop); }
  }
  const client = {
    snapshot: () => session,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async refresh(signal) {
      invalidate(); const run = generation; refreshing = true;
      try {
        const value = await transport('/i2idlx/learning/session', { method: 'GET', headers: { Accept: 'application/json' } }, signal, run);
        const next = learningSession(value, origin());
        if (run !== generation) throw fail('Cancelled.', 'cancelled');
        csrf = next.authenticated ? value.csrf : ''; session = next; publish(); return next;
      } finally { if (run === generation) refreshing = false; }
    },
    async request(operation, args = {}, signal) {
      if (!session?.authenticated || !csrf) throw fail('Sign in to your learning account first.', 'learning_sign_in_required');
      if (Date.parse(session.expires_at) <= now()) { clear(); throw fail('Your learning sign-in expired.', 'learning_sign_in_required'); }
      if (refreshing) throw fail('Your learning account is being checked.', 'learning_busy');
      const body = learningArguments(operation, args), run = generation;
      return learningResponse(operation, await transport('/i2idlx/api/learning', { method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-I2IDLX-Learning-CSRF': csrf }, body: JSON.stringify(body) }, signal, run), args);
    },
    async launch(args, signal) {
      if (!object(args) || Object.keys(args).some(key => !['link_id', 'course_id', 'version', 'location_ref'].includes(key)) ||
          !bounded(args.link_id) || !bounded(args.course_id) || !Number.isSafeInteger(args.version) || args.version < 0 ||
          args.location_ref !== undefined && (typeof args.location_ref !== 'string' || !/^[a-f0-9]{64}$/.test(args.location_ref))) throw fail('Select one verified enrolled course to open.', 'learning_invalid_request');
      const identity = session?.authenticated ? session.account.id : null;
      if (!identity) throw fail('Sign in to your learning account first.', 'learning_sign_in_required');
      // A deliberate launch gets current human authorization and CSRF, independently of AI pairing.
      const current = await client.refresh(signal);
      if (!current.authenticated || current.account.id !== identity) throw fail('Your learning account changed. Select your enrolled course again.', 'learning_sign_in_required');
      const run = generation;
      return learningLaunch(await transport('/i2idlx/api/learning/launch', { method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-I2IDLX-Learning-CSRF': csrf },
        body: JSON.stringify(args) }, signal, run), { targeted: args.location_ref !== undefined, now: now() });
    },
    async signOut(signal) {
      const token = csrf; clear(); refreshing = false;
      if (token) await transport('/i2idlx/learning/sign-out', { method: 'POST', headers: { Accept: 'application/json', 'X-I2IDLX-Learning-CSRF': token } }, signal, generation);
    },
    clear,
    dispose() { clear(); listeners.clear(); },
  };
  return client;
}

export function learningLaunchUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { invalid(); }
  const prefix = '/api/cloud/registration/launch/';
  if (!bounded(raw, 8192) || url.protocol !== 'https:' || url.hostname !== 'cloud.scorm.com' || url.username || url.password ||
      url.port && url.port !== '443' || url.hash || !url.pathname.startsWith(prefix) || url.pathname.length <= prefix.length) invalid();
  return url.href;
}

export function learningLaunch(value, { targeted = false, now = Date.now() } = {}) {
  if (!object(value) || !date(value.expires_at) || Date.parse(value.expires_at) <= now || Date.parse(value.expires_at) > now + 301_000 ||
      value.tracking !== true || !bounded(value.notice, 2000) || !object(value.destination) ||
      value.destination.kind !== (targeted ? 'activity' : 'course') || !bounded(value.destination.title, 400)) invalid();
  const destination = { kind: value.destination.kind, title: value.destination.title };
  if (value.destination.source_file !== undefined) destination.source_file = sourceFile(value.destination.source_file);
  return { launch_url: learningLaunchUrl(value.launch_url), expires_at: value.expires_at, destination, tracking: true, notice: value.notice };
}

// Only the pending blank window is retained. Successful course navigation is handed to
// the learner; later local revocation cannot revoke Cloud's already opened session.
export function createLearningLauncher(client, { open = (...args) => globalThis.window.open(...args) } = {}) {
  let pending = null;
  const close = opened => { try { opened?.close(); } catch {} };
  const cancel = () => { const old = pending; pending = null; if (old) { old.controller.abort(); close(old.opened); } };
  return {
    cancel,
    async open(args, { signal, current = () => true } = {}) {
      cancel();
      if (signal?.aborted || !current()) throw fail('Cancelled.', 'cancelled');
      let opened;
      try { opened = open('about:blank', '_blank'); } catch { /* A browser may refuse a new window. */ }
      if (!opened) throw fail('Allow a new course window, then choose Open course again.', 'learning_popup_blocked');
      const controller = new AbortController(), task = { opened, controller }; pending = task;
      const stop = () => { if (pending === task) cancel(); };
      signal?.addEventListener('abort', stop, { once: true });
      try {
        opened.opener = null;
        const referrer = opened.document.createElement('meta');
        referrer.name = 'referrer'; referrer.content = 'no-referrer'; opened.document.head.appendChild(referrer);
        if (signal?.aborted) stop();
        const value = await client.launch(args, controller.signal);
        if (pending !== task || controller.signal.aborted || !current()) throw fail('Cancelled.', 'cancelled');
        if (opened.closed) throw fail('The course window was closed. Choose Open course to try again.', 'learning_popup_closed');
        opened.location.replace(value.launch_url);
        pending = null;
        // Never return the capability URL to React state, conversation history or model context.
        const { expires_at, destination, tracking, notice } = value;
        return { expires_at, destination, tracking, notice };
      } catch (error) {
        if (pending === task) { pending = null; controller.abort(); close(opened); }
        throw error;
      } finally { signal?.removeEventListener('abort', stop); }
    },
  };
}

function sourceFile(value) {
  if (!bounded(value, 1024) || /[\\%?#:]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) invalid();
  return value;
}

export function learningNavigation(value, citations) {
  if (value === undefined) return undefined;
  if (!object(value) || !object(value.course) || value.course.kind !== 'course') invalid();
  const seen = new Set(), cited = new Set(citations.map(citation => citation.id));
  return { course: { kind: 'course' }, locations: list(value.locations, 100).map(location => {
    if (!object(location) || !bounded(location.citation_id, 200) || !cited.has(location.citation_id) || seen.has(location.citation_id) ||
        location.precision !== 'published-file' || !['course', 'activity'].includes(location.target_kind) ||
        location.target_kind === 'activity' && (typeof location.location_ref !== 'string' || !/^[a-f0-9]{64}$/.test(location.location_ref)) || location.target_kind === 'course' && location.location_ref !== undefined) invalid();
    seen.add(location.citation_id);
    return { citation_id: location.citation_id, source_file: sourceFile(location.source_file), precision: 'published-file', target_kind: location.target_kind,
      ...(location.target_kind === 'activity' ? { location_ref: location.location_ref } : {}), ...(bounded(location.title, 400) ? { title: location.title } : {}) };
  }) };
}

export function selectedLearningPacket(value, { link_id, course, share_content, share_progress }) {
  if (!object(value) || !object(value.source) || value.source.course_id !== course.id || value.source.version !== course.version ||
      value.source.provider !== 'scorm-cloud' || !bounded(value.source.source_version, 256) || !object(value.access) || value.access.link_id !== link_id ||
      !object(value.access.sharing) || value.access.sharing.content !== share_content || value.access.sharing.progress !== share_progress ||
      !object(value.interventionContext) || !object(value.interventionContext.source_context) || !Array.isArray(value.citations) || value.citations.length > 100 || !Array.isArray(value.missing_context) ||
      typeof value.authorization_ticket !== 'string' || !/^[a-f0-9]{64}$/.test(value.authorization_ticket)) invalid();
  if (!share_content && !share_progress || value.authorization_ticket && JSON.stringify(value.interventionContext).includes(value.authorization_ticket)) invalid();
  const citations = value.citations.map(citation => { if (!object(citation) || !bounded(citation.id, 200)) invalid(); return { id: citation.id, ...(bounded(citation.title, 400) ? { title: citation.title } : {}) }; });
  const navigation = learningNavigation(value.navigation, citations);
  return { source: { provider: value.source.provider, course_id: course.id, version: course.version, source_version: value.source.source_version },
    access: { link_id, sharing: { content: share_content, progress: share_progress } }, interventionContext: value.interventionContext,
    citations, ...(navigation ? { navigation } : {}),
    missing_context: value.missing_context.filter(item => bounded(item, 2000)).slice(0, 30),
    ...(value.authorization_ticket ? { authorization_ticket: value.authorization_ticket } : {}) };
}
