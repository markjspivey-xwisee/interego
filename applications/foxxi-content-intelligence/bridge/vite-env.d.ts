// Vite ambient declaration — the bridge's tsconfig transitively pulls
// in dashboard-app/src/hypermedia.tsx which references
// `import.meta.env.VITE_FOXXI_BRIDGE_URL`. The dashboard's own build
// uses `@vite/client` to provide this typing; the bridge needs its own
// minimal ambient declaration to type-check without depending on Vite.
//
// The dashboard runs as a separate build pipeline (Vite); this file
// only affects the bridge's tsc type-resolution.

interface ImportMetaEnv {
  readonly [key: string]: string | boolean | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
