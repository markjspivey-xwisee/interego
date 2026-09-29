/**
 * Shared answer contract for the native grader and exported assessment forms.
 *
 * The types are the xAPI interaction types (SCORM 2004 names them the same), so one authored
 * question records the same way in a SCORM package, a cmi5 activity or a plain xAPI statement.
 * `text` is a fill-in and `integer`/`number` a numeric, kept under their old names so a stored
 * course reads unchanged. A learner names an option, item or target by its letter (A, B, …) or
 * by its text.
 */
export interface ScormAnswerInput {
  type: 'text' | 'integer' | 'number' | 'choice' | 'true-false' | 'sequencing' | 'matching' | 'likert' | 'long-fill-in';
  min?: number;
  max?: number;
  /** choice: the options in the order shown; likert: the scale, lowest first. */
  options?: string[];
  /** choice: more than one option is right, and a reply names all of them. */
  multiple?: boolean;
  /** sequencing: the items in the (scrambled) order shown; matching: the prompts, in order. */
  items?: string[];
  /** matching: what each prompt can be matched with, in the order shown. */
  targets?: string[];
  /** Mixed into an exact question's verifier, so a right answer never hashes to a value shared by every course. */
  salt?: string;
  /** text: letter case counts, as the source a question was read from declares; otherwise a typed answer is read without it. */
  caseSensitive?: boolean;
}
export interface ScormAssessmentQuestion {
  question: string;
  /** SHA-256 of the canonical right answer. Absent for a question nothing grades (likert, long-fill-in). */
  answerHash?: string;
  /** fill-in: verifiers of the other answers the author accepts. */
  acceptHashes?: string[];
  input?: ScormAnswerInput;
  /** Why the answer is right, shown once the question has been answered. */
  explanation?: string;
}

/**
 * The option a learner named: its letter (A, B, …) or its text, or -1 when it names none.
 * Embedded in generated pages by its source, like everything the answer contract exports.
 */
export function scormOptionIndex(token: string, labels: readonly string[]): number {
  const text = String(token ?? '').trim();
  const letter = /^\(?([a-z])\)?[.:)]?$/i.exec(text);
  if (letter) {
    const index = String(letter[1]).toLowerCase().charCodeAt(0) - 97;
    return index < labels.length ? index : -1;
  }
  const said = normalizeScormAnswer(text);
  return said ? labels.findIndex(label => normalizeScormAnswer(label) === said) : -1;
}

/**
 * The options, items or targets a reply names, as indices, or what to fix. One part unless `many`.
 * Letters may be separated by commas, spaces, semicolons or "and"; texts by semicolons or new lines.
 */
export function scormAnswerParts(value: string, labels: readonly string[], many: boolean): number[] | string {
  const text = String(value ?? '').trim();
  const lettered = /^\(?[a-z]\)?[.:)]?(?:\s*(?:,|;|\band\b|\s)\s*\(?[a-z]\)?[.:)]?)*$/i.test(text);
  const tokens = !many ? [text]
    : lettered ? text.split(/\s*(?:,|;|\band\b)\s*|\s+/i).filter(Boolean)
    : text.split(/\s*[;\n]\s*/).filter(Boolean);
  const parts = tokens.map(token => scormOptionIndex(token, labels));
  const last = String.fromCharCode(64 + labels.length);
  if (!tokens.length || parts.some(part => part < 0)) {
    return many ? `Name each one by its letter, A to ${last}, separated by commas.` : `Choose one, by its letter (A to ${last}) or its text.`;
  }
  return parts;
}

/** The xAPI (and SCORM) interaction type a question records as. */
export function scormInteractionType(input?: ScormAnswerInput): string {
  if (!input || input.type === 'text') return 'fill-in';
  if (input.type === 'integer' || input.type === 'number') return 'numeric';
  return input.type;
}

/**
 * A valid reply in the response format xAPI and SCORM both define: choice, likert and sequencing
 * as ids joined by `[,]`, matching as `prompt[.]target` pairs joined by `[,]`. Ids are the letters
 * a to z of the options, items and targets, and 1 to n of the prompts.
 */
