/**
 * A scored scenario's stakes, and the answers that leave them out.
 *
 * The stakes are what turn levels into a result: each criterion's weight, each level's value, the
 * pass rule (its minimum percent and required levels), and everything computed from them (points,
 * the maximum, the percent, whether the pass rule is met, which requirements are unmet). A judge
 * who knew them could steer a level toward or away from the pass mark, so the judge's own request
 * never carries them (`rubricForJudge` in practice.ts). The bridge makes the same cut on answers:
 * a signed request from this bridge's own web app, or from a key registered on the workspace,
 * reads the stakes; an answer to a chat assistant the Interego relay signed for, to a key that
 * holds no role there, or to a request nobody signed carries the rubric's criteria and levels by
 * name, the levels chosen and the quotes, and none of the stakes. Who is asking is decided in the
 * handlers (`showsStakes`); these functions only cut.
 *
 * Such an answer also carries the rubric's and the scenario's hashes keyed (`maskAnswerHashes`):
 * each is a sha256 over the whole rubric, stakes included, and the rest of the rubric is in the
 * answer, so only a few small integers are unknown and a bare hash would confirm a guess offline.
 * The key covers the scenario and the version a hash belongs to as well as the hash, so the same
 * rubric keys differently in any other scenario or version: a scenario an author's chat saves with
 * stakes it chose shows a keyed value no other scenario's matches, its right guess included. A hash
 * inside any other text, which a caller may have written there, is replaced with a stand-in keyed
 * apart from those fields (`Keyer.inText`), so a guess written into a turn, a reason or a scenario's
 * words never comes back equal to the hash it would be checked against. The stand-in is the same
 * each time the same hash is shown in the same scope, so a judge who quotes a line holding one
 * quotes what every view of that transcript shows, and the quote is read back as the stored text
 * at the place a view shows it (`quoteReadingsAsStored`). Such a quote is shown as the stretch of the line it was matched
 * against, as that line is shown (`readBackAsShown`), so a copy of it reads back again. A signed
 * request a record keeps is shown without what it signed: that is the signer's own object, which
 * could hold a guess under a field name this bridge keys.
 *
 * Pure: no I/O.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { cutsAWord, normaliseForQuote, verifyQuote, type Assessment, type JudgmentResult, type QuoteReadings, type Rubric, type ScenarioSpec, type Turn } from './practice.js';
import type { ReviewResult } from './records.js';

/** What every answer that left a scored scenario's stakes out says, at its top level. */
export const STAKES_WITHHELD = 'This answer leaves out a scored scenario\'s stakes: each criterion\'s weight, each level\'s points, the pass rule, '
  + 'and any points, percent or pass result worked out from them; its rubric and scenario fingerprints are keyed to their own scenario version, '
  + 'so they match no other scenario\'s or version\'s, and one written into any text is replaced with a stand-in keyed apart from them, so none can be checked against a guess. '
  + 'A signed request a record keeps is shown without its payload; its signature and the payload\'s hash stay. Practice Evidence leaves the stakes out of every answer to a chat assistant the Interego relay signs for, a key '
  + 'no admin registered or one registered as an agent, or a request nobody signed; people see them in the Practice Evidence '
  + 'web app, signed in with Interego or with an address an admin registered.';

/**
 * The keyed stand-ins for a hash (`full`, 64 hex) and for a 16-hex prefix of one (`prefix`), in one
 * scope: `full` and `prefix` for the fields this bridge writes a hash into, `inText` for a hash
 * inside any other text. The two are keyed under different labels, so a hash's stand-in in text
 * never equals any field's value, in this scope or another, nor the first 16 hex of one.
 */
export interface Keyer {
  readonly full: (hex: string) => string;
  readonly prefix: (hex16: string) => string;
  readonly inText: { readonly full: (hex: string) => string; readonly prefix: (hex16: string) => string };
}

/**
 * The keyed stand-ins for rubric and scenario hashes, in the fields this bridge writes them into
 * (`maskAnswerHashes`). Each is an HMAC-SHA256 under a key only the bridge holds, over the hash and
 * the scope it is shown in:
 *   · `version`: one scenario version (its IRI and number), for every answer about a scenario, an
 *     attempt or a judgment. The same rubric keys differently in any other scenario or version, so
 *     no answer about a scenario a caller saved can be compared with one about another.
 *   · `cells`: calibration cells, which group judgments by a rubric's content across scenarios;
 *     no caller chooses the hashes a cell shows, and its values match no scenario's.
 *   · `loose()`: a salt of its own each time it is called, for a hash an answer does not tie to a
 *     scenario version (none should): it is equal to nothing outside that one answer.
 * Each scope keys a field's hash under one label and a hash in text under another (`Keyer.inText`).
 */
export interface HashMask {
  readonly version: (scenarioIri: string, version: number) => Keyer;
  readonly cells: Keyer;
  readonly loose: () => Keyer;
}

export function hashMask(key: Buffer): HashMask {
  const keyer = (scope: readonly unknown[]): Keyer => {
    const mac = (label: string, v: string): string =>
      createHmac('sha256', key).update(JSON.stringify([label, ...scope, v]), 'utf8').digest('hex');
    return {
      full: (hex) => mac('hash', hex), prefix: (hex16) => mac('prefix', hex16).slice(0, 16),
      inText: { full: (hex) => mac('in-text-hash', hex), prefix: (hex16) => mac('in-text-prefix', hex16).slice(0, 16) },
    };
  };
  return {
    version: (scenarioIri, version) => keyer(['scenario-version', scenarioIri, version]),
    cells: keyer(['calibration-cells']),
    loose: () => keyer(['loose', randomBytes(16).toString('hex')]),
  };
}

