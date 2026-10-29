import {
  BadRequestHttpError, DeleteOperationHandler, type OperationHandlerInput,
  type ResourceStore, type ResponseDescription,
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
    return nativeDeleteScope.run({ resource: operation.target.path, expectedRevision }, () => super.handle(input));
  }
}
