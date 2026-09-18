/** Explicit capability inventory. Prepared adapters are never described as active hosts. */
export function nativeIntegrations(base: string) {
  return { browser_extension: false, local_source_build: false, host_activation: 'not-verified',
    setup: `${base}/llm-telemetry/setup`, logs_endpoint: `${base}/llm-telemetry/otlp/v1/logs`,
    protocol: 'OTLP HTTP/JSON logs only; no metrics, traces, protobuf or gRPC',
    supported_events: ['user_prompt', 'assistant_response', 'tool_result', 'api_request', 'api_error'],
    privacy: 'Only allowlisted metadata persists. Prompt/reply text, reasoning, emails, paths, arguments, results and credentials are discarded. Provider estimated cost is not measured billing.',
    identity: 'Collector credentials are ingest-only, expire, can be revoked and bind to the signing observer. Cowork additionally requires exact user.account_uuid filtering. Resource attributes cannot change Interego authority.',
    reliability: 'Acknowledgement follows LRS readback and private durable persistence. Exporter retries use stable event IDs. Unsupported records return OTLP partialSuccess. Missing tool/request identifiers are excluded rather than fabricated.',
    integrations: [
      { host: 'ChatGPT Work', method: 'native plugin MCP-tool hooks', implementation: 'package-prepared', live_host_test: false, requires: 'Host installation and exact-hook trust review', documentation: 'https://learn.chatgpt.com/docs/plugins' },
      { host: 'Codex CLI', method: 'native plugin or hook configuration', implementation: 'package-prepared', live_host_test: false, requires: 'Existing Interego connection; /hooks review', documentation: 'https://learn.chatgpt.com/docs/hooks' },
      { host: 'Codex VS Code', method: 'runtime hook configuration', implementation: 'host-setup-unverified', live_host_test: false, requires: 'Verify IDE runtime hook loading; IDE does not support plugin installation', documentation: 'https://learn.chatgpt.com/docs/plugins' },
      { host: 'Claude Code CLI/VS Code', method: 'native hooks or OTLP logs', implementation: 'receiver-and-package-prepared', live_host_test: false, requires: 'Install native settings in the actual host; client consent', documentation: 'https://code.claude.com/docs/en/monitoring-usage' },
      { host: 'Claude Cowork web/desktop/mobile', method: 'native OTLP logs', implementation: 'receiver-prepared', live_host_test: false, requires: 'Team/Enterprise organization owner configures collector; exact own user.account_uuid; actual export verification', documentation: 'https://claude.com/docs/cowork/monitoring' },
      { host: 'Ordinary ChatGPT chat', method: 'Enterprise Compliance API for approved audit use', implementation: 'blocked-contract-and-access', live_host_test: false, requires: 'Eligible workspace, administrator authorization, exact API reference and credentials. Personal Pro all-chat collection is not established.', documentation: 'https://learn.chatgpt.com/docs/enterprise/compliance-api' },
      { host: 'Ordinary Claude chat', method: 'Compliance API', implementation: 'blocked-contract-and-access', live_host_test: false, requires: 'Eligible organization and Compliance Access Key; exact endpoint contract. Ordinary chat plugins do not run lifecycle hooks.', documentation: 'https://support.claude.com/en/articles/13015708-access-the-compliance-api' },
    ],
    evidence: 'Query source + capture_mode + setup timestamp. Validation exports do not establish native host activation. Cross-source observations are not deduplicated into unique work without a shared identity.' };
}