/** The scenario version an answer is about, or `cells` for calibration, or null when the answer names it itself. */
export type HashScope = { readonly scenarioIri: string; readonly version: number } | 'cells' | null;

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }

const HEX64 = /^[0-9a-f]{64}$/;
/** Keys whose value is a rubric's or a scenario's hash. */
const HASH_KEYS: ReadonlySet<string> = new Set(['rubricHash', 'scenarioHash']);
/**
 * Keys whose value is signed or exported bytes, left as they are: a record's descriptor and graph
 * (export_record gives a scored attempt's graphs only to a reader of the stakes) and a statement
 * (project_attempt gives a scored one only to such a reader). A feedback-only rubric's hash in
 * them carries no stake.
 */
const SIGNED_KEYS: ReadonlySet<string> = new Set(['graphTrig', 'descriptorTurtle', 'statement']);
/**
 * A rubric IRI, its hash as `hashIn` reads it: `urn:pev:rubric:`, 63 hex, and the hash's last digit, or the one letter
 * NFC folded that digit and the combining marks after it into (`foldedDigit`).
 */
const RUBRIC_IRI = /urn:pev:rubric:([0-9a-f]{63}(?:[0-9a-f]|[\u0080-\uffff]))/g;
/**
 * A calibration decision kind's hash prefix, `pev/<first 16 hex of the rubric hash>/`, wherever it sits,
 * whatever comes before it. No word boundary: `\b` reads only ASCII as word characters, and NFC folds
 * some characters that are not (the Kelvin sign) into ASCII letters that are, so a line and its
 * normalised form (`normaliseForQuote`, which the judge packet and an attempt's `normalisedText` show)
 * would be masked differently.
 */
const KIND_PREFIX = /pev\/([0-9a-f]{16})\//g;
const HEX_DIGIT = /^[0-9a-f]$/;

/**
 * The hex digit a letter was folded from, and the combining marks folded with it: NFC writes a hex
 * digit a mark follows as one letter where Unicode has one (`e` and U+0301 as `é`, `b` and U+0307 as
 * `ḃ`), so `normaliseForQuote`, whose form the judge packet and an attempt's `normalisedText` show,
 * writes a run of hex whose last digit a mark follows with one hex digit fewer. Null for any other
 * character.
 */
function foldedDigit(c: string): { readonly digit: string; readonly marks: string } | null {
  const d = c.normalize('NFD');
  return d.length > 1 && HEX_DIGIT.test(d[0]!) ? { digit: d[0]!, marks: d.slice(1) } : null;
}

/**
 * The hash in `run` (`n` - 1 hex and one more character, as `RUBRIC_IRI` and `HASH_OR_RUN` take it):
 * its `n` hex, the last a digit or the letter it was folded into (`foldedDigit`), and the marks folded
 * with it ('' when none were). Null when the last character is neither.
 */
function hashIn(run: string): { readonly hash: string; readonly marks: string } | null {
  const last = run.slice(-1);
  if (HEX_DIGIT.test(last)) return { hash: run, marks: '' };
  const f = foldedDigit(last);
  return f === null ? null : { hash: run.slice(0, -1) + f.digit, marks: f.marks };
}

/**
 * The letter a stand-in's last digit is shown as where the hash's was folded with `marks`: that digit
 * with those marks, when NFC folds them into one letter, so the normalised form of the masked line is
 * the masked normalised form; otherwise a hex letter that takes them, chosen by the stand-in's digit.
 * One character either way, so every offset keeps. Which letter tells nothing of the hash's own last
 * digit beyond that it takes those marks, which a line and its normalised form shown side by side
 * already tell.
 */
function refolded(digit: string, marks: string, was: string): string {
  const own = `${digit}${marks}`.normalize('NFC');
  if (own.length === 1) return own;
  const takers = [...'abcdef'].map((b) => `${b}${marks}`.normalize('NFC')).filter((c) => c.length === 1);
  return takers[parseInt(digit, 16) % takers.length] ?? was;
}

/**
 * `run` (a hash as `hashIn` reads it) with its hash's stand-in in text for `k` in its place, the same
 * length: the stand-in's hex, its last digit refolded where the hash's was folded (`refolded`). `run`
 * as it is when it holds no hash.
 */
function standInFor(run: string, k: Keyer): string {
  const at = hashIn(run);
  if (at === null) return run;
  const s = at.hash.length === 64 ? k.inText.full(at.hash) : k.inText.prefix(at.hash);
  return at.marks === '' ? s : s.slice(0, -1) + refolded(s.slice(-1), at.marks, run.slice(-1));
}

