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
  var out = [], para = [], list = null, fence = null;
  function flushPara() { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } }
  function flushList() { if (list) { out.push('<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.tag + '>'); list = null; } }
  function flushFence() { if (fence) { out.push('<pre class="src">' + fence.lines.join('\n') + '</pre>'); fence = null; } }
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    // Fenced code block (triple-backtick or ~~~ fence): its content is INERT <pre> and is
    // never probed as a heading / list / table — a code-fenced pipe table must NOT render
    // as a live <table> (Finding 3; mirrors the lift's fence skip). Already HTML-escaped.
    var fo = /^\s*(\x60{3,}|~{3,})/.exec(ln);
    if (fence) {
      var fc = /^\s*(\x60{3,}|~{3,})\s*$/.exec(ln);
      if (fc && fc[1].charAt(0) === fence.ch) flushFence();
      else fence.lines.push(ln);
      continue;
    }
    if (fo) { flushPara(); flushList(); fence = { ch: fo[1].charAt(0), lines: [] }; continue; }
    var h = /^(#{1,6})\s+(.*)$/.exec(ln);
    var ul = /^\s*[-*+]\s+(.*)$/.exec(ln);
    var ol = /^\s*\d+\.\s+(.*)$/.exec(ln);
    var bq = /^&gt;\s?(.*)$/.exec(ln); // '>' was escaped
    // A GFM pipe table (header row + delimiter row + body) is an HMD-native block:
    // detected here and rendered as a real <table>. Only PROBED when the line is not
    // already a heading / list / quote, so those keep precedence and the probe is
    // skipped for the common case. Existing notes need no re-authoring — the pipe
    // syntax in the body is enough. (The Markdown / HMD-source panes use mkpre and
    // still show the raw pipe text — georgio's constraint.)
    var tbl = (!h && !ul && !ol && !bq) ? detectTable(lines, i) : null;
    if (h) { flushPara(); flushList(); var lvl = h[1].length; out.push('<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>'); }
    else if (ul) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(ul[1]); }
    else if (ol) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(ol[1]); }
    else if (bq) { flushPara(); flushList(); out.push('<blockquote>' + inline(bq[1]) + '</blockquote>'); }
    else if (tbl) { flushPara(); flushList(); out.push(renderTable(tbl.header, tbl.aligns, tbl.rows)); i = tbl.next - 1; }
    else if (ln.trim() === '') { flushPara(); flushList(); }
    else { flushList(); para.push(ln); }
  }
  flushPara(); flushList(); flushFence();
  return out.join('\n');
}
function inline(s) {
  // code spans first so their content isn't further transformed (\x60 = backtick,
  // written as a hex escape so a literal backtick can't terminate the host template)
  s = s.replace(/\x60([^\x60]+)\x60/g, function (_, c) { return '<code>' + c + '</code>'; });
  // links [label](href) — label already HTML-escaped; href already escaped by the
  // whole-string escapeHtml above, so it is placed in the attribute WITHOUT a
  // second escape (double-escaping mangled ampersands); sanitizeHref keeps it safe.
  // Consume the OPTIONAL typed-link attribute suffix {rel="..." type="..."} (already
  // HTML-escaped here, so a quote is &quot;) so it does NOT render as visible braces
  // text in the Enhanced view; surface rel/type as real <a> attributes instead. The
  // brace syntax survives verbatim only in the raw Markdown / HMD-source tabs. (georgio.)
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)(\{[^}]*\})?/g, function (_, label, href, attrs) {
    var relM = attrs && /rel=(?:&quot;|")([^&"}]+)/.exec(attrs);
    var typeM = attrs && /type=(?:&quot;|")([^&"}]+)/.exec(attrs);
    var relAttr = 'noopener noreferrer' + (relM ? ' ' + relM[1] : '');
    var typeAttr = typeM ? ' type="' + typeM[1] + '"' : '';
    return '<a href="' + sanitizeHref(href) + '" target="_blank" rel="' + relAttr + '"' + typeAttr + '>' + label + '</a>';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return s;
}

