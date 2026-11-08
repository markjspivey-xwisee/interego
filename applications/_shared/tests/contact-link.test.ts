/**
 * The operator's "Contact" link, as both vertical sites check it before it reaches an href: an
 * https page with no credentials and no `@`, or a mailto: link to exactly one address and nothing
 * after it. Everything else is refused, so the sites keep their default link.
 *
 * Addresses here are example.org placeholders only.
 */
import { describe, it, expect } from 'vitest';
import { CONTACT_RAW_MAX, contactForLog, contactHrefOf } from '../contact-link/index.js';

describe('contactHrefOf', () => {
  it('accepts an https page with no credentials and no @, as the URL parser normalises it', () => {
    const accepted: ReadonlyArray<readonly [string, string]> = [
      ['https://example.org/book', 'https://example.org/book'],
      ['https://example.org', 'https://example.org/'],
      ['HTTPS://Example.ORG/Contact?from=pev#top', 'https://example.org/Contact?from=pev#top'],
      ['  https://example.org/book \n', 'https://example.org/book'],
      ['https://example.org/a"b<c>', 'https://example.org/a%22b%3Cc%3E'],
    ];
    for (const [raw, href] of accepted) expect([raw, contactHrefOf(raw)]).toEqual([raw, href]);
  });

  it('accepts a mailto: link to one address in any case, rebuilt with the domain lower-cased', () => {
    const accepted: ReadonlyArray<readonly [string, string]> = [
      ['mailto:operator@example.org', 'mailto:operator@example.org'],
      ['MAILTO:Operator@Example.ORG', 'mailto:Operator@example.org'],
      ['MailTo:first.last+pev@mail.example.org', 'mailto:first.last+pev@mail.example.org'],
      ['  mailto:operator@example.org\t', 'mailto:operator@example.org'],
      ['mailto:a_b-c@sub-domain.example.co', 'mailto:a_b-c@sub-domain.example.co'],
    ];
    for (const [raw, href] of accepted) expect([raw, contactHrefOf(raw)]).toEqual([raw, href]);
  });

  it('refuses every other scheme, credentials, an @ in an https page, and a mailto: with anything but one address', () => {
    const refused: readonly string[] = [
      // Other schemes and non-URLs.
      'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'data:text/html;base64,PHA+eDwvcD4=', 'http://example.org/contact',
      'ftp://example.org/', 'vbscript:x', 'file:///etc/passwd', '/ui/help#contact', 'example.org/book', 'not a url', '', '   ',
      // An https page with credentials, or an @ anywhere in it.
      'https://user:pass@example.org/', 'https://user@example.org/', 'https://example.org/team/@operator', 'https://example.org/?to=operator@example.org',
      // A mailto: with headers, a fragment, an escape, a second address, spaces, or not exactly one address.
      'mailto:', 'mailto:operator', 'mailto:@example.org', 'mailto:operator@', 'mailto:operator@example', 'mailto:operator@example.',
      'mailto:operator@.example.org', 'mailto:operator@example..org',
      'mailto:operator@example.org?subject=x', 'mailto:operator@example.org?cc=other@example.org', 'mailto:operator@example.org#x',
      'mailto:operator@example.org%0Abcc:other@example.org', 'mailto:operator%40example.org', 'mailto:operator@example.org,other@example.org',
      'mailto:operator@example.org other@example.org', 'mailto: operator@example.org', 'mailto:operator @example.org', 'mailto:operator@exa mple.org',
      'mailto:operator@@example.org', 'mailto:a@b@example.org', 'mailto://operator@example.org', 'mailto:operator@example.org/',
      'mailto:"op erator"@example.org', 'mailto:opérateur@example.org', 'mailto:operator@exämple.org', 'mailto:operator@example.org\nbcc:x@example.org',
      // Too long: a local part over 64, a label over 63, an address over 254, a value over the cap.
      `mailto:${'a'.repeat(65)}@example.org`, `mailto:operator@${'b'.repeat(64)}.org`,
      `mailto:${'a'.repeat(64)}@${Array.from({ length: 4 }, () => 'c'.repeat(60)).join('.')}.org`,
      `https://example.org/${'x'.repeat(CONTACT_RAW_MAX)}`,
    ];
    for (const raw of refused) expect([raw, contactHrefOf(raw)]).toEqual([raw, null]);
  });

  it('takes a mailto: address up to 254 characters and an https value up to the cap', () => {
    const domain = `${Array.from({ length: 3 }, () => 'c'.repeat(60)).join('.')}.example.org`;
    const local = 'a'.repeat(254 - 1 - domain.length);
    expect(local.length).toBeLessThanOrEqual(64);
    expect(contactHrefOf(`mailto:${local}@${domain}`)).toBe(`mailto:${local}@${domain}`);
    expect(contactHrefOf(`mailto:${local}a@${domain}`)).toBeNull();
    const page = `https://example.org/${'x'.repeat(CONTACT_RAW_MAX - 'https://example.org/'.length)}`;
    expect(page.length).toBe(CONTACT_RAW_MAX);
    expect(contactHrefOf(page)).toBe(page);
  });

  it('names a value in a startup line without printing an email address', () => {
    expect(contactForLog('https://example.org/book')).toBe('https://example.org/book');
    const mailto = contactForLog('MAILTO:Operator@Example.ORG');
    expect(mailto).toBe('a mailto: link to one address at example.org (the address itself is not printed)');
    expect(mailto).not.toContain('Operator');
    for (const raw of ['mailto:operator@example.org?subject=x', 'https://user@example.org/', 'operator@example.org', 'mailto:operator%40example.org']) {
      expect([raw, contactForLog(raw)]).toEqual([raw, 'a value with an @ in it (not printed)']);
    }
    expect(contactForLog('javascript:alert(1)')).toBe('"javascript:alert(1)"');
    expect(contactForLog(`http://example.org/${'x'.repeat(200)}`)).toHaveLength(122);
    const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    for (const raw of ['mailto:operator@example.org', 'mailto:operator@example.org,other@example.org', ' operator@example.org ']) expect(contactForLog(raw)).not.toMatch(EMAIL);
  });
});
