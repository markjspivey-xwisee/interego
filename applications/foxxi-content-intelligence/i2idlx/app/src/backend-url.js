import { isChatGPTApp } from "./chatgpt-host.js";
// MCP App resources run in the host sandbox, not at Foxxi's browser origin.
export const backendUrl = path => {
  if (!isChatGPTApp()) return path;
  const base = new URL(window.__APP_URL__);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Workbench deployment URL must use HTTP(S) without credentials.");
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error("Workbench requests must use the injected deployment origin.");
  return target.href;
};
export const workbenchHosted = () => isChatGPTApp() || /^\/i2idlx(?:\/|$)/.test(window.location.pathname);
