/** Encrypted, request-bound transport between the app and its local companions. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { AgentEndpoint, AgentTicket } from './agent-types.js';

export const MAX_AGENT_REQUEST_BYTES = 512 * 1024;
export const MAX_AGENT_RESPONSE_BYTES = 2 * 1024 * 1024;
export const AGENT_REQUEST_WINDOW_MS = 60_000;
export const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type AgentDirection = 'request' | 'response';
export interface AgentEnvelope {
  readonly version: 1;
  readonly connectionId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

function base64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > MAX_AGENT_RESPONSE_BYTES) throw new Error('Invalid encrypted agent message.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) throw new Error('Invalid encrypted agent message.');
  return bytes;
}

function context(ticket: AgentTicket, endpoint: AgentEndpoint, requestId: string, direction: AgentDirection) {
  if (ticket.version !== 1 || endpoint.version !== 1 || !AGENT_ID_PATTERN.test(ticket.connectionId)
    || !AGENT_ID_PATTERN.test(endpoint.sessionId) || !AGENT_ID_PATTERN.test(requestId)
    || !['request', 'response'].includes(direction)) throw new Error('Invalid encrypted agent context.');
  const secret = base64(ticket.secret, 32);
  try {
    return {
      key: Buffer.from(hkdfSync('sha256', secret, endpoint.sessionId, `interego.local-agent/v1:${direction}`, 32)),
      aad: Buffer.from(JSON.stringify(['interego.local-agent/v1', direction, ticket.connectionId, endpoint.sessionId, requestId])),
    };
  } finally { secret.fill(0); }
}

export function sealAgentMessage(ticket: AgentTicket, endpoint: AgentEndpoint, requestId: string, direction: AgentDirection, value: unknown): AgentEnvelope {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > 1024 * 1024) throw new Error('The agent result is too large. Narrow the request.');
  const { key, aad } = context(ticket, endpoint, requestId, direction);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return { version: 1, connectionId: ticket.connectionId, sessionId: endpoint.sessionId, requestId,
      nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  } finally { key.fill(0); }
}

export function openAgentMessage(ticket: AgentTicket, endpoint: AgentEndpoint, envelope: unknown, direction: AgentDirection): unknown {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Invalid encrypted agent message.');
  const record = envelope as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'ciphertext,connectionId,nonce,requestId,sessionId,tag,version'
    || record['version'] !== 1 || record['connectionId'] !== ticket.connectionId || record['sessionId'] !== endpoint.sessionId
    || typeof record['requestId'] !== 'string') throw new Error('Invalid encrypted agent message.');
  const { key, aad } = context(ticket, endpoint, record['requestId'], direction);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, base64(record['nonce'], 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(base64(record['tag'], 16));
    const plaintext = Buffer.concat([decipher.update(base64(record['ciphertext'])), decipher.final()]);
    if (plaintext.length > 1024 * 1024) throw new Error('Invalid encrypted agent message.');
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } finally { key.fill(0); }
}