/** A rubric IRI as this bridge writes it under `rubricIri` (`records.ts` `rubricIriOf`): that and nothing else. */
const RUBRIC_IRI_FIELD = /^urn:pev:rubric:([0-9a-f]{64})$/;
/** A calibration kind as `calibration.ts` writes it under a cell's `kind`: `pev/<16 hex>/<criterion id>`, and nothing else. */
const KIND_FIELD = /^pev\/([0-9a-f]{16})\/([a-z0-9-]{1,40})$/;
/** Whether `s` may hold a rubric IRI or a kind prefix: the cheap test before the patterns. */
const mayHoldHash = (s: string): boolean => s.includes('urn:pev:rubric:') || s.includes('pev/');

/**
 * `s` with every rubric IRI's hash and every calibration-kind prefix inside it replaced by its
 * stand-in in text for scope `k` (`Keyer.inText`), each the same length as what it replaces, so an
 * offset into the stored text is the same offset into this one. A rubric IRI's hash is found in a
 * line and in its normalised form alike: where a combining mark follows its last digit, NFC folds the
 * two into one letter (`hashIn`), and the 63 hex before that letter are replaced as well, the letter
 * refolded onto the stand-in's last digit (`standInFor`).
 */
export function maskText(s: string, k: Keyer): string {
  if (!mayHoldHash(s)) return s;
  return s.replace(RUBRIC_IRI, (_m, run: string) => `urn:pev:rubric:${standInFor(run, k)}`)
    .replace(KIND_PREFIX, (_m, p: string) => `pev/${k.inText.prefix(p)}/`);
}

/**
 * A rubric IRI's hash, a kind's prefix, the first 64 hex of a run of 64 or more with no hex before it,
 * or a whole run of 16 hex, each run's last digit possibly folded with the marks after it into one
 * letter (`hashIn`): one pass, so nothing is replaced twice. A run of 64 may go on: a rubric IRI's
 * hash is masked whatever follows it (`RUBRIC_IRI`), so a quote that leaves out `urn:pev:rubric:` can
 * hold a hash with more hex after it. A kind's 16 hex always have a `/` after them.
 */
const HASH_OR_RUN = new RegExp([
  RUBRIC_IRI.source, KIND_PREFIX.source,
  '(?<![0-9a-f])([0-9a-f]{63}(?:[0-9a-f]|[\\u0080-\\uffff]))',
  '(?<![0-9a-f])([0-9a-f]{15}(?:[0-9a-f](?![0-9a-f])|[\\u0080-\\uffff]))',
].join('|'), 'g');

/**
 * A quote that was read back (`QuoteCheck.readBack`) as an answer that masks text shows it when there
 * is no line to show it from (`readBackAsShown`): one that did not check out, or one an answer shows
 * without its attempt's lines. `maskText`, and each run of hex `HASH_OR_RUN` takes (the first 64 of a
 * run of 64 or more, a whole run of 16) replaced with its stand-in in text as well: a judge may have
 * copied a stand-in's hex alone (`quoteReadingsAsStored`), so the saved quote can hold a hash with no
 * `urn:pev:rubric:` or `pev/` around it, and more hex after it, and no hash read back into it is shown
 * bare. A run of hex the learner or the judge wrote bare is shown as a stand-in too, and a run whose
 * last digit NFC folded with a mark after it (`hashIn`) as well, in `normalised` as in `text`.
 */
export function maskReadBackQuote(s: string, k: Keyer): string {
  return s.replace(HASH_OR_RUN, (_m, iri?: string, kind?: string, run64?: string, run16?: string) => (
    iri !== undefined ? `urn:pev:rubric:${standInFor(iri, k)}`
      : kind !== undefined ? `pev/${k.inText.prefix(kind)}/`
        : standInFor(run64 ?? run16!, k)));
}

/**
 * A judge's quote that was read back (practice.ts `QuoteCheck` with `readBack`), wherever an answer
 * holds one, whole or cut down to its words and whether it checked out (`record_judgment`'s answer).
 */
const isReadBackQuote = (o: Record<string, unknown>): boolean => o['readBack'] === true && typeof o['verified'] === 'boolean';

/** A turn as a read-back quote is shown from it (`readBackAsShown`). */
export type QuotedTurn = Pick<Turn, 'index' | 'speaker' | 'text'>;
/**
 * The stored turns of each attempt whose read-back quotes an answer shows, by the attempt's IRI as the
 * answer names it (`attemptIri`, on the answer or on the entry that holds the quotes).
 */
export type QuotedLines = ReadonlyMap<string, readonly QuotedTurn[]>;
const NO_LINES: QuotedLines = new Map();

const isOffset = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Each place `s` sits in `line`, as `shown` (`line` masked, which keeps every offset) shows it there. */
function shownWhere(line: string, shown: string, s: string): string[] {
  const out: string[] = [];
  for (let at = line.indexOf(s); s !== '' && at >= 0; at = line.indexOf(s, at + 1)) out.push(shown.slice(at, at + s.length));
  return out;
}

/**
 * A read-back quote that checked out, as an answer that masks text shows it: the stretch of the
 * learner's line it was matched against (its `turnIndex`, `start` and `end`, or, where an answer
 * leaves those out, found again as `verifyQuote` found it, in its `turnIndex` when the answer gives
 * that alone), as every view of that line shows it
 * (`maskText`). `normalised` is that stretch of the normalised line, which the judge packet and an
 * attempt's `normalisedText` show; `text` is the same stretch of the line as stored, which an
 * attempt's `text` shows, where the saved words sit there and are shown the same way, and otherwise
 * the normalised stretch too. So only what the line's own views mask is masked: a stand-in the
 * line shows is shown, and a run of hex the line shows as written is shown as written. A copy of it
 * is one of those views' own words, so it reads back (`quoteReadingsAsStored`) and checks out at the same
 * place, as often as it is copied. Null when there is no such line: the quote did not check out,
 * or the answer was given no lines for its attempt (`maskReadBackQuote` then).
 */
