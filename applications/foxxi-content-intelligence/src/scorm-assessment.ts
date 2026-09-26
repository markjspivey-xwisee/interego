/** Shared answer contract for the native grader and exported assessment forms. */
export interface ScormAnswerInput {
  type: 'text' | 'integer' | 'number';
  min?: number;
  max?: number;
}
export interface ScormAssessmentQuestion {
  question: string;
  answerHash: string;
  input?: ScormAnswerInput;
}

/** A numeric authored answer has a numeric contract unless the author overrides it. */
export function inferScormAnswerInput(answer: string): ScormAnswerInput | undefined {
  if (/^[+-]?\d+$/.test(answer.trim())) return { type: 'integer' };
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(answer.trim())) return { type: 'number' };
  return undefined;
}

/** Preserve legacy text hashes, including words with digits. Numeric-only
 * expressions retain punctuation; typed numeric answers use their numeric contract. */
export function normalizeScormAnswer(value: string): string {
  const text = String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return /[a-z]/.test(text) ? text.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim() : text;
}

export function validateScormAnswer(value: unknown, input?: ScormAnswerInput): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'Enter an answer before submitting.';
  if (value.length > 250) return 'Use 250 characters or fewer.';
  if (!input || input.type === 'text') return null;
  const text = value.trim();
  if (input.type === 'integer' && !/^[+-]?\d+$/.test(text)) return 'Enter a whole number, such as 0, 1, or -1.';
  if (input.type === 'number' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return 'Enter a number.';
  const number = Number(text);
  if (!Number.isFinite(number) || (input.type === 'integer' && !Number.isSafeInteger(number))) return 'Enter a finite number within the supported range.';
  if (input.min !== undefined && number < input.min) return 'Enter a number greater than or equal to ' + input.min + '.';
  if (input.max !== undefined && number > input.max) return 'Enter a number less than or equal to ' + input.max + '.';
  return null;
}

export function scormAnswerCandidates(value: string, input?: ScormAnswerInput): string[] {
  if (validateScormAnswer(value, input)) return [];
  if (input && input.type !== 'text') return [String(Number(value.trim()))];
  const normalized = normalizeScormAnswer(value);
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
  return [normalizeScormAnswer, validateScormAnswer, scormAnswerCandidates, validateScormResponses].map(fn => fn.toString()).join('\n');
}
