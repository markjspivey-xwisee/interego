import { HttpHandler, type HttpHandlerInput } from '@solid/community-server';
import { NATIVE_COMMIT_MEDIA_TYPE } from './NativeCommit.js';

/** Public protocol discovery only; write authority remains with the existing CSS/gate authorization path. */
export class NativeCapabilityHeaders extends HttpHandler {
  async handle({ request, response }: HttpHandlerInput): Promise<void> {
    if (request.method === 'OPTIONS') {
      response.setHeader('Accept-Put', NATIVE_COMMIT_MEDIA_TYPE);
      response.setHeader('Interego-Native-Commit', '1');
    }
  }
}
