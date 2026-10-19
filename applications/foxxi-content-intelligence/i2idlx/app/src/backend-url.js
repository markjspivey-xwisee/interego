import { isChatGPTApp } from "./chatgpt-host.js";
// MCP App resources run in the host sandbox, not at Foxxi's browser origin.
export const backendUrl = path => isChatGPTApp() ? "https://foxxi-bridge.interego.xwisee.com" + path : path;
export const workbenchHosted = () => isChatGPTApp() || /^\/i2idlx(?:\/|$)/.test(window.location.pathname);
