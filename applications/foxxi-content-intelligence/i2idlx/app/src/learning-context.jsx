import { createLearningClient, createLearningLauncher, selectedLearningPacket } from './learning-client.js';
import { learningContextRequest, userCourseSample, subscribeAgentSession, workbenchConnectionStatus } from './interego-caps.js';

const { useState, useEffect, useRef } = React;
const dateLabel = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unreported';
const ready = agent => agent?.state === 'connected' && (!agent.monitoring || agent.monitoring === 'ready');
const keyOf = course => JSON.stringify([course.id, course.version]);
const linkLabel = status => ({ 'pending-admin': 'Waiting for your learning administrator', approved: 'Approved — activate this account', active: 'Active', revoked: 'Link ended' })[status];
const reviewLabel = status => ({ available: 'Released review is available', 'not-released': 'The owner has not released this review', 'no-completed-results': 'No released completed or terminal quiz results were found', 'not-authorized': 'Quiz review is not authorized', unavailable: 'Quiz review could not be checked' })[status] || 'Not checked';
const reviewBasis = submission => submission === 'completed' ? 'Provider reports this activity completed. This does not establish overall course completion.' : submission === 'terminal-lesson-status' ? 'Provider reports a terminal lesson status. This does not establish overall course completion.' : 'Completion basis not supplied. Overall course completion is not established here.';
const blankMap = course => ({ schema_version: 1, course_id: course.id, version: course.version, release_quiz_review: false,
  instructional_locations: [], review_items: [], objectives: [], prerequisites: [] });
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const optionalStrings = (value, keys) => keys.every(key => value[key] === undefined || typeof value[key] === 'string');
const stringList = value => value === undefined || Array.isArray(value) && value.every(item => typeof item === 'string');
const mapRows = (value, key, valid) => value[key] === undefined || Array.isArray(value[key]) && value[key].every(item => record(item) && valid(item));
const renderableMap = value => record(value) && optionalStrings(value, ['title']) &&
  mapRows(value, 'instructional_locations', item => optionalStrings(item, ['id', 'label', 'source_file', 'fragment'])) &&
  mapRows(value, 'objectives', item => optionalStrings(item, ['id', 'label']) && stringList(item.location_ids) && stringList(item.competency_iris)) &&
  mapRows(value, 'prerequisites', item => optionalStrings(item, ['course_id', 'label', 'relation'])) &&
  mapRows(value, 'review_items', item => optionalStrings(item, ['activity_id', 'interaction_id', 'question_label']) && stringList(item.location_ids) &&
    mapRows(item, 'response_labels', response => optionalStrings(response, ['response', 'label']))) &&
  (value.curriculum === undefined || record(value.curriculum) && optionalStrings(value.curriculum, ['label']) &&
    Array.isArray(value.curriculum.sequence) && value.curriculum.sequence.every(item => record(item) && optionalStrings(item, ['course_id', 'label'])));

