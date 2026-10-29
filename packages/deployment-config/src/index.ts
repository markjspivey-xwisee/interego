import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

export { resolveStdioConfig } from './stdio.js';
export type { StdioConfig } from './stdio.js';

export type DeploymentProfile = 'local' | 'hosted';

export interface FederationInput {
  readonly enabled?: boolean;
  readonly knownPods?: readonly string[];
  readonly directoryUrl?: string;
  readonly externalRelays?: readonly string[];
  readonly inboundAuthors?: readonly string[];
}

export interface FederationConfig {
  readonly enabled: boolean;
  readonly knownPods: readonly string[];
  readonly directoryUrl?: string;
  readonly externalRelays: readonly string[];
  readonly inboundAuthors: readonly string[];
}

export interface LocalDeploymentInput {
  readonly profile: 'local';
  readonly dataDir: string;
  readonly baseUrl?: string;
  readonly podName?: string;
  readonly federation?: FederationInput;
}

export interface HostedDeploymentInput {
  readonly profile: 'hosted';
  readonly baseUrl: string;
  readonly podName?: string;
  readonly podUrl?: string;
  readonly relayUrl?: string;
  readonly identityUrl?: string;
  readonly ipfsProvider?: 'local-unpinned' | 'pinata' | 'web3storage';
  readonly federation?: FederationInput;
}

export type DeploymentConfigInput = LocalDeploymentInput | HostedDeploymentInput;

interface DeploymentConfigBase {
  readonly baseUrl: string;
  readonly podName: string;
  readonly podUrl: string;
  /** Credential/cache scope only: not a DID, signing identity or migration proof. */
  readonly instanceId: string;
  readonly federation: FederationConfig;
}

export interface LocalDeploymentConfig extends DeploymentConfigBase {
  readonly profile: 'local';
  readonly dataDir: string;
  readonly ipfsProvider: 'local-unpinned';
  readonly identityUrl: null;
  readonly relayUrl: null;
}

export interface HostedDeploymentConfig extends DeploymentConfigBase {
  readonly profile: 'hosted';
  readonly ipfsProvider: 'local-unpinned' | 'pinata' | 'web3storage';
  readonly identityUrl: string | null;
  readonly relayUrl: string | null;
}

export type DeploymentConfig = LocalDeploymentConfig | HostedDeploymentConfig;

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${name}.${key} is not supported`);
  }
}

function nonemptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a nonempty string without surrounding whitespace or control characters`);
  }
  return value;
}

function endpoint(value: unknown, name: string, protocols: readonly string[]): URL {
  const raw = nonemptyString(value, name);
  let url: URL;
  try { url = new URL(raw); } catch { throw new TypeError(`${name} must be an absolute URL`); }
  if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || raw.includes('?') || raw.includes('#') || raw.includes('\\')) {
    throw new TypeError(`${name} must use ${protocols.join(' or ')} without credentials, query or fragment`);
  }
  if (url.port === '0') throw new TypeError(`${name} must use a fixed nonzero port`);
  return url;
}

