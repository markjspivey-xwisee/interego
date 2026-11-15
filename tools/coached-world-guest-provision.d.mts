// Declarations for a plain-ESM runner tool, so a test that imports it typechecks.

export declare const WORLD_ORIGIN: string;
export declare const IDENTITY_URL: string;
export declare const RETURN_PATH: string;
export declare const NAMESPACE: string;
export declare class ProvisionRefusal extends Error {}
/** identity's `isGuestReturnPath`, mirrored. */
export declare function isGuestReturnPath(value: unknown): boolean;
/** identity's `parsePlayClients` as a check: the parsed object, or a ProvisionRefusal where identity would not start. */
export declare function checkPlayClients(raw: string | undefined, what?: string): Record<string, unknown>;
/** identity's `parseDoorOrigin`, HTTPS only: the origin, or a ProvisionRefusal. */
export declare function checkDoorOrigin(value: unknown, issuer?: string): string;
/** The coached world's entry merged into the list already on identity; `value` is what the tool writes. */
export declare function mergePlayClients(existingRaw: string | undefined, service: { agentDid: string; podUrl: string; maxPods: number }):
  { value: string; origins: string[]; unchanged: boolean };
