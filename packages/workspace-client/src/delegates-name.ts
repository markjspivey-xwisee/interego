/**
 * NAMING A DELEGATE.
 *
 * Split out of `delegates.ts` for one small reason with a real consequence: the check below is
 * about CONTROL CHARACTERS, and a regex character class written with literal ones turns this
 * source file into bytes an editor reports as binary. Code points are compared numerically
 * instead, so the rule is readable and the file stays text.
 */

/** How long a delegate's name may be. Long enough to be descriptive, short enough to render. */
export const DELEGATE_NAME_MAX = 48;

/**
 * The label a delegator writes on the row, and the only place a delegate's NAME lives.
 *
 * ★ ONE FORMAT SITE, for the reason `challengeLabel` states about the Discord one: the string a
 * client writes and the string another client parses must be one string. And it is deliberately
 * a DIFFERENT prefix from `discord-link`, because the two rows mean different things — one
 * authorises a conduit to relay a person's own words, the other authorises an author.
 *
 * Not a secret. Delegation rows are world-readable, measured. The name is a label a person chose
 * so they can tell their own delegates apart; there is nothing in it to steal.
 */
export const DELEGATE_LABEL_PREFIX = 'workspace-delegate ';
export const delegateLabel = (name: string): string => DELEGATE_LABEL_PREFIX + name;

/** The name inside a delegate label, or null when the row is not a delegate row at all. */
export function parseDelegateLabel(label: string | null | undefined): string | null {
  if (typeof label !== 'string' || label.indexOf(DELEGATE_LABEL_PREFIX) !== 0) return null;
  const name = label.slice(DELEGATE_LABEL_PREFIX.length).trim();
  return name === '' ? null : name;
}

/**
 * Why a name is refused, or null.
 *
 * The name is interpolated into a `label` argument and later rendered beside an author, so the
 * characters that would break either — newlines, control characters — are refused rather than
 * stripped. A silently stripped name is not the name the delegator chose, and a delegate the
 * person cannot recognise in the roster is a delegate they will not think to revoke.
 */
export function delegateNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give this delegate a name. It is how you and everybody reading the channel tell it apart from your other delegates and from you.';
  if (n.length > DELEGATE_NAME_MAX) return 'That name is ' + n.length + ' characters; the limit is ' + DELEGATE_NAME_MAX + '.';
  for (const ch of n) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) {
      return 'That name contains a control character (code point ' + c + '). It is refused rather than stripped, '
        + 'because a stripped name is not the name you chose.';
    }
  }
  const bare = DELEGATE_LABEL_PREFIX.trim();
  if (n.indexOf(bare) === 0) {
    return 'That name starts with "' + bare + '", which is the prefix this client already adds. The row would read '
      + 'back as a delegate called "' + n.slice(bare.length).trim() + '".';
  }
  return null;
}
