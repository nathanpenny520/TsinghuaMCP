import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config, SessionManager, State } from "@thu-agent/core";
import { fail } from "./util.js";

/**
 * 工具定义：每个工具声明 zod 参数 shape 和一个 handler。
 * handler 内通过 session.run 调用 lib（自动串行 + 审计 + 会话自愈）。
 */
export interface ToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, z.ZodType>;
    // 参数已由 registerTool 的 zod shape 校验，这里放宽为 any 以便直接解构
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => Promise<CallToolResult>;
}

export interface Deps {
    session: SessionManager;
    state: State;
    config: Config;
    dataDir: string;
}

/** 包一层错误处理：lib 异常 → 文本错误结果（而非协议异常），让模型能读到并自行调整 */
export function tool(def: ToolDef): ToolDef {
    return {
        ...def,
        handler: async (args) => {
            try {
                return await def.handler(args);
            } catch (e) {
                return fail(e);
            }
        },
    };
}