export function scormInteractionResponse(value: string, input?: ScormAnswerInput): string {
  const text = String(value ?? '').trim();
  if (!input || input.type === 'text' || input.type === 'long-fill-in') return text;
  if (input.type === 'integer' || input.type === 'number') return String(Number(text));
  if (input.type === 'true-false') return /^(true|t|yes|y)$/i.test(text) ? 'true' : 'false';
  const labels = input.type === 'sequencing' ? (input.items ?? []) : input.type === 'matching' ? (input.targets ?? []) : (input.options ?? []);
  const parts = scormAnswerParts(text, labels, input.type !== 'likert' && (input.type !== 'choice' || !!input.multiple));
  if (typeof parts === 'string') return text;
  if (input.type === 'matching') return parts.map((part, i) => `${i + 1}[.]${String.fromCharCode(97 + part)}`).join('[,]');
  const ordered = input.type === 'choice' ? [...new Set(parts)].sort((a, b) => a - b) : parts;
  return ordered.map(part => String.fromCharCode(97 + part)).join('[,]');
}

/** A numeric authored answer has a numeric contract unless the author overrides it. */
export function inferScormAnswerInput(answer: string): ScormAnswerInput | undefined {
  if (/^[+-]?\d+$/.test(answer.trim())) return { type: 'integer' };
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(answer.trim())) return { type: 'number' };
  return undefined;
}

/** Preserve legacy text hashes, including words with digits. Numeric-only
 * expressions retain punctuation; typed numeric answers use their numeric contract.
 * Letter case is kept only when a question says it counts (`caseSensitive`). */
export function normalizeScormAnswer(value: string, caseSensitive = false): string {
  const spaced = String(value ?? '').replace(/\s+/g, ' ').trim();
  const text = caseSensitive ? spaced : spaced.toLowerCase();
  return /[a-z]/i.test(text) ? text.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim() : text;
}

export function validateScormAnswer(value: unknown, input?: ScormAnswerInput): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'Enter an answer before submitting.';
  if (input && input.type === 'long-fill-in') return value.length > 4000 ? 'Use 4000 characters or fewer.' : null;
  if (value.length > 250) return 'Use 250 characters or fewer.';
  if (!input || input.type === 'text') return null;
  if (input.type === 'true-false') return /^(true|false|t|f|yes|no|y|n)$/i.test(value.trim()) ? null : 'Answer true or false.';
  if (input.type === 'choice' || input.type === 'likert' || input.type === 'sequencing' || input.type === 'matching') {
    const labels = input.type === 'sequencing' ? (input.items ?? []) : input.type === 'matching' ? (input.targets ?? []) : (input.options ?? []);
    const parts = scormAnswerParts(value, labels, input.type === 'sequencing' || input.type === 'matching' || (input.type === 'choice' && !!input.multiple));
    if (typeof parts === 'string') return parts;
    const last = String.fromCharCode(64 + labels.length);
    if (input.type === 'sequencing' && (parts.length !== labels.length || new Set(parts).size !== parts.length)) {
      return `Put all ${labels.length} items in order, each once, as letters such as ${labels.map((_, i) => String.fromCharCode(65 + i)).reverse().join(', ')}.`;
    }
    if (input.type === 'matching' && parts.length !== (input.items ?? []).length) {
      return `Match each of the ${(input.items ?? []).length} prompts, in order, to a letter from A to ${last}.`;
    }
    if (input.type === 'choice' && input.multiple && new Set(parts).size !== parts.length) return 'Name each option once.';
    return null;
  }
  const text = value.trim();
  if (input.type === 'integer' && !/^[+-]?\d+$/.test(text)) return 'Enter a whole number, such as 0, 1, or -1.';
  if (input.type === 'number' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return 'Enter a number.';
  const number = Number(text);
  if (!Number.isFinite(number) || (input.type === 'integer' && !Number.isSafeInteger(number))) return 'Enter a finite number within the supported range.';
  if (input.min !== undefined && number < input.min) return 'Enter a number greater than or equal to ' + input.min + '.';
  if (input.max !== undefined && number > input.max) return 'Enter a number less than or equal to ' + input.max + '.';
  return null;
}

