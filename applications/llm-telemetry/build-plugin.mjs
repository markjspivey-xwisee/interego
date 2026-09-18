/** Compatibility notice: telemetry now configures the client's existing MCP connection. */
console.error('The separate telemetry plugin generator is retired. Open https://foxxi-bridge.interego.xwisee.com/llm-telemetry/setup through your existing Interego connection. Download the configuration for your supported client; no source build or additional MCP server is required.');
process.exitCode = 1;