// Root composes this active ref with the owner connector and glossary controls.
// Account/admin controls remain usable without an AI agent; private Ask does not.
export function useLearningContext(engine, { onActivate } = {}) {
  const client = useRef(null);
  if (!client.current) client.current = createLearningClient();
  const launcher = useRef(null);
  if (!launcher.current) launcher.current = createLearningLauncher(client.current);
  const [session, setSession] = useState(null), [agent, setAgent] = useState(() => workbenchConnectionStatus().agent);
  const [links, setLinks] = useState([]), [connectors, setConnectors] = useState([]), [pending, setPending] = useState({});
  const [link, setLink] = useState(null), [courses, setCourses] = useState([]), [selected, setSelected] = useState(null);
  const [progress, setProgress] = useState(null), [packet, setPacket] = useState(null), [discovery, setDiscovery] = useState(null);
  const [journey, setJourney] = useState('learner'), [readiness, setReadiness] = useState(null), [review, setReview] = useState(null);
  const [shareContent, setShareContent] = useState(false), [shareProgress, setShareProgress] = useState(false), [shareReview, setShareReview] = useState(false);
  const [storageAccepted, setStorageAccepted] = useState(false), [allowContent, setAllowContent] = useState(false), [allowProgress, setAllowProgress] = useState(false);
  const [allowReview, setAllowReview] = useState(false), [reviewConfirmations, setReviewConfirmations] = useState({});
  const [allowNotifications, setAllowNotifications] = useState(false), [notificationConfirmations, setNotificationConfirmations] = useState({});
  const [notifications, setNotifications] = useState(null), [notificationAccepted, setNotificationAccepted] = useState(false);
  const [notificationSignal, setNotificationSignal] = useState(false);
  const [ownedCourses, setOwnedCourses] = useState({}), [mapEditors, setMapEditors] = useState({});
  const [confirmations, setConfirmations] = useState({}), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [targetedConfirmations, setTargetedConfirmations] = useState({});
  const [active, setActive] = useState(false), activeRef = useRef(false), mounted = useRef(true), generation = useRef(0), request = useRef(null);
  const account = useRef(null), recipient = useRef(null), popup = useRef(null), createId = useRef(null);
  const notificationPoll = useRef(null), notificationBaseline = useRef(null);
  const joinCode = useRef(null), label = useRef(null), appId = useRef(null), secret = useRef(null), registrations = useRef(new Map());
  const paired = ready(agent), authenticated = !!session?.authenticated;
  const invalidate = () => { generation.current++; request.current?.abort(); request.current = null; notificationPoll.current?.abort(); launcher.current.cancel(); setLoading(false); };
  const clearCredentials = () => { for (const field of [appId, secret]) if (field.current) field.current.value = ''; };
  const clearPrivate = (cancel = true) => {
    launcher.current.cancel();
    if (cancel) invalidate(); setSelected(null); setProgress(null); setPacket(null); setReadiness(null); setReview(null); setNotifications(null); setNotificationAccepted(false); setShareContent(false); setShareProgress(false); setShareReview(false); if (activeRef.current) engine.reset();
    setNotificationSignal(false); notificationBaseline.current = null;
  };
  const clearSelectedLink = () => {
    // Keep private source intent blocked until the learner explicitly leaves it.
    clearPrivate(); setLink(null); setCourses([]);
  };
  const clear = () => { clearPrivate(); activeRef.current = false; setActive(false); setError(''); };
  const clearAccount = (cancel = true) => {
    clearPrivate(cancel); setLink(null); setLinks([]); setCourses([]); setConnectors([]); setPending({}); setDiscovery(null); setConfirmations({});
    setStorageAccepted(false); setAllowContent(false); setAllowProgress(false); setAllowReview(false); setReviewConfirmations({}); setOwnedCourses({}); setMapEditors({}); setTargetedConfirmations({}); clearCredentials(); registrations.current.clear(); createId.current = null;
    setAllowNotifications(false); setNotificationConfirmations({});
    if (joinCode.current) joinCode.current.value = '';
    if (label.current) label.current.value = '';
  };
  const current = run => mounted.current && generation.current === run;
  function begin() { invalidate(); const controller = new AbortController(); request.current = controller; setLoading(true); setError(''); setNotice(''); return { run: generation.current, controller }; }
  function failed(cause, run, controller) {
    if (!current(run) || controller.signal.aborted || cause?.code === 'cancelled') return;
    const locationOnly = ['learning_launch_location_expired', 'learning_targeted_launch_not_allowed', 'learning_launch_location_unavailable'].includes(cause?.code);
    if (['learning_sign_in_required', 'learning_session_expired', 'learning_account_invalid', 'learning_csrf_refused'].includes(cause?.code)) { clearAccount(); client.current.clear(); setSession(null); }
    else if (['learning_access_revoked', 'learning_context_revoked', 'learning_connection_not_found', 'learning_connection_revoked', 'learning_link_inactive', 'learning_link_not_found', 'learning_link_required', 'learning_link_revoked'].includes(cause?.code)) {
      clearSelectedLink(); setLinks(old => old.filter(value => value.id !== link?.id));
    }
    else if (!locationOnly && (cause?.status === 401 || cause?.status === 403 || ['learning_authority_changed', 'learning_content_not_allowed', 'learning_progress_not_allowed', 'learning_review_not_allowed', 'learning_enrollment_required', 'learning_permission_required', 'learning_authorization_expired', 'session_expired', 'session_unauthorized'].includes(cause?.code))) clearPrivate();
    const messages = {
      learning_sign_in_required: 'Sign in to your learning account again.', learning_session_expired: 'Your learning sign-in expired. Sign in again.',
      learning_link_inactive: 'This learning account link is no longer active. Refresh your connections.', learning_link_not_found: 'This learning account link could not be confirmed. Refresh your connections.',
      learning_connection_revoked: 'The learning provider ended this connection.', learning_authority_changed: 'Your learning access changed. Refresh your courses before continuing.',
      learning_content_not_allowed: 'This learning connection has not authorized course passages to be shared with AI.', learning_progress_not_allowed: 'This learning connection has not authorized access to your progress.',
      learning_review_not_allowed: 'The connection owner has not authorized this released quiz review to be shared with AI.',
      learning_review_unavailable: 'A released review of your provider-reported completed or terminal results is not available. Check course readiness for the current reason.',
      learning_map_conflict: 'The saved learning map changed. Load it again before saving or deleting.',
      learning_map_invalid: 'The learning map could not be validated. Check its course, version and mapping fields before trying again.',
      learning_enrollment_required: 'Your enrollment could not be confirmed. Refresh your enrolled courses.', learning_self_approval_forbidden: 'A separate learning administrator must verify your registration match.',
      learning_access_revoked: 'Your learning access changed. The private conversation was cleared. Refresh your enrolled courses before asking again.',
      learning_popup_blocked: 'Allow a new course window, then choose Open course again. No launch link was created.',
      learning_popup_closed: 'The course window was closed. Choose Open course to try again.',
      learning_launch_unavailable: 'The course could not be opened. Refresh your enrolled courses before trying again.',
      learning_launch_location_expired: 'This lesson reference expired. Ask your question again for a fresh source reference, or choose Open course.',
      learning_targeted_launch_not_allowed: 'Your learning administrator has not enabled lesson links. Choose Open course to continue normally.',
      learning_launch_location_unavailable: 'This lesson can no longer be targeted reliably. Ask again for fresh sources, or choose Open course.',
      learning_launch_registration_ambiguous: 'More than one registration matches this course. Your learning administrator must resolve the enrollment before it can be opened here.',
      learning_launch_busy: 'The course launch service is busy. Try again shortly.',
      learning_launch_timeout: 'SCORM Cloud did not finish creating the launch link. Choose Open course to try again.',
      learning_launch_expired: 'The new course link expired before it could open. Choose Open course to create another.',
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
    return () => { mounted.current = false; generation.current++; request.current?.abort(); launcher.current.cancel(); clearCredentials(); unsubscribe(); client.current.dispose(); try { popup.current?.close(); } catch {} };
  }, []);
  useEffect(() => subscribeAgentSession(setAgent), []);
  useEffect(() => {
    if (!link) return;
    const refreshed = links.find(value => value.id === link.id);
    if (!refreshed || refreshed.status !== 'active') {
      clearSelectedLink(); setError('This learning account link is no longer active. Select an active link before continuing.');
    } else setLink(refreshed);
  }, [links, link?.id]);
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
  useEffect(() => {
    if (!authenticated || !link || link.status !== 'active' || !selected || !notifications?.enabled || loading || engine.busy) return;
    let stopped = false;
    const visible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';
    const poll = async () => {
      if (stopped || !visible() || notificationPoll.current) return;
      const run = generation.current, controller = new AbortController(); notificationPoll.current = controller;
      try {
        const value = await client.current.request('progress-notification-status', { link_id: link.id, course_id: selected.id, version: selected.version }, controller.signal);
        if (stopped || !visible() || !current(run) || controller.signal.aborted) return;
        if (!value.notifications.enabled) { clearPrivate(); setNotice(value.notifications.notice); return; }
        const received = value.notifications.last_received_at || null;
        if (received && received !== notificationBaseline.current) { setNotificationSignal(true); setNotice('New progress is available — Refresh my progress.'); }
        notificationBaseline.current = received; setNotifications(value.notifications);
      } catch (cause) {
        if (!stopped && (cause?.status === 401 || cause?.status === 403 || ['learning_sign_in_required', 'learning_session_expired', 'learning_account_invalid', 'learning_csrf_refused', 'learning_link_not_found', 'learning_connection_not_found', 'learning_link_revoked', 'learning_connection_revoked', 'learning_access_revoked'].includes(cause?.code))) failed(cause, run, controller);
      }
      finally { if (notificationPoll.current === controller) notificationPoll.current = null; }
    };
    const visibility = () => { if (!visible()) notificationPoll.current?.abort(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(poll, 30_000);
    return () => { stopped = true; clearInterval(timer); notificationPoll.current?.abort(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); };
  }, [authenticated, session?.account?.id, link?.id, link?.status, selected?.id, selected?.version, notifications?.enabled, loading, engine.busy]);
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
    if (kind === 'content') setShareContent(value); else if (kind === 'progress') setShareProgress(value); else setShareReview(value);
  }
  function chooseJourney(value) { clear(); clearCredentials(); setJourney(value); }
  function checkReadiness() {
    if (!link || !selected) return;
    perform('course-readiness', { link_id: link.id, course_id: selected.id, version: selected.version }, value => {
      setReadiness(value.readiness); setReview(null);
      if (value.readiness.content.status !== 'readable' && shareContent || value.readiness.quiz_review.status !== 'available' && shareReview) {
        setPacket(null); setShareContent(false); setShareReview(false); engine.reset();
      }
    });
  }
  function checkReview() {
    if (!link || !selected) return;
    perform('quiz-review', { link_id: link.id, course_id: selected.id, version: selected.version }, value => {
      setReview(value.quiz_review);
      if (value.quiz_review.status !== 'available' && shareReview) { setShareReview(false); setPacket(null); engine.reset(); }
    });
  }
  function checkNotifications() {
    if (!link || !selected) return;
    perform('progress-notification-status', { link_id: link.id, course_id: selected.id, version: selected.version }, value => {
      notificationBaseline.current = value.notifications.last_received_at || null; setNotificationSignal(false); setNotifications(value.notifications);
    });
  }
  function changeNotifications(enable) {
    if (!link || !selected || enable && (!notifications?.available || !notificationAccepted)) return;
    const target = { link_id: link.id, course_id: selected.id, version: selected.version, confirmed: true };
    clearPrivate();
    perform(enable ? 'enable-progress-notifications' : 'disable-progress-notifications', target, value => {
      setNotice(value.notifications.notice + ' Select your enrolled course again for fresh readiness and sharing choices.');
    });
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
      policy: { allowAiContent: allowContent, allowAiProgress: allowProgress, allowAiReview: allowReview, allowProgressNotifications: allowNotifications }, intent: 'authorize-enrolled-learners', request_id: createId.current }, result => {
      setConnectors(old => [...old.filter(item => item.id !== result.connector.id), result.connector]); createId.current = null; clearCredentials();
      setStorageAccepted(false); setAllowContent(false); setAllowProgress(false); setAllowReview(false); setAllowNotifications(false); setNotice('Your learning connection was created. Share its connection code only with intended learners.');
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
  function setReviewPolicy(connector, allow) {
    if (allow && reviewConfirmations[connector.id] !== true) return;
    clearPrivate();
    perform('set-review-policy', { connector_id: connector.id, allowAiReview: allow, confirmed: true }, value => {
      setConnectors(old => old.map(item => item.id === connector.id ? value.connector : item));
      setReviewConfirmations(old => ({ ...old, [connector.id]: false }));
      setNotice(allow ? 'Learners may choose to share released reviews of their own provider-reported completed or terminal results. Each course still needs an owner-supplied release map.' : 'Sharing released quiz reviews with AI is off for this connection.');
    });
  }
  function setNotificationPolicy(connector, allow) {
    if (allow && notificationConfirmations[connector.id] !== true) return;
    clearPrivate();
    perform('set-notification-policy', { connector_id: connector.id, allowProgressNotifications: allow, confirmed: true }, value => {
      setConnectors(old => old.map(item => item.id === connector.id ? value.connector : item));
      setNotificationConfirmations(old => ({ ...old, [connector.id]: false }));
      setNotice(allow ? 'Enrolled learners may explicitly enable authenticated progress update signals for their own registrations.' : 'Progress update notifications are off for this connection. Current progress still comes from a fresh provider check.');
    });
  }
  function editMap(connectorId, change) {
    setMapEditors(old => ({ ...old, [connectorId]: { ...old[connectorId], ...change,
      ...(change.document !== undefined ? { preview: null, confirmed: false } : {}) } }));
  }
  function chooseMapCourse(connector, value) {
    const course = (ownedCourses[connector.id] || []).find(item => keyOf(item) === value);
    if (!course) { editMap(connector.id, { course: null, snapshot: null, loaded: false, document: '', preview: null, confirmed: false }); return; }
    editMap(connector.id, { course, snapshot: null, loaded: false, document: JSON.stringify(blankMap(course), null, 2) });
    perform('get-course-map', { connector_id: connector.id, course_id: course.id, version: course.version }, value => {
      editMap(connector.id, { course, loaded: true, snapshot: value.course_map,
        document: JSON.stringify(value.course_map?.map || blankMap(course), null, 2) });
    });
  }
  function previewMap(connector) {
    const editor = mapEditors[connector.id];
    if (!editor?.course || !editor.loaded) return;
    let map;
    try { if (new TextEncoder().encode(editor.document).byteLength > 32768) throw Error(); map = JSON.parse(editor.document); }
    catch { setError('The learning map must be valid and fit within 32 KB. Check the draft before trying again.'); return; }
    perform('preview-course-map', { connector_id: connector.id, course_id: editor.course.id, version: editor.course.version, map }, value => {
      const document = JSON.stringify(value.map, null, 2);
      setMapEditors(old => ({ ...old, [connector.id]: { ...old[connector.id], document, preview: { ...value, document }, confirmed: false } }));
      setNotice('The map structure is valid. Its descriptions and prerequisites remain owner supplied, rather than LMS-verified achievement evidence.');
    });
  }
  function saveMap(connector) {
    const editor = mapEditors[connector.id];
    if (!editor?.loaded || !editor.preview || editor.preview.document !== editor.document || !editor.confirmed) return;
    perform('save-course-map', { connector_id: connector.id, course_id: editor.course.id, version: editor.course.version,
      map: editor.preview.map, confirmed: true, expected_revision: editor.snapshot?.provenance.revision || null }, value => {
      clearPrivate(); editMap(connector.id, { loaded: true, snapshot: value.course_map, document: JSON.stringify(value.course_map.map, null, 2) });
      setNotice('The owner-supplied learning map was saved. Review is available only when this release matches the learner’s provider-reported completed or terminal results.');
    });
  }
  function deleteMap(connector) {
    const editor = mapEditors[connector.id];
    if (!editor?.loaded || !editor.snapshot || !editor.confirmed) return;
    perform('delete-course-map', { connector_id: connector.id, course_id: editor.course.id, version: editor.course.version,
      confirmed: true, expected_revision: editor.snapshot.provenance.revision }, () => {
      clearPrivate(); editMap(connector.id, { loaded: true, snapshot: null, document: JSON.stringify(blankMap(editor.course), null, 2) });
      setNotice('The saved learning map was removed and its review release ended. Original course results and messages already shared with an AI client are unchanged.');
    });
  }
  function setTargetedLaunch(connector, allow) {
    if (allow && targetedConfirmations[connector.id] !== true) return;
    clearPrivate();
    perform('set-targeted-launch-policy', { connector_id: connector.id, allowTargetedLaunch: allow, confirmed: true }, value => {
      setConnectors(old => old.map(item => item.id === connector.id ? value.connector : item));
      setTargetedConfirmations(old => ({ ...old, [connector.id]: false }));
      setNotice(allow ? 'Verified lesson links are enabled for enrolled learners. Course rules may still limit which lesson can open.' : 'Lesson links are off. Enrolled learners can still open the course normally.');
    });
  }
  async function openCourse(location) {
    if (loading || engine.busy || !authenticated || !link || link.status !== 'active' || !selected) return;
    const { run, controller } = begin();
    try {
      // The blank window opens synchronously inside this deliberate click before authorization is fetched.
      const value = await launcher.current.open({ link_id: link.id, course_id: selected.id, version: selected.version,
        ...(location?.target_kind === 'activity' ? { location_ref: location.location_ref } : {}) },
        { signal: controller.signal, current: () => current(run) });
      if (current(run)) setNotice(value.notice);
    } catch (cause) { failed(cause, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  async function send(text, ids = engine.ctx) {
    const question = (text || '').trim();
    if (!question || loading || engine.busy) return;
    if (!activeRef.current || !authenticated || !link || link.status !== 'active' || !selected || !paired || !shareContent && !shareProgress && !shareReview) {
      setError('Select a verified enrolled course and explicitly choose what to share before asking.'); return;
    }
    if (shareContent && !contentAvailable || shareProgress && !selectedProgress || shareReview && !reviewAvailable) {
      setError('Check the selected course’s readiness, progress or released review before sharing that context.'); return;
    }
    const sample = userCourseSample();
    if (!sample) { setError('Connect your AI agent before sharing selected learning context.'); return; }
    const { run, controller } = begin(), conversation = engine.captureGeneration();
    const options = { link_id: link.id, course: selected, share_content: shareContent, share_progress: shareProgress, share_review: shareReview };
    try {
      const value = selectedLearningPacket(await learningContextRequest({ link_id: link.id, course_id: selected.id,
        version: selected.version, question, share_content: shareContent, share_progress: shareProgress, share_review: shareReview }, controller.signal), options);
      if (!current(run) || engine.captureGeneration() !== conversation) return;
      setPacket(value);
      const identity = JSON.stringify(['learner', session.account.id, link.id, value.source.provider, selected.id, selected.version,
        value.source.source_version, shareContent, shareProgress, shareReview]);
      await engine.send(question, ids, value.interventionContext, sample, identity,
        value.authorization_ticket ? { learningAuthorization: value.authorization_ticket } : {});
    } catch (cause) { failed(cause, run, controller); }
    finally { if (current(run)) setLoading(false); }
  }
  function stop() { invalidate(); engine.stop(); }
  function mapEditorPanel(connector) {
    const editor = mapEditors[connector.id], catalog = ownedCourses[connector.id] || [];
    let draft;
    try {
      draft = JSON.parse(editor?.document || 'null');
      if (!renderableMap(draft) || draft.course_id !== editor?.course?.id || draft.version !== editor?.course?.version) draft = null;
    } catch { draft = null; }
    const rows = key => draft?.[key] || [];
    const write = value => editMap(connector.id, { document: JSON.stringify(value, null, 2) });
    const updateRows = (key, index, change) => write({ ...draft, [key]: rows(key).map((item, i) => i === index ? { ...item, ...change } : item) });
    const removeRow = (key, index) => write({ ...draft, [key]: rows(key).filter((_, i) => i !== index) });
    const freshId = key => { let next = 1; while (rows(key).some(item => item.id === key + '-' + next)) next++; return key + '-' + next; };
    const sectionOptions = rows('instructional_locations').filter(item => typeof item.id === 'string' && item.id);
    const sectionSelect = (label, ids, change) => <label className="stack">Related section<select className="input" aria-label={label} disabled={disabled} value={ids?.[0] || ''} onChange={event => change(event.target.value ? [event.target.value] : [])}><option value="">Choose a released section…</option>{sectionOptions.map(item => <option key={item.id} value={item.id}>{item.label || 'Unnamed section'}</option>)}</select></label>;
    const reference = value => catalog.find(course => keyOf(course) === value);
    const courseOptions = (values, index, omitCurrent = false) => catalog.filter(course => (!omitCurrent || course.id !== editor?.course.id) && !values.some((item, i) => i !== index && item.course_id === course.id));
    const courseValue = item => item.course_id ? JSON.stringify([item.course_id, item.version]) : '';
    return <details data-testid={'learning-map-editor-' + connector.id}><summary>Course learning map and released quiz review</summary><div className="stack" style={{ gap: 9 }}>
      <p>Supply instructional locations, question labels and optional objectives or prerequisites. These descriptions are owner supplied; they do not establish LMS prerequisites, completion or achievement. Do not include answer keys.</p>
      <button className="btn sm" disabled={disabled} onClick={() => perform('owned-courses', { connector_id: connector.id }, value => setOwnedCourses(old => ({ ...old, [connector.id]: value.courses })))}>Load courses for this connection</button>
      <label className="stack">Course to map<select className="input" aria-label={'Learning map course ' + connector.id} disabled={disabled} value={editor?.course ? keyOf(editor.course) : ''} onChange={event => chooseMapCourse(connector, event.target.value)}><option value="">Choose a course and version…</option>{catalog.map(course => <option key={keyOf(course)} value={keyOf(course)}>{course.title} · Version {course.version}</option>)}</select></label>
      {editor?.course ? <>
        <p>{editor.snapshot ? 'Owner-supplied map saved ' + dateLabel(editor.snapshot.provenance.saved_at) + '.' : editor.loaded ? 'No owner-supplied map is saved for this course version.' : 'Checking the saved map…'}</p>
        {editor.loaded && draft ? <div className="stack" style={{ gap: 12 }} data-testid={'learning-map-guided-' + connector.id}>
          <label className="stack">Map title<input className="input" aria-label={'Learning map title ' + connector.id} disabled={disabled} value={draft.title || ''} onChange={event => { const value = { ...draft }; if (event.target.value) value.title = event.target.value; else delete value.title; write(value); }} /></label>
          <fieldset><legend>Instructional sections</legend><p>Name each section and its exact published course file. An optional section reference is descriptive; it does not promise an internal slide jump.</p>
            {rows('instructional_locations').map((item, index) => <div className="note stack" style={{ flexDirection: 'column', alignItems: 'stretch' }} key={index}>
              <label className="stack">Section name<input className="input" aria-label={'Section name ' + index + ' ' + connector.id} disabled={disabled} value={item.label || ''} onChange={event => updateRows('instructional_locations', index, { label: event.target.value })} /></label>
              <label className="stack">Published course file<input className="input" aria-label={'Published section file ' + index + ' ' + connector.id} disabled={disabled} placeholder="lesson.html" value={item.source_file || ''} onChange={event => updateRows('instructional_locations', index, { source_file: event.target.value })} /></label>
              <label className="stack">Optional section reference<input className="input" aria-label={'Section reference ' + index + ' ' + connector.id} disabled={disabled} value={item.fragment || ''} onChange={event => { const next = { ...item }; if (event.target.value) next.fragment = event.target.value; else delete next.fragment; write({ ...draft, instructional_locations: rows('instructional_locations').map((old, i) => i === index ? next : old) }); }} /></label>
              <button className="btn sm" disabled={disabled} onClick={() => removeRow('instructional_locations', index)}>Remove section {index + 1}</button>
            </div>)}<button className="btn sm" disabled={disabled} onClick={() => write({ ...draft, instructional_locations: [...rows('instructional_locations'), { id: freshId('instructional_locations'), label: '', source_file: '' }] })}>Add instructional section</button>
          </fieldset>
          <fieldset><legend>Learning objectives</legend>{rows('objectives').map((item, index) => <div className="note stack" style={{ flexDirection: 'column', alignItems: 'stretch' }} key={index}>
            <label className="stack">Objective<input className="input" aria-label={'Objective label ' + index + ' ' + connector.id} disabled={disabled} value={item.label || ''} onChange={event => updateRows('objectives', index, { label: event.target.value })} /></label>
            {sectionSelect('Objective section ' + index + ' ' + connector.id, item.location_ids, ids => updateRows('objectives', index, { location_ids: ids }))}
            <button className="btn sm" disabled={disabled} onClick={() => removeRow('objectives', index)}>Remove objective {index + 1}</button>
          </div>)}<button className="btn sm" disabled={disabled} onClick={() => write({ ...draft, objectives: [...rows('objectives'), { id: freshId('objectives'), label: '', competency_iris: [], location_ids: [] }] })}>Add learning objective</button></fieldset>
          <fieldset><legend>Owner-supplied prerequisites</legend><p>Choose required or recommended explicitly. This does not determine whether a learner has met a prerequisite.</p>{rows('prerequisites').map((item, index) => <div className="note stack" style={{ flexDirection: 'column', alignItems: 'stretch' }} key={index}>
            <label className="stack">Prerequisite course<select className="input" aria-label={'Prerequisite course ' + index + ' ' + connector.id} disabled={disabled} value={courseValue(item)} onChange={event => { const chosen = reference(event.target.value); if (chosen) updateRows('prerequisites', index, { course_id: chosen.id, version: chosen.version, label: chosen.title }); }}><option value="">Choose a course…</option>{courseOptions(rows('prerequisites'), index, true).map(course => <option key={keyOf(course)} value={keyOf(course)}>{course.title} · Version {course.version}</option>)}</select></label>
            <label className="stack">Requirement<select className="input" aria-label={'Prerequisite relation ' + index + ' ' + connector.id} disabled={disabled} value={item.relation || 'recommended'} onChange={event => updateRows('prerequisites', index, { relation: event.target.value })}><option value="recommended">Recommended</option><option value="required">Required</option></select></label>
            <button className="btn sm" disabled={disabled} onClick={() => removeRow('prerequisites', index)}>Remove prerequisite {index + 1}</button>
          </div>)}<button className="btn sm" disabled={disabled} onClick={() => write({ ...draft, prerequisites: [...rows('prerequisites'), { course_id: '', relation: 'recommended' }] })}>Add prerequisite</button></fieldset>
          <fieldset><legend>Suggested course order</legend><label><input type="checkbox" aria-label={'Include course sequence ' + connector.id} checked={!!draft.curriculum} disabled={disabled} onChange={event => { const next = { ...draft }; if (event.target.checked) next.curriculum = { label: 'Owner-supplied suggested sequence', sequence: [] }; else delete next.curriculum; write(next); }} /> Include an owner-supplied sequence</label>
            {draft.curriculum ? <><label className="stack">Sequence name<input className="input" aria-label={'Course sequence label ' + connector.id} disabled={disabled} value={draft.curriculum.label || ''} onChange={event => write({ ...draft, curriculum: { ...draft.curriculum, label: event.target.value } })} /></label>
              {(draft.curriculum.sequence || []).map((item, index) => <div className="note stack" style={{ flexDirection: 'column', alignItems: 'stretch' }} key={index}>
                <label className="stack">Course {index + 1}<select className="input" aria-label={'Sequence course ' + index + ' ' + connector.id} disabled={disabled} value={courseValue(item)} onChange={event => { const chosen = reference(event.target.value); if (chosen) write({ ...draft, curriculum: { ...draft.curriculum, sequence: draft.curriculum.sequence.map((old, i) => i === index ? { course_id: chosen.id, version: chosen.version, label: chosen.title } : old) } }); }}><option value="">Choose a course…</option>{courseOptions(draft.curriculum.sequence, index).map(course => <option key={keyOf(course)} value={keyOf(course)}>{course.title} · Version {course.version}</option>)}</select></label>
                <div className="row wrap"><button className="btn sm" disabled={disabled || index === 0} onClick={() => { const values = [...draft.curriculum.sequence]; [values[index - 1], values[index]] = [values[index], values[index - 1]]; write({ ...draft, curriculum: { ...draft.curriculum, sequence: values } }); }}>Move course {index + 1} up</button><button className="btn sm" disabled={disabled} onClick={() => write({ ...draft, curriculum: { ...draft.curriculum, sequence: draft.curriculum.sequence.filter((_, i) => i !== index) } })}>Remove sequence course {index + 1}</button></div>
              </div>)}<button className="btn sm" disabled={disabled} onClick={() => write({ ...draft, curriculum: { ...draft.curriculum, sequence: [...draft.curriculum.sequence, { course_id: '' }] } })}>Add course to sequence</button>
            </> : null}
          </fieldset>
          <fieldset><legend>Released quiz review</legend><label><input type="checkbox" aria-label={'Release completed or terminal quiz results ' + connector.id} disabled={disabled} checked={draft.release_quiz_review === true} onChange={event => write({ ...draft, release_quiz_review: event.target.checked })} /> Release mapped questions for review when the provider reports completed or terminal results</label><p>Question labels and related sections are separate from provider records. Exact provider references are required before a mapping can be saved. A terminal lesson status does not establish overall course completion.</p>
            {rows('review_items').map((item, index) => <div className="note stack" style={{ flexDirection: 'column', alignItems: 'stretch' }} key={index}>
              <label className="stack">Question shown to learners<input className="input" aria-label={'Released question label ' + index + ' ' + connector.id} disabled={disabled} value={item.question_label || ''} onChange={event => updateRows('review_items', index, { question_label: event.target.value })} /></label>
              {sectionSelect('Released question section ' + index + ' ' + connector.id, item.location_ids, ids => updateRows('review_items', index, { location_ids: ids }))}
              <details><summary>Advanced provider references and response labels</summary><p>Use the exact activity and interaction IDs recorded by the provider. A matching name alone is not evidence of an attempted question.</p>
                <label className="stack">Provider activity ID<input className="input" aria-label={'Review activity ID ' + index + ' ' + connector.id} disabled={disabled} value={item.activity_id || ''} onChange={event => updateRows('review_items', index, { activity_id: event.target.value })} /></label>
                <label className="stack">Provider interaction ID<input className="input" aria-label={'Review interaction ID ' + index + ' ' + connector.id} disabled={disabled} value={item.interaction_id || ''} onChange={event => updateRows('review_items', index, { interaction_id: event.target.value })} /></label>
                {(item.response_labels || []).map((response, responseIndex) => <div className="row wrap" key={responseIndex}><label>Recorded response code<input className="input" aria-label={'Response code ' + index + ' ' + responseIndex + ' ' + connector.id} disabled={disabled} value={response.response || ''} onChange={event => updateRows('review_items', index, { response_labels: item.response_labels.map((old, i) => i === responseIndex ? { ...old, response: event.target.value } : old) })} /></label><label>Learner-facing response label<input className="input" aria-label={'Response label ' + index + ' ' + responseIndex + ' ' + connector.id} disabled={disabled} value={response.label || ''} onChange={event => updateRows('review_items', index, { response_labels: item.response_labels.map((old, i) => i === responseIndex ? { ...old, label: event.target.value } : old) })} /></label><button className="btn sm" disabled={disabled} onClick={() => updateRows('review_items', index, { response_labels: item.response_labels.filter((_, i) => i !== responseIndex) })}>Remove response label {responseIndex + 1}</button></div>)}
                <button className="btn sm" disabled={disabled} onClick={() => updateRows('review_items', index, { response_labels: [...(item.response_labels || []), { response: '', label: '' }] })}>Add response label for question {index + 1}</button><p>No correct-answer key is stored in this map.</p>
              </details><button className="btn sm" disabled={disabled} onClick={() => removeRow('review_items', index)}>Remove released question {index + 1}</button>
            </div>)}<button className="btn sm" disabled={disabled} onClick={() => write({ ...draft, review_items: [...rows('review_items'), { activity_id: '', interaction_id: '', question_label: '', response_labels: [], location_ids: [] }] })}>Add released question mapping</button>
          </fieldset>
        </div> : editor.loaded ? <p className="note warn">The advanced draft cannot be shown in guided fields. Fix its JSON or reload the saved map.</p> : null}
        <details><summary>Advanced: edit map JSON</summary><label className="stack">Learning map JSON<textarea className="input" rows={16} spellCheck={false} maxLength={32768} aria-label={'Learning map JSON ' + connector.id} disabled={disabled || !editor.loaded} value={editor.document || ''} onChange={event => editMap(connector.id, { document: event.target.value })} /></label></details>
        <p>Release only material the owner permits learners to review with provider-reported completed or terminal results. Each question must match its exact provider record and related section. A released map alone does not prove that a learner attempted the question.</p>
        <details><summary>Map fields and review scope</summary><p><code>instructional_locations</code> names published files and optional informational fragments. <code>review_items</code> maps learner-facing question and response labels to those locations. <code>objectives</code>, <code>prerequisites</code> and <code>curriculum</code> are explicit owner descriptions. They do not infer achievement or permit jumping to an internal slide.</p></details>
        <div className="row wrap"><button className="btn sm" disabled={disabled || !editor.loaded} onClick={() => chooseMapCourse(connector, keyOf(editor.course))}>Reload saved map</button><button className="btn sm" disabled={disabled || !editor.loaded} onClick={() => previewMap(connector)}>Validate map preview</button></div>
        {editor.preview ? <p role="status">Map structure validated. The owner’s descriptions have not been independently verified against learner achievement.</p> : null}
        <label><input type="checkbox" aria-label={'Confirm learning map change ' + connector.id} checked={editor.confirmed === true} disabled={disabled || !editor.loaded} onChange={event => editMap(connector.id, { confirmed: event.target.checked })} /> I authorize this learning-map change and any explicit quiz-review release it contains.</label>
        <div className="row wrap"><button className="btn sm" disabled={disabled || !editor.confirmed || !editor.preview || editor.preview.document !== editor.document} onClick={() => saveMap(connector)}>Save this owner-supplied map</button><button className="btn sm" disabled={disabled || !editor.confirmed || !editor.snapshot} onClick={() => deleteMap(connector)}>Delete saved map and review release</button></div>
      </> : null}
    </div></details>;
  }
  const disabled = loading || engine.busy;
  const selectedProgress = progress?.records.find(record => record.course_id === selected?.id && record.version === selected?.version);
  const reviewStatus = readiness?.quiz_review;
  const reviewAvailable = reviewStatus?.status === 'available' && reviewStatus.count > 0;
  const contentAvailable = readiness?.content.status === 'readable';
  const blocked = active && (!authenticated || !link || !selected || !paired || !shareContent && !shareProgress && !shareReview ||
    shareContent && !contentAvailable || shareProgress && !selectedProgress || shareReview && !reviewAvailable);
  const panel = <details className="note" style={{ display: 'block' }} data-testid="learning-account-panel">
    <summary><b>Your learning account</b>{authenticated ? ' · Signed in' : ''}</summary>
    <div className="stack small" style={{ gap: 12, marginTop: 12 }}>
      <p>Your verified Interego account connects to your own enrolled courses and progress. Your AI agent is a separate connection.</p>
      <div className="row wrap" role="group" aria-label="Learning journey"><button className="btn sm" aria-pressed={journey === 'learner'} onClick={() => chooseJourney('learner')}>I’m learning</button><button className="btn sm" aria-pressed={journey === 'owner'} onClick={() => chooseJourney('owner')}>I manage courses</button></div>
      <ol className="small" data-testid="learning-journey-steps">{journey === 'learner' ? <>
        <li>{authenticated ? 'Interego account verified.' : 'Connect your Interego learning account.'}</li>
        <li>{link?.status === 'active' ? 'Learning account link is active.' : links.some(value => value.status === 'active') ? 'Your active learning account link is ready. Choose Show my enrolled courses.' : links.some(value => value.status === 'approved') ? 'Your administrator approved the registration match. Activate this account to continue.' : links.some(value => value.status === 'pending-admin') ? 'Waiting for your learning administrator to verify the registration match.' : 'Request a provider link; wait for administrator verification, then activate the approved link.'}</li>
        <li>{selected ? 'Selected course: ' + selected.title + '. ' + (readiness ? 'Readiness checked ' + dateLabel(readiness.checked_at) + '.' : 'Check course readiness.') : link?.status === 'active' ? 'Choose one of your enrolled courses and check its readiness.' : 'Open the enrolled courses of an active account link to continue.'}</li>
        <li>{paired ? 'AI agent connected. ' : 'Connect your AI agent. '}{shareContent || shareProgress || shareReview ? 'Your sharing choices are set. Ask about your selected course.' : 'Choose the context you want to share before asking.'}</li>
      </> : <><li>Connect your Interego learning account.</li><li>Create a managed connection and explicitly choose its permissions.</li><li>Share its code and verify learners against actual registrations.</li><li>Optionally save a course learning map and release review of completed or terminal quiz results.</li></>}</ol>
      {!session ? <p>Checking your learning account…</p> : !session.enabled ? <p>Learning account sign-in is not available on this workbench yet.</p> : !authenticated ? <button className="btn" disabled={loading} onClick={signIn}>Connect your Interego learning account</button> : <>
        <p>Your Interego account is verified.</p><details><summary>My verified account details</summary><p style={{ overflowWrap: 'anywhere' }}>{session.account.webId}</p></details>
        <div className="row wrap"><button className="btn sm" disabled={disabled} onClick={refreshAccount}>Refresh learning account</button><button className="btn sm" disabled={loading} onClick={signOut}>Sign out of learning account</button></div>
        {journey === 'learner' ? <>
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
          {selected ? <div className="stack" style={{ gap: 6 }} data-testid="learner-course-launch"><button className="btn sm" disabled={disabled} onClick={() => openCourse()}>Open course</button><span>Opens your enrolled course in SCORM Cloud. Your normal registration tracking applies; Cloud controls resume position and course-version changes.</span></div> : null}
          {selected ? <div className="note stack" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }} data-testid="learner-course-readiness">
            <b>Course readiness</b><button className="btn sm" disabled={disabled} onClick={checkReadiness}>Check course readiness</button>
            {readiness ? <span>Checked {dateLabel(readiness.checked_at)}. Each question checks current access again.</span> : <span>Not checked. Content readability, released review and lesson-link support have not been confirmed.</span>}
            <dl style={{ margin: 0 }}><dt>Enrollment</dt><dd>{readiness ? 'Verified with the provider ' + dateLabel(readiness.enrollment.observed_at) : 'Course listed among your registrations; a fresh readiness check is available.'}</dd>
              <dt>Content for questions</dt><dd>{contentAvailable ? 'Readable' : readiness?.content.status === 'not-authorized' ? 'Not authorized by the connection owner' : readiness ? 'Unavailable' : 'Not checked'}{readiness?.content.reason ? ' · ' + readiness.content.reason : ''}</dd>
              <dt>Released quiz review for AI</dt><dd>{reviewLabel(reviewStatus?.status)}{reviewStatus?.reason ? ' · ' + reviewStatus.reason : ''}{reviewAvailable ? ' · ' + reviewStatus.count + ' released result(s)' : ''}</dd>
              <dt>Course and lesson links</dt><dd>{readiness ? (readiness.launch.kind === 'lesson' ? 'Verified published lessons may be linked from question sources. ' : 'Course launch only. ') + readiness.launch.reason : 'Open course uses your registration. Lesson-link support has not been checked.'}</dd>
              <dt>Progress freshness</dt><dd>{selectedProgress ? 'Provider summary observed ' + dateLabel(selectedProgress.observed_at) : 'Not checked for this selected course. Choose Check my progress.'}</dd></dl>
            {readiness?.learning_map.status === 'owner-supplied' ? <div className="stack" data-testid="learner-owner-map"><b>Owner-supplied learning map</b><span>Saved {dateLabel(readiness.learning_map.saved_at)}. These are the owner’s descriptions, not LMS prerequisite or achievement evidence.</span>
              {readiness.learning_map.objectives.length ? <ul>{readiness.learning_map.objectives.map(objective => <li key={objective.id}>{objective.label}</li>)}</ul> : <span>No objectives were supplied.</span>}
              <b>Owner-supplied prerequisites</b>{readiness.learning_map.prerequisites.length ? <ul>{readiness.learning_map.prerequisites.map((item, index) => <li key={index}>{item.label || courses.find(course => course.id === item.course_id)?.title || 'Course title not supplied'} · {item.relation}. Whether you meet it has not been established here.</li>)}</ul> : <span>No prerequisite requirements were supplied by the owner.</span>}
              {readiness.learning_map.curriculum ? <><b>{readiness.learning_map.curriculum.label}</b><ol>{readiness.learning_map.curriculum.sequence.map((item, index) => <li key={index}>{courses.find(course => course.id === item.course_id)?.title || 'Course title not supplied'}{item.version !== undefined ? ' · Version ' + item.version : ''}</li>)}</ol><span>This is an owner-supplied sequence, not a provider-confirmed required curriculum.</span></> : <span>No curriculum sequence was supplied by the owner.</span>}
            </div> : <p>Learning map: {readiness ? 'No owner-supplied map is available.' : 'Not checked.'} The provider has not supplied authoritative prerequisites or a required curriculum.</p>}
          </div> : null}
          <button className="btn sm" disabled={disabled} onClick={() => perform('progress', { link_id: link.id }, setProgress)}>Check my progress</button>
          {progress ? <div className="stack" data-testid="learner-progress"><b>Your progress · SCORM Cloud</b><span>Checked {dateLabel(progress.as_of)}</span>{progress.records.length ? progress.records.map((record, index) => <div key={record.course_id + ':' + index} className="note stack" style={{ alignItems: 'stretch' }}><b>{record.title || 'Enrolled course'} · Version {record.version}</b><span>Completion: {record.completion} · Success: {record.success}</span><span>Score: {record.score === undefined ? 'Unreported' : record.score + ' / 100'} · Time: {record.total_seconds === undefined ? 'Unreported' : record.total_seconds + ' seconds'}</span><span>Source: SCORM Cloud · Checked {dateLabel(record.observed_at)}</span></div>) : <span>No progress records were supplied.</span>}</div> : null}
          {selected ? <div className="stack" style={{ gap: 8 }} data-testid="learner-quiz-review"><button className="btn sm" disabled={disabled} onClick={checkReview}>Check my released quiz review</button>
            {review ? <><b>{reviewLabel(review.status)}</b><span>Provider records checked {dateLabel(review.observed_at)}.{review.reason ? ' ' + review.reason : ''}</span>{review.records.map(record => <article className="note stack" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 5 }} key={record.citation_id}>
              <b>{record.question_label}</b><span>Your recorded response: {record.learner_response_label || record.learner_response || 'Not supplied'}</span><span>Recorded result: {record.result}</span><span data-testid="quiz-review-basis">{reviewBasis(record.submission)}</span><span>Observed {dateLabel(record.observed_at)}</span>
              {record.learner_response_label && record.learner_response ? <details><summary>Exact recorded response</summary><code>{record.learner_response}</code></details> : null}
              {record.locations.map(location => <span key={location.id}>Related released material: {location.label}. Exact internal slide navigation is not implied.</span>)}
            </article>)}</> : <p>No question review has been read. A release map and your provider-reported completed or terminal results must both be present; completion or a score alone does not expose question details.</p>}
          </div> : null}
          {selected ? <details data-testid="learner-progress-notifications"><summary>Optional progress updates</summary><div className="stack" style={{ gap: 8 }}>
            <p>An authenticated update signal means the provider reported a change. Check my progress still reads the current provider record; the signal is not a grade or completion claim.</p>
            <button className="btn sm" disabled={disabled} onClick={checkNotifications}>Check progress update status</button>
            {notifications ? <><p>{notifications.enabled ? 'Progress updates are enabled.' : notifications.available ? 'The connection owner permits progress updates; none are enabled for this selection.' : 'Progress updates are not available for this selection.'} {notifications.notice}</p>
              {notifications.last_received_at ? <span>Latest authenticated update signal: {dateLabel(notifications.last_received_at)}</span> : null}
              {notificationSignal ? <><p role="status">New progress is available — Refresh my progress.</p><button className="btn sm" disabled={disabled} onClick={() => perform('progress', { link_id: link.id, course_id: selected.id, version: selected.version }, value => { setProgress(value); setNotificationSignal(false); })}>Refresh my progress</button></> : null}
              {notifications.available && !notifications.enabled ? <><label><input type="checkbox" aria-label="Confirm progress update notifications" disabled={disabled} checked={notificationAccepted} onChange={event => setNotificationAccepted(event.target.checked)} /> Enable authenticated progress update signals for my selected enrolled course. Signals do not send quiz answers or course content to my AI.</label><button className="btn sm" disabled={disabled || !notificationAccepted} onClick={() => changeNotifications(true)}>Enable progress updates</button></> : notifications.enabled ? <button className="btn sm" disabled={disabled} onClick={() => changeNotifications(false)}>Disable progress updates</button> : null}
            </> : <p>Availability has not been checked. Selecting a course never enables notifications automatically.</p>}
          </div></details> : null}
          {selected ? <div className="stack" style={{ gap: 9 }} data-testid="learner-sharing">
            <b>Ask about {selected.title}</b>
            <label><input type="checkbox" aria-label="Share selected enrolled course passages with AI" checked={shareContent} disabled={disabled || !contentAvailable} onChange={event => sharing('content', event.target.checked)} /> Share selected passages from this enrolled course with my paired AI.</label>
            <label><input type="checkbox" aria-label="Share my enrolled course progress with AI" checked={shareProgress} disabled={disabled || !selectedProgress} onChange={event => sharing('progress', event.target.checked)} /> Share my own checked progress for this course with my paired AI.</label>
            <label><input type="checkbox" aria-label="Share my released quiz review with AI" checked={shareReview} disabled={disabled || !reviewAvailable} onChange={event => sharing('review', event.target.checked)} /> Share my released quiz review with AI.</label>
            {!contentAvailable || !reviewAvailable || !selectedProgress ? <p>Check course readiness and your progress first. Each sharing option stays off until its selected-course evidence and permissions are confirmed.</p> : null}
            {!paired ? <p>Pair an AI agent in the toolbar before asking. Viewing your courses and progress does not require an AI.</p> : null}
            <p>Each question rechecks the account link, enrollment and allowed sharing. A failed private question does not fall back to another catalog or the glossary.</p>
            <button className="btn sm" disabled={loading} onClick={clear}>Leave this learning context</button>
          </div> : null}
          {packet ? <details data-testid="learner-citations"><summary>Sources for the latest learning question</summary><p>{packet.source.provider} · Course version {packet.source.version} · Source {packet.source.source_version}</p>{packet.navigation ? <p>Source links open the course or a verified published lesson. Exact slide or section navigation is unavailable.</p> : null}{packet.citations.map(citation => {
            const location = packet.navigation?.locations.find(item => item.citation_id === citation.id);
            return <div className="stack" style={{ gap: 5, marginBottom: 10 }} key={citation.id}><b>{citation.title || location?.title || 'Course source'}</b>{location ? <><span style={{ overflowWrap: 'anywhere' }}>Published source file: {location.source_file}</span><button className="btn sm" disabled={disabled} onClick={() => openCourse(location)}>{location.target_kind === 'activity' ? 'Open lesson in course' : 'Open course'}</button></> : null}<details><summary>Source reference</summary><code style={{ overflowWrap: 'anywhere' }}>{citation.id}</code></details></div>;
          })}{packet.missing_context.map((item, index) => <p key={index}>{item}</p>)}</details> : null}
        </div> : null}
        </> : null}
        {journey === 'owner' ? <details open data-testid="learning-admin"><summary>Manage learning connections</summary><div className="stack" style={{ gap: 12, marginTop: 12 }}>
          <p>For course owners and learning administrators. Create a connection you manage, authorize enrolled-learner sharing, and match verified accounts to actual SCORM Cloud registrations.</p>
          <button className="btn sm" disabled={disabled} onClick={() => perform('owned-connectors', {}, value => setConnectors(value.connectors))}>Show connections I manage</button>
          <label className="stack">Connection name<input className="input" aria-label="Managed learning connection name" ref={label} maxLength={200} disabled={disabled} /></label>
          <label className="stack">SCORM Cloud application ID<input className="input" aria-label="Managed SCORM Cloud application ID" ref={appId} autoComplete="off" disabled={disabled} /></label>
          <label className="stack">SCORM Cloud secret<input className="input" aria-label="Managed SCORM Cloud secret" type="password" ref={secret} autoComplete="off" disabled={disabled} /></label>
          <label><input type="checkbox" aria-label="Allow encrypted learning credential storage" checked={storageAccepted} disabled={disabled} onChange={event => setStorageAccepted(event.target.checked)} /> Allow this workbench to store these connection credentials encrypted so enrolled learners can use the connection until I revoke it.</label>
          <label><input type="checkbox" aria-label="Authorize enrolled course passage sharing" checked={allowContent} disabled={disabled} onChange={event => setAllowContent(event.target.checked)} /> Authorize enrolled learners to share selected course passages with their chosen AI.</label>
          <label><input type="checkbox" aria-label="Authorize enrolled learner progress sharing" checked={allowProgress} disabled={disabled} onChange={event => setAllowProgress(event.target.checked)} /> Authorize enrolled learners to share their own course progress with their chosen AI.</label>
          <label><input type="checkbox" aria-label="Authorize released quiz review sharing" checked={allowReview} disabled={disabled} onChange={event => setAllowReview(event.target.checked)} /> Authorize enrolled learners to share released reviews of their own provider-reported completed or terminal quiz results with their chosen AI. Each course still requires a release map.</label>
          <label><input type="checkbox" aria-label="Authorize enrolled progress notifications" checked={allowNotifications} disabled={disabled} onChange={event => setAllowNotifications(event.target.checked)} /> Permit enrolled learners to explicitly enable authenticated progress update signals for their own registrations. This does not authorize AI sharing by itself.</label>
          <button className="btn sm" disabled={disabled || !storageAccepted} onClick={createConnector}>Create my managed learning connection</button>
          {connectors.map(connector => <div className="note stack" style={{ alignItems: 'stretch', gap: 8 }} key={connector.id}>
            <b>{connector.label}</b><span>{connector.status === 'active' ? 'Active' : 'Revoked'}</span>
            {connector.join_code && connector.status === 'active' ? <span>Connection code: <code>{connector.join_code}</code></span> : null}
            <span>Enrolled-learner sharing: course passages {connector.policy.allowAiContent ? 'allowed' : 'off'}; own progress {connector.policy.allowAiProgress ? 'allowed' : 'off'}; released quiz review {connector.policy.allowAiReview ? 'allowed' : 'off'}.</span>
            {connector.status === 'active' ? <>
              <div className="stack" style={{ gap: 6 }} data-testid="managed-review-policy">{connector.policy.allowAiReview ? <button className="btn sm" disabled={disabled} onClick={() => setReviewPolicy(connector, false)}>Turn off quiz review sharing</button> : <><label><input type="checkbox" aria-label={'Authorize quiz review sharing ' + connector.id} checked={reviewConfirmations[connector.id] === true} disabled={disabled} onChange={event => setReviewConfirmations(old => ({ ...old, [connector.id]: event.target.checked }))} /> I authorize learners to share released review of their own provider-reported completed or terminal results. Unreleased questions and answer banks stay excluded.</label><button className="btn sm" disabled={disabled || reviewConfirmations[connector.id] !== true} onClick={() => setReviewPolicy(connector, true)}>Enable released quiz review sharing</button></>}</div>
              <div className="stack" style={{ gap: 6 }} data-testid="managed-notification-policy"><span>Progress update signals: {connector.policy.allowProgressNotifications ? 'permitted' : 'off'}.</span>{connector.policy.allowProgressNotifications ? <button className="btn sm" disabled={disabled} onClick={() => setNotificationPolicy(connector, false)}>Turn off progress update permission</button> : <><label><input type="checkbox" aria-label={'Authorize progress notifications ' + connector.id} checked={notificationConfirmations[connector.id] === true} disabled={disabled} onChange={event => setNotificationConfirmations(old => ({ ...old, [connector.id]: event.target.checked }))} /> I authorize authenticated progress update signals for learners who explicitly enable them on their own enrolled registrations.</label><button className="btn sm" disabled={disabled || notificationConfirmations[connector.id] !== true} onClick={() => setNotificationPolicy(connector, true)}>Permit enrolled progress updates</button></>}</div>
              {mapEditorPanel(connector)}
              <div className="stack" style={{ gap: 6 }} data-testid="managed-targeted-launch-policy"><span>Lesson launch links: {connector.policy.allowTargetedLaunch ? 'enabled' : 'off'}.</span>{connector.policy.allowTargetedLaunch ? <button className="btn sm" disabled={disabled} onClick={() => setTargetedLaunch(connector, false)}>Turn off lesson launch links</button> : <><label><input type="checkbox" aria-label={'Authorize lesson launch links ' + connector.id} checked={targetedConfirmations[connector.id] === true} disabled={disabled} onChange={event => setTargetedConfirmations(old => ({ ...old, [connector.id]: event.target.checked }))} /> I authorize enrolled learners to open verified lessons directly. These links can override normal course order, and normal registration tracking applies.</label><button className="btn sm" disabled={disabled || targetedConfirmations[connector.id] !== true} onClick={() => setTargetedLaunch(connector, true)}>Enable lesson launch links</button></>}</div>
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
        </div></details> : null}
      </>}
      {(!session || session.enabled && !authenticated) ? <button className="btn sm" disabled={loading} onClick={refreshAccount}>Refresh learning account</button> : null}
      <details data-testid="learning-retention"><summary>What is stored and shared</summary><p>Original courses and learning records stay with the provider. This managed connection stores encrypted provider credentials, verified account links and any owner-supplied learning maps. It does not keep a reusable course-text cache. Owner-supplied question labels and relationships remain encrypted until the map is deleted or its connection is revoked.</p><p>Only the context you explicitly select is sent to your paired AI. That AI client’s retention applies. Clearing this view or ending a link cannot erase messages already shared with it or close a course you already opened in SCORM Cloud.</p><p>End your learning account link to stop future workbench access. The connection owner can revoke the managed connection or delete its saved course map and review release.</p></details>
      {error ? <p className="note warn small" role="alert">{error}</p> : null}{notice ? <p className="note small" role="status">{notice}</p> : null}
    </div>
  </details>;
  return { panel, active, activeRef, clear, send, stop, loading, blocked, selected };
}
