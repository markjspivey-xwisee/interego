/** Optional composition of existing session signing and affordance following.
 * No caller-selected identity, target bypass, or domain-specific action dispatch. */
export async function signedActPayload(args: Record<string, unknown>, payload: unknown,
  sign: (args: Record<string, unknown>) => Promise<string>): Promise<unknown> {
  if (args.sign_payload !== true) return payload;
  if (!args.descriptor_url || !args.action_iri) throw new Error('sign_payload requires descriptor_url and action_iri');
  if (args.authorization) throw new Error('choose one authentication transport');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('signed payload must be a JSON object');
  if ('_signature' in payload || '_signed_payload' in payload) throw new Error('payload is already signed');
  // Forward only server-injected session plumbing. Transport selectors and
  // caller-injected identity/pod fields never become sign_request options.
  const session = Object.fromEntries(Object.entries(args).filter(([k]) => k.startsWith('_')));
  const envelope = JSON.parse(await sign({ ...session, payload }));
  if (typeof envelope._signature !== 'string' || typeof envelope._signed_payload !== 'string') throw new Error(envelope.error ?? 'bound identity signing failed');
  return { _signature: envelope._signature, _signed_payload: envelope._signed_payload };
}
