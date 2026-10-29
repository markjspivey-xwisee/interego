import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestHttpError, type Conditions, type ResourceIdentifier } from '@solid/community-server';
import { nativeRevisionFromEtag } from './NativeCommit.js';

export const NATIVE_DELETE_HEADER = 'Interego-Native-Delete';

export interface NativeDeleteScope {
  readonly resource: string;
  readonly expectedRevision: string;
  /** Paths of the auxiliary resources CSS's auxiliary strategy names for `resource` (`<doc>.acl`, `<doc>.meta`). */
  readonly auxiliaries: ReadonlySet<string>;
  /**
   * Those of `auxiliaries` that CSS asked the accessor to delete before the target. They are
   * deleted only after the exact native delete of the target succeeds.
   */
  readonly deferredAuxiliaries: ResourceIdentifier[];
  /**
   * Set once the target's own delete has been decided. From then on every delete made inside the
   * scope (CSS work this request started, such as notification cleanup) is an ordinary one.
   */
  settled: boolean;
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
