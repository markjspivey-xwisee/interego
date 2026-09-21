/** Scope/owner binding around the bridge's existing signature+delegation verifier.
 * Caller pod stamps are accepted only as corroboration, never as destinations. */
export type PrivateAuthResult = { ok: true; callerDid: string; payload: Record<string, unknown> } | { ok: false; status: number; error: string };
export type VerifyPrivateCaller = (body: unknown, write: boolean) => Promise<PrivateAuthResult>;
export function makePrivatePerformanceVerifier(config: {
  recover: (body: unknown) => { ok: true; agentId: string; signer: string } | { ok: false; reason: string };
  verify: (body: unknown) => Promise<PrivateAuthResult>;
  ownPod: (identity: string) => string;
  samePod: (a: string | undefined, b: string) => boolean;
  credential: (pod: string, actor: string) => Promise<{ pod?: string; scope?: readonly string[] } | null>;
}): VerifyPrivateCaller {
  return async (body, write) => {
    const rec = config.recover(body);
    if (!rec.ok) return { ok: false, status: 401, error: `agent signature required: ${rec.reason}` };
    let pod: string;
    try { pod = config.ownPod(rec.agentId); }
    catch { return { ok: false, status: 403, error: 'Private performance requires a canonical own-pod identity on this deployment.' }; }
    const auth = await config.verify(body);
    if (!auth.ok) return auth;
    if (!config.samePod(config.ownPod(auth.callerDid), pod)) return { ok: false, status: 403, error: 'Verified actor does not own the selected account.' };
    const stamped = auth.payload.subject_pod_url;
    if (stamped !== undefined && (typeof stamped !== 'string' || !config.samePod(stamped, pod))) return { ok: false, status: 403, error: 'Signed pod stamp does not match the verified own pod; steering refused.' };
    // A did:ethr can itself be a delegated AGENT whose request is signed by a
    // different anchor key. Its namespace is not proof of direct ownership.
    // Only the canonical DID's exact address matching the recovered signature
    // proves the caller owns that key and may bypass delegated capability scope.
    const directAddress = /^did:ethr:(0x[0-9a-f]{40})$/i.exec(auth.callerDid)?.[1];
    if (directAddress && directAddress.toLowerCase() === rec.signer.toLowerCase()) return auth;
    const vc = await config.credential(pod, auth.callerDid);
    const scope = vc?.scope ?? [];
    if (!config.samePod(vc?.pod, pod) || !scope.includes('discover') || (write && !scope.includes('publish'))) return { ok: false, status: 403, error: 'Private performance requires own-pod discover scope and publish scope for writes (ordinary ReadWrite delegation).' };
    return auth;
  };
}