/**
 * The strings a reply's verifier is checked against, already canonical: hash them as they are.
 * A fill-in gives its normalized text and each of its words of four letters or more; a numeric its
 * number. An exact question gives one string naming its type, its salt and the indices it chose, so
 * option order and wording in the reply do not matter. A likert or long-fill-in gives none: nothing
 * grades it.
 */
export function scormAnswerCandidates(value: string, input?: ScormAnswerInput): string[] {
  if (validateScormAnswer(value, input)) return [];
  if (input && (input.type === 'likert' || input.type === 'long-fill-in')) return [];
  if (input && input.type === 'true-false') return [`true-false|${input.salt ?? ''}|${/^(true|t|yes|y)$/i.test(value.trim()) ? 'true' : 'false'}`];
  if (input && (input.type === 'choice' || input.type === 'sequencing' || input.type === 'matching')) {
    const labels = input.type === 'sequencing' ? (input.items ?? []) : input.type === 'matching' ? (input.targets ?? []) : (input.options ?? []);
    const parts = scormAnswerParts(value, labels, input.type !== 'choice' || !!input.multiple);
    if (typeof parts === 'string') return [];
    const chosen = input.type === 'choice' ? [...new Set(parts)].sort((a, b) => a - b) : parts;
    return [`${input.type}|${input.salt ?? ''}|${chosen.join(',')}`];
  }
  if (input && input.type !== 'text') return [String(Number(value.trim()))];
  const normalized = normalizeScormAnswer(value, !!(input && input.caseSensitive));
  return normalized ? [...new Set([normalized, ...normalized.split(' ').filter(token => token.length >= 4)])] : [];
}

/**
 * An authored answer may explain itself after a spaced em or en dash, as the sample course's do:
 * `a team lead — the $250 would carry the customer past the $1,000 rolling cap`. The key is what
 * comes before the dash, and the rest is why. Without a dash the whole answer is the key.
 */
export function explainedAnswer(authored: string): { key: string; why: string } {
  const text = String(authored ?? '');
  const dash = /\s[\u2014\u2013]\s/.exec(text);
  return dash ? { key: text.slice(0, dash.index).trim(), why: text.slice(dash.index + dash[0].length).trim() } : { key: text.trim(), why: '' };
}

/**
 * Whether a reply gives an answer key.
 *
 * A reply that denies the key when the key denies nothing ("not a team lead") never gives it.
 * Otherwise the engine's own rule comes first: the reply's normalized text, or one of its words, is
 * the key. A key of several words also matches a reply with every word of the key except the
 * articles and connectives, so "team lead" gives "a team lead".
 *
 * ★ A SHORT WORD IS NOT AN UNIMPORTANT ONE. This used to require only the key's words of four
 * letters or more, so "escalate" gave "do not escalate", "fraud" gave "no fraud" and "limit" gave
 * "the $250 limit": an opposite answer passed (the automated review of #480). Negations and numbers
 * are always required now; only the words in `minor` may be left out. "don't" counts as "do not"
 * on both sides.
 *
 * ★ A NEGATION DENIES WHAT IT REACHES, AND NOTHING ELSE. Any negation anywhere in a reply used to
 * fail it, so "fraud occurred without warning" did not give "fraud" and "proceed without delay" did
 * not give "proceed" (the automated review of #486). A negation now reaches no further than its own
 * clause, which ends at punctuation, a spaced dash, or a contrast (but, however, although, though,
 * whereas, except, rather, instead). "without" reaches forward, to what it governs, and so does
 * "no" where it opens its clause or follows a preposition or a conjunction: "no evidence of fraud"
 * still denies fraud, and "proceed with no delay" still says proceed. Everywhere else a negation
 * denies its whole clause, the words before it too: "fraud was not found", "fraud was neither found
 * nor suspected" (the automated review of #488), "fraud was no issue" and "the audit found no
 * fraud" all deny it. A comparative bound denies its comparative and not the quantity it bounds:
 * "no more than 30 days" and "not later than 30 days" say 30 days, while "not greater than 30"
 * does not say "greater than 30". A key word is denied when the reply says it only where a
 * negation reaches it, so "fraud, not negligence" gives "fraud".
 *
 * A numeric key keeps its numeric contract. No inner named functions, and nothing outside it but
 * the shared scoring helpers: this is embedded in generated pages by its source.
 */