function readBackAsShown(q: Record<string, unknown>, k: Keyer, turns: readonly QuotedTurn[] | undefined): { readonly text: string; readonly normalised: string } | null {
  const text = q['text'];
  if (turns === undefined || q['verified'] !== true || typeof text !== 'string') return null;
  const normalised = normaliseForQuote(text);
  const found = isOffset(q['turnIndex']) && isOffset(q['start']) && isOffset(q['end'])
    ? { verified: true, turnIndex: q['turnIndex'], start: q['start'], end: q['end'] }
    : verifyQuote({ text, ...(isOffset(q['turnIndex']) ? { turnIndex: q['turnIndex'] } : {}) }, turns);
  if (!found.verified || found.turnIndex === undefined || found.start === undefined || found.end === undefined) return null;
  const { turnIndex, start, end } = found;
  const line = turns.find((t) => t.speaker === 'learner' && t.index === turnIndex)?.text;
  if (line === undefined) return null;
  const norm = normaliseForQuote(line);
  if (norm.slice(start, end) !== normalised) return null;
  const normShown = maskText(norm, k);
  const shownNormalised = normShown.slice(start, end);
  if (text === normalised) return { text: shownNormalised, normalised: shownNormalised };
  // Words saved as the stored line holds them (a judge who copied an attempt's `text`): that line's
  // view of them, where it masks them as the matched stretch is masked.
  const asCopied = [...shownWhere(line, maskText(line, k), text), ...shownWhere(norm, normShown, text)]
    .find((c) => normaliseForQuote(c) === shownNormalised);
  return { text: asCopied ?? shownNormalised, normalised: shownNormalised };
}

/** One stand-in in a quote, from `at` to `end`, and the stored text it is read back as (`to`). */
interface ReadBack { readonly at: number; readonly end: number; readonly to: string }

/**
 * A learner's line as the answers that mask text show it, for finding a quote copied from one of
 * them (`quoteReadingsAsStored`). Each view either keeps the stored text's offsets or maps them back
 * exactly, so a stretch found in a view is read back as the stored stretch at the same place.
 */
interface ShownLine {
  /** The turn's index, when the line was given as a turn. */
  readonly index?: number;
  /** The line as stored, and as an attempt's `text` shows it (`maskText`): one length, the same offsets. */
  readonly raw: string;
  readonly rawShown: string;
  /**
   * The line normalised (`normaliseForQuote`), and as the judge packet and `normalisedText` show it:
   * one length, the same offsets. `normShown` need not be in NFC: where a mark follows a fingerprint's
   * last digit that does not take it, the stand-in's last digit may, and is shown with the mark after it.
   */
  readonly norm: string;
  readonly normShown: string;
  /**
   * `rawShown` and `normShown` normalised as a quote is (`normaliseForQuote`), the forms a quote copied
   * from them and normalised, by the quote rule or on the way, is found in, where they are not
   * `normShown`: each with the offset in `norm` of each of its offsets and of its end, -1 inside a
   * letter or its marks where they stand for more or fewer characters there (`linedUp`). One that
   * cannot be lined up with `normShown` is left out, so a quote is never read back by offsets that do
   * not hold.
   */
  readonly normalised: readonly { readonly shown: string; readonly at: readonly number[] }[];
}

const MARK = /\p{M}/u;

/** The end of the letter at `from` in `s` and the combining marks after it. */
function marksEnd(s: string, from: number): number {
  let at = from + 1;
  for (let cp = s.codePointAt(at); cp !== undefined && MARK.test(String.fromCodePoint(cp)); cp = s.codePointAt(at)) at += cp > 0xffff ? 2 : 1;
  return at;
}

/**
 * `alt` (`rawShown` or `normShown` normalised, `ShownLine.normalised`) lined up with `normShown`, the
 * masked normalised line: the offset in the normalised line of each offset of `alt`, and of its end.
 * The two differ only at a rubric IRI's last hex digit and the combining marks after it, where NFC
 * folds the hash's digit and the stand-in's differently (`refolded`): one shows a letter the digit and
 * some marks were folded into, the other the digit with those marks after it. Such a place is lined
 * up whole, the letter with the marks after it in one against the same in the other, when both start
 * with a hex digit and hold the same marks: its first character maps to that place, any character
 * after it in `alt` to -1. Null when anything else differs.
 */
