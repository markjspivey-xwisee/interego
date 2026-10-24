/**
 * The customer-facing pages the bridge serves to browsers: the landing page at / (content-negotiated;
 * agents keep the factory's JSON-LD / HMD) and the guide at /ui/help. Both are static HTML files filled
 * once at attach time: no script, no style element or attribute, same-origin assets only, so they render
 * without JavaScript under UI_CSP. No environment reads: bridge/server.ts passes everything through attachUi.
 */
import type { Request } from 'express';
import type { UiSignIn } from './ui.js';   // type-only import: no runtime cycle

/** What a deployment may set on its pages: the "Contact us" link, the legal name on the © line, the sibling product's address. */
export interface LandingOptions { readonly contactHref?: string; readonly legalName?: string; readonly siblingUrl?: string }

/** The other Interego product, linked from every page's product switch and footer. */
export const SIBLING = { name: 'Practice Evidence', url: 'https://pev-bridge-production.up.railway.app/' } as const;
/** Where an Interego account is made and a chat assistant connects when the bridge has no sign-in configured. */
export const INTEREGO_DEFAULTS = { identityUrl: 'https://identity.interego.xwisee.com/', relayUrl: 'https://relay.interego.xwisee.com' } as const;
/** Where "Contact us" goes when the deployment names no contact: the guide's contact section. */
const DEFAULT_CONTACT = '/ui/help#contact';

/** A browser asking for the root gets the landing page; an agent, curl or fetch() (no Accept, star-slash-star, JSON-LD, Markdown) keeps the entry point. */
export const prefersHtml = (req: Request): boolean =>
  req.accepts(['application/ld+json', 'text/turtle', 'text/markdown', 'text/html']) === 'text/html';