// ── GFM pipe tables (HMD-native) — rendered as a real <table> in the Enhanced view.
// Split a row into cells on UNescaped pipes that are NOT inside a code span: '\|' is a
// literal pipe (no split) and a '|' between backticks does not split. One optional
// leading/trailing pipe is dropped. (Char codes: 124='|', 92='\', 96=backtick — used
// so a literal backtick can't terminate the host String.raw template.)
function splitRowCells(row) {
  var s = row.replace(/^\s+|\s+$/g, '');
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.charCodeAt(s.length - 1) === 124 && s.charCodeAt(s.length - 2) !== 92) s = s.slice(0, -1);
  var cells = [], buf = '', code = false;
  for (var i = 0; i < s.length; i++) {
    var cc = s.charCodeAt(i);
    if (cc === 92 && s.charCodeAt(i + 1) === 124) { buf += '|'; i++; continue; } // '\|' → literal pipe, no split
    if (cc === 96) { code = !code; buf += s.charAt(i); continue; }               // backtick toggles a code span
    if (cc === 124 && !code) { cells.push(buf); buf = ''; continue; }            // '|' splits cells (outside code)
    buf += s.charAt(i);
  }
  cells.push(buf);
  return cells;
}
// '' | 'l' | 'r' | 'c' per column from the delimiter row, or null when the row is not a
// valid delimiter (every cell must be ':?-+:?'; a leading/trailing ':' marks alignment).
function delimiterAligns(row) {
  var cells = splitRowCells(row);
  if (!cells.length) return null;
  var aligns = [];
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i].replace(/^\s+|\s+$/g, '');
    if (!/^:?-+:?$/.test(c)) return null;
    var l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
    aligns.push(l && r ? 'c' : r ? 'r' : l ? 'l' : '');
  }
  return aligns;
}
// A table = a header row (must contain a pipe) + a delimiter row, then body rows until
// a blank / pipe-less line. Header & delimiter column counts must match (GFM), else the
// pair is treated as ordinary text (no re-authoring or false positives on '---').
function detectTable(lines, i) {
  if (lines[i].indexOf('|') < 0 || i + 1 >= lines.length) return null;
  var aligns = delimiterAligns(lines[i + 1]);
  if (!aligns) return null;
  var header = splitRowCells(lines[i]);
  if (header.length !== aligns.length) return null;
  var rows = [], j = i + 2;
  for (; j < lines.length; j++) {
    if (lines[j].trim() === '' || lines[j].indexOf('|') < 0) break;
    rows.push(splitRowCells(lines[j]));
  }
  return { header: header, aligns: aligns, rows: rows, next: j };
}
// Cells are already HTML-escaped (safeMarkdown escaped the whole doc up front), then run
// through inline() so links/bold/code work while a hostile cell (<img onerror=…>, a
// javascript: link, an injected '|') stays inert. The alignment class is a fixed
// constant (hmd-al-l/c/r), never author input, so it is CSP-safe with no inline style.
function renderTable(header, aligns, rows) {
  function cls(a) { return a ? ' class="hmd-al-' + a + '"' : ''; }
  function cell(tag, text, a) { return '<' + tag + cls(a) + '>' + inline(String(text == null ? '' : text).replace(/^\s+|\s+$/g, '')) + '</' + tag + '>'; }
  var n = aligns.length, html = '<table><thead><tr>', c;
  for (c = 0; c < n; c++) html += cell('th', header[c], aligns[c]);
  html += '</tr></thead><tbody>';
  for (var r = 0; r < rows.length; r++) {
    html += '<tr>';
    for (c = 0; c < n; c++) html += cell('td', rows[r][c], aligns[c]);
    html += '</tr>';
  }
  return html + '</tbody></table>';
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
// ── hydration guards — decide WHEN to re-render (render rebuilds the DOM) ──────
// render() destroys in-progress form input / the confirm box / action status, so a
// re-render must happen ONLY when the mounted DOCUMENT actually changes — never on
// an unrelated openai:set_globals (theme/display/focus) event, a cloned-but-equal
// payload (hosts may clone the object), or a nested invoke_affordance tool result.
function isHmdDoc(d) {
  return !!d && typeof d === 'object'
    && typeof d.descriptorUrl === 'string'
    && ('hmd' in d || 'body' in d || 'controls' in d);
}
function shouldRehydrate(current, next) {
  if (!isHmdDoc(next)) return false; // non-HMD (e.g. an invoke_affordance result) never replaces the doc
  if (current && current.descriptorUrl === next.descriptorUrl && current.hmd === next.hmd) return false; // unchanged
  return true;
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
