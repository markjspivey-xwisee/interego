import { HMD_APP_HTML } from './hmd-app.js';

function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

// A new cache key lets refreshed tool metadata fetch each new bundle.
export const HMD_WIDGET_URI = `ui://widget/hmd-${shortHash(HMD_APP_HTML)}.html`;

/** Resolve the generic viewer resource without touching a pod or user data. */
export function readHmdWidgetResource(uri: string, domain: string) {
  // Tool metadata and resource requests do not refresh atomically. Existing chats
  // can keep an older outputTemplate after deployment, including the original
  // unversioned URI. Keep this viewer's URI family as compatibility aliases for
  // the current shell. These short hashes are cache keys, not integrity proofs.
  // The shell remains compatible with earlier structured tool results and reads
  // no user data until the authenticated host supplies that result.
  if (!/^ui:\/\/widget\/hmd(?:-[a-z0-9]{1,7})?\.html$/.test(uri)) return null;
  return {
    contents: [{
      uri,
      mimeType: 'text/html;profile=mcp-app',
      text: HMD_APP_HTML,
      _meta: {
        ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, domain },
        'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
      },
    }],
  };
}
