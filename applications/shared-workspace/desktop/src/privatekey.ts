/**
 * What a pasted private key is, and — when it is not one — exactly what is wrong with it.
 *
 * ★ WHY THIS IS A MODULE AND NOT A REGEX AT EACH CALL SITE. Two places in this app take a key a
 * person typed or pasted: adopting a DELEGATE minted elsewhere, and signing in as an ACCOUNT whose
 * pod already exists. Both had — or would have had — their own `/^0x[0-9a-fA-F]{64}$/` and their
 * own sentence, and two copies of one intention is the origin of every drift defect in this
 * vertical. It lives here so both use the same one, and so the RENDERER can refuse before the
 * key crosses an IPC boundary while the MAIN process still refuses independently. The renderer's
 * check is a courtesy; the main process's is the guard, and neither trusts the other.
 *
 * ★ AND WHY IT IS IN THE DESKTOP PACKAGE RATHER THAN IN `@interego/workspace-client`. The shared
 * package is bundled verbatim into the published artifact, which has no key input at all — it
 * reaches the substrate through a connector and never holds one. Putting a private-key parser in
 * there would ship it to a surface that must never have one, for the same reason `discordLinkPlan`
 * lives in the Discord conduit rather than in the shared client. Both callers here are in THIS
 * package, so one copy here is one copy everywhere it is used.
 *
 * ★ "INVALID KEY" IS NOT AN ANSWER. Somebody pasting a key has made one of a small number of
 * specific mistakes — they grabbed the address instead, the copy was truncated, a line break came
 * along with it — and each has a different fix. A single refusal string tells them none of them,
 * so they retry the same paste. Every branch below names the actual defect and, where the defect
 * is a recognisable OTHER thing, says what they pasted instead.
 *
 * Nothing here logs, and nothing here returns the key inside a message: a diagnostic that echoes
 * the input would put the secret in whatever renders the diagnostic.
 */

/**
 * The order of the secp256k1 group.
 *
 * A private key is a scalar in [1, n-1]. Outside that range the point multiplication that derives
 * the public key is undefined (0) or a duplicate of `k mod n` (>= n), so such a value is not a key
 * even though it is 32 well-formed bytes — which is exactly the case a length-and-hex regex passes
 * and a wallet library then throws about in its own words.
 */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export type PrivateKeyCheck =
  /** `key` is 0x-prefixed, lower-case, 64 hex digits, and in range. `normalised` records whether the input needed fixing up. */
  | { readonly ok: true; readonly key: string; readonly normalised: boolean }
  | { readonly ok: false; readonly why: string };

/** How many hex digits a 32-byte scalar is written in. Named so the message below cannot drift from the check. */
const HEX_DIGITS = 64;

/**
 * Read a pasted string as a secp256k1 private key, or say precisely why it is not one.
 *
 * ★ SURROUNDING WHITESPACE IS TRIMMED AND A MISSING `0x` IS ACCEPTED, because both are how the
 * thing actually arrives — out of a JSON file, out of a terminal, out of a password manager — and
 * neither changes which key it is. Whitespace INSIDE is not accepted: a key with a newline through
 * the middle of it is a truncated copy far more often than it is a formatting quirk, and silently
 * splicing it back together would sign in as a key the person did not think they had.
 */
export function checkPrivateKey(raw: string): PrivateKeyCheck {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    return { ok: false, why: 'Nothing was pasted. A private key is 64 hexadecimal characters, usually written with a 0x in front.' };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, why: 'That has a space or a line break inside it. A private key is one unbroken run of 64 hexadecimal '
      + 'characters — this is almost always a copy that picked up a wrap, so copy it again rather than deleting the break, in '
      + 'case what came across is also short.' };
  }
  const prefixed = /^0x/i.test(trimmed);
  const body = prefixed ? trimmed.slice(2) : trimmed;
  const badAt = body.search(/[^0-9a-fA-F]/);
  if (badAt >= 0) {
    // The offending CHARACTER is named, and nothing around it: quoting the surrounding text would
    // print part of a secret into whatever draws this.
    return { ok: false, why: 'That contains "' + body[badAt] + '" at character ' + (badAt + 1 + (prefixed ? 2 : 0))
      + ', which is not a hexadecimal digit. A private key uses only 0-9 and a-f.' };
  }
  if (body.length === 40) {
    // ★ A REAL AND COMMON PASTE, AND IT DESERVES ITS OWN SENTENCE. An address is the PUBLIC half.
    // Telling somebody who pasted one that their key is "invalid" sends them looking for a better
    // copy of a thing that could never work.
    return { ok: false, why: 'That is 40 hexadecimal characters, which is the length of an Ethereum ADDRESS, not a private key. '
      + 'An address is the public half of the pair — it names the account but cannot sign for it. The private key is the longer '
      + 'one, 64 characters.' };
  }
  if (body.length !== HEX_DIGITS) {
    return { ok: false, why: 'That is ' + body.length + ' hexadecimal characters' + (prefixed ? ' after the 0x' : '')
      + '. A private key is exactly ' + HEX_DIGITS + ' (32 bytes)'
      + (body.length < HEX_DIGITS ? ', so this copy is short — check that the whole thing came across.' : ', so this copy has more than one key\'s worth in it.') };
  }
  const value = BigInt('0x' + body);
  if (value === 0n) {
    return { ok: false, why: 'That is 64 hexadecimal characters and all of them are zero. Zero is not a usable secp256k1 key: '
      + 'the scalar has to be at least 1, and a file full of zeros is usually a key that was never written.' };
  }
  if (value >= SECP256K1_N) {
    // 64 valid hex digits and still not a key — the one failure a length-and-hex regex waves through.
    return { ok: false, why: 'That is 64 hexadecimal characters but the number they spell is at or above the secp256k1 group '
      + 'order, so it is not a valid key on this curve. Every real key is below '
      + '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141. This is not a truncation — it is a value that '
      + 'looks like a key and is not one.' };
  }
  const key = '0x' + body.toLowerCase();
  return { ok: true, key, normalised: key !== trimmed };
}
