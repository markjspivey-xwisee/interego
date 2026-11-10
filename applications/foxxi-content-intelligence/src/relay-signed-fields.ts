/**
 * The fields of a signed request that the signer sets, not the caller, set aside before the rest
 * reaches a closed schema.
 *
 * A request the relay signs for a delegated agent (`sign_request`) carries `agent_id` and
 * `timestamp`, which the signature binder requires, `subject_pod_url`, which the relay stamps, and,
 * once the relay's operator has turned it on, `client_id`: the OAuth client the relay's session
 * token was issued to. None of them is an option the caller chose. A route that passes "everything
 * else" to a validator that refuses unknown keys (the telemetry capture settings and the telemetry
 * query) has to set all four aside first, or it refuses every relay-signed request the moment the
 * relay adds one more field of its own.
 */
export const RELAY_SIGNED_FIELDS: readonly string[] = ['agent_id', 'timestamp', 'subject_pod_url', 'client_id'];

/** A copy of a verified signed payload without the signer's own fields; the caller's options are left. */
export function withoutRelaySignedFields(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !RELAY_SIGNED_FIELDS.includes(key)));
}
