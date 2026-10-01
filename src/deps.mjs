// The MCP server's only third-party imports, in one place. ESM resolves bare specifiers from
// the importing file's directory upward and ignores NODE_PATH, so when the dependencies live
// outside the plugin directory (CLAUDE_PLUGIN_DATA, see launcher.mjs) a copy of this file is
// placed next to that node_modules and imported from there instead.
export { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
export { z } from "zod";
