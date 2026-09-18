import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer, createAppDeps, describeApp } from "./app.js";

/**
 * 本机 HTTP（Streamable）入口 —— 给只支持 HTTP 传输的 MCP 客户端用（如豆包桌面版）。
 *
 * - 仅监听 127.0.0.1：校园卡凭据与学校会话不出本机；
 * - 无状态模式：每个请求独立 McpServer + transport，状态全部落在 SQLite；
 * - 学校侧会话进程内唯一（SessionManager 串行队列），多客户端并发安全；
 * - 可选共享口令：设 THU_HTTP_TOKEN 后客户端需带 `Authorization: Bearer <token>`
 *   （豆包连接器的"自定义 Headers"里加）；不设则仅靠 loopback 隔离；
 * - 给不受信任的客户端用：启动前设 THU_AGENT_MAX_RISK=read，写工具整体不注册。
 */

const MCP_PATH = "/mcp";
const HOST = "127.0.0.1";
const PORT = Number(process.env.THU_HTTP_PORT ?? 9876);
const TOKEN = process.env.THU_HTTP_TOKEN || undefined;

const app = createAppDeps();

const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== MCP_PATH) {
        res.writeHead(404).end();
        return;
    }
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, {"Content-Type": "application/json"}).end(JSON.stringify({error: "unauthorized"}));
        return;
    }
    if (req.method !== "POST") {
        // Streamable HTTP 的 GET(SSE)/DELETE 会话语义在无状态模式下不使用
        res.writeHead(405, {Allow: "POST"}).end();
        return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        res.writeHead(400, {"Content-Type": "application/json"}).end(JSON.stringify({error: "invalid json"}));
        return;
    }
    // 每请求一个无状态 transport/server：客户端无需管理会话 id
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
    const server = buildMcpServer(app.visible);
    const done = new Promise<void>((resolve) => res.on("close", resolve));
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    } catch (e) {
        if (!res.headersSent) {
            res.writeHead(500, {"Content-Type": "application/json"}).end(JSON.stringify({error: (e as Error).message}));
        }
    } finally {
        await done.catch(() => undefined);
        transport.close();
        server.close();
    }
});

httpServer.listen(PORT, HOST, () => {
    console.error(describeApp(app));
    console.error(`HTTP transport listening on http://${HOST}:${PORT}/mcp` +
        (TOKEN ? " (Bearer token required)" : " (no token — loopback only)"));
});
