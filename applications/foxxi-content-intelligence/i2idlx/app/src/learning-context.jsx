import { createLearningClient, selectedLearningPacket } from './learning-client.js';
import { learningContextRequest, userCourseSample, subscribeAgentSession, workbenchConnectionStatus } from './interego-caps.js';

const { useState, useEffect, useRef } = React;
const dateLabel = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unreported';
const ready = agent => agent?.state === 'connected' && (!agent.monitoring || agent.monitoring === 'ready');
const keyOf = course => JSON.stringify([course.id, course.version]);
const linkLabel = status => ({ 'pending-admin': 'Waiting for your learning administrator', approved: 'Approved — activate this account', active: 'Active', revoked: 'Link ended' })[status];

// Root composes this active ref with the owner connector and glossary controls.
// Account/admin controls remain usable without an AI agent; private Ask does not.
export function useLearningContext(engine, { onActivate } = {}) {
  const client = useRef(null);
  if (!client.current) client.current = createLearningClient();
  const [session, setSession] = useState(null), [agent, setAgent] = useState(() => workbenchConnectionStatus().agent);
  const [links, setLinks] = useState([]), [connectors, setConnectors] = useState([]), [pending, setPending] = useState({});
  const [link, setLink] = useState(null), [courses, setCourses] = useState([]), [selected, setSelected] = useState(null);
  const [progress, setProgress] = useState(null), [packet, setPacket] = useState(null), [discovery, setDiscovery] = useState(null);
  const [shareContent, setShareContent] = useState(false), [shareProgress, setShareProgress] = useState(false);
  const [storageAccepted, setStorageAccepted] = useState(false), [allowContent, setAllowContent] = useState(false), [allowProgress, setAllowProgress] = useState(false);
  const [confirmations, setConfirmations] = useState({}), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [active, setActive] = useState(false), activeRef = useRef(false), mounted = useRef(true), generation = useRef(0), request = useRef(null);
  const account = useRef(null), recipient = useRef(null), popup = useRef(null), createId = useRef(null);
  const joinCode = useRef(null), label = useRef(null), appId = useRef(null), secret = useRef(null), registrations = useRef(new Map());
  const paired = ready(agent), authenticated = !!session?.authenticated;
  const invalidate = () => { generation.current++; request.current?.abort(); request.current = null; setLoading(false); };
  const clearCredentials = () => { for (const field of [appId, secret]) if (field.current) field.current.value = ''; };
  const clearPrivate = (cancel = true) => {
    if (cancel) invalidate(); setSelected(null); setProgress(null); setPacket(null); setShareContent(false); setShareProgress(false); if (activeRef.current) engine.reset();
  };
  const clear = () => { clearPrivate(); activeRef.current = false; setActive(false); setError(''); };
  const clearAccount = (cancel = true) => {
    clearPrivate(cancel); setLink(null); setLinks([]); setCourses([]); setConnectors([]); setPending({}); setDiscovery(null); setConfirmations({});
    setStorageAccepted(false); setAllowContent(false); setAllowProgress(false); clearCredentials(); registrations.current.clear(); createId.current = null;
    if (joinCode.current) joinCode.current.value = '';
  };
  const current = run => mounted.current && generation.current === run;
  function begin() { invalidate(); const controller = new AbortController(); request.current = controller; setLoading(true); setError(''); setNotice(''); return { run: generation.current, controller }; }
  function failed(cause, run, controller) {
    if (!current(run) || controller.signal.aborted || cause?.code === 'cancelled') return;
    if (['learning_sign_in_required', 'learning_session_expired', 'learning_account_invalid', 'learning_csrf_refused'].includes(cause?.code)) { clearAccount(); client.current.clear(); setSession(null); }
    else if (cause?.status === 401 || cause?.status === 403 || ['learning_access_revoked', 'learning_authority_changed', 'learning_connection_not_found', 'learning_connection_revoked', 'learning_content_not_allowed', 'learning_progress_not_allowed', 'learning_link_inactive', 'learning_link_not_found', 'learning_link_required', 'learning_link_revoked', 'learning_enrollment_required', 'learning_permission_required', 'learning_context_revoked', 'learning_authorization_expired', 'session_expired', 'session_unauthorized'].includes(cause?.code)) clearPrivate();
    const messages = {
      learning_sign_in_required: 'Sign in to your learning account again.', learning_session_expired: 'Your learning sign-in expired. Sign in again.',
      learning_link_inactive: 'This learning account link is no longer active. Refresh your connections.', learning_link_not_found: 'This learning account link could not be confirmed. Refresh your connections.',
      learning_connection_revoked: 'The learning provider ended this connection.', learning_authority_changed: 'Your learning access changed. Refresh your courses before continuing.',
      learning_content_not_allowed: 'This learning connection has not authorized course passages to be shared with AI.', learning_progress_not_allowed: 'This learning connection has not authorized access to your progress.',
      learning_enrollment_required: 'Your enrollment could not be confirmed. Refresh your enrolled courses.', learning_self_approval_forbidden: 'A separate learning administrator must verify your registration match.',
      learning_access_revoked: 'Your learning access changed. The private conversation was cleared. Refresh your enrolled courses before asking again.',
    };
    setError(messages[cause?.code] || 'The learning operation could not be completed. Refresh its status before trying again.');
  }
  async function perform(operation, args = {}, apply = () => {}) {
    if (loading) return;
    const { run, controller } = begin();
    try { const value = await client.current.request(operation, args, controller.signal); if (current(run)) await apply(value, controller.signal, run); }
    catch (cause) { failed(cause, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  async function refreshAccount() {
    const { run, controller } = begin();
    try {
      const value = await client.current.refresh(controller.signal);
      if (!current(run) || !value.authenticated) return;
      const found = await client.current.request('my-links', {}, controller.signal);
      if (current(run)) setLinks(found.links);
    } catch (cause) { failed(cause, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = client.current.subscribe(value => {
      const identity = value?.authenticated ? value.account.id : null;
      if (account.current !== identity) { clearAccount(false); account.current = identity; }
      setSession(value);
    });
    refreshAccount();
    return () => { mounted.current = false; generation.current++; request.current?.abort(); clearCredentials(); unsubscribe(); client.current.dispose(); try { popup.current?.close(); } catch {} };
  }, []);
  useEffect(() => subscribeAgentSession(setAgent), []);
  useEffect(() => {
    const identity = paired ? agent.connectionId : null;
    if (recipient.current !== identity) {
      if (activeRef.current || selected) clearPrivate();
      recipient.current = identity;
    }
  }, [agent?.connectionId, paired]);
  useEffect(() => {
    if (!authenticated || !session.expires_at) return;
    const remaining = Date.parse(session.expires_at) - Date.now();
    const expire = () => { client.current.clear(); setError('Your learning sign-in expired. Sign in again before using private learning context.'); };
    if (remaining <= 0) { expire(); return; }
    const timer = setTimeout(expire, Math.min(remaining, 2147483647)); return () => clearTimeout(timer);
  }, [authenticated, session?.expires_at]);
  useEffect(() => {
    if (!link?.expires_at) return;
    const remaining = Date.parse(link.expires_at) - Date.now();
    const expire = () => { clearPrivate(); setLink(null); setCourses([]); setError('Your learning account link expired. Refresh your connections.'); };
    if (remaining <= 0) { expire(); return; }
    const timer = setTimeout(expire, Math.min(remaining, 2147483647)); return () => clearTimeout(timer);
  }, [link?.id, link?.expires_at]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (popup.current && popup.current.closed) { popup.current = null; refreshAccount(); }
    }, 500);
    return () => clearInterval(timer);
  }, []);
  function signIn() {
    if (!session?.enabled || !session.sign_in_url || loading) return;
    const opened = window.open('about:blank', '_blank');
    if (!opened) { setError('Allow a new sign-in window, then connect your learning account again.'); return; }
    opened.opener = null; opened.location.replace(session.sign_in_url); popup.current = opened;
    setNotice('Finish the normal Interego sign-in, then close its window or refresh your learning account here.');
  }
  async function signOut() {
    clearAccount(); const { run, controller } = begin();
    try { await client.current.signOut(controller.signal); if (current(run)) { await client.current.refresh(controller.signal); setNotice('You are signed out of this learning account. Your AI connection is separate.'); } }
    catch (cause) { if (current(run)) setError('Local learning context was cleared. Server sign-out was not confirmed; refresh your account.'); }
    finally { if (current(run)) setLoading(false); }
  }
  function useLink(value) {
    clearPrivate(); setLink(value); setCourses([]);
    perform('courses', { link_id: value.id }, result => { setCourses(result.courses); });
  }
  function chooseCourse(value) {
    const course = courses.find(item => keyOf(item) === value);
    clearPrivate();
    if (!course) return;
    onActivate?.(); activeRef.current = true; setActive(true); setSelected(course);
  }
  function sharing(kind, value) {
    invalidate(); setPacket(null); engine.reset();
    if (kind === 'content') setShareContent(value); else setShareProgress(value);
  }
  function requestLink() {
    const code = joinCode.current?.value.trim();
    if (!code) { setError('Enter the connection code your learning provider supplied.'); return; }
    perform('request-link', { join_code: code }, value => {
      setDiscovery(value.connection);
      if (value.link) setLinks(old => [...old.filter(item => item.id !== value.link.id), value.link]);
      if (joinCode.current) joinCode.current.value = '';
      setNotice('Your verified account was submitted to this learning provider. An administrator must match an actual registration, then you must activate the link.');
    });
  }
  function activateLink(value) {
    clearPrivate();
    perform('confirm-link', { link_id: value.id }, result => {
      setLinks(old => old.map(item => item.id === result.link.id ? result.link : item));
      setNotice('The learning account link is active. Open its enrolled courses to continue.');
    });
  }
  function revokeLink(value) {
    if (link?.id === value.id) { clearPrivate(); setLink(null); setCourses([]); }
    perform('revoke-link', { link_id: value.id }, result => { setLinks(old => old.map(item => item.id === result.link.id ? result.link : item)); setNotice('The learning account link ended.'); });
  }
  function createConnector() {
    const name = label.current?.value.trim(), application = appId.current?.value.trim(), password = secret.current?.value;
    if (!storageAccepted || !name || !application || !password) { setError('Enter the connection details and explicitly allow encrypted credential storage.'); return; }
    if (!createId.current) createId.current = crypto.randomUUID();
    perform('create-connector', { label: name, credentials: { app_id: application, secret: password },
      policy: { allowAiContent: allowContent, allowAiProgress: allowProgress }, intent: 'authorize-enrolled-learners', request_id: createId.current }, result => {
      setConnectors(old => [...old.filter(item => item.id !== result.connector.id), result.connector]); createId.current = null; clearCredentials();
      setStorageAccepted(false); setAllowContent(false); setAllowProgress(false); setNotice('Your learning connection was created. Share its connection code only with intended learners.');
    }).finally(clearCredentials);
  }
  function inspectPending(connector) {
    perform('pending-links', { connector_id: connector.id }, value => setPending(old => ({ ...old, [connector.id]: value.links })));
  }
  function approvePending(connector, value) {
    const registration = registrations.current.get(value.id)?.value.trim();
    if (!registration || confirmations[value.id] !== true) { setError('Match an actual registration and confirm it against your institutional records.'); return; }
    perform('approve-link', { link_id: value.id, registration_id: registration, confirmed: true }, () => {
      setPending(old => ({ ...old, [connector.id]: (old[connector.id] || []).filter(item => item.id !== value.id) }));
      setConfirmations(old => ({ ...old, [value.id]: false })); registrations.current.delete(value.id);
      setNotice('The registration match was approved. The learner must activate this link before it can be used.');
    });
  }
  function ltiAction(connector, operation) {
    perform(operation, { connector_id: connector.id }, value => setConnectors(old => old.map(item => item.id === connector.id ? { ...item, lti: value.lti } : item)));
  }
  async function send(text, ids = engine.ctx) {
    const question = (text || '').trim();
    if (!question || loading || engine.busy) return;
    if (!activeRef.current || !authenticated || !link || link.status !== 'active' || !selected || !paired || !shareContent && !shareProgress) {
      setError('Select a verified enrolled course and explicitly choose what to share before asking.'); return;
    }
    const sample = userCourseSample();
    if (!sample) { setError('Connect your AI agent before sharing selected learning context.'); return; }
    const { run, controller } = begin(), conversation = engine.captureGeneration();
    const options = { link_id: link.id, course: selected, share_content: shareContent, share_progress: shareProgress };
    try {
      const value = selectedLearningPacket(await learningContextRequest({ link_id: link.id, course_id: selected.id,
        version: selected.version, question, share_content: shareContent, share_progress: shareProgress }, controller.signal), options);
      if (!current(run) || engine.captureGeneration() !== conversation) return;
      setPacket(value);
      const identity = JSON.stringify(['learner', session.account.id, link.id, value.source.provider, selected.id, selected.version,
        value.source.source_version, shareContent, shareProgress]);
      await engine.send(question, ids, value.interventionContext, sample, identity,
        value.authorization_ticket ? { learningAuthorization: value.authorization_ticket } : {});
    } catch (cause) { failed(cause, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  function stop() { invalidate(); engine.stop(); }
  const blocked = active && (!authenticated || !link || !selected || !paired || !shareContent && !shareProgress);
  const disabled = loading || engine.busy;
  const panel = <details className="note" style={{ display: 'block' }} data-testid="learning-account-panel">
    <summary><b>Your learning account</b>{authenticated ? ' · Signed in' : ''}</summary>
    <div className="stack small" style={{ gap: 12, marginTop: 12 }}>
      <p>Your verified Interego account connects to your own enrolled courses and progress. Your AI agent is a separate connection.</p>
      {!session ? <p>Checking your learning account…</p> : !session.enabled ? <p>Learning account sign-in is not available on this workbench yet.</p> : !authenticated ? <button className="btn" disabled={loading} onClick={signIn}>Connect your Interego learning account</button> : <>
        <p>Verified account: <span style={{ overflowWrap: 'anywhere' }}>{session.account.webId}</span></p>
        <div className="row wrap"><button className="btn sm" disabled={disabled} onClick={refreshAccount}>Refresh learning account</button><button className="btn sm" disabled={loading} onClick={signOut}>Sign out of learning account</button></div>
        <label className="stack">Learning provider connection code<input className="input" aria-label="Learning provider connection code" ref={joinCode} autoComplete="off" disabled={disabled} /></label>
        <div className="row wrap"><button className="btn sm" disabled={disabled} onClick={() => {
          const code = joinCode.current?.value.trim(); if (!code) { setError('Enter the connection code your learning provider supplied.'); return; }
          perform('discover', { join_code: code }, value => setDiscovery(value.connection));
        }}>Check connection code</button><button className="btn sm" disabled={disabled} onClick={requestLink}>Request my learning account link</button></div>
        {discovery ? <p>{discovery.label}{discovery.lti_discovered ? ' was discovered through LTI' : ' is available for account linking'}. Discovery alone does not establish enrollment.</p> : null}
        {links.length ? <div className="stack" style={{ gap: 10 }}>{links.map(value => <div className="note stack" style={{ alignItems: 'stretch' }} key={value.id}>
          <b>{value.provider_label}</b><span>{linkLabel(value.status)}</span>
          {value.lti_discovered ? <span>LTI discovery identifies this connection; the verified registration match establishes your enrollment.</span> : null}
          <div className="row wrap">
            {value.status === 'approved' ? <button className="btn sm" disabled={disabled} onClick={() => activateLink(value)}>Activate this approved learning account</button> : null}
            {value.status === 'active' ? <button className="btn sm" disabled={disabled} onClick={() => useLink(value)}>Show my enrolled courses</button> : null}
            {value.status !== 'revoked' ? <button className="btn sm" disabled={loading} onClick={() => revokeLink(value)}>End this learning account link</button> : null}
          </div>
        </div>)}</div> : <p>No learning account links are available. Use a provider connection code or open its authenticated LTI learning link.</p>}
        {link ? <div className="stack" style={{ gap: 10 }} data-testid="learner-courses">
          <b>Your enrolled courses · {link.provider_label}</b>
          <label className="stack">Course<select className="input" aria-label="Your enrolled course" value={selected ? keyOf(selected) : ''} disabled={disabled} onChange={event => chooseCourse(event.target.value)}><option value="">Choose one of your enrolled courses…</option>{courses.map(course => <option key={keyOf(course)} value={keyOf(course)}>{course.title} · Version {course.version}</option>)}</select></label>
          {!courses.length ? <p>No current enrollments were confirmed for this account link.</p> : null}
          <button className="btn sm" disabled={disabled} onClick={() => perform('progress', { link_id: link.id }, setProgress)}>Check my progress</button>
          {progress ? <div className="stack" data-testid="learner-progress"><b>Your progress · SCORM Cloud</b><span>Checked {dateLabel(progress.as_of)}</span>{progress.records.length ? progress.records.map((record, index) => <div key={record.course_id + ':' + index} className="note stack" style={{ alignItems: 'stretch' }}><b>{record.title || 'Enrolled course'} · Version {record.version}</b><span>Completion: {record.completion} · Success: {record.success}</span><span>Score: {record.score === undefined ? 'Unreported' : record.score + ' / 100'} · Time: {record.total_seconds === undefined ? 'Unreported' : record.total_seconds + ' seconds'}</span><span>Source: SCORM Cloud · Checked {dateLabel(record.observed_at)}</span></div>) : <span>No progress records were supplied.</span>}</div> : null}
          <p>Prerequisites: SCORM Cloud has not supplied authoritative prerequisite requirements for this connection.</p>
          <p>Curriculum: SCORM Cloud has not supplied an authoritative learning path. Course structure does not establish prerequisites or a required curriculum.</p>
          {selected ? <div className="stack" style={{ gap: 9 }} data-testid="learner-sharing">
            <b>Ask about {selected.title}</b>
            <label><input type="checkbox" aria-label="Share selected enrolled course passages with AI" checked={shareContent} disabled={disabled} onChange={event => sharing('content', event.target.checked)} /> Share selected passages from this enrolled course with my paired AI.</label>
            <label><input type="checkbox" aria-label="Share my enrolled course progress with AI" checked={shareProgress} disabled={disabled} onChange={event => sharing('progress', event.target.checked)} /> Share my own progress for this course with my paired AI.</label>
            {!paired ? <p>Pair an AI agent in the toolbar before asking. Viewing your courses and progress does not require an AI.</p> : null}
            <p>Each question rechecks the account link, enrollment and allowed sharing. A failed private question does not fall back to another catalog or the glossary.</p>
            <button className="btn sm" disabled={loading} onClick={clear}>Leave this learning context</button>
          </div> : null}
          {packet ? <details><summary>Sources for the latest learning question</summary><p>{packet.source.provider} · Course version {packet.source.version} · Source {packet.source.source_version}</p>{packet.citations.map(citation => <p key={citation.id}>{citation.id}{citation.title ? ': ' + citation.title : ''}</p>)}{packet.missing_context.map((item, index) => <p key={index}>{item}</p>)}</details> : null}
        </div> : null}
        <details data-testid="learning-admin"><summary>Manage learning connections</summary><div className="stack" style={{ gap: 12, marginTop: 12 }}>
          <p>For course owners and learning administrators. Create a connection you manage, authorize enrolled-learner sharing, and match verified accounts to actual SCORM Cloud registrations.</p>
          <button className="btn sm" disabled={disabled} onClick={() => perform('owned-connectors', {}, value => setConnectors(value.connectors))}>Show connections I manage</button>
          <label className="stack">Connection name<input className="input" aria-label="Managed learning connection name" ref={label} maxLength={200} disabled={disabled} /></label>
          <label className="stack">SCORM Cloud application ID<input className="input" aria-label="Managed SCORM Cloud application ID" ref={appId} autoComplete="off" disabled={disabled} /></label>
          <label className="stack">SCORM Cloud secret<input className="input" aria-label="Managed SCORM Cloud secret" type="password" ref={secret} autoComplete="off" disabled={disabled} /></label>
          <label><input type="checkbox" aria-label="Allow encrypted learning credential storage" checked={storageAccepted} disabled={disabled} onChange={event => setStorageAccepted(event.target.checked)} /> Allow this workbench to store these connection credentials encrypted so enrolled learners can use the connection until I revoke it.</label>
          <label><input type="checkbox" aria-label="Authorize enrolled course passage sharing" checked={allowContent} disabled={disabled} onChange={event => setAllowContent(event.target.checked)} /> Authorize enrolled learners to share selected course passages with their chosen AI.</label>
          <label><input type="checkbox" aria-label="Authorize enrolled learner progress sharing" checked={allowProgress} disabled={disabled} onChange={event => setAllowProgress(event.target.checked)} /> Authorize enrolled learners to share their own course progress with their chosen AI.</label>
          <button className="btn sm" disabled={disabled || !storageAccepted} onClick={createConnector}>Create my managed learning connection</button>
          {connectors.map(connector => <div className="note stack" style={{ alignItems: 'stretch', gap: 8 }} key={connector.id}>
            <b>{connector.label}</b><span>{connector.status === 'active' ? 'Active' : 'Revoked'}</span>
            {connector.join_code && connector.status === 'active' ? <span>Connection code: <code>{connector.join_code}</code></span> : null}
            <span>Enrolled-learner sharing: course passages {connector.policy.allowAiContent ? 'allowed' : 'off'}; own progress {connector.policy.allowAiProgress ? 'allowed' : 'off'}.</span>
            {connector.status === 'active' ? <>
              <div className="row wrap"><button className="btn sm" disabled={disabled} onClick={() => inspectPending(connector)}>Check pending account links</button><button className="btn sm" disabled={disabled} onClick={() => perform('revoke-connector', { connector_id: connector.id }, value => { clearPrivate(); setConnectors(old => old.map(item => item.id === connector.id ? value.connector : item)); })}>Revoke this managed connection</button></div>
              {(pending[connector.id] || []).map(value => <div className="stack" key={value.id}>
                <span>Verified Interego account: <span style={{ overflowWrap: 'anywhere' }}>{value.account.display_name || value.account.webId}</span></span>
                <details><summary>Verified account details</summary><p style={{ overflowWrap: 'anywhere' }}>{value.account.webId}</p></details>
                {value.status === 'approved' ? <p>The registration match was approved. This learner must activate the link.</p> : <>
                <label className="stack">Actual SCORM Cloud registration ID<input className="input" aria-label={'Registration for pending account ' + value.id} ref={element => { if (element) registrations.current.set(value.id, element); else registrations.current.delete(value.id); }} disabled={disabled} autoComplete="off" /></label>
                <label><input type="checkbox" aria-label={'Confirm registration match ' + value.id} checked={confirmations[value.id] === true} disabled={disabled} onChange={event => setConfirmations(old => ({ ...old, [value.id]: event.target.checked }))} /> I checked institutional records and confirm this actual registration belongs to this verified Interego account. An email or name resemblance is not sufficient.</label>
                <button className="btn sm" disabled={disabled || confirmations[value.id] !== true} onClick={() => approvePending(connector, value)}>Approve this registration match</button>
                </>}
              </div>)}
              <details><summary>LTI discovery settings</summary><div className="stack" style={{ gap: 8 }}><p>LTI can discover this learning connection. A verified registration match and learner activation are still required for enrollment access.</p>
                <p>Installing creates a trusted LTI connection and a separate helper course in this SCORM Cloud account. Removal targets only this setup; original courses remain in place.</p>
                <div className="row wrap"><button className="btn sm" disabled={disabled} onClick={() => ltiAction(connector, 'prepare-lti')}>Prepare public LTI settings</button><button className="btn sm" disabled={disabled} onClick={() => ltiAction(connector, 'install-lti')}>Install LTI discovery in my Cloud</button><button className="btn sm" disabled={disabled} onClick={() => ltiAction(connector, 'remove-lti')}>Remove this LTI discovery setup</button></div>
                {connector.lti ? <><span>LTI setup: {connector.lti.state}</span>{connector.lti.note ? <span>{connector.lti.note}</span> : null}{connector.lti.settings ? <details><summary>Public connection settings</summary>{['login_url', 'launch_url', 'jwks_url'].map(key => <p key={key} style={{ overflowWrap: 'anywhere' }}>{key.replaceAll('_', ' ')}: {connector.lti.settings[key]}</p>)}{connector.lti.settings.public_key_pem ? <pre style={{ whiteSpace: 'pre-wrap' }}>{connector.lti.settings.public_key_pem}</pre> : null}</details> : null}</> : null}
              </div></details>
            </> : null}
          </div>)}
        </div></details>
      </>}
      {(!session || session.enabled && !authenticated) ? <button className="btn sm" disabled={loading} onClick={refreshAccount}>Refresh learning account</button> : null}
      {error ? <p className="note warn small" role="alert">{error}</p> : null}{notice ? <p className="note small" role="status">{notice}</p> : null}
    </div>
  </details>;
  return { panel, active, activeRef, clear, send, stop, loading, blocked, selected };
}
