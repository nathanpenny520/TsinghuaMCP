import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, createAppDeps, describeApp } from "./app.js";

const app = createAppDeps();
const server = buildMcpServer(app.visible);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(describeApp(app));
