/**
 * Connect an external AI chat session to a page, so the page's turns run on that session's own
 * subscription and no model key is held anywhere. See README.md beside this file.
 */
import { fileURLToPath } from 'node:url';

export {
  AGENT_CONNECTION_BODY_BYTES, AgentConnectionBroker, AgentConnectionError, DEFAULT_AGENT_CONNECTION_WORDING,
  exact, record, reject,
  type AgentBrowserIdentity, type AgentConnectionConfig, type AgentConnectionProfile, type AgentConnectionRoutine,
  type AgentConnectionWording, type AgentMessage, type AgentPageTool, type AgentToolCall, type AgentTurnAccess,
  type AgentTurnPhase, type Row,
} from './broker.js';
export {
  agentConnectionRoute, attachExpress, handleAgentConnection, handleNodeHttp,
  type AgentConnectionExpressOptions, type AgentConnectionHttpOptions, type AgentConnectionNodeOptions,
  type AgentConnectionReply, type AgentConnectionRequest, type AgentConnectionRoute,
  type ExpressLikeApp, type ExpressLikeRequest, type ExpressLikeResponse,
  type SignedCallerResult, type VerifySignedCaller,
} from './http.js';
export { makeDelegatedCallerVerifier, type DelegatedCallerDeps } from './signed-caller.js';

/**
 * Where the framework-free browser client lives on disk. It is an ES module with no build step:
 * a bridge serves these bytes at a path of its own (`text/javascript`) and its page imports it,
 * which keeps a `script-src 'self'` policy intact.
 */
export const AGENT_CONNECTION_BROWSER_CLIENT = fileURLToPath(new URL('./browser-client.js', import.meta.url));
