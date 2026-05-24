import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Microsite for first-touch visitors. Talks to the live Foxxi bridge for
// every demo card; the bridge URL is baked at build time via
// VITE_FOXXI_BRIDGE_URL (defaults to localhost:6080 for dev).
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
});
