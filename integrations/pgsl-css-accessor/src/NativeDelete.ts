import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestHttpError, type Conditions, type ResourceIdentifier } from '@solid/community-server';
import { nativeRevisionFromEtag } from './NativeCommit.js';

export const NATIVE_DELETE_HEADER = 'Interego-Native-Delete';

export interface NativeDeleteScope {
  readonly resource: string;
  readonly expectedRevision: string;
  /**
   * Auxiliary resources of `resource` (`<doc>.acl`, ...) that CSS asked the accessor to delete
   * before the target. They are deleted only after the exact native delete of the target succeeds.
   */
  readonly deferredAuxiliaries: ResourceIdentifier[];
}

export const nativeDeleteScope = new AsyncLocalStorage<NativeDeleteScope>();

/** Native deletion accepts exactly one strong native validator and never an absent predicate. */
export function expectedNativeDeleteRevision(conditions: Conditions | undefined): string {
  const matches = conditions?.matchesETag;
  const revision = matches?.length === 1 ? nativeRevisionFromEtag(matches[0]!) : null;
  if (conditions?.notMatchesETag || matches?.length !== 1 || !revision) {
    throw new BadRequestHttpError('Native delete requires exactly one strong native If-Match');
  }
  return revision;
}
