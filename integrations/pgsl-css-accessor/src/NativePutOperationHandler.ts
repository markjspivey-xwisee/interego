import { Readable } from 'node:stream';
import {
  BadRequestHttpError, HH, InternalServerError, OkResponseDescription, PutOperationHandler,
  RepresentationMetadata, guardStream, type AuxiliaryStrategy, type OperationHandlerInput,
  type ResourceStore, type ResponseDescription,
} from '@solid/community-server';
import { isNativeCommitMediaType, nativeCommitScope, nativeRevisionEtag } from './NativeCommit.js';

/** Retains CSS's authorized ResourceStore path and returns the atomic engine's own receipt. */
export class NativePutOperationHandler extends PutOperationHandler {
  constructor(store: ResourceStore, metadataStrategy: AuxiliaryStrategy) { super(store, metadataStrategy); }

  override async handle(input: OperationHandlerInput): Promise<ResponseDescription> {
    const { operation } = input;
    if (!isNativeCommitMediaType(operation.body.metadata.contentType)) return super.handle(input);
    if (operation.target.path.endsWith('/')) throw new BadRequestHttpError('Native commits target document resources');
    return nativeCommitScope.run({ resource: operation.target.path, conditions: operation.conditions }, async () => {
      await super.handle(input);
      const receipt = nativeCommitScope.getStore()?.receipt;
      if (!receipt || receipt.resource !== operation.target.path) throw new InternalServerError('Native commit receipt is unavailable');
      const metadata = new RepresentationMetadata(operation.target);
      metadata.contentType = 'application/json';
      metadata.set(HH.terms.etag, nativeRevisionEtag(receipt.revision, receipt.contentType));
      return new OkResponseDescription(metadata, guardStream(Readable.from([JSON.stringify(receipt)])));
    });
  }
}
