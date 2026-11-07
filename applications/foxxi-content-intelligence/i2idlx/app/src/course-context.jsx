import { userCourseRequest, userCourseSample, subscribeAgentSession, workbenchConnectionStatus } from './interego-caps.js';

const { useState, useEffect, useRef } = React;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = course => JSON.stringify([course.id, course.version]);
const ready = session => session?.state === 'connected' && (!session.monitoring || session.monitoring === 'ready');

export function selectedCoursePacket(value, connectionId, course) {
  if (!object(value) || value.connection_id !== connectionId || !object(value.source) ||
      value.source.provider !== 'scorm-cloud' || value.source.course_id !== course.id || value.source.version !== course.version ||
      !/^[a-f0-9]{64}$/.test(value.source.package_sha256 || '') || !object(value.interventionContext) || !Array.isArray(value.citations)) {
    throw new Error('The returned course context does not match your selected source. Select the course again.');
  }
  return value;
}

export function useCourseContext(engine) {
  const [agent, setAgent] = useState(() => workbenchConnectionStatus().agent);
  const [connection, setConnection] = useState(null), [courses, setCourses] = useState([]);
  const [page, setPage] = useState(null), [selected, setSelected] = useState(null), [packet, setPacket] = useState(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [courseMode, setCourseMode] = useState(false);
  const appId = useRef(null), secret = useRef(null), request = useRef(null), generation = useRef(0);
  const mode = useRef(false), mounted = useRef(true), initialized = useRef(false);
  const eligible = ready(agent), sessionId = agent?.connectionId;
  const clearCredentials = () => { if (appId.current) appId.current.value = ''; if (secret.current) secret.current.value = ''; };
  const invalidate = () => { generation.current++; request.current?.abort(); request.current = null; setLoading(false); };
  const clearSource = () => { setConnection(null); setCourses([]); setPage(null); setSelected(null); setPacket(null); clearCredentials(); };
  const current = run => mounted.current && generation.current === run;
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
      if (current(run) && value.connected && typeof value.connection_id === 'string') setConnection(value);
    }).catch(e => { if (current(run) && e.code !== 'cancelled' && !controller.signal.aborted) setError(e.message); });
  }, [sessionId, eligible, engine.reset]);

  function begin() {
    invalidate();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    return { run: generation.current, controller };
  }
  function failed(e, run, controller) {
    if (!current(run) || controller.signal.aborted) return;
    if (['course_connection_expired', 'course_connection_not_found', 'session_expired'].includes(e.code)) {
      clearSource(); engine.reset();
    }
    setError(e.message || 'The course source is unavailable.');
  }
  async function list(connectionId, nextPage, signal) {
    const value = await userCourseRequest({ operation: 'courses', connection_id: connectionId, ...(nextPage ? { page: nextPage } : {}) }, signal);
    if (value.connection_id !== connectionId || !Array.isArray(value.courses)) throw new Error('The source returned an invalid course list.');
    return { courses: value.courses.filter(course => object(course) && typeof course.id === 'string' && typeof course.title === 'string' && Number.isSafeInteger(course.version)), page: value.next_page || null };
  }
  async function connect() {
    if (!eligible || loading || engine.busy) return;
    const id = appId.current?.value.trim(), password = secret.current?.value;
    if (!id || !password) { setError('Enter your SCORM Cloud application ID and secret.'); return; }
    const { run, controller } = begin(); clearSource(); engine.reset();
    try {
      const value = await userCourseRequest({ operation: 'connect', credentials: { type: 'basic', app_id: id, secret: password } }, controller.signal);
      if (!current(run)) return;
      if (!value.connected || typeof value.connection_id !== 'string') throw new Error('SCORM Cloud did not confirm this connection.');
      setConnection(value);
      const result = await list(value.connection_id, null, controller.signal);
      if (current(run)) { setCourses(result.courses); setPage(result.page); }
    } catch (e) { failed(e, run, controller); }
    finally { clearCredentials(); if (current(run)) setLoading(false); }
  }
  async function browse(more = false) {
    if (!connection || loading || engine.busy) return;
    const { run, controller } = begin();
    try {
      const result = await list(connection.connection_id, more ? page : null, controller.signal);
      if (!current(run)) return;
      setCourses(old => more ? [...new Map([...old, ...result.courses].map(course => [keyOf(course), course])).values()] : result.courses);
      setPage(result.page);
      if (!more) { setSelected(null); setPacket(null); engine.reset(); }
    } catch (e) { failed(e, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  function choose(value) {
    invalidate(); engine.reset(); setPacket(null); setError('');
    const course = courses.find(item => keyOf(item) === value) || null;
    mode.current = !!course; setCourseMode(!!course); setSelected(course);
  }
  function glossaryOnly() {
    invalidate(); engine.reset(); setPacket(null); setSelected(null); setError('');
    mode.current = false; setCourseMode(false);
  }
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
    const pairedSample = userCourseSample();
    if (!pairedSample) { setError('Reconnect your paired AI agent before sharing course passages.'); return; }
    const { run, controller } = begin();
    try {
      const value = selectedCoursePacket(await userCourseRequest({ operation: 'source', connection_id: connection.connection_id, course_id: selected.id, version: selected.version, question }, controller.signal), connection.connection_id, selected);
      if (!current(run)) return;
      if (packet && packet.source.package_sha256 !== value.source.package_sha256) {
        engine.reset(); setPacket(value); setError('The course source changed, so the conversation was cleared. Ask again to use the refreshed content.'); return;
      }
      setPacket(value);
      await engine.send(question, ids, value.interventionContext, pairedSample);
    } catch (e) { failed(e, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  function stop() { invalidate(); engine.stop(); }
  const blocked = courseMode && (!eligible || !connection || !selected);
  const panel = <details className="note" style={{ display: 'block' }} data-testid="ask-course-source">
    <summary><b>Ask about a course</b>{selected ? ' · ' + selected.title : ''}</summary>
    <div className="stack" style={{ gap: 12, marginTop: 12 }}>
      <p className="small">Connect your own SCORM Cloud application and choose a course. Its content is private to this temporary connection. Clicking Ask shares the passages retrieved for that question with your paired AI agent.</p>
      {!eligible ? <p className="note small">Use Connect in the toolbar to pair an active AI agent first.</p> : null}
      {!connection ? <div className="stack" style={{ gap: 10 }}>
        <label className="stack small">SCORM Cloud application ID<input className="input" ref={appId} aria-label="SCORM Cloud application ID" autoComplete="off" disabled={!eligible || loading} /></label>
        <label className="stack small">SCORM Cloud secret<input className="input" type="password" ref={secret} aria-label="SCORM Cloud secret" autoComplete="off" disabled={!eligible || loading} /></label>
        <button className="btn" disabled={!eligible || loading || engine.busy} onClick={connect}>Connect my SCORM Cloud</button>
      </div> : <>
        <p className="small">SCORM Cloud connected{connection.expires_at ? ' until ' + new Date(connection.expires_at).toLocaleTimeString() : ''}.</p>
        <div className="row wrap"><button className="btn sm" disabled={loading || engine.busy} onClick={() => browse()}>Refresh courses</button><button className="btn sm" disabled={loading || engine.busy} onClick={disconnect}>Disconnect course source</button></div>
        <label className="stack small">Course<select className="input" aria-label="SCORM Cloud course" disabled={loading || engine.busy} value={selected ? keyOf(selected) : ''} onChange={event => choose(event.target.value)}><option value="">Choose a course…</option>{courses.map(course => <option key={keyOf(course)} value={keyOf(course)}>{course.title} · Version {course.version}{course.standard ? ' · ' + course.standard : ''}</option>)}</select></label>
        {!courses.length ? <p className="small muted">No courses have been listed. Refresh courses to check this application.</p> : null}
        {page ? <button className="btn sm" disabled={loading || engine.busy} onClick={() => browse(true)}>Load more courses</button> : null}
      </>}
      {courseMode ? <button className="btn ghost sm" disabled={loading || engine.busy} onClick={glossaryOnly}>Use glossary only</button> : null}
      {loading ? <p className="small" role="status">{engine.busy ? 'Waiting for your connected agent…' : 'Reading your course source…'}</p> : null}
      {error ? <p className="note warn small" role="alert">{error}</p> : null}
      {packet ? <details><summary>Course sources for the latest question</summary><div className="stack small" style={{ gap: 10, marginTop: 10 }}>
        <b>{packet.source.title} · Version {packet.source.version}</b>
        <span>Retrieved {new Date(packet.retrieved_at).toLocaleString()}</span>
        <span>Package SHA-256 <code style={{ overflowWrap: 'anywhere' }}>{packet.source.package_sha256}</code></span>
        {packet.citations.map(citation => <article className="note stack" key={citation.id} style={{ gap: 5, flexDirection: 'column', alignItems: 'stretch' }}><b>{citation.id} · {citation.title}</b><span>{citation.body}</span><code style={{ overflowWrap: 'anywhere' }}>{citation.source_uri}</code><span>{citation.locator}</span></article>)}
        {(packet.missing_context || []).map((message, index) => <p key={index}>{message}</p>)}
        {packet.truncated ? <p>These passages are excerpts. Ask a narrower question for more focused context.</p> : null}
      </div></details> : null}
    </div>
  </details>;
  return { panel, send, stop, loading, blocked, selected };
}