function linedUp(alt: string, normShown: string, norm: string): { readonly shown: string; readonly at: readonly number[] } | null {
  const lastDigits = new Set<number>();
  for (const m of norm.matchAll(RUBRIC_IRI)) if (hashIn(m[1]!) !== null) lastDigits.add(m.index + 'urn:pev:rubric:'.length + 63);
  const map: number[] = [];
  let i = 0;
  let j = 0;
  while (j < alt.length) {
    if (lastDigits.has(i)) {
      const ni = marksEnd(normShown, i);
      const nj = marksEnd(alt, j);
      const ours = normShown.slice(i, ni);
      const theirs = alt.slice(j, nj);
      if (ours !== theirs) {
        const [a, b] = [ours.normalize('NFD'), theirs.normalize('NFD')];
        if (!HEX_DIGIT.test(a[0]!) || !HEX_DIGIT.test(b[0]!) || a.slice(1) !== b.slice(1)) return null;
        map.push(i, ...Array.from({ length: nj - j - 1 }, () => -1));
        i = ni;
        j = nj;
        continue;
      }
    }
    if (i < normShown.length && alt[j] === normShown[i]) {
      map.push(i);
      i += 1;
      j += 1;
    } else {
      return null;
    }
  }
  if (i !== normShown.length) return null;
  map.push(norm.length);
  return { shown: alt, at: map };
}

function shownLine(raw: string, k: Keyer, index?: number): ShownLine {
  const norm = normaliseForQuote(raw);
  const normShown = maskText(norm, k);
  const rawShown = maskText(raw, k);
  const normalised = [...new Set([normaliseForQuote(rawShown), normaliseForQuote(normShown)])].filter((alt) => alt !== normShown)
    .flatMap((alt) => linedUp(alt, normShown, norm) ?? []);
  return { ...(index !== undefined ? { index } : {}), raw, rawShown, norm, normShown, normalised };
}

/** Each offset `needle` starts at in `haystack`, overlapping ones included. */
function startsOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = haystack.indexOf(needle); needle !== '' && at >= 0; at = haystack.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** A turn, or a stored line given alone: a learner's when given alone. */
type StoredLine = string | QuotedTurn;

/**
 * Reads a quote copied from a view of `stored` masked for scope `k` (`maskText`) as the stored text
 * it was copied from (practice.ts `QuoteReadings`).
 *
 * `matched`: the quote is looked for in each learner line as each view shows it, and every place it
 * is found is read back as the stored stretch at that place. Every view keeps the stored line's
 * offsets, or maps them back exactly (`ShownLine`): an attempt's `text` shows the line masked, a
 * stand-in the length of the hash or kind it replaces, and the quote is looked for there as sent; the
 * judge packet and `normalisedText` show the normalised line masked, and the quote is looked for there
 * normalised as `verifyQuote` normalises it. That view need not be in NFC: where a mark follows a
 * fingerprint's last digit, the stand-in's digit may take it where the fingerprint's did not, or the
 * other way round. So the quote, which the quote rule normalises and a chat app may have normalised on
 * the way, is also looked for in each view normalised, lined up with the normalised line in whichever
 * direction NFC folds there (`linedUp`), and an exact copy of the packet is found that way too. So which runs
 * of hex are stand-ins and which are written out (a stand-in the learner copied from an earlier view
 * and wrote out reads the same as the hash it stands for) is read from the line itself, however many
 * there are. A place where the quote starts or ends inside a word of the stored line is skipped: such
 * a match cuts a word (the quote rule's `cutsAWord`), and a stretch that cut a run of hex would hold
 * part of a hash. Only learner lines are looked in; a line given alone is taken as one. The turn the
 * judge named, when given, is looked in first, so its stretch is the first checked.
 *
 * `otherwise`: each stand-in in the quote that stands for a hash in `stored` put back as that hash,
 * as a view shows it (`urn:pev:rubric:<64 hex>`, `pev/<16 hex>/`) or as its hex alone, a run of 64 hex
 * digits (the first 64 of a longer one) or a whole run of 16 (the quote rule lets a quote start or end at
 * a `:` or a `/`, so a quote may leave out `urn:pev:rubric:`, `pev/` or the closing `/`); anything else
 * as it is. It names no hash that is
 * not already in `stored`. A quote that cuts a run of hex is not read back. This is what a quote no
 * matched stretch checks out for is saved as, and says why.
 */
