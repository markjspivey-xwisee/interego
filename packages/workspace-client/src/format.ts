/**
 * Shortening an identifier for display, in ONE place.
 *
 * ★ WHY THIS IS NOT A SHELL'S BUSINESS. A precondition may be asserted with a content CID or,
 * when the manifest reported none, with the prior entry's DESCRIPTOR URL. Abbreviating a URL
 * with a CID formatter — head + tail of the opaque string — presents one as the other, and a
 * reader deciding whether a compare-and-swap was asserted against a revision or against a
 * storage address cannot tell which they are looking at. So the two forms are shortened
 * DIFFERENTLY and the rule lives beside the code that decides which was sent, rather than
 * being re-derived in each shell.
 *
 * The published artifact and the desktop shell both wrap this to add their own placeholder for
 * "there was nothing to shorten"; what "none" should read as is presentation, and differs.
 */

/** A URL keeps its last path segment; anything else keeps its head and tail. */
export function shortRef(v: string): string {
  if (/^https?:\/\//.test(v)) {
    const t = v.split('/').filter(Boolean).pop();
    return '…/' + (t ?? v);
  }
  return v.slice(0, 10) + '…' + v.slice(-6);
}
