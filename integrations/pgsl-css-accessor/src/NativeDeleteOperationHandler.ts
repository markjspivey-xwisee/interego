import {
  BadRequestHttpError, DeleteOperationHandler, NotFoundHttpError, PreconditionFailedHttpError,
  type OperationHandlerInput, type ResourceStore, type ResponseDescription,
} from '@solid/community-server';
import { expectedNativeDeleteRevision, nativeDeleteScope } from './NativeDelete.js';

/** Runs opt-in native deletion through CSS's ordinary authorized ResourceStore path. */
export class NativeDeleteOperationHandler extends DeleteOperationHandler {
  constructor(store: ResourceStore) { super(store); }

  override async handle(input: OperationHandlerInput): Promise<ResponseDescription> {
    const { operation } = input;
    if (!(operation.conditions as typeof operation.conditions & { nativeDelete?: true })?.nativeDelete) return super.handle(input);
    if (operation.target.path.endsWith('/')) throw new BadRequestHttpError('Native delete targets document resources');
    const expectedRevision = expectedNativeDeleteRevision(operation.conditions);
    // CSS answers 404 for a missing document before the accessor runs. A native delete names one
    // exact revision, and a document that is not there does not hold it: that is a failed
    // precondition (RFC 9110 If-Match), as a document deleted after CSS's check already is.
    return nativeDeleteScope.run({ resource: operation.target.path, expectedRevision }, async () => {
      try { return await super.handle(input); }
      catch (error) {
        if (NotFoundHttpError.isInstance(error)) throw new PreconditionFailedHttpError('Native resource revision changed or disappeared');
        throw error;
      }
    });
  }
}
