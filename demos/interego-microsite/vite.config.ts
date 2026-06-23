import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Interego substrate demo surface. Talks to the generic interego-bridge over its
// /mcp surface (discover→act); the bridge URL is baked at build time via
// VITE_INTEREGO_BRIDGE_URL (defaults to localhost:6058 for dev).
export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
});