export function quoteReadingsAsStored(k: Keyer, stored: readonly StoredLine[]): (quote: string, turnIndex?: number) => QuoteReadings {
  const texts = stored.flatMap((t) => (typeof t === 'string' ? [t] : t.text !== undefined ? [t.text] : []));
  // Each stand-in as a view shows it, to the stored text it stands for: from a line and from its
  // normalised form, which writes a hash a mark follows otherwise (`hashIn`) and is shown so.
  const full = new Map<string, string>();
  const prefix = new Map<string, string>();
  for (const t of texts) {
    if (!mayHoldHash(t)) continue;
    for (const form of [t, normaliseForQuote(t)]) {
      for (const m of form.matchAll(RUBRIC_IRI)) if (hashIn(m[1]!) !== null) full.set(standInFor(m[1]!, k), m[1]!);
      for (const m of form.matchAll(KIND_PREFIX)) prefix.set(k.inText.prefix(m[1]!), m[1]!);
    }
  }
  if (full.size === 0 && prefix.size === 0) return (quote) => ({ matched: [], otherwise: quote });
  // A line no view masks is shown as stored: a quote found there was found as sent.
  const lines = stored.flatMap((t) => (typeof t === 'string' ? (mayHoldHash(t) ? [shownLine(t, k)] : [])
    : t.speaker === 'learner' && t.text !== undefined && mayHoldHash(t.text) ? [shownLine(t.text, k, t.index)] : []));
  const everyStandInBack = (quote: string): string => {
    const back: ReadBack[] = [];
    for (const m of quote.matchAll(HASH_OR_RUN)) {
      const [whole, iri, kind, run64, run16] = m;
      const raw = iri !== undefined ? full.get(iri) : kind !== undefined ? prefix.get(kind) : run64 !== undefined ? full.get(run64) : prefix.get(run16!);
      if (raw === undefined) continue;
      back.push({ at: m.index, end: m.index + whole.length, to: iri !== undefined ? `urn:pev:rubric:${raw}` : kind !== undefined ? `pev/${raw}/` : raw });
    }
    let out = '';
    let from = 0;
    for (const r of back) {
      out += quote.slice(from, r.at) + r.to;
      from = r.end;
    }
    return out + quote.slice(from);
  };
  return (quote, turnIndex) => {
    const q = normaliseForQuote(quote);
    const matched = new Set<string>();
    const keep = (line: string, start: number, end: number, as: string): void => {
      const r = line.slice(start, end);
      if (r !== as && !cutsAWord(line, start, end)) matched.add(r);
    };
    const named = turnIndex === undefined ? [] : lines.filter((l) => l.index === turnIndex);
    for (const l of [...named, ...lines.filter((x) => !named.includes(x))]) {
      // Copied from an attempt's `text`: the stored line's own words at that place, as they are stored.
      for (const at of startsOf(l.rawShown, quote)) keep(l.raw, at, at + quote.length, quote);
      // Copied from the normalised line, normalised as the quote rule normalises it: the normalised line's words at that place.
      for (const at of startsOf(l.normShown, q)) keep(l.norm, at, at + q.length, q);
      // Copied from either view, normalised by the quote rule or on the way, where that view normalised is not the normalised
      // line as shown (which need not be in NFC: `ShownLine.normShown`): the normalised line's words at the place it lines up with.
      for (const alt of l.normalised) {
        for (const at of startsOf(alt.shown, q)) {
          const from = alt.at[at]!;
          const to = alt.at[at + q.length]!;
          if (from >= 0 && to > from) keep(l.norm, from, to, q);
        }
      }
    }
    return { matched: [...matched], otherwise: everyStandInBack(quote) };
  };
}

/**
 * A quote with every stand-in in it that stands for a hash in `stored` read back
 * (`quoteReadingsAsStored`'s `otherwise`): the reading of a quote copied whole from a view.
 */
export function quoteAsStored(k: Keyer, stored: readonly StoredLine[]): (quote: string) => string {
  const readings = quoteReadingsAsStored(k, stored);
  return (quote) => readings(quote).otherwise;
}

type Version = { readonly scenarioIri: string; readonly version: number };
const isVersionNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
/** The scenario version an object names: `scenarioIri` with `version` (or `scenarioVersion`). */
function namedVersion(o: unknown): Version | null {
  if (!isRecord(o) || typeof o['scenarioIri'] !== 'string') return null;
  const v = isVersionNumber(o['version']) ? o['version'] : o['scenarioVersion'];
  return isVersionNumber(v) ? { scenarioIri: o['scenarioIri'], version: v } : null;
}

/**
 * The scenario version the hashes in `o` belong to: the one it names, or the one its `scenario`
 * names (an attempt view), or, for an object that holds a hash and its own `version` (a scenario's
 * list of versions), the scenario it sits under at that version; otherwise the one it sits under.
 */
function versionIn(o: Record<string, unknown>, under: Version | null): Version | null {
  const own = namedVersion(o) ?? namedVersion(o['scenario']);
  if (own !== null) return own;
  if (under !== null && isVersionNumber(o['version']) && [...HASH_KEYS].some((k) => k in o)) return { scenarioIri: under.scenarioIri, version: o['version'] };
  return under;
}

/** The forms a record keeps a signed request in (records.ts `EnvelopeForm`). */
const ENVELOPE_FORMS: ReadonlySet<unknown> = new Set(['pev-canonical', 'signed-request']);
/**
 * A signed request as a record keeps it (records.ts `StoredEnvelope`), wherever an answer holds one: a
 * turn's, a review's, a contest's or a withdrawal's, a removal's, a scenario's draft receipt.
 */
const isStoredEnvelope = (o: Record<string, unknown>): boolean =>
  ENVELOPE_FORMS.has(o['form']) && typeof o['signature'] === 'string' && typeof o['payloadSha256'] === 'string';

/**
 * A stored signed request without what was signed (`payload`, or the signed JSON text,
 * `signedPayload`), saying so (`payloadLeftOut`); its signature, its payload's sha256 and who stood
 * behind it stay. An envelope whose payload redaction already removed is returned as it is.
 */
function withoutPayload(o: Record<string, unknown>): Record<string, unknown> {
  if (!('payload' in o) && !('signedPayload' in o)) return o;
  const { payload: _p, signedPayload: _s, ...rest } = o;
  return { ...rest, payloadLeftOut: true };
}

/**
 * A calibration cell (calibration.ts `CalibrationCellView`), wherever an answer holds one (the
 * calibration read, a scenario's results): it groups judgments by a rubric's content across
 * scenarios, so its hashes are keyed for cells (`HashMask.cells`), as calibration's are.
 */
const isCalibrationCell = (o: Record<string, unknown>): boolean =>
  (o['grouping'] === 'rubric-version' || o['grouping'] === 'criterion-content') && typeof o['criterionContentHash'] === 'string' && typeof o['judgeId'] === 'string';

