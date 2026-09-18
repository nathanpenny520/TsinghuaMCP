import { z } from "zod";
import { ok } from "../util.js";
import { tool } from "../registry.js";
import type { Deps, ToolDef } from "../registry.js";

/**
 * 长程监控规则管理：agent 通过这些工具把"长期任务"写入 SQLite，
 * supervisor 常驻进程每轮读取并执行（出成绩提醒、抢课监控、关键词新闻等）。
 * 规则持久化，重启不丢；删除即停。
 */
export function monitorTools({ state }: Deps): ToolDef[] {
    return [
        tool({
            name: "thu_add_news_watch",
            description: "添加新闻关键词监控：supervisor 定期检索信息门户，出现新匹配就推送通知。",
            inputSchema: { keyword: z.string().min(1).describe("关键词，如 奖学金") },
            handler: async ({ keyword }) => {
                const id = state.addMonitor("news_keyword", { keyword });
                return ok({ id, type: "news_keyword", keyword, note: "已生效，supervisor 每轮轮询" });
            },
        }),
        tool({
            name: "thu_add_course_watch",
            description:
                "添加选课余量监控（抢课盯梢）：supervisor 定期查课余量，名额从无到有时推送通知。用户确认后可再调 thu_prepare_select_course。",
            inputSchema: {
                courseId: z.string(),
                courseSeq: z.string().optional().describe("课序号，缺省匹配该课号任意序号"),
                name: z.string().optional().describe("备注用的课程名"),
                semesterId: z.string().optional().describe("缺省最新学期"),
            },
            handler: async ({ courseId, courseSeq, name, semesterId }) => {
                const id = state.addMonitor("cr_course", { courseId, courseSeq: courseSeq ?? null, name: name ?? null, semesterId: semesterId ?? null });
                return ok({ id, type: "cr_course", courseId, courseSeq: courseSeq ?? "任意", note: "余量>0 时推送" });
            },
        }),
        tool({
            name: "thu_list_monitors",
            description: "列出所有长程监控规则（新闻关键词、抢课盯梢等）。",
            inputSchema: {},
            handler: async () => {
                const monitors = state.listMonitors();
                return ok({ count: monitors.length, monitors });
            },
        }),
        tool({
            name: "thu_remove_monitor",
            description: "删除一条监控规则。",
            inputSchema: { id: z.number().int() },
            handler: async ({ id }) => ok({ removed: state.removeMonitor(id as number) }),
        }),
    ];
}
