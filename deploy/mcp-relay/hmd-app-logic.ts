/**
 * hmd-app-logic — the PURE, security-critical browser logic of the generic
 * HyperMarkdown MCP-App renderer, kept as a JS-source STRING so it is the single
 * source of truth: `hmd-app.ts` embeds it verbatim in the widget HTML, and
 * `_hmd-app-test.ts` evals it to unit-test the functions (escaping, href
 * sanitization, safe Markdown, action classification, field validation, payload
 * assembly). The widget renders UNTRUSTED HMD content (a note author — possibly
 * not the reader — controls titles, labels, field names, links), so every one of
 * these must be XSS-safe and fail closed.
 *
 * No DOM, no imports — plain functions on strings/objects, so they run identically
 * in the browser and under `eval` in a test.
 */
export const HMD_APP_LOGIC_JS = String.raw`
// ── escaping ──────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

// ── href sanitization — allow only safe schemes; everything else is inert ──
function sanitizeHref(h) {
  // Strip ALL C0 control chars + DEL first (tab/newline/CR included). Browsers
  // delete these from a URL before resolving its scheme, so 'java\tscript:x'
  // would otherwise reconstitute to 'javascript:x' after passing a naive scheme
  // check. The RETURNED value is the stripped string, so the sink sees what we
  // checked. A relative/fragment href is allowed; any scheme not on the allowlist
  // (javascript:, data:, vbscript:, file:, …) → '#'.
  var s = String(h == null ? '' : h).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!s) return '#';
  // Undo entity-escaping that could hide a scheme separator, then test.
  var probe = s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  var m = /^([a-z][a-z0-9+.\-]*):/i.exec(probe);
  if (!m) return s; // no scheme → relative/fragment, safe
  var scheme = m[1].toLowerCase();
  var ALLOWED = { https: 1, http: 1, mailto: 1, urn: 1, did: 1, tel: 1 };
  return ALLOWED[scheme] ? s : '#';
}

// ── minimal, SAFE Markdown → HTML (escape first, then add only our own tags) ──
function safeMarkdown(md) {
  var text = escapeHtml(md == null ? '' : md);
  var lines = text.split('\n');
  var out = [], para = [], list = null;
  function flushPara() { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } }
  function flushList() { if (list) { out.push('<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.tag + '>'); list = null; } }
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var h = /^(#{1,6})\s+(.*)$/.exec(ln);
    var ul = /^\s*[-*+]\s+(.*)$/.exec(ln);
    var ol = /^\s*\d+\.\s+(.*)$/.exec(ln);
    var bq = /^&gt;\s?(.*)$/.exec(ln); // '>' was escaped
    if (h) { flushPara(); flushList(); var lvl = h[1].length; out.push('<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>'); }
    else if (ul) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(ul[1]); }
    else if (ol) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(ol[1]); }
    else if (bq) { flushPara(); flushList(); out.push('<blockquote>' + inline(bq[1]) + '</blockquote>'); }
    else if (ln.trim() === '') { flushPara(); flushList(); }
    else { flushList(); para.push(ln); }
  }
  flushPara(); flushList();
  return out.join('\n');
}
function inline(s) {
  // code spans first so their content isn't further transformed (\x60 = backtick,
  // written as a hex escape so a literal backtick can't terminate the host template)
  s = s.replace(/\x60([^\x60]+)\x60/g, function (_, c) { return '<code>' + c + '</code>'; });
  // links [label](href) — label already HTML-escaped; href already escaped by the
  // whole-string escapeHtml above, so it is placed in the attribute WITHOUT a
  // second escape (double-escaping mangled ampersands); sanitizeHref keeps it safe.
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, label, href) {
    return '<a href="' + sanitizeHref(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return s;
}

// ── action classification — the CONFIRMATION-SKIP signal ──────────────────────
// SECURITY: the read/mutate decision must NOT come from the note author. The
// action IRI and the affordance's declared method both live in the (author-signed)
// descriptor, and a mutation can be named 'askQuestion' / 'verifyClaim'. The ONLY
// trustworthy signal the browser has is the HTTP method's SAFE-method contract:
// GET must not have side effects (RFC 9110). So ONLY a GET affordance may fire
// without confirmation; every non-GET action is a potential mutation and MUST pass
// the in-app confirm step before an invoke_affordance tools/call. (A read op that
// wants to skip confirmation should be modelled as GET.)
function localName(iri) {
  var s = String(iri == null ? '' : iri);
  var hash = s.lastIndexOf('#'); if (hash >= 0) return s.slice(hash + 1);
  var slash = s.lastIndexOf('/'); if (slash >= 0) return s.slice(slash + 1);
  var colon = s.lastIndexOf(':'); if (colon >= 0) return s.slice(colon + 1);
  return s;
}
function classifyAction(actionIri, method) {
  return String(method || 'POST').toUpperCase() === 'GET' ? 'read' : 'mutate';
}

// ── SHACL field → input model + validation ─────────────────────────────────
var XSD = 'http://www.w3.org/2001/XMLSchema#';
function inputModel(field) {
  var dt = String(field.datatype || '');
  if (dt === XSD + 'boolean') return { kind: 'boolean' };
  if (dt === XSD + 'integer' || dt === XSD + 'int' || dt === XSD + 'long' || dt === XSD + 'decimal' || dt === XSD + 'double' || dt === XSD + 'float' || dt === XSD + 'nonNegativeInteger' || dt === XSD + 'positiveInteger') return { kind: 'number' };
  if (dt === XSD + 'date') return { kind: 'date' };
  if (dt === XSD + 'dateTime') return { kind: 'datetime-local' };
  var max = Number(field.maxLength);
  if (Number.isInteger(max) && max > 0 && max <= 120) return { kind: 'text' };
  return { kind: field.maxLength && Number(field.maxLength) <= 120 ? 'text' : 'textarea' };
}
function isRequired(field) { return Number.isInteger(Number(field.minCount)) && Number(field.minCount) >= 1; }
// Returns an error string, or '' when valid. Never throws (a hostile pattern is
// length-capped and tried in a try/catch so it cannot break validation).
function validateValue(field, raw) {
  var v = raw == null ? '' : String(raw);
  var m = inputModel(field);
  if (isRequired(field) && v.trim() === '') return (field.name || localName(field.path)) + ' is required';
  if (v === '') return '';
  if (m.kind === 'number') { if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return (field.name || localName(field.path)) + ' must be a number'; }
  if (m.kind === 'boolean') { if (v !== 'true' && v !== 'false') return (field.name || localName(field.path)) + ' must be true or false'; }
  var minL = Number(field.minLength); if (Number.isInteger(minL) && v.length < minL) return (field.name || localName(field.path)) + ' must be at least ' + minL + ' characters';
  var maxL = Number(field.maxLength); if (Number.isInteger(maxL) && v.length > maxL) return (field.name || localName(field.path)) + ' must be at most ' + maxL + ' characters';
  var pat = field.pattern;
  if (typeof pat === 'string' && pat.length > 0 && pat.length <= 300) {
    try { if (!(new RegExp(pat)).test(v)) return (field.name || localName(field.path)) + ' does not match the required format'; }
    catch (e) { /* invalid regex in the shape — skip, don't block the user */ }
  }
  return '';
}
// Assemble the invoke_affordance payload from field values, keyed by each field's
// property LOCAL NAME (the conventional form-field key). Empty optionals dropped.
function collectPayload(fields, values) {
  var payload = {};
  for (var i = 0; i < (fields || []).length; i++) {
    var f = fields[i]; var key = localName(f.path); var v = values[key];
    if (v == null || v === '') continue;
    var m = inputModel(f);
    if (m.kind === 'number') payload[key] = Number(v);
    else if (m.kind === 'boolean') payload[key] = (v === true || v === 'true');
    else payload[key] = String(v);
  }
  return payload;
}
`;
