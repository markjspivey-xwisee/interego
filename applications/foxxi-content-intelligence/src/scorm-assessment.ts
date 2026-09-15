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

/** Keep legacy word matching, but never erase a numeric sign or decimal point. */
export function normalizeScormAnswer(value: string): string {
  const text = String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return /[0-9]/.test(text) ? text : text.replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
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
