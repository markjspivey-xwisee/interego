// Build-time adapter: stage-shared-config.mjs puts the shared implementation in
// dist so the public MCP tarball has no dependency on an unpublished workspace.
export { resolveStdioConfig } from '@interego/deployment-config';