/** The design system's icon set (24x24, stroked), plus the two the app's navigation adds. */
export const ICON_PATHS: Readonly<Record<string, readonly string[]>> = {
  'sign-in': ['M15 3h3a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-3', 'M10 17l5-5-5-5', 'M15 12H3'],
  'user': ['M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0', 'M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1'],
  'check': ['M5 12.5l4.5 4.5L19 7.5'],
  'warning': ['M10.27 3.98 2.3 17.8A2 2 0 0 0 4.03 20.8h15.94a2 2 0 0 0 1.73-3L13.73 3.98a2 2 0 0 0-3.46 0Z', 'M12 9.5v4', 'M12 17h.01'],
  'info': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 11v5', 'M12 8h.01'],
  'document': ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  'people': ['M5.5 8a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0', 'M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1', 'M16 4.2a3.8 3.8 0 0 1 0 7.6', 'M18 14.2a5 5 0 0 1 3 4.6V20'],
  'chart': ['M3 3v18h18', 'M8 17v-5', 'M12.5 17V7', 'M17 17v-8'],
  'shield': ['M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6Z', 'M9 12l2 2 4-4'],
  'sparkle': ['M12 3l1.8 5.2a3 3 0 0 0 1.9 1.9L21 12l-5.3 1.8a3 3 0 0 0-1.9 1.9L12 21l-1.8-5.3a3 3 0 0 0-1.9-1.9L3 12l5.3-1.9a3 3 0 0 0 1.9-1.9Z', 'M19 2.5v3', 'M17.5 4h3'],
  'arrow-right': ['M5 12h14', 'M13 6l6 6-6 6'],
  'external': ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
  'download': ['M12 4v11', 'M7 10l5 5 5-5', 'M4 19h16'],
  'chat': ['M20 12a8 8 0 0 1-11.8 7L4 20l1-4.2A8 8 0 1 1 20 12Z'],
  'clipboard': ['M9 3.5h6a1 1 0 0 1 1 1V6a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z', 'M16 5h1a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1', 'M9 14l2 2 4-4'],
  'close': ['M6 6l12 12', 'M18 6 6 18'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'menu': ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  'home': ['M3 10.5 12 3l9 7.5', 'M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5'],
  'money': ['M12 2.5v19', 'M17 6.5H9.75a3.25 3.25 0 0 0 0 6.5h4.5a3.25 3.25 0 0 1 0 6.5H6'],
};

/** The Interego mark on the teal tile, with literal colours: a standalone file has no stylesheet (and a style element would be blocked). */
export const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  + '<rect x="0" y="0" width="32" height="32" rx="9" fill="#0e7f75"/>'
  + '<path d="M10.5 11.5 21.5 11.5 16 21.5Z" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>'
  + '<circle cx="10.5" cy="11.5" r="3" fill="#ffffff"/><circle cx="21.5" cy="11.5" r="3" fill="#ffffff"/><circle cx="16" cy="21.5" r="3" fill="#ffffff"/>'
  + '</svg>\n';

const BRAND_MARK = '<svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect class="mark-tile" x="0" y="0" width="32" height="32" rx="9"/>'
  + '<path class="mark-edge" d="M10.5 11.5 21.5 11.5 16 21.5Z"/><circle class="mark-node" cx="10.5" cy="11.5" r="3"/><circle class="mark-node" cx="21.5" cy="11.5" r="3"/>'
  + '<circle class="mark-node" cx="16" cy="21.5" r="3"/></svg>';
const BRAND = `<a class="brand" href="/">${BRAND_MARK}<span class="brand__name"><span class="brand__company">Interego</span><span class="brand__product">Work Redesign</span></span></a>`;

/** HTML-safe text for an attribute or element body (kept here so this module imports no value from ui.ts). */
const htmlText = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Tokens whose value is markup this module built (every interpolated part already escaped); every other token is escaped text. */
const MARKUP_TOKENS = new Set(['contact_line']);

/** One icon as inline SVG, or a throw for a name the set does not have. */
function iconSvg(name: string, size: string | undefined): string {
  const paths = ICON_PATHS[name];
  if (!paths) throw new Error(`unknown icon in a site page: ${name}`);
  if (size !== undefined && size !== 'sm') throw new Error(`unknown icon size in a site page: ${name}:${size}`);
  return `<svg class="icon${size ? ` icon--${size}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}

/** The values the site pages' {{tokens}} take, from what attachUi was given (never the environment). */
export function siteValues(o: { readonly base: string; readonly signIn?: UiSignIn; readonly landing?: LandingOptions }): Record<string, string> {
  const relayUrl = (o.signIn?.relayUrl ?? INTEREGO_DEFAULTS.relayUrl).replace(/\/$/, '');
  let relayOrigin: string = INTEREGO_DEFAULTS.relayUrl;
  try { relayOrigin = new URL(relayUrl).origin; } catch { relayOrigin = INTEREGO_DEFAULTS.relayUrl; }
  const identityHost = o.signIn?.policy?.identityHost;
  const contactHref = o.landing?.contactHref ?? DEFAULT_CONTACT;
  const securityTxt = `${relayOrigin}/.well-known/security.txt`;
  return {
    base: o.base.replace(/\/$/, ''),
    sibling_name: SIBLING.name,
    sibling_url: o.landing?.siblingUrl ?? SIBLING.url,
    identity_url: identityHost ? `https://${identityHost}/` : INTEREGO_DEFAULTS.identityUrl,
    connector_url: `${relayUrl}/mcp`,
    security_txt: securityTxt,
    contact_href: contactHref,
    contact_line: contactHref === DEFAULT_CONTACT
      ? 'Ask the person who sent you this link, or your Interego contact.'
      : `To talk to us about Work Redesign for your team, or to book a walkthrough with sample data: <a href="${htmlText(contactHref)}">Contact us</a>.`,
    legal_name: o.landing?.legalName ?? 'Interego',
    year: String(new Date().getUTCFullYear()),
  };
}

/**
 * Fill a site page: {{brand}} becomes the brand link, {{icon:x}} / {{icon:x:sm}} inline SVG, and
 * {{name}} the HTML-escaped value. An unknown token or icon throws, so a typo fails the boot and
 * the tests and never ships a "{{".
 */
export function renderSitePage(template: string, values: Readonly<Record<string, string>>): string {
  const out = template.replace(/\{\{([a-z_]+)(?::([a-z-]+))?(?::([a-z]+))?\}\}/g, (_m, name: string, arg: string | undefined, size: string | undefined) => {
    if (name === 'brand' && arg === undefined) return BRAND;
    if (name === 'icon' && arg !== undefined) return iconSvg(arg, size);
    const v = values[name];
    if (v === undefined || arg !== undefined) throw new Error(`unknown token in a site page: {{${name}${arg ? `:${arg}` : ''}}}`);
    return MARKUP_TOKENS.has(name) ? v : htmlText(v);
  });
  if (out.includes('{{')) throw new Error('a site page holds a token this renderer does not read');
  return out;
}
