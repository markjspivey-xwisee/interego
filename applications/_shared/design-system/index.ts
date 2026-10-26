/**
 * Interego Design System 1.0: the one stylesheet Work Redesign and Practice Evidence serve at the
 * head of /ui/app.css, before their own product rules. It stays CSP-safe (style-src 'self'): no
 * @import, no web fonts, no remote url(). No environment reads.
 */
import { readFileSync } from 'node:fs';

let cached: string | null = null;

/** The design system stylesheet, read once from beside this module. */
export function designSystemCss(): string {
  cached ??= readFileSync(new URL('./design-system.css', import.meta.url), 'utf8');
  return cached;
}
