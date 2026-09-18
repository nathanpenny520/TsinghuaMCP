import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// 共享的课表工具已在 agent-core（supervisor 也要用），这里转发以保持旧导入兼容
export { weekOf, flattenWeek, flattenDay, TYPE_NAME } from "@thu-agent/core";
export type { Occurrence } from "@thu-agent/core";

/** 工具统一返回：JSON 文本内容 */
export function ok(value: unknown): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }] };
}

/** 工具统一错误：作为文本返回（而非协议异常），让模型能读到并自行调整 */
export function fail(e: unknown, hint?: string): CallToolResult {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `失败: ${msg}${hint ? `\n提示: ${hint}` : ""}` }], isError: true };
}
