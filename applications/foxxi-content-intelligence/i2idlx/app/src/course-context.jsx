import { userCourseRequest, userCourseSample, subscribeAgentSession, workbenchConnectionStatus } from './interego-caps.js';

const { useState, useEffect, useRef } = React;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validVersion = value => Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && value.length > 0 && value.length <= 256;
const keyOf = course => JSON.stringify([course.id, course.version]);
const ready = session => session?.state === 'connected' && (!session.monitoring || session.monitoring === 'ready');
const providers = { 'scorm-cloud': 'SCORM Cloud', 'source-service': 'Course source service' };
const accessModes = {
  transient: { label: 'Read on demand', description: 'Foxxi temporarily downloads the course package for each question. It does not keep a reusable course cache.' },
  cached: { label: 'Keep a temporary local content graph', description: 'Foxxi keeps extracted text and a graph of the published course structure in this session until permission expires. It does not cache the original package or media.' },
  virtual: { label: 'Query at source (virtual)', description: 'The source searches its own course and returns relevant passages. Foxxi does not download the course package or keep a local course graph.' },
};
const modesFor = course => Array.isArray(course?.access_modes) ? course.access_modes.filter(mode => Object.hasOwn(accessModes, mode)) : [];
const validGrant = value => object(value) && typeof value.id === 'string' && value.id.length > 0 && Object.hasOwn(accessModes, value.mode) && typeof value.expires_at === 'string' && Number.isFinite(Date.parse(value.expires_at));
const dateLabel = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unreported';

export function selectedCoursePacket(value, connectionId, course, grant = null, provider = 'scorm-cloud') {
  if (!object(value) || value.connection_id !== connectionId || !object(value.source) ||
      !Object.hasOwn(providers, provider) || value.source.provider !== provider || value.source.course_id !== course.id ||
      !validVersion(value.source.version) || value.source.version !== course.version || !sha256(value.source.content_sha256) ||
      (provider === 'scorm-cloud' && !sha256(value.source.package_sha256)) ||
      (provider === 'source-service' && value.source.package_sha256 !== undefined) ||
      !object(value.interventionContext) || !Array.isArray(value.citations) ||
      grant && (!validGrant(grant) || !object(value.access) || value.access.mode !== grant.mode ||
        !validGrant(value.access.permission) || value.access.permission.id !== grant.id || value.access.permission.mode !== grant.mode)) {
    throw new Error('The returned course context does not match your selected source and permission. Select the course again.');
  }
  return value;
}

function deletionMessage(value) {
  if (value?.deleted !== true || value.permission_revoked !== true) return 'Deletion was not confirmed. Disconnect the course source to end this temporary connection.';
  const status = value.remote_deletion?.status;
  if (status === 'submitting') return 'The local text, graph and permission were removed. The source deletion request is being submitted; no receipt has been confirmed yet.';
  if (status === 'pending') return 'The local text, graph and permission were removed. The source service accepted a deletion request for its derived content; completion is pending.';
  if (status === 'completed') return 'The local text, graph and permission were removed. The source service reports that its derived content was deleted. The original hosted course is unchanged.';
  if (status === 'failed') return 'The local text, graph and permission were removed. The source service did not confirm the remote deletion request. You can retry it.';
  if (status === 'unsupported') return 'The local text, graph and permission were removed. This source does not offer remote deletion requests; only this session’s deletion is confirmed.';
  return 'The local text, graph and permission were removed from this session. Passages already shared with your AI client are outside this deletion.';
}

function recoveredDeletion(value, connectionId, course) {
  const result = value?.deletion;
  if (value?.connection_id !== connectionId || value?.course_id !== course.id || value?.version !== course.version ||
      !object(result) || typeof result.grant_id !== 'string' || !/^[a-f0-9]{48}$/.test(result.grant_id) ||
      result.deleted !== true || result.permission_revoked !== true || !object(result.remote_deletion)) return null;
  return { target: { connection_id: connectionId, course_id: course.id, version: course.version, grant_id: result.grant_id },
    operation: 'request-deletion', result };
}

const deletionNotice = (value, currentGrant, target) => (currentGrant && currentGrant.id !== target.grant_id ? 'Earlier deletion request: ' : '') + deletionMessage(value);

