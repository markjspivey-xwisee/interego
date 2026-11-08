/*
 * Interego chat-agent helpers, shared by the vertical web apps that let people use their own chat
 * assistant. They build the text a person copies into that assistant (Claude, ChatGPT, or any chat app),
 * read a draft pasted back from it, and name the app a record came through. No model runs here
 * or on the server, and no key is ever asked for.
 *
 * SERVED BY CONCATENATION, never as a file of its own: each site answers /ui/app.js with
 * chatAgentJs() + '\n' + its own app.js (see index.ts beside this file). That one text has to be
 * valid twice over: as a classic script, because every jsdom harness evaluates /ui/app.js that
 * way, and as an ES module, because browsers load it with type="module", where a duplicate
 * top-level name is an early error. So this file
 *   - declares exactly ONE top-level name, InteregoChatAgent, built inside an IIFE, so no helper
 *     here can collide with a function an app declares;
 *   - has no import or export statement, no DOM access, no network access, and writes no markup:
 *     every function takes plain values and returns plain text or plain data.
 *
 * Action IRIs, payload shapes and wording about a particular product stay in each app's own
 * app.js; nothing in this file names a vertical.
 */
const InteregoChatAgent = (() => {
  'use strict';

  /**
   * How every signed payload's nonce is composed. A stated composition, not "random", because
   * language models reuse example values, and a repeated nonce from the same person is refused
   * as a replay partway through a session. The result is 16 to 64 characters of letters, digits
   * and '-', which every Interego vertical's nonce check accepts.
   *
   * The example names a step the prompt really has (its first signed step), so an assistant is
   * never shown a step name the site does not offer, and that step's own turn: a turn number when
   * its payload carries a turnIndex, 0 when it carries none, as the rule says, so an assistant
   * copying the example copies the right one. With no signed step to name, as in workspace details,
   * it is said in words (NONCE_RULE, also published as nonceRule).
   */
  const NONCE_HOW = 'nonce = the step name, the turn number (or 0), then 16 random letters or digits, joined by "-", never reused. ';
  const NONCE_EXAMPLE_TURN = 4;
  const NONCE_EXAMPLE_LETTERS = 'q8Xr2mVp7LkA9dTz';
  const NONCE_RULE = `${NONCE_HOW}For example, at turn ${NONCE_EXAMPLE_TURN} a step's nonce is that step's own name, then ${NONCE_EXAMPLE_TURN}, `
    + `then 16 letters or digits such as ${NONCE_EXAMPLE_LETTERS}, but make up new random letters for every call.`;

  /**
   * The nonce rule with an example made from one step's own name (stepNameOf) and turn (`hasTurn`:
   * NONCE_EXAMPLE_TURN when the step has a turn number, 0 when it has none), or in words when there
   * is no step.
   */
  function nonceRuleFor(stepName, hasTurn) {
    if (!stepName) return NONCE_RULE;
    return `${NONCE_HOW}For example ${stepName}-${hasTurn ? NONCE_EXAMPLE_TURN : 0}-${NONCE_EXAMPLE_LETTERS}, but make up new random letters for every call.`;
  }

  /** A step name longer than this is cut, so step + turn + 16 letters stays inside 64 characters. */
  const STEP_NAME_MAX = 32;

  /**
   * How to do a signed step when the person's chat app shows an act tool with no sign_payload option
   * (an app can keep a stale copy of the connector's tools). sign_payload: true is the connector
   * signing the payload with its sign_request tool and acting with the result, so the same two calls,
   * made by the assistant, send the same request. Payload is sign_request's only argument because it
   * signs a caller's other top-level arguments too; deploy/mcp-relay/tests/
   * sign-request-alone-signs-what-act-signs.test.ts shows the two ways sign the same fields.
   */
  const SIGN_FALLBACK = 'If your act tool has no sign_payload option, do a signed step in two calls: call the connector\'s sign_request tool '
    + 'with payload as its only argument, set to the step\'s payload, then call act with the same descriptor_url and action_iri and with payload set to exactly '
    + 'the _signature and _signed_payload it returned, unchanged. A plain step is the same act call without sign_payload.';

  /** A rule that speaks of signing, so a prompt that carries it needs the two-call way too. */
  const SIGNING_WORDS = /\bsign_payload\b|\bsigned\b/i;

  /** What every prompt says about refusals after the app's own rules, which come first and win. */
  const REFUSAL_RULE = 'Unless a rule above says otherwise: if a call is refused because a field or its format is wrong, '
    + 'fix it once from the refusal message and try again. For any other refusal, tell me what it said in plain words and stop.';

  /** The longest pasted answer extractJsonObject reads, and how many '{' it tries before giving up. */
  const JSON_TEXT_MAX = 2000000;
  const JSON_STARTS_MAX = 64;

  function textOf(v) {
    return v === undefined || v === null ? '' : String(v).trim();
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /** The step name an action IRI ends with: its last ':', '/' or '#' segment, as letters, digits and '-'. */
  function stepNameOf(actionIri) {
    const s = String(actionIri).replace(/[/:#]+$/, '');
    const last = s.slice(Math.max(s.lastIndexOf(':'), s.lastIndexOf('/'), s.lastIndexOf('#')) + 1);
    const name = last.replace(/[^A-Za-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, STEP_NAME_MAX).replace(/-+$/, '');
    return name || 'step';
  }

  function stepText(step, n) {
    if (!isPlainObject(step)) throw new TypeError(`actPrompt: step ${n} must be an object`);
    const actionIri = textOf(step.actionIri);
    if (!actionIri) throw new TypeError(`actPrompt: step ${n} needs an actionIri`);
    if (step.payload !== undefined && !isPlainObject(step.payload)) {
      throw new TypeError(`actPrompt: step ${n}'s payload must be a JSON object`);
    }
    const signed = step.signed === true;
    // A copy: the caller's template is never changed. Where the template names an action, it is
    // this step's action, written exactly as action_iri is (a web-address form of the same action
    // is refused). A signed step's nonce is always the composed one.
    const payload = Object.assign({}, step.payload || {});
    const namesAction = Object.prototype.hasOwnProperty.call(payload, 'action');
    if (namesAction) payload.action = actionIri;
    if (signed) payload.nonce = `${stepNameOf(actionIri)}-<turn number, or 0>-<16 new random letters or digits>`;
    const isUrn = /^urn:/i.test(actionIri);
    const lines = [
      `${n}. ${textOf(step.say) || 'Call this action.'}`,
      `   action_iri: "${actionIri}"`,
      signed
        ? '   sign_payload: true (signed: the connector signs this payload as me)'
        : '   sign_payload: false (plain: nothing is signed, and the arguments go at the top level of payload)',
      `   payload: ${JSON.stringify(payload)}`,
    ];
    if (namesAction) {
      lines.push(isUrn
        ? `   payload.action is exactly this urn: "${actionIri}", not a web address.`
        : `   payload.action is exactly "${actionIri}".`);
    }
    return lines.join('\n');
  }

  /**
   * A paste-ready prompt that tells a chat assistant how to do each step with the Interego
   * connector's act tool: the call shape (descriptor_url, action_iri, sign_payload, payload), the
   * nonce rule (its example made from the first signed step's own name, at turn 0 unless that step's
   * payload has a turnIndex, or said in words when no step is signed), and per step whether it is
   * signed or plain and which exact action it names. Whenever the prompt can lead to a signed step (a
   * step is signed, a rule speaks of signing, or there are no steps, so the assistant picks the
   * actions itself), it also says how to sign one with sign_request where the act tool has no
   * sign_payload option; a prompt whose every step is plain leaves that out.
   *
   * spec: { intro?, affordancesUrl, podUrl?, steps?: [{ say, actionIri, signed, payload }],
   *         rules?: string[], outro? }. Throws TypeError on a malformed spec: that is a bug in the
   * calling app, never something a person typed.
   */
  function actPrompt(spec) {
    const o = isPlainObject(spec) ? spec : {};
    const affordancesUrl = textOf(o.affordancesUrl);
    if (!affordancesUrl) throw new TypeError('actPrompt needs affordancesUrl, the address of the site\'s actions');
    const steps = o.steps === undefined ? [] : o.steps;
    if (!Array.isArray(steps)) throw new TypeError('actPrompt: steps must be an array');
    const rules = o.rules === undefined ? [] : o.rules;
    if (!Array.isArray(rules)) throw new TypeError('actPrompt: rules must be an array');
    const podUrl = textOf(o.podUrl);
    // The nonce example names the first signed step this prompt really has (a malformed step is
    // refused below, when its text is built).
    const firstSigned = steps.find((s) => isPlainObject(s) && s.signed === true && textOf(s.actionIri));

    const parts = [];
    const intro = textOf(o.intro);
    if (intro) parts.push(intro);
    const how = [
      'How to do each step: call the act tool of the Interego connector with',
      `- descriptor_url: "${affordancesUrl}"`,
      '- action_iri: the action the step names, exactly as written',
      '- sign_payload: true or false, exactly as the step says',
      '- payload: the JSON object the step shows, with every <...> replaced by the real value',
    ];
    if (podUrl) how.push(`My storage address (pod_url): "${podUrl}"`);
    const firstHasTurn = Boolean(firstSigned && isPlainObject(firstSigned.payload) && Object.prototype.hasOwnProperty.call(firstSigned.payload, 'turnIndex'));
    how.push(`Every signed payload carries a nonce: ${nonceRuleFor(firstSigned ? stepNameOf(textOf(firstSigned.actionIri)) : '', firstHasTurn)}`);
    const appRules = rules.map(textOf).filter((r) => r.length > 0);
    if (steps.length === 0 || firstSigned || appRules.some((r) => SIGNING_WORDS.test(r))) how.push(SIGN_FALLBACK);
    parts.push(how.join('\n'));
    if (steps.length > 0) parts.push(['Steps:', ...steps.map((s, i) => stepText(s, i + 1))].join('\n'));
    const ruleLines = appRules.concat([REFUSAL_RULE]);
    parts.push(['Rules:', ...ruleLines.map((r) => `- ${r}`)].join('\n'));
    const outro = textOf(o.outro);
    if (outro) parts.push(outro);
    return parts.join('\n\n');
  }

  function contentText(content) {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content.map((b) => (isPlainObject(b) && typeof b.text === 'string' ? b.text : '')).join('').trim();
    }
    return textOf(content);
  }

  function conversationLine(m, i, me, them) {
    if (!isPlainObject(m)) throw new TypeError(`requestAsText: message ${i + 1} is not an object`);
    const said = contentText(m.content);
    // A synthetic opener such as "(The conversation starts. Say your first line.)" is a stage
    // direction, not a line the person spoke, so it is never labelled as theirs.
    if (i === 0 && m.role === 'user' && /^\([^()]*\)$/.test(said)) return `(Stage direction: ${said.slice(1, -1).trim()})`;
    if (m.role === 'user') return `${me}: ${said}`;
    if (m.role === 'assistant') return `${them}: ${said}`;
    return `(${textOf(m.role) || 'Note'}: ${said})`;
  }

  /**
   * A packet's model request as one paste-ready prompt: {system, messages[]} (a conversation, the
   * person's lines as meLabel and the assistant's as themLabel) or {system, user} (one request).
   * replyRule, when given, ends the text. Throws TypeError when the request has neither.
   */
  function requestAsText(request, options) {
    if (!isPlainObject(request)) throw new TypeError('requestAsText needs a request: {system, messages} or {system, user}');
    const o = isPlainObject(options) ? options : {};
    const me = textOf(o.meLabel) || 'Me';
    const them = textOf(o.themLabel) || 'The other person';
    const replyRule = textOf(o.replyRule);

    const parts = [];
    const system = textOf(request.system);
    if (system) parts.push(`Instructions for you:\n${system}`);
    let messages = Array.isArray(request.messages) && request.messages.length > 0 ? request.messages : null;
    let user = typeof request.user === 'string' && request.user.trim() ? request.user.trim() : '';
    // One user message and nothing else is a request, not a conversation.
    if (messages && messages.length === 1 && !user && isPlainObject(messages[0]) && messages[0].role === 'user') {
      user = contentText(messages[0].content);
      messages = null;
    }
    if (!messages && !user) throw new TypeError('requestAsText: the request has neither messages nor user text');
    if (messages) parts.push(`The conversation so far:\n${messages.map((m, i) => conversationLine(m, i, me, them)).join('\n')}`);
    if (user) parts.push(`The request:\n${user}`);
    if (replyRule) parts.push(replyRule);
    return parts.join('\n\n');
  }

  /** The index of the '}' that closes the '{' at start, skipping braces inside JSON strings; -1 if none. */
  function closingBrace(s, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < s.length; i += 1) {
      const c = s[i];
      if (inString) {
        if (c === '\\') i += 1;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function firstObjectIn(s) {
    let from = 0;
    let why = 'There is no JSON object in the text: nothing runs from { to }.';
    for (let tries = 0; tries < JSON_STARTS_MAX; tries += 1) {
      const start = s.indexOf('{', from);
      if (start < 0) return { ok: false, why };
      const end = closingBrace(s, start);
      if (end < 0) {
        // An object that starts like JSON and never closes was cut off: never answer with a piece
        // of it. A stray '{' in prose is skipped instead.
        if (/^\{\s*["}]/.test(s.slice(start, start + 64))) {
          return { ok: false, why: 'The JSON object never closes: the answer may have been cut off.' };
        }
        from = start + 1;
        continue;
      }
      try {
        const value = JSON.parse(s.slice(start, end + 1));
        if (isPlainObject(value)) return { ok: true, value };
      } catch (e) {
        why = `The text from { to } is not valid JSON: ${e && e.message ? e.message : 'it could not be read'}.`;
      }
      // A balanced object that does not parse is skipped whole: an object nested inside a broken
      // one is never taken for the answer.
      from = end + 1;
    }
    return { ok: false, why: `No valid JSON object in the first ${JSON_STARTS_MAX} places that start with {.` };
  }

  /**
   * The first JSON object in a pasted answer: code fences (``` or ~~~) are tried first, then the
   * whole text, with string-aware brace matching. Returns { ok: true, value } or { ok: false, why }.
   */
  function extractJsonObject(input) {
    if (typeof input !== 'string' || !input.trim()) return { ok: false, why: 'There is no text to read.' };
    if (input.length > JSON_TEXT_MAX) return { ok: false, why: 'The text is too long to read.' };
    const sources = [];
    const fence = /(```|~~~)[^\n]*\n([\s\S]*?)\1/g;
    for (let m = fence.exec(input); m !== null; m = fence.exec(input)) sources.push(m[2]);
    sources.push(input);
    let last = { ok: false, why: 'There is no text to read.' };
    for (const source of sources) {
      last = firstObjectIn(source);
      if (last.ok) return last;
    }
    return last;
  }

  /**
   * The app a record came through, in plain words, from its agent id (did:web:<host>:agents:<slug>,
   * or the bare slug). The slug is the name the app gave itself when it connected, as the relay
   * turned it into a slug. ownPrefix / ownName name the site's own web app.
   */
  function agentAppName(agentId, ownPrefix, ownName) {
    const s = textOf(agentId);
    const i = s.indexOf(':agents:');
    const slug = (i >= 0 ? s.slice(i + ':agents:'.length) : s).toLowerCase();
    if (!slug) return 'another app';
    const own = textOf(ownPrefix).toLowerCase();
    if (own && slug.startsWith(own)) return textOf(ownName) || 'this app';
    if (/^claude(-|$)/.test(slug)) return 'Claude';
    if (/^chatgpt(-|$)/.test(slug)) return 'ChatGPT';
    if (/^(openai-codex|codex)(-|$)/.test(slug)) return 'Codex';
    if (/^openai(-|$)/.test(slug)) return 'ChatGPT or another OpenAI app';
    if (/^cursor(-|$)/.test(slug)) return 'Cursor';
    return 'another app';
  }

  return Object.freeze({ actPrompt, requestAsText, extractJsonObject, agentAppName, nonceRule: NONCE_RULE });
})();
