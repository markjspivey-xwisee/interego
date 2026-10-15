import {
  GetOperationHandler, toNamedTerm, type ETagHandler, type OperationHandlerInput,
  type ResourceStore, type ResponseDescription,
} from '@solid/community-server';
import { NATIVE_COMMIT_MEDIA_TYPE, nativeReadScope } from './NativeCommit.js';

/** Preserves CSS read authorization/conversion and binds native GET evidence to one resource snapshot. */
export class NativeGetOperationHandler extends GetOperationHandler {
  constructor(store: ResourceStore, eTagHandler: ETagHandler) { super(store, eTagHandler); }

  override async handle(input: OperationHandlerInput): Promise<ResponseDescription> {
    return nativeReadScope.run({ resource: input.operation.target.path }, async () => {
      const response = await super.handle(input);
      const snapshot = await nativeReadScope.getStore()?.snapshot;
      if (snapshot && response.statusCode === 200 && response.metadata?.contentType === snapshot.contentType.split(';', 1)[0]?.trim()) {
        // Partial and converted representations must not inherit the full stored-body digest.
        response.metadata.set(toNamedTerm('http://www.w3.org/2011/http-headers#interego-revision'), snapshot.revision);
        response.metadata.set(toNamedTerm('http://www.w3.org/2011/http-headers#interego-body-digest'), snapshot.bodyDigest);
        response.metadata.set(toNamedTerm('http://www.w3.org/2011/http-headers#accept-put'), NATIVE_COMMIT_MEDIA_TYPE);
      }
      return response;
    });
  }
}