function directoryEndpoint(value: unknown, name: string): string {
  const url = endpoint(value, name, ['http:', 'https:']);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

function localBaseUrl(value: unknown): string {
  const url = endpoint(value, 'baseUrl', ['http:']);
  if (!isLoopback(url) || url.pathname !== '/') {
    throw new TypeError('local baseUrl must be an HTTP loopback origin (localhost, 127.0.0.1 or [::1]) with no path');
  }
  return url.href;
}

function absoluteDataDir(value: unknown): string {
  const raw = nonemptyString(value, 'dataDir');
  // Parse both supported path styles without consulting the host OS or current directory.
  // Drive-relative, root-relative Windows, file URLs and network shares are not local roots.
  if (/^[a-z]:[\\/]/iu.test(raw)) {
    if (/[<>"|?*]/u.test(raw.slice(2)) || raw.slice(2).includes(':')) {
      throw new TypeError('dataDir contains invalid Windows path characters');
    }
    const normalized = win32.normalize(raw);
    if (normalized === win32.parse(normalized).root) throw new TypeError('dataDir must be a dedicated directory, not a filesystem root');
    return normalized.replace(/[\\/]+$/u, '');
  }
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    const normalized = posix.normalize(raw);
    if (normalized === '/') throw new TypeError('dataDir must be a dedicated directory, not a filesystem root');
    return normalized.replace(/\/+$/u, '');
  }
  throw new TypeError('dataDir must be an absolute local directory path');
}

function stringArray(value: unknown, name: string, transform: (v: unknown, n: string) => string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return Object.freeze([...new Set(value.map((item, index) => transform(item, `${name}[${index}]`)))]);
}

function resolveFederation(value: unknown, profile: DeploymentProfile): FederationConfig {
  const input = value === undefined ? {} : record(value, 'federation');
  knownKeys(input, ['enabled', 'knownPods', 'directoryUrl', 'externalRelays', 'inboundAuthors'], 'federation');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new TypeError('federation.enabled must be boolean');
  const enabled = input.enabled === undefined ? profile === 'hosted' : input.enabled;
  const knownPods = stringArray(input.knownPods, 'federation.knownPods', directoryEndpoint);
  const externalRelays = stringArray(input.externalRelays, 'federation.externalRelays', (v, n) => endpoint(v, n, ['ws:', 'wss:']).href);
  const inboundAuthors = stringArray(input.inboundAuthors, 'federation.inboundAuthors', nonemptyString);
  const directoryUrl = input.directoryUrl === undefined ? undefined : endpoint(input.directoryUrl, 'federation.directoryUrl', ['http:', 'https:']).href;
  if (!enabled && (knownPods.length > 0 || externalRelays.length > 0 || inboundAuthors.length > 0 || directoryUrl !== undefined)) {
    throw new TypeError('federation must be enabled before configuring peers, a directory or external relays');
  }
  return Object.freeze({ enabled, knownPods, externalRelays, inboundAuthors, ...(directoryUrl === undefined ? {} : { directoryUrl }) });
}

function instanceId(profile: DeploymentProfile, parts: readonly string[]): string {
  return `${profile}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`;
}

/** Resolve explicit inputs only. Validation does not create directories, start services or permit egress. */
export function resolveDeploymentConfig(input: LocalDeploymentInput): LocalDeploymentConfig;
export function resolveDeploymentConfig(input: HostedDeploymentInput): HostedDeploymentConfig;
export function resolveDeploymentConfig(input: DeploymentConfigInput): DeploymentConfig;
export function resolveDeploymentConfig(input: DeploymentConfigInput): DeploymentConfig {
  const value = record(input, 'deployment');
  if (value.profile !== 'local' && value.profile !== 'hosted') throw new TypeError('profile must be local or hosted');
  const profile = value.profile;
  knownKeys(value, profile === 'local'
    ? ['profile', 'dataDir', 'baseUrl', 'podName', 'federation']
    : ['profile', 'baseUrl', 'podName', 'podUrl', 'relayUrl', 'identityUrl', 'ipfsProvider', 'federation'], 'deployment');
  const podName = value.podName === undefined ? 'agent' : nonemptyString(value.podName, 'podName');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(podName) || podName === '.' || podName === '..') {
    throw new TypeError('podName must be a single URL-safe path segment');
  }
  const federation = resolveFederation(value.federation, profile);
  if (profile === 'local') {
    const dataDir = absoluteDataDir(value.dataDir);
    const baseUrl = localBaseUrl(value.baseUrl === undefined ? 'http://127.0.0.1:3456/' : value.baseUrl);
    return Object.freeze({ profile, dataDir, baseUrl, podName, podUrl: new URL(`${podName}/`, baseUrl).href,
      instanceId: instanceId(profile, [dataDir]), federation, ipfsProvider: 'local-unpinned', identityUrl: null, relayUrl: null });
  }
  const baseUrl = directoryEndpoint(value.baseUrl, 'baseUrl');
  const podUrl = value.podUrl === undefined ? new URL(`${podName}/`, baseUrl).href : directoryEndpoint(value.podUrl, 'podUrl');
  const relayUrl = value.relayUrl === undefined ? null : directoryEndpoint(value.relayUrl, 'relayUrl');
  const identityUrl = value.identityUrl === undefined ? null : directoryEndpoint(value.identityUrl, 'identityUrl');
  const ipfsProvider = value.ipfsProvider === undefined ? 'local-unpinned' : value.ipfsProvider;
  if (ipfsProvider !== 'local-unpinned' && ipfsProvider !== 'pinata' && ipfsProvider !== 'web3storage') throw new TypeError('ipfsProvider must be local-unpinned, pinata or web3storage');
  return Object.freeze({ profile, baseUrl, podName, podUrl, relayUrl, identityUrl, ipfsProvider, federation,
    instanceId: instanceId(profile, [podUrl, relayUrl ?? '', identityUrl ?? '']) });
}