/**
 * An answer with every rubric and scenario hash keyed or replaced, apart from signed bytes
 * (`SIGNED_KEYS`), and every stored signed request's payload left out.
 *
 * Left out: what a signed request kept in a record signed (`payload`, `signedPayload`), wherever the
 * answer holds one (`withoutPayload`). A payload is the signer's own object, with any fields it chose
 * beside the act's: walked like this bridge's own, a `rubricHash` or `rubricIri` written there would be
 * keyed as the answer's own is, in a scenario version an object inside it could name, or for cells
 * inside an object shaped like one, so a guess written there would come back keyed, to compare. The
 * signature, the payload's sha256 and who stood behind it stay.
 *
 * Keyed: the fields this bridge writes a hash into, and only those: the value of a `rubricHash` or
 * `scenarioHash` (64 hex), of a `rubricIri` (`urn:pev:rubric:<hash>`, exactly), and of a calibration
 * cell's `kind` (`pev/<16 hex>/<criterion id>`, exactly). Each is keyed for the scenario version it
 * belongs to (`versionIn`, starting from `scope`), for calibration cells (`scope` `cells`, or inside a
 * cell wherever it sits), or, where nothing names its version, with a salt of this answer's own
 * (`loose`).
 *
 * Replaced: a rubric IRI's hash or a kind's prefix inside any other string (`maskText`). Such text
 * may be a caller's (a turn, a contest or redaction reason, a judge's quote or rationale, a
 * scenario's words or a criterion's title), and keyed like the answer's own `rubricHash` it would let
 * a caller write the bare hash of a guessed rubric and read it back keyed, to compare. So each one is
 * replaced with its stand-in in text for the same scope (`Keyer.inText`), keyed under a label of its
 * own: equal to no field's value, and the same wherever the same hash is shown in that scope, so
 * every view of one attempt's transcript shows a line the same way and a quote copied from any of
 * them reads back as the stored line (`quoteReadingsAsStored`).
 *
 * Shown from its line: a read-back quote's words, which are the stored line's and can hold a hash
 * with nothing around it, are shown as the stretch of the learner's line they were matched against,
 * as that line is shown (`readBackAsShown`). The line comes from `lines`: the stored turns of the
 * attempt the answer, or the entry holding the quote, names by `attemptIri`. With no line to show
 * them from, every whole run of 64 or 16 hex in them is replaced as well (`maskReadBackQuote`).
 *
 * Two stand-ins in text are equal when their hashes are, which tells a caller only that two texts
 * hold the same hash. A caller who reads no stakes can learn something from that only if a real
 * rubric hash already sits in some text, and this bridge writes none there: only a person who reads
 * the stakes can have put it there, and such a person could as well pass the stakes on.
 */
export function maskAnswerHashes(v: unknown, m: HashMask, scope: HashScope = null, lines: QuotedLines = NO_LINES): unknown {
  let loose: Keyer | null = null;
  const keyerFor = (at: Version | 'cells' | null): Keyer => {
    if (at === 'cells') return m.cells;
    if (at !== null) return m.version(at.scenarioIri, at.version);
    return (loose ??= m.loose());
  };
  // `attempt`: the attempt whose quotes `x` may hold, as the object it sits in names it.
  const walk = (x: unknown, at: Version | 'cells' | null, attempt: string | null, key?: string): unknown => {
    if (typeof x === 'string') {
      if (key !== undefined && HASH_KEYS.has(key) && HEX64.test(x)) return keyerFor(at).full(x);
      const iri = key === 'rubricIri' ? RUBRIC_IRI_FIELD.exec(x) : null;
      if (iri !== null) return `urn:pev:rubric:${keyerFor(at).full(iri[1]!)}`;
      const kind = key === 'kind' && at === 'cells' ? KIND_FIELD.exec(x) : null;
      if (kind !== null) return `pev/${keyerFor(at).prefix(kind[1]!)}/${kind[2]!}`;
      return mayHoldHash(x) ? maskText(x, keyerFor(at)) : x;
    }
    if (Array.isArray(x)) return x.map((y) => walk(y, at, attempt));
    if (isRecord(x)) {
      const o = isStoredEnvelope(x) ? withoutPayload(x) : x;
      const here = at === 'cells' || isCalibrationCell(o) ? 'cells' : versionIn(o, at);
      const within = typeof o['attemptIri'] === 'string' ? o['attemptIri'] : attempt;
      const readBack = isReadBackQuote(o);
      const shown = readBack ? readBackAsShown(o, keyerFor(here), within === null ? undefined : lines.get(within)) : null;
      return Object.fromEntries(Object.entries(o).map(([k, y]) => [k,
        SIGNED_KEYS.has(k) ? y
          : readBack && (k === 'text' || k === 'normalised') && typeof y === 'string' ? (shown?.[k] ?? maskReadBackQuote(y, keyerFor(here)))
            : walk(y, here, within, k)]));
    }
    return x;
  };
  return walk(v, scope, null);
}

/** A rubric as an answer without the stakes carries it: criteria and levels, in words. */
export interface RubricWithoutStakes {
  readonly criteria: readonly {
    readonly id: string; readonly title: string; readonly description: string;
    readonly levels: readonly { readonly id: string; readonly label: string; readonly descriptor: string }[];
  }[];
}

