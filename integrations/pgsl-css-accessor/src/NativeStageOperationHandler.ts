import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BadRequestHttpError, BasicConditions, BasicRepresentation, ConflictHttpError, HttpError, InternalServerError,
  OkResponseDescription, PostOperationHandler, PreconditionFailedHttpError, RepresentationMetadata, guardStream, parseContentType, toNamedTerm,
  type ETagHandler, type OperationHandlerInput, type ResourceIdentifier, type ResourceStore, type ResponseDescription,
} from '@solid/community-server';
import {
  NATIVE_COMMIT_MAX_BYTES, NATIVE_COMMIT_MEDIA_TYPE, NATIVE_REVISION_PREDICATE, isNativeRevision, nativeCommitScope,
  type NativeCommitScope,
} from './NativeCommit.js';
import type { PgslDataAccessorFactory } from './PgslDataAccessorFactory.js';
import { isNativeStageMediaType, readNativeStageCommand, type NativeStageItem, type NativeStageReceipt } from './NativeStage.js';

/**
 * Stages several immutable, content-named representations into one container in a single request.
 *
 * Every item is created if its name is absent, or confirmed if the name already holds the identical
 * representation (read back and compared), and is answered with a receipt bound to the digest of
 * its bytes. The whole batch is ONE storage transaction followed by one refresh of the container:
 * a name that holds anything else refuses the request, and a refused request stages nothing.
 *
 * The batch goes to the storage accessor directly rather than through one ResourceStore write per
 * item. The request was authorized as an append to the container, exactly as before; what it does
 * not do is take a per-document lock or emit a change notification for each staged name. Neither
 * is needed for these: a staged name is immutable and content-addressed, creation is a
 * compare-and-set inside the transaction, and a later reader observes it or not, atomically.
 * A container that does not exist yet is first created by staging one item the ordinary way.
 */
export class NativeStageOperationHandler extends PostOperationHandler {
  private readonly stageStore: ResourceStore;
  private readonly eTagHandler: ETagHandler;
  private readonly accessor: PgslDataAccessorFactory;

  constructor(store: ResourceStore, eTagHandler: ETagHandler, accessor: PgslDataAccessorFactory) {
    super(store);
    this.stageStore = store;
    this.eTagHandler = eTagHandler;
    this.accessor = accessor;
  }

  override async handle(input: OperationHandlerInput): Promise<ResponseDescription> {
    const { operation } = input;
    if (!isNativeStageMediaType(operation.body.metadata.contentType)) return super.handle(input);
    if (!operation.target.path.endsWith('/')) throw new BadRequestHttpError('Native staging targets a container');
    const items = await readNativeStageCommand(operation.body.data);
    const started = performance.now();
    const receipts: NativeStageReceipt[] = [];
    let rest = items;
    if (!await this.stageStore.hasResource(operation.target)) {
      // The ordinary write creates the container (and any missing ancestors) with CSS's own rules.
      receipts.push(await this.stage({ path: operation.target.path + items[0]!.name }, items[0]!));
      rest = items.slice(1);
    }
    const prepared = performance.now();
    let engineMs = 0;
    let containerMs = 0;
    if (rest.length > 0) {
      const outcome = await this.accessor.stageDocuments(operation.target, rest);
      if (!outcome) throw new ConflictHttpError('A staged name already holds a different representation');
      ({ engineMs, containerMs } = outcome);
      rest.forEach((item, index) => {
        const receipt = outcome.receipts[index]!;
        const bodyDigest = `sha256:${createHash('sha256').update(item.bytes).digest('hex')}`;
        if (receipt.bodyDigest !== bodyDigest || receipt.size !== item.bytes.length || !isNativeRevision(receipt.revision)) {
          throw new InternalServerError('Native stage receipt is unavailable');
        }
        receipts.push({ name: item.name, status: 'staged', created: receipt.created, revision: receipt.revision,
          bodyDigest, contentType: receipt.contentType, size: receipt.size });
      });
    }
    // Numbers only: where the time of one staging request went, on the server that spent it.
    process.stderr.write(`[pgsl-css] native-stage ${JSON.stringify({
      items: items.length, bytes: items.reduce((sum, item) => sum + item.bytes.length, 0),
      created: receipts.filter(receipt => receipt.created).length, ordinary: items.length - rest.length,
      prepareMs: Math.round(prepared - started), engineMs: Math.round(engineMs), containerMs: Math.round(containerMs),
      totalMs: Math.round(performance.now() - started),
    })}\n`);
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
    // The whole media type, parameters included: the same bytes under another charset are another
    // representation. Both sides go through CSS's parser, as the stored one did when it was read.
    const full = (value: string): string => { try { return parseContentType(value).toHeaderValueString(); } catch { return value.trim(); } };
    const storedType = existing.metadata.contentTypeObject?.toHeaderValueString() ?? existing.metadata.contentType;
    if (!stored.equals(item.bytes) || storedType === undefined || storedType !== full(item.contentType) || !isNativeRevision(revision)) {
      throw new ConflictHttpError('A staged name already holds a different representation');
    }
    return { name: item.name, status: 'staged', created: false, revision, bodyDigest, contentType: item.contentType, size: stored.length };
  }
}