export type CapabilitySurface = DeploymentProfile | 'personal-bridge';
export type CapabilitySupport = 'available' | 'requires-configuration' | 'not-included' | 'not-guaranteed';
export type DeploymentCapabilityId = 'solid-pod-storage' | 'encrypted-graph-payloads' | 'local-key-custody' | 'mcp-tools'
  | 'hosted-oauth' | 'solid-notifications' | 'cross-pod-federation' | 'encrypted-relay-sharing' | 'durable-offline-delivery';
export interface DeploymentCapability {
  readonly id: DeploymentCapabilityId;
  readonly support: CapabilitySupport;
  readonly detail: string;
}

function capability(id: DeploymentCapabilityId, support: CapabilitySupport, detail: string): DeploymentCapability {
  return Object.freeze({ id, support, detail });
}

/** Implemented surfaces, not promises of parity. Selecting config does not install capabilities. */
export const CAPABILITY_MATRIX: Readonly<Record<CapabilitySurface, readonly DeploymentCapability[]>> = Object.freeze({
  local: Object.freeze([
    capability('solid-pod-storage', 'available', 'The local node provides persistent Solid HTTP storage behind a local authenticated gateway.'),
    capability('encrypted-graph-payloads', 'available', 'Existing Solid clients encrypt graph payloads; descriptor metadata remains readable to authorized local clients.'),
    capability('local-key-custody', 'available', 'Local clients can retain signing and decryption keys on the machine; the node does not provision an owner identity.'),
    capability('mcp-tools', 'not-included', 'The local node is a Solid service; the separate stdio MCP server supplies its own tool surface.'),
    capability('hosted-oauth', 'not-included', 'No hosted sign-in, account provisioning or OAuth service is bundled.'),
    capability('solid-notifications', 'not-included', 'This local runtime does not expose a notification WebSocket gateway.'),
    capability('cross-pod-federation', 'not-included', 'Federation configuration is reserved for a separately enabled transport; the local runtime does not launch one.'),
    capability('encrypted-relay-sharing', 'not-included', 'The P2P relay bridge remains a separate composition.'),
    capability('durable-offline-delivery', 'not-guaranteed', 'Local persistence is not an outbound delivery queue.'),
  ]),
  hosted: Object.freeze([
    capability('solid-pod-storage', 'available', 'The hosted deployment supplies its configured pod storage.'),
    capability('encrypted-graph-payloads', 'available', 'Graph payload encryption is supported; descriptor metadata may remain discoverable and hosted agents may hold decryption keys.'),
    capability('local-key-custody', 'not-included', 'Hosted agent key custody is distinct from device-only ownership.'),
    capability('mcp-tools', 'available', 'The hosted relay exposes its MCP tool surface, a superset of stdio MCP.'),
    capability('hosted-oauth', 'available', 'The existing hosted identity and OAuth services authenticate remote clients.'),
    capability('solid-notifications', 'available', 'Configured hosted pods support their existing notification transport.'),
    capability('cross-pod-federation', 'requires-configuration', 'Pod discovery and encrypted sharing require reachable peers; notify_agent currently delivers only within its deployment.'),
    capability('encrypted-relay-sharing', 'not-included', 'The personal P2P bridge is a separate deployment.'),
    capability('durable-offline-delivery', 'not-guaranteed', 'Cross-domain recipient delivery is not guaranteed by a federation registry entry.'),
  ]),
  'personal-bridge': Object.freeze([
    capability('solid-pod-storage', 'not-included', 'The bridge persists relay events and does not embed a Solid pod.'),
    capability('encrypted-graph-payloads', 'not-included', 'Encrypted P2P shares are distinct from the Solid graph-storage surface.'),
    capability('local-key-custody', 'requires-configuration', 'A private bridge key must replace the example public test key.'),
    capability('mcp-tools', 'available', 'The bridge exposes six core P2P tools, not the full hosted tool surface.'),
    capability('hosted-oauth', 'not-included', 'The bridge uses its own local or bearer-token trust boundary.'),
    capability('solid-notifications', 'not-included', 'Its event feed is not a Solid notification service.'),
    capability('cross-pod-federation', 'not-included', 'Solid discovery/sharing is provided by a separate Solid composition.'),
    capability('encrypted-relay-sharing', 'requires-configuration', 'Selected common relays, peer authors and recipient keys enable encrypted shares; recipient tags and topics remain visible.'),
    capability('durable-offline-delivery', 'not-guaranteed', 'The mirror skips disconnected outbound sockets and does not provide a durable outbox.'),
  ]),
});

export function capabilitiesFor(profile: CapabilitySurface): readonly DeploymentCapability[] {
  if (!Object.hasOwn(CAPABILITY_MATRIX, profile)) throw new TypeError('unknown capability surface');
  return CAPABILITY_MATRIX[profile];
}
