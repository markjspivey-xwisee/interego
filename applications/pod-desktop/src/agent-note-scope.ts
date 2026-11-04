import type { AgentPermission } from './agent-types.js';

const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Absence preserves legacy all-note access. An explicit empty list permits no reads. */
export function selectedNoteIds(value: { readonly permissions: readonly AgentPermission[]; readonly selectedNoteIds?: readonly string[] }): readonly string[] | undefined {
  if (!Object.hasOwn(value, 'selectedNoteIds')) return undefined;
  const ids = value.selectedNoteIds;
  if (!value.permissions.includes('notes:read') || !Array.isArray(ids) || ids.length > 100
    || ids.some(id => typeof id !== 'string' || !NOTE_ID.test(id))
    || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
    throw new Error('Choose up to 100 distinct notes for read access.');
  }
  return Object.freeze(ids.map(id => id.toLowerCase()));
}
