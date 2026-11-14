/**
 * Voice in and out for a page, on the browser's own speech objects. See README.md beside this
 * file. The module itself is `voice.js`: an ES module with no build step, served by a bridge or
 * imported by a bundler. This file only says where it is on disk.
 */
import { fileURLToPath } from 'node:url';

/**
 * Where the browser module lives on disk. A bridge serves these bytes at a path of its own
 * (`text/javascript`) and its page imports it, which keeps a `script-src 'self'` policy intact.
 */
export const VOICE_BROWSER_MODULE = fileURLToPath(new URL('./voice.js', import.meta.url));
