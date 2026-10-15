import { BasicETagHandler, type ETagHandler, type RepresentationMetadata, toNamedTerm } from '@solid/community-server';
import { isNativeRevision, NATIVE_REVISION_PREDICATE, nativeRevisionEtag, nativeRevisionFromEtag } from './NativeCommit.js';

/** Documents use the committed native version; unversioned legacy/container metadata retains CSS behavior. */
export class NativeETagHandler implements ETagHandler {
  private readonly fallback = new BasicETagHandler();

  getETag(metadata: RepresentationMetadata): string | undefined {
    const revision = metadata.get(toNamedTerm(NATIVE_REVISION_PREDICATE))?.value;
    return isNativeRevision(revision) && metadata.contentType
      ? nativeRevisionEtag(revision, metadata.contentType) : this.fallback.getETag(metadata);
  }
  matchesETag(metadata: RepresentationMetadata, etag: string, strict: boolean): boolean {
    const revision = metadata.get(toNamedTerm(NATIVE_REVISION_PREDICATE))?.value;
    if (!isNativeRevision(revision)) return this.fallback.matchesETag(metadata, etag, strict);
    return strict ? this.getETag(metadata) === etag : nativeRevisionFromEtag(etag) === revision;
  }
  sameResourceState(left: string, right: string): boolean {
    const revision = nativeRevisionFromEtag(left);
    if (revision !== null || nativeRevisionFromEtag(right) !== null) return revision !== null && revision === nativeRevisionFromEtag(right);
    return this.fallback.sameResourceState(left, right);
  }
}
