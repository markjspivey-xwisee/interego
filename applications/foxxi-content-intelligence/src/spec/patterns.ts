/**
 * Lexical patterns the standards models share, each written once.
 *
 * Every pattern here is anchored, ^…$, and stays inside the regular-expression subset that XML
 * Schema (an OWL 2 pattern facet), XPath (SHACL sh:pattern, by way of SPARQL REGEX), JavaScript (the
 * Foxxi validator) and Python (the review tooling) all read the same way: plain groups, explicit
 * character classes, quantifiers, alternation. `(?:…)`, lookarounds and `\d` are outside it, and
 * spec-ontology.ts refuses them when a document is built (portablePattern, xsdRegex).
 *
 * "At least one component" is spelled out as alternatives rather than with a lookahead, because a
 * lookahead is not XML Schema.
 */

const D = '[0-9]';
/** An unsigned number with an optional fraction. */
const NUM = `${D}+(\\.${D}+)?`;

// ── ISO 8601 durations ──────────────────────────────────────────────────────────────────────
// ISO 8601:2004 §4.4.3.2, as xAPI requires it (IEEE 9274.1.1-2023 §5.2.7): years, months, days,
// hours, minutes, seconds; at least one; T only before a time component; the week form PnW stands
// alone; and only the lowest-order component present may carry a decimal fraction ("P1Y2.5M", not
// "P1.5Y2M"). Each part is therefore written twice: whole, when a later component follows it, and
// ending in a fraction, when it is the last.
const INT = `${D}+`;
/** Date components, all whole: a time part follows. */
const ISO_DATE_WHOLE = `(${INT}Y(${INT}M)?(${INT}D)?|${INT}M(${INT}D)?|${INT}D)`;
/** Date components, the last one fractional or whole: nothing follows. */
const ISO_DATE_LAST = `(${NUM}Y|${INT}Y${NUM}M|${INT}Y${INT}M${NUM}D|${INT}Y${NUM}D|${NUM}M|${INT}M${NUM}D|${NUM}D)`;
/** Time components, the last one fractional or whole. */
const ISO_TIME_LAST = `T(${NUM}H|${INT}H${NUM}M|${INT}H${INT}M${NUM}S|${INT}H${NUM}S|${NUM}M|${INT}M${NUM}S|${NUM}S)`;
export const ISO8601_DURATION = `^P(${NUM}W|${ISO_DATE_LAST}|${ISO_DATE_WHOLE}${ISO_TIME_LAST}|${ISO_TIME_LAST})$`;

// XML Schema xs:duration (XML Schema 1.1 Part 2 §3.3.6), the type of IMS Simple Sequencing's
// duration limits: an optional minus sign; integer components except the seconds; no weeks; at
// least one component; T only before a time component.
const XS_DATE = `(${D}+Y(${D}+M)?(${D}+D)?|${D}+M(${D}+D)?|${D}+D)`;
const XS_TIME = `T(${D}+H(${D}+M)?(${NUM}S)?|${D}+M(${NUM}S)?|${NUM}S)`;
export const XS_DURATION = `^-?P(${XS_DATE}(${XS_TIME})?|${XS_TIME})$`;

// ── SCORM 2004 run-time data types ───────────────────────────────────────────────────────────
// timeinterval (second,10,2): P[yY][mM][dD][T[hH][nM][s[.s]S]] — integer components, the
// seconds to a hundredth; at least one component.
const SECONDS_TO_HUNDREDTHS = `${D}+(\\.${D}{1,2})?`;
const TI_TIME = `T(${D}+H(${D}+M)?(${SECONDS_TO_HUNDREDTHS}S)?|${D}+M(${SECONDS_TO_HUNDREDTHS}S)?|${SECONDS_TO_HUNDREDTHS}S)`;
export const SCORM_TIMEINTERVAL = `^P(${XS_DATE}(${TI_TIME})?|${TI_TIME})$`;

// time (second,10,0): YYYY[-MM[-DD[Thh[:mm[:ss[.s[TZD]]]]]]] — a point in time, as precise as
// the writer knows it, to a hundredth of a second; the zone designator (Z, or ±hh, or ±hh:mm)
// follows the seconds.
const TZD = `(Z|[+-]${D}{2}(:${D}{2})?)`;
export const SCORM_TIME = `^${D}{4}(-${D}{2}(-${D}{2}(T${D}{2}(:${D}{2}(:${D}{2}(\\.${D}{1,2})?${TZD}?)?)?)?)?)?$`;

// ── Timestamps ─────────────────────────────────────────────────────────────────────────────
// RFC 3339 date-time (xAPI timestamps): date, T (or t, or a space), hours and minutes, optional
// seconds and fraction, optional offset.
export const RFC3339_TIMESTAMP = `^${D}{4}-${D}{2}-${D}{2}[Tt ]${D}{2}:${D}{2}(:${D}{2}(\\.${D}+)?)?(Z|[+-]${D}{2}:${D}{2})?$`;

// An xAPI 2.0 timestamp as a statement states it (IEEE 9274.1.1-2023 §5.2.7 requires ISO 8601, in the
// format RFC 3339 describes, in UTC): an RFC 3339 date-time with seconds, in UTC (Z, or +00:00), with
// T and Z in upper case — the form XML Schema gives an xsd:dateTime, which is what a statement's RDF
// reading types it. The LRS accepts more on
// input, as xAPI 2.0 (LRS part, Timestamps) has it convert rather than reject (and the ADL test suite
// sends `2008-09-15 15:53:00.601+00:00` and `2023-05-04T12:00-05:00`), and stores this form.
export const RFC3339_UTC_TIMESTAMP = `^${D}{4}-${D}{2}-${D}{2}T${D}{2}:${D}{2}:${D}{2}(\\.${D}+)?(Z|\\+00:00)$`;