export function rubricWithoutStakes(r: Rubric): RubricWithoutStakes {
  return {
    criteria: r.criteria.map((c) => ({
      id: c.id, title: c.title, description: c.description,
      levels: c.levels.map((l) => ({ id: l.id, label: l.label, descriptor: l.descriptor })),
    })),
  };
}

/** The levels an assessment counted, each with its place in its criterion (0 = lowest). */
export interface AssessmentWithoutStakes {
  readonly use: Assessment['use']; readonly provisional: boolean;
  readonly levels: readonly { readonly criterionId: string; readonly levelId: string; readonly levelIndex: number }[];
  readonly computedBy: 'platform';
}

/**
 * An assessment without the stakes: the levels it counted and nothing computed from a weight, a
 * value or the pass rule. A feedback-only assessment holds nothing else and is returned as it is.
 */
export function assessmentWithoutStakes(a: Assessment, r: Rubric): AssessmentWithoutStakes {
  if (a.use === 'feedback-only') return a;
  const indexOf = (criterionId: string, levelId: string): number =>
    r.criteria.find((c) => c.id === criterionId)?.levels.findIndex((l) => l.id === levelId) ?? -1;
  return {
    use: a.use, provisional: a.provisional,
    levels: a.perCriterion.map((p) => ({ criterionId: p.criterionId, levelId: p.levelId, levelIndex: indexOf(p.criterionId, p.levelId) })),
    computedBy: a.computedBy,
  };
}

export type JudgmentWithoutStakes = Omit<JudgmentResult, 'provisional'> & { readonly provisional: AssessmentWithoutStakes };

/** A judgment with its levels, quotes and rationale, and its provisional result reduced to the levels it counted. */
export function judgmentWithoutStakes(j: JudgmentResult, r: Rubric): JudgmentWithoutStakes {
  return { ...j, provisional: assessmentWithoutStakes(j.provisional, r) };
}

export type ReviewWithoutStakes = Omit<ReviewResult, 'assessment'> & { readonly assessment: AssessmentWithoutStakes };

/** A review with the reviewer's levels and reasons, and its result reduced to those levels. */
export function reviewWithoutStakes(v: ReviewResult, r: Rubric): ReviewWithoutStakes {
  return { ...v, assessment: assessmentWithoutStakes(v.assessment, r) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  A scenario sent without its stakes
// ═════════════════════════════════════════════════════════════════════════════════════════════

const given = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

/** True when a scenario as sent names any stake: a criterion's weight, a level's value, or a pass rule. */
export function sentStakes(raw: unknown): boolean {
  if (!isRecord(raw) || !isRecord(raw['rubric'])) return false;
  const r = raw['rubric'];
  if (given(r['passRule'])) return true;
  const criteria = Array.isArray(r['criteria']) ? r['criteria'] as unknown[] : [];
  return criteria.some((c) => isRecord(c) && (given(c['weight'])
    || (Array.isArray(c['levels']) && (c['levels'] as unknown[]).some((l) => isRecord(l) && given(l['value'])))));
}

/** True when a scenario as sent is scored (`assessmentUse: pass-gate`) and names no stake. */
export function scoredWithoutStakes(raw: unknown): boolean {
  return isRecord(raw) && typeof raw['assessmentUse'] === 'string' && raw['assessmentUse'].trim() === 'pass-gate' && !sentStakes(raw);
}

/**
 * The criteria and levels of a scenario as sent, by id and in order, are exactly those of `head`:
 * the only case in which `head`'s stakes can be put back on it unchanged.
 */
export function sameRubricShape(raw: unknown, head: Rubric): boolean {
  if (!isRecord(raw) || !isRecord(raw['rubric'])) return false;
  const criteria = Array.isArray(raw['rubric']['criteria']) ? raw['rubric']['criteria'] as unknown[] : [];
  const id = (x: unknown): string => (isRecord(x) && typeof x['id'] === 'string' ? x['id'].trim() : '');
  return criteria.length === head.criteria.length && criteria.every((c, i) => {
    const h = head.criteria[i]!;
    const levels = isRecord(c) && Array.isArray(c['levels']) ? c['levels'] as unknown[] : [];
    return id(c) === h.id && levels.length === h.levels.length && levels.every((l, j) => id(l) === h.levels[j]!.id);
  });
}

/**
 * A scenario as sent, with `head`'s stakes put back: each criterion's weight and each level's value
 * by id, and the pass rule; the reason a pass mark fits too when none was sent. Only for a scenario
 * `sameRubricShape` holds for: everything else in it is the sender's.
 */
export function withStakesOf(raw: Record<string, unknown>, head: ScenarioSpec): Record<string, unknown> {
  const rubric = raw['rubric'] as Record<string, unknown>;
  const criteria = (rubric['criteria'] as Record<string, unknown>[]).map((c, i) => {
    const h = head.rubric.criteria[i]!;
    return { ...c, weight: h.weight, levels: (c['levels'] as Record<string, unknown>[]).map((l, j) => ({ ...l, value: h.levels[j]!.value })) };
  });
  return {
    ...raw, rubric: { ...rubric, criteria, passRule: head.rubric.passRule },
    ...(given(raw['passGateWhy']) || head.passGateWhy === null ? {} : { passGateWhy: head.passGateWhy }),
  };
}
