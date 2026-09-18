import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, riskRank, SessionManager, State } from "@thu-agent/core";
import type { Config } from "@thu-agent/core";
import type { Deps, ToolDef } from "./registry.js";
import { assertClassified, toolRisk } from "./risk.js";
import { academicTools } from "./tools/academic.js";
import { campusTools } from "./tools/campus.js";
import { infoTools } from "./tools/info.js";
import { writeTools } from "./tools/write.js";
import { monitorTools } from "./tools/monitors.js";

export const SERVER_INSTRUCTIONS =
    "这是清华事务个人 agent 的工具集。要点：\n" +
    "1. 回答涉及'今天/本周/接下来/还没'的问题时，先调 thu_context 建立时间与状态上下文。\n" +
    "2. 写操作一律两段式：先调 thu_prepare_X（校验并锁定参数，返回确认码），把将执行的内容展示给用户，" +
    "用户明确同意后才调 thu_confirm_action{code}。绝不能未经用户同意就 confirm。" +
    "高危动作（退课/挂失/解挂）还需要用户原样说出 confirmPhraseRequired 短语。\n" +
    "3. 需要图形验证码的流程（订场/选课/usereg）：先 thu_get_captcha 拿验证码图片（结果里同时有内嵌图片和本地路径）给用户看，用户报码后继续。\n" +
    "4. 长期需求（出分提醒、抢课盯梢、新闻关键词）用 thu_add_*_watch 注册，supervisor 会轮询并推送；" +
    "用 thu_list_monitors / thu_remove_monitor 管理。\n" +
    "5. 上游是校内系统，偶发超时/解析失败/业务期外拒绝都属正常：如实告知，不要编造数据。\n" +
    "6. 查询类工具尽量带缺省参数调用，不要问用户要技术参数（如 semesterId/周次）。\n" +
    "7. 已确认的支付码（电费/订场/校园卡充值）要把支付宝码/链接完整给用户，付款由用户在支付宝完成。";

export interface AppDeps {
    deps: Deps;
    config: Config;
    session: SessionManager;
    state: State;
    /** 按当前 maxRisk 过滤后可注册的工具 */
    visible: ToolDef[];
    total: number;
    hidden: number;
}

/**
 * 进程级装配：配置/状态/会话与工具收集只做一次。
 * stdio（index.ts）与 HTTP（http.ts）入口共用；HTTP 下请勿并发创建多个 AppDeps
 * （lib cookie jar 为进程级全局，多会话会互相打架）。
 */
export function createAppDeps(): AppDeps {
    const config = loadConfig();
    const state = new State(config.dataDir);
    const session = new SessionManager(config, state, false);
    session.startKeepalive();

    const deps: Deps = { session, state, config, dataDir: config.dataDir };
    const tools: ToolDef[] = [
        ...academicTools(deps),
        ...campusTools(deps),
        ...infoTools(deps),
        ...writeTools(deps),
        ...monitorTools(deps),
    ];

    // fail-safe：所有工具必须完成风险分级，未定级的一律拒启（见 risk.ts）
    assertClassified(tools.map((t) => t.name));

    // 权限管控：超出 maxRisk 的工具不注册（对客户端彻底不可见）
    const maxRank = riskRank(config.maxRisk);
    const visible = tools.filter((t) => riskRank(toolRisk(t.name).risk) <= maxRank);
    const hidden = tools.length - visible.length;
    return { deps, config, session, state, visible, total: tools.length, hidden };
}

/** 组装 McpServer 并注册可见工具；HTTP 无状态模式每个请求新建实例时也可调用 */
export function buildMcpServer(visible: ToolDef[]): McpServer {
    const server = new McpServer(
        {name: "thu-agent", version: "0.4.0"},
        {instructions: SERVER_INSTRUCTIONS},
    );
    for (const t of visible) {
        const {risk, destructive} = toolRisk(t.name);
        server.registerTool(
            t.name,
            {
                description: t.description,
                inputSchema: t.inputSchema,
                annotations: {
                    readOnlyHint: risk === "read",
                    destructiveHint: destructive === true,
                    idempotentHint: risk === "read",
                },
            },
            async (args) => t.handler(args as Record<string, unknown>),
        );
    }
    return server;
}

export function describeApp(app: AppDeps): string {
    return `thu-agent MCP server ready: ${app.visible.length}/${app.total} tools ` +
        `(mock=${app.config.mock}, maxRisk=${app.config.maxRisk}${app.hidden > 0 ? `, 隐藏${app.hidden}个更高风险工具` : ""})`;
}
