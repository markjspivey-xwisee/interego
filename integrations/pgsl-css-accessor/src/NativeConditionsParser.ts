import {
  BadRequestHttpError, BasicConditionsParser, type Conditions, type ETagHandler, type HttpRequest,
} from '@solid/community-server';

export interface NativeDeleteConditions extends Conditions { nativeDelete?: true; }

/** Retains the explicit native-delete opt-in while using CSS's normal condition parser. */
export class NativeConditionsParser extends BasicConditionsParser {
  constructor(eTagHandler: ETagHandler) { super(eTagHandler); }

  override async handle(request: HttpRequest): Promise<Conditions | undefined> {
    const conditions = await super.handle(request) as NativeDeleteConditions | undefined;
    if (request.method === 'DELETE' && request.headers['interego-native-delete'] === '1') {
      if (!conditions) throw new BadRequestHttpError('Native delete requires If-Match');
      conditions.nativeDelete = true;
    }
    return conditions;
  }
}
