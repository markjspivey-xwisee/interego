import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BadRequestHttpError, BasicConditions, BasicRepresentation, ConflictHttpError, HttpError, InternalServerError,
  OkResponseDescription, PostOperationHandler, PreconditionFailedHttpError, RepresentationMetadata, guardStream, toNamedTerm,
  type ETagHandler, type OperationHandlerInput, type ResourceIdentifier, type ResourceStore, type ResponseDescription,
} from '@solid/community-server';
import {
  NATIVE_COMMIT_MAX_BYTES, NATIVE_COMMIT_MEDIA_TYPE, NATIVE_REVISION_PREDICATE, isNativeRevision, nativeCommitScope,
  type NativeCommitScope,
} from './NativeCommit.js';
import { isNativeStageMediaType, readNativeStageCommand, type NativeStageItem, type NativeStageReceipt } from './NativeStage.js';

/**
 * Stages several immutable, content-named representations into one container in a single request.
 *
 * Each item is the same create-if-absent native commit a conditional PUT of that document would be,
 * through the same authorized ResourceStore path, one after another, and is answered with a receipt
 * bound to the digest of its bytes. A name that already holds the identical representation is read
 * back and confirmed; one that holds anything else refuses the request. The items are independent
 * commits, not one transaction: a refused request may have staged the items before the one refused.
 */
export class NativeStageOperationHandler extends PostOperationHandler {
  private readonly stageStore: ResourceStore;
  private readonly eTagHandler: ETagHandler;

  constructor(store: ResourceStore, eTagHandler: ETagHandler) {
    super(store);
    this.stageStore = store;
    this.eTagHandler = eTagHandler;
  }

  override async handle(input: OperationHandlerInput): Promise<ResponseDescription> {
    const { operation } = input;
    if (!isNativeStageMediaType(operation.body.metadata.contentType)) return super.handle(input);
    if (!operation.target.path.endsWith('/')) throw new BadRequestHttpError('Native staging targets a container');
    const items = await readNativeStageCommand(operation.body.data);
    const receipts: NativeStageReceipt[] = [];
    for (const item of items) receipts.push(await this.stage({ path: operation.target.path + item.name }, item));
    const metadata = new RepresentationMetadata(operation.target);
    metadata.contentType = 'application/json';
    return new OkResponseDescription(metadata, guardStream(Readable.from([JSON.stringify({ version: 1, receipts })])));
  }

  private async stage(identifier: ResourceIdentifier, item: NativeStageItem): Promise<NativeStageReceipt> {
    const bodyDigest = `sha256:${createHash('sha256').update(item.bytes).digest('hex')}`;
    const conditions = new BasicConditions(this.eTagHandler, { notMatchesETag: ['*'] });
    const scope: NativeCommitScope = { resource: identifier.path, conditions };
    const command = JSON.stringify({ version: 1, expectedRevision: null, contentType: item.contentType, bodyBase64: item.bodyBase64 });
    try {
      await nativeCommitScope.run(scope, () => this.stageStore.setRepresentation(
        identifier, new BasicRepresentation(command, identifier, NATIVE_COMMIT_MEDIA_TYPE), conditions));
    } catch (error) {
      if (!PreconditionFailedHttpError.isInstance(error)) throw error;
      return this.confirmExisting(identifier, item, bodyDigest);
    }
    const receipt = scope.receipt;
    // setNativeCommitReceipt has already bound this receipt to the submitted bytes and content type.
    if (!receipt || receipt.resource !== identifier.path || receipt.bodyDigest !== bodyDigest || receipt.size !== item.bytes.length) {
      throw new InternalServerError('Native stage receipt is unavailable');
    }
    return { name: item.name, status: 'staged', created: true, revision: receipt.revision, bodyDigest,
      contentType: receipt.contentType, size: receipt.size };
  }

  /** The name is taken: only the identical stored representation, read back here, confirms it. */
  private async confirmExisting(identifier: ResourceIdentifier, item: NativeStageItem, bodyDigest: string): Promise<NativeStageReceipt> {
    const existing = await this.stageStore.getRepresentation(identifier, {});
    // Events, not `for await`: CSS's locking store returns a stream object derived from the real
    // one (it renews the read lock on every read), and that object does not iterate.
    const stored = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      existing.data.on('data', (chunk: Buffer | string) => {
        const part = Buffer.from(chunk);
        size += part.length;
        if (size > NATIVE_COMMIT_MAX_BYTES) existing.data.destroy(new HttpError(413, 'PayloadTooLargeHttpError', 'Stored representation exceeds the native limit'));
        else chunks.push(part);
      });
      existing.data.once('error', reject);
      existing.data.once('end', () => resolve(Buffer.concat(chunks)));
    });
    const revision = existing.metadata.get(toNamedTerm(NATIVE_REVISION_PREDICATE))?.value;
    const bare = (value: string | undefined): string | undefined => value?.split(';', 1)[0]?.trim().toLowerCase();
    if (!stored.equals(item.bytes) || bare(existing.metadata.contentType) !== bare(item.contentType) || !isNativeRevision(revision)) {
      throw new ConflictHttpError('A staged name already holds a different representation');
    }
    return { name: item.name, status: 'staged', created: false, revision, bodyDigest, contentType: item.contentType, size: stored.length };
  }
}