export function useCourseContext(engine) {
  const [agent, setAgent] = useState(() => workbenchConnectionStatus().agent);
  const [provider, setProvider] = useState('scorm-cloud');
  const [connection, setConnection] = useState(null), [courses, setCourses] = useState([]);
  const [page, setPage] = useState(null), [selected, setSelected] = useState(null), [packet, setPacket] = useState(null);
  const [grant, setGrant] = useState(null), [accessMode, setAccessMode] = useState(''), [cache, setCache] = useState(null);
  const [authority, setAuthority] = useState(''), [acknowledged, setAcknowledged] = useState(false), [retention, setRetention] = useState('10');
  const [refresh, setRefresh] = useState(false), [deletion, setDeletion] = useState(null), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [courseMode, setCourseMode] = useState(false);
  const appId = useRef(null), secret = useRef(null), serviceUrl = useRef(null), sourceToken = useRef(null);
  const request = useRef(null), generation = useRef(0), mode = useRef(false), mounted = useRef(true), initialized = useRef(false);
  const eligible = ready(agent), sessionId = agent?.connectionId;
  const clearCredentials = () => {
    for (const field of [appId, secret, serviceUrl, sourceToken]) if (field.current) field.current.value = '';
  };
  const invalidate = () => { generation.current++; request.current?.abort(); request.current = null; setLoading(false); };
  const clearApproval = () => { setGrant(null); setPacket(null); setCache(null); setAcknowledged(false); setAuthority(''); setRefresh(false); };
  const clearSelection = () => { setSelected(null); clearApproval(); setAccessMode(''); setDeletion(null); setNotice(''); };
  const clearSource = () => { setConnection(null); setCourses([]); setPage(null); clearSelection(); clearCredentials(); };
  const current = run => mounted.current && generation.current === run;
  const clearCourseIntent = () => {
    invalidate(); clearSelection(); setError(''); mode.current = false; setCourseMode(false);
  };
  useEffect(() => engine.registerCourseContext({ active: () => mode.current, clear: clearCourseIntent }), [engine.registerCourseContext]);
  useEffect(() => subscribeAgentSession(setAgent), []);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; generation.current++; request.current?.abort(); clearCredentials();
    if (mode.current) engine.reset();
  }; }, [engine.reset]);
  useEffect(() => {
    invalidate(); clearSource();
    if (initialized.current) engine.reset();
    initialized.current = true; setError('');
    if (!eligible) {
      if (mode.current) setError('Your course connection ended. Reconnect the AI agent and course source, or choose Use glossary only.');
      return;
    }
    const run = generation.current, controller = new AbortController(); request.current = controller;
    userCourseRequest({ operation: 'status' }, controller.signal).then(value => {
      if (current(run) && value.connected && typeof value.connection_id === 'string' && Object.hasOwn(providers, value.provider)) {
        setConnection(value); setProvider(value.provider);
      }
    }).catch(e => { if (current(run) && e.code !== 'cancelled' && !controller.signal.aborted) setError(e.message); });
  }, [sessionId, eligible, engine.reset]);
  useEffect(() => {
    if (!grant) return;
    const expire = () => {
      invalidate(); clearApproval(); engine.reset(); setError('Your course permission expired. Confirm fresh permission before asking again.');
    };
    const remaining = Date.parse(grant.expires_at) - Date.now();
    if (remaining <= 0) { expire(); return; }
    const timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [grant?.id, grant?.expires_at, engine.reset]);

  function begin() {
    invalidate(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(''); return { run: generation.current, controller };
  }
  function failed(e, run, controller) {
    if (!current(run) || controller.signal.aborted) return;
    if (['course_connection_expired', 'course_connection_not_found', 'course_provider_authentication_failed', 'session_expired', 'session_unauthorized'].includes(e.code)) {
      clearSource(); engine.reset();
    } else if (['course_permission_expired', 'course_permission_required', 'course_permission_revoked', 'course_grant_not_found', 'course_grant_expired'].includes(e.code)) {
      clearApproval(); engine.reset();
    }
    setError(e.message || 'The course source is unavailable.');
  }
  async function list(connectionId, nextPage, signal) {
    const value = await userCourseRequest({ operation: 'courses', connection_id: connectionId, ...(nextPage ? { page: nextPage } : {}) }, signal);
    if (value.connection_id !== connectionId || !Array.isArray(value.courses)) throw new Error('The source returned an invalid course list.');
    return { courses: value.courses.filter(course => object(course) && typeof course.id === 'string' && typeof course.title === 'string' && validVersion(course.version)), page: value.next_page || null };
  }
  async function connect() {
    if (!eligible || loading || engine.busy) return;
    let credentials;
    if (provider === 'scorm-cloud') {
      const id = appId.current?.value.trim(), password = secret.current?.value;
      if (!id || !password) { setError('Enter your SCORM Cloud application ID and secret.'); return; }
      credentials = { type: 'basic', app_id: id, secret: password };
    } else {
      const url = serviceUrl.current?.value.trim(), token = sourceToken.current?.value;
      if (!url || !token) { setError('Enter the source service URL and its scoped access token.'); return; }
      credentials = { service_url: url, token };
    }
    const { run, controller } = begin(); clearSource(); engine.reset();
    try {
      const value = await userCourseRequest({ operation: 'connect', provider, credentials }, controller.signal);
      if (!current(run)) return;
      if (!value.connected || typeof value.connection_id !== 'string' || value.provider !== provider) throw new Error('The course source did not confirm this connection.');
      setConnection(value);
      const result = await list(value.connection_id, null, controller.signal);
      if (current(run)) { setCourses(result.courses); setPage(result.page); }
    } catch (e) { failed(e, run, controller); }
    finally { clearCredentials(); credentials = null; if (current(run)) setLoading(false); }
  }
  async function browse(more = false) {
    if (!connection || loading || engine.busy) return;
    const { run, controller } = begin();
    try {
      const result = await list(connection.connection_id, more ? page : null, controller.signal);
      if (!current(run)) return;
      setCourses(old => more ? [...new Map([...old, ...result.courses].map(course => [keyOf(course), course])).values()] : result.courses);
      setPage(result.page);
      if (!more) { clearSelection(); engine.reset(); }
    } catch (e) { failed(e, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  async function choose(value) {
    const { run, controller } = begin(); engine.reset(); clearSelection();
    const course = courses.find(item => keyOf(item) === value) || null;
    mode.current = !!course; setCourseMode(!!course); setSelected(course);
    if (!course || !connection) { setLoading(false); return; }
    try {
      const value = await userCourseRequest({ operation: 'access-status', connection_id: connection.connection_id, course_id: course.id, version: course.version }, controller.signal);
      if (!current(run)) return;
      if (validGrant(value.grant) && modesFor(course).includes(value.grant.mode)) { setGrant(value.grant); setAccessMode(value.grant.mode); }
      setCache(object(value.cache) ? value.cache : null);
      const receipt = recoveredDeletion(value, connection.connection_id, course);
      if (receipt) { setDeletion(receipt); setNotice(deletionNotice(receipt.result, value.grant, receipt.target)); }
    } catch (e) { failed(e, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  async function permit() {
    if (!connection || !selected || loading || engine.busy || !modesFor(selected).includes(accessMode)) return;
    if (!acknowledged || !['owner', 'authorized-by-owner'].includes(authority)) { setError('Confirm the course owner’s permission and your authority before continuing.'); return; }
    const { run, controller } = begin(); clearApproval(); engine.reset(); setDeletion(null); setNotice('');
    try {
      const value = await userCourseRequest({ operation: 'grant', connection_id: connection.connection_id, course_id: selected.id, version: selected.version,
        mode: accessMode, permission: { authorized: true, authority, retention_minutes: Number(retention) } }, controller.signal);
      if (!current(run)) return;
      if (!validGrant(value.grant) || value.grant.mode !== accessMode) throw new Error('The course source did not confirm the requested permission.');
      setGrant(value.grant); setCache(object(value.cache) ? value.cache : null);
    } catch (e) { failed(e, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  async function erase(operation = 'delete', priorTarget = null) {
    if (!eligible || !connection || !selected) return;
    const target = priorTarget || (grant ? { connection_id: connection.connection_id, course_id: selected.id, version: selected.version, grant_id: grant.id } : null);
    if (!target) return;
    const { run, controller } = begin(); clearApproval(); engine.reset(); setNotice('');
    setDeletion({ target, operation, checking: true });
    try {
      const value = await userCourseRequest({ operation, ...target }, controller.signal);
      if (!current(run)) return;
      setDeletion({ target, operation, result: value }); setNotice(deletionMessage(value));
    } catch (e) {
      if (current(run) && !controller.signal.aborted) setDeletion({ target, operation, uncertain: true });
      failed(e, run, controller);
    } finally { if (current(run)) setLoading(false); }
  }
  async function checkDeletion() {
    const requestId = deletion?.result?.remote_deletion?.request_id;
    if (!deletion?.target || !requestId || loading) return;
    const target = deletion.target, { run, controller } = begin();
    try {
      const value = await userCourseRequest({ operation: 'deletion-status', ...target, request_id: requestId }, controller.signal);
      if (!current(run)) return;
      setDeletion({ target, operation: 'request-deletion', result: value }); setNotice(deletionNotice(value, grant, target));
    } catch (e) { failed(e, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  async function refreshDeletion() {
    if (!connection || !selected || loading) return;
    const { run, controller } = begin();
    try {
      const value = await userCourseRequest({ operation: 'access-status', connection_id: connection.connection_id, course_id: selected.id, version: selected.version }, controller.signal);
      if (!current(run)) return;
      const receipt = recoveredDeletion(value, connection.connection_id, selected);
      if (receipt) { setDeletion(receipt); setNotice(deletionNotice(receipt.result, value.grant, receipt.target)); }
      else setError('This connection has not returned a deletion receipt. No remote completion is confirmed.');
    } catch (e) { failed(e, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  function changeMode(value) {
    setAccessMode(value); setDeletion(null); setNotice('');
    if (grant) return erase();
    invalidate(); clearApproval(); engine.reset(); setError('');
  }
  function glossaryOnly() { clearCourseIntent(); engine.reset(); }
  async function disconnect() {
    const { run, controller } = begin(); clearSource(); engine.reset(); mode.current = false; setCourseMode(false);
    try { if (eligible) await userCourseRequest({ operation: 'disconnect' }, controller.signal); }
    catch (e) { failed(e, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  async function send(text, ids = engine.ctx) {
    const question = (text || '').trim();
    if (!question || loading || engine.busy) return;
    if (!courseMode) return engine.send(question, ids);
    if (!eligible || !connection || !selected) { setError('Reconnect your course source and select a course before asking about it.'); return; }
    if (!grant || grant.mode !== accessMode || Date.parse(grant.expires_at) <= Date.now()) { setError('Confirm current course permission and an access mode before asking.'); return; }
    const pairedSample = userCourseSample();
    if (!pairedSample) { setError('Reconnect your paired AI agent before sharing course passages.'); return; }
    const { run, controller } = begin(), conversation = engine.captureGeneration();
    try {
      const value = selectedCoursePacket(await userCourseRequest({ operation: 'source', connection_id: connection.connection_id, course_id: selected.id,
        version: selected.version, question, grant_id: grant.id, ...(grant.mode === 'cached' && refresh ? { refresh: true } : {}) }, controller.signal), connection.connection_id, selected, grant, connection.provider);
      if (!current(run) || engine.captureGeneration() !== conversation) return;
      setGrant(value.access.permission); setRefresh(false); setCache(object(value.access?.cache) ? value.access.cache : null);
      if (packet && packet.source.content_sha256 !== value.source.content_sha256) {
        engine.reset(); setPacket(value); setError('The course content changed, so the conversation was cleared. Ask again to use the refreshed source.'); return;
      }
      setPacket(value);
      const identity = JSON.stringify([value.source.provider, value.source.course_id, value.source.version, value.source.content_sha256, grant.id, grant.mode]);
      await engine.send(question, ids, value.interventionContext, pairedSample, identity);
    } catch (e) { failed(e, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  function stop() { invalidate(); engine.stop(); }
  const blocked = courseMode && (!eligible || !connection || !selected || !grant);
  const selectedModes = modesFor(selected), sourceName = providers[connection?.provider || provider];
  const remoteDeletion = deletion?.result?.remote_deletion;
  const panel = <details className="note" style={{ display: 'block' }} data-testid="ask-course-source">
    <summary><b>Ask about a course</b>{selected ? ' · ' + selected.title : ''}</summary>
    <div className="stack" style={{ gap: 12, marginTop: 12 }}>
      <p className="small">Choose a course source, then confirm the owner’s permission and how the course may be read. Clicking Ask shares the selected passages with your paired AI agent.</p>
      {!eligible ? <p className="note small">Use Connect in the toolbar to pair an active AI agent first.</p> : null}
      {!connection ? <div className="stack" style={{ gap: 10 }}>
        <label className="stack small">Course source<select className="input" aria-label="Course source provider" value={provider} disabled={!eligible || loading} onChange={event => { clearCredentials(); setProvider(event.target.value); setError(''); }}><option value="scorm-cloud">SCORM Cloud</option><option value="source-service">LMS or publisher source service</option></select></label>
        {provider === 'scorm-cloud' ? <>
          <label className="stack small">SCORM Cloud application ID<input className="input" ref={appId} aria-label="SCORM Cloud application ID" autoComplete="off" disabled={!eligible || loading} /></label>
          <label className="stack small">SCORM Cloud secret<input className="input" type="password" ref={secret} aria-label="SCORM Cloud secret" autoComplete="off" disabled={!eligible || loading} /></label>
        </> : <>
          <p className="small muted">Use the source service connection supplied by your LMS or course owner. An ordinary course URL or LTI launch link does not provide content access.</p>
          <label className="stack small">Source service URL<input className="input" type="url" ref={serviceUrl} aria-label="Source service URL" autoComplete="off" disabled={!eligible || loading} /></label>
          <label className="stack small">Source service access token<input className="input" type="password" ref={sourceToken} aria-label="Source service access token" autoComplete="off" disabled={!eligible || loading} /></label>
        </>}
        <button className="btn" disabled={!eligible || loading || engine.busy} onClick={connect}>{provider === 'scorm-cloud' ? 'Connect my SCORM Cloud' : 'Connect course source'}</button>
      </div> : <>
        <p className="small">{sourceName} connected{connection.expires_at ? ' until ' + dateLabel(connection.expires_at) : ''}.</p>
        <div className="row wrap"><button className="btn sm" disabled={loading || engine.busy} onClick={() => browse()}>Refresh courses</button><button className="btn sm" onClick={disconnect}>Disconnect course source</button></div>
        <label className="stack small">Course<select className="input" aria-label={connection.provider === 'scorm-cloud' ? 'SCORM Cloud course' : 'Source service course'} value={selected ? keyOf(selected) : ''} onChange={event => choose(event.target.value)}><option value="">Choose a course…</option>{courses.map(course => <option key={keyOf(course)} value={keyOf(course)}>{course.title} · Version {course.version}{course.standard ? ' · ' + course.standard : ''}</option>)}</select></label>
        {!courses.length ? <p className="small muted">No courses have been listed. Refresh courses to check this source.</p> : null}
        {page ? <button className="btn sm" disabled={loading || engine.busy} onClick={() => browse(true)}>Load more courses</button> : null}
        {selected ? <div className="note stack" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }} data-testid="course-access-permission">
          <label className="stack small">How to access this course<select className="input" aria-label="Course access mode" value={accessMode} onChange={event => changeMode(event.target.value)}><option value="">Choose an access mode…</option>{selectedModes.map(value => <option key={value} value={value}>{accessModes[value].label}</option>)}</select></label>
          {accessMode ? <p className="small">{accessModes[accessMode]?.description}</p> : null}
          {!selectedModes.length ? <p className="small" role="alert">This source has not offered a supported content access mode. No course content will be read.</p> : null}
          {connection.provider === 'scorm-cloud' ? <p className="small muted">SCORM Cloud offers package export, so querying content at source is unavailable for this connection.</p> : null}
          {grant ? <>
            <p className="small" role="status">Permission active until {dateLabel(grant.expires_at)}. {grant.verification === 'user-attested' ? 'Based on your permission confirmation; course ownership has not been independently verified.' : 'The source service supplied this permission; its ownership claim has not been independently verified.'}</p>
            {grant.mode === 'cached' ? <label className="row small"><input type="checkbox" aria-label="Refresh course content for next question" checked={refresh} onChange={event => setRefresh(event.target.checked)} disabled={loading || engine.busy} />Refresh course content for the next question</label> : null}
            {cache?.present ? <p className="small">Local text and graph {cache.hit ? 'used for the latest question' : 'available in this session'}{cache.expires_at ? ' until ' + dateLabel(cache.expires_at) : ''}.{cache.stored_at ? ' Stored ' + dateLabel(cache.stored_at) + '.' : ''}</p> : null}
            <div className="row wrap"><button className="btn sm" onClick={() => erase()}>Delete local content and revoke permission</button>{connection.provider === 'source-service' ? <button className="btn sm" onClick={() => erase('request-deletion')}>Request deletion at source</button> : null}</div>
            <p className="small muted">Deletion does not remove the original hosted course or passages already shared with your AI client.</p>
          </> : accessMode ? <>
            <label className="stack small">Your authority<select className="input" aria-label="Course permission authority" value={authority} onChange={event => setAuthority(event.target.value)} disabled={loading}><option value="">Choose your authority…</option><option value="owner">I own this course</option><option value="authorized-by-owner">The owner has authorized me</option></select></label>
            <label className="row small"><input type="checkbox" aria-label="Confirm course owner permission" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={loading} />I have the owner’s permission for this access mode and for sharing relevant passages with my paired AI agent.</label>
            <label className="stack small">Permission duration<select className="input" aria-label="Course permission duration" value={retention} onChange={event => setRetention(event.target.value)} disabled={loading}><option value="5">Up to 5 minutes</option><option value="10">Up to 10 minutes</option><option value="30">Up to 30 minutes</option></select></label>
            <p className="small muted">Permission and any local cache also end when this connection ends. The source may allow a shorter duration.</p>
            <button className="btn sm" disabled={loading || engine.busy || !acknowledged || !authority} onClick={permit}>Apply course permission</button>
          </> : null}
        </div> : null}
      </>}
      {notice ? <p className="note small" role="status">{notice}</p> : null}
      {deletion?.uncertain ? <p className="note warn small">Deletion was not confirmed. Your visible course context was cleared; retry the deletion or disconnect this source.</p> : null}
      {deletion?.uncertain || remoteDeletion?.status === 'failed' ? <button className="btn sm" disabled={loading} onClick={() => erase(deletion.operation || 'request-deletion', deletion.target)}>{deletion.operation === 'delete' ? 'Retry local deletion' : 'Retry deletion request'}</button> : null}
      {remoteDeletion?.status === 'pending' && remoteDeletion.request_id ? <button className="btn sm" disabled={loading} onClick={checkDeletion}>Check deletion request</button> : null}
      {remoteDeletion?.status === 'submitting' || remoteDeletion?.status === 'pending' && !remoteDeletion.request_id ? <button className="btn sm" disabled={loading} onClick={refreshDeletion}>Refresh deletion status</button> : null}
      {typeof remoteDeletion?.request_id === 'string' && remoteDeletion.request_id ? <p className="small">Deletion request reference: <code style={{ overflowWrap: 'anywhere' }}>{remoteDeletion.request_id}</code></p> : null}
      {courseMode ? <button className="btn ghost sm" disabled={loading || engine.busy} onClick={glossaryOnly}>Use glossary only</button> : null}
      {loading ? <p className="small" role="status">{engine.busy ? 'Waiting for your connected agent…' : deletion?.checking ? 'Removing course access…' : 'Reading your course source…'}</p> : null}
      {error ? <p className="note warn small" role="alert">{error}</p> : null}
      {packet ? <details><summary>Course sources for the latest question</summary><div className="stack small" style={{ gap: 10, marginTop: 10 }}>
        <b>{packet.source.title} · Version {packet.source.version}</b>
        <span>{packet.access?.mode === 'cached' ? 'Context prepared ' : 'Passages returned '}{dateLabel(packet.retrieved_at)}</span>
        <span>Access: {accessModes[packet.access?.mode]?.label || 'Unreported'}</span>
        {packet.access?.mode === 'cached' && packet.access.cache?.stored_at ? <span>Local content stored {dateLabel(packet.access.cache.stored_at)}. {packet.access.cache.hit ? 'This question reused the local content.' : 'This question read and cached source content.'}</span> : null}
        <span>{packet.source.provider === 'source-service' ? 'Content fingerprint supplied by the source service' : 'Content fingerprint'} <code style={{ overflowWrap: 'anywhere' }}>{packet.source.content_sha256}</code></span>
        {packet.source.package_sha256 ? <span>Export archive SHA-256 <code style={{ overflowWrap: 'anywhere' }}>{packet.source.package_sha256}</code></span> : <span>Foxxi did not download the course package to verify this source-supplied fingerprint.</span>}
        {packet.access?.graph?.representation === 'published-structure' ? <span>Local content graph: {packet.access.graph.nodes} graph items, {packet.access.graph.edges} published structure links. Semantic prerequisites have not been inferred.</span> : packet.access?.graph?.representation === 'source-service' ? <span>Graph context was supplied by the source service.</span> : null}
        {object(packet.source.lti) ? <span>Course context was supplied by the source service. This workbench has not independently verified an LTI login.</span> : null}
        {packet.citations.map(citation => <article className="note stack" key={citation.id} style={{ gap: 5, flexDirection: 'column', alignItems: 'stretch' }}><b style={{ overflowWrap: 'anywhere' }}>{citation.id} · {citation.title}</b><span>{citation.body}</span><code style={{ overflowWrap: 'anywhere' }}>{citation.source_uri}</code><span>{citation.locator}</span></article>)}
        {(packet.missing_context || []).map((message, index) => <p key={index}>{message}</p>)}
        {packet.truncated ? <p>These passages are excerpts. Ask a narrower question for more focused context.</p> : null}
      </div></details> : null}
    </div>
  </details>;
  return { panel, send, stop, loading, blocked, selected };
}
