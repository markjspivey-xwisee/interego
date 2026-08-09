/**
 * The one coercion this vertical adds to the substrate's literal escaper.
 *
 * ★ IN ITS OWN FILE BECAUSE `turtle.ts` MUST NOT IMPORT AND RE-EXPORT ONE NAME UNDER TWO
 * MEANINGS. The substrate's `escapeTurtleLiteral` takes a `string`; the call sites in this
 * vertical pass values lifted out of other people's documents, which are `unknown` until
 * something coerces them. Doing the coercion at each call site is how one of them ends up
 * doing it differently, so it is done once — but WHAT gets escaped, once it is a string, is
 * `@interego/core/rdf`'s answer and not a second one living beside it.
 */

import { escapeTurtleLiteral as escape } from '@interego/core/rdf/turtle-region';

/** Escape any value for use inside a short Turtle literal. */
export const escapeTurtleLiteral = (s: unknown): string => escape(String(s));