export function matchesAnswerKey(reply: string, key: string): boolean {
  const input = inferScormAnswerInput(key);
  const keyWords = normalizeScormAnswer(String(key ?? '').replace(/n['’]t\b/gi, ' not')).split(' ').filter(Boolean);
  const replyWords = normalizeScormAnswer(String(reply ?? '').replace(/n['’]t\b/gi, ' not')).split(' ').filter(Boolean);
  const minor = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'it', 'its', 'this', 'that', 'do', 'does', 'did']);
  const content = keyWords.filter(word => !minor.has(word));
  const required = content.length > 0 ? content : keyWords;
  const forward = new Set(['no', 'without']);
  const clausal = new Set(['not', 'never', 'cannot', 'neither', 'nor', 'none', 'nothing', 'nobody', 'nowhere']);
  const governs = new Set(['with', 'at', 'in', 'on', 'for', 'by', 'from', 'to', 'of', 'into', 'under', 'about', 'and', 'or', 'as', 'than']);
  const comparative = new Set(['more', 'less', 'fewer', 'greater', 'later', 'earlier', 'sooner', 'longer', 'shorter', 'higher', 'lower']);
  if (!keyWords.some(word => forward.has(word) || clausal.has(word))) {
    const denied = new Set<string>();
    const said = new Set<string>();
    for (const clause of String(reply ?? '').replace(/n['’]t\b/gi, ' not').split(/[,;:.!?()]|\s[-\u2013\u2014]+\s|\b(?:but|however|although|though|whereas|except|rather|instead)\b/i)) {
      const words = normalizeScormAnswer(clause).split(' ').filter(Boolean);
      const bound = words.map((word, i) => (forward.has(word) || clausal.has(word)) && comparative.has(words[i + 1] ?? '') && words[i + 2] === 'than');
      const negates = words.map((word, i) => (forward.has(word) || clausal.has(word)) && !bound[i]);
      let reached = words.some((word, i) => negates[i] && (clausal.has(word) || (word === 'no' && !governs.has(words[i - 1] ?? ''))));
      for (let i = 0; i < words.length; i++) {
        if (negates[i]) reached = true;
        (reached || bound[i] || bound[i - 1] || bound[i - 2] ? denied : said).add(words[i] ?? '');
      }
    }
    if (required.some(word => denied.has(word) && !said.has(word))) return false;
  }
  const expected = scormAnswerCandidates(key, input)[0];
  if (expected !== undefined && scormAnswerCandidates(reply, input).includes(expected)) return true;
  if (input && input.type !== 'text') return false;
  const have = new Set(replyWords);
  return required.length > 0 && required.every(word => have.has(word));
}

/** Validate the whole submission before writing tracking or advancing a SCO. */
export function validateScormResponses(questions: readonly ScormAssessmentQuestion[], answers: unknown): Array<{ index: number; message: string }> {
  if (!Array.isArray(answers) || answers.length !== questions.length) return [{ index: -1, message: 'Submit exactly one answer for each question.' }];
  return questions.flatMap((question, index) => {
    const message = validateScormAnswer(answers[index], question.input);
    return message ? [{ index, message }] : [];
  });
}

/** Embedded functions have no dependencies beyond this same shared contract. */
export function scormAssessmentScript(): string {
  return [normalizeScormAnswer, scormOptionIndex, scormAnswerParts, validateScormAnswer, scormAnswerCandidates, validateScormResponses, scormInteractionType, scormInteractionResponse]
    .map(fn => fn.toString()).join('\n');
}
