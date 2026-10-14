/**
 * Declarative semantic vocabulary migrated once from src/semantic.py.
 * Generation and reasoning consume this native data; Python is never invoked.
 */
import { readFileSync } from 'node:fs';

export interface Category {
  readonly id: string;
  readonly cls: string;
  readonly label: string;
  readonly definition: string;
  readonly group: string;
  readonly why: string;
  readonly broader?: string;
  readonly mode?: string;
  readonly abstract?: boolean;
  readonly bearsRole?: boolean;
  readonly referent?: readonly string[];
  readonly concept?: readonly string[];
  readonly expressible?: readonly string[];
}
export interface Vocabulary {
  readonly prefix: string;
  readonly column: string;
  readonly kind: string;
  readonly title: string;
  readonly short: string;
  readonly home: string;
}
export type Alignment = readonly [subject: string, targets: readonly string[], why: string];
export type FoxxiAlignment = readonly [subject: string, targets: readonly string[], why: string, peers: readonly string[]];
export type Individual = readonly [iri: string, types: readonly string[], classifiedBy: readonly string[], why: string];
export type PropertyAlignment = readonly [subject: string, predicate: string, object: string, why: string];
export interface SemanticData {
  readonly PREFIXES: Readonly<Record<string, string>>;
  readonly VOCABS: readonly Vocabulary[];
  readonly COLUMNS: readonly (readonly [string, string])[];
  readonly CATEGORIES: readonly Category[];
  readonly TYPE_DEFAULT: Readonly<Record<string, string>>;
  readonly TYPE_DEFAULT_WHY: Readonly<Record<string, string>>;
  readonly CONCEPT_CATEGORY: Readonly<Record<string, readonly [category: string, why: string]>>;
  readonly RECORDS: readonly Alignment[];
  readonly INDIVIDUALS: readonly Individual[];
  readonly INTEREGO: readonly Alignment[];
  readonly FOXXI: readonly FoxxiAlignment[];
  readonly PROPERTIES: readonly PropertyAlignment[];
}
const data = JSON.parse(readFileSync(new URL('./semantic-data.json', import.meta.url), 'utf8')) as SemanticData;
export const PREFIXES = data.PREFIXES;
export const VOCABS = data.VOCABS;
export const COLUMNS = data.COLUMNS;
export const CATEGORIES = data.CATEGORIES;
export const CAT_BY_ID: Readonly<Record<string, Category>> = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
export const TYPE_DEFAULT = data.TYPE_DEFAULT;
export const TYPE_DEFAULT_WHY = data.TYPE_DEFAULT_WHY;
export const CONCEPT_CATEGORY = data.CONCEPT_CATEGORY;
export const RECORDS = data.RECORDS;
export const INDIVIDUALS = data.INDIVIDUALS;
export const INTEREGO = data.INTEREGO;
export const FOXXI = data.FOXXI;
export const PROPERTIES = data.PROPERTIES;
