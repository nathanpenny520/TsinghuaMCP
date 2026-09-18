import { z } from "zod";
import dayjs from "dayjs";
import { ok, flattenWeek, weekOf } from "../util.js";
import { tool } from "../registry.js";
import type { Deps, ToolDef } from "../registry.js";

export function infoTools({ session }: Deps): ToolDef[] {
    const run = session.run.bind(session);

    return [
        tool({
            name: "thu_context",
            description:
                "获取清华上下文仪表盘：今天日期、当前教学周、今天/明天的课、校园卡余额、宿舍电费、待办概览。" +
                "回答任何'今天/本周/接下来'类问题、或做日程规划前，应先调用本工具建立时间上下文。",
            inputSchema: {},
            handler: async () => {
                const errors: string[] = [];
                const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
                    try {
                        return await fn();
                    } catch (e) {
                        errors.push(`${label}: ${(e as Error).message}`);
                        return null;
                    }
                };

                const sched = await safe("课表", () => run("ctx_schedule", "read", (h) => h.getSchedule()));
                let context: Record<string, unknown> = { now: dayjs().format("YYYY-MM-DD ddd HH:mm") };

                if (sched) {
                    const { calendar } = sched;
                    const w = weekOf(calendar.firstDay, calendar.weekCount);
                    context = {
                        ...context,
                        semester: calendar.semesterName,
                        firstDay: calendar.firstDay,
                        week: w,
                        weekCount: calendar.weekCount,
                        todayClasses: flattenWeek(sched.schedule, calendar.firstDay, w).filter((o) => o.date === dayjs().format("YYYY-MM-DD")),
                        tomorrowClasses: flattenWeek(sched.schedule, calendar.firstDay, w).filter((o) => o.date === dayjs().add(1, "day").format("YYYY-MM-DD")),
                        next7DaysCount: flattenWeek(sched.schedule, calendar.firstDay, Math.min(w + 1, calendar.weekCount)).length,
                    };
                }

                const card = await safe("校园卡", () => run("ctx_card", "read", (h) => h.getCampusCardInfo()));
                if (card) context.cardBalance = card.balance;

                const ele = await safe("电费", () => run("ctx_ele", "read", (h) => h.getEleRemainder()));
                if (ele) context.electricity = ele;

                const thos = await safe("THOS", () => run("ctx_thos", "read", (h) => h.prepareThosSession()));
                if (thos) context.thosPending = { active: thos.active, todo: thos.todo, unread: thos.unread };

                if (errors.length > 0) context.errors = errors;
                return ok(context);
            },
        }),
        tool({
            name: "thu_get_news",
            description: "获取信息门户新闻列表（各频道）。",
            inputSchema: {
                channel: z.string().optional().describe("频道名，缺省全部；可用 thu_get_news_channels 查"),
                page: z.number().int().optional(),
                length: z.number().int().optional().describe("条数，默认10"),
            },
            handler: async ({ channel, page, length }) =>
                ok(await run("get_news_list", "read", (h) => h.getNewsList(page ?? 1, length ?? 10, channel as never))),
        }),
        tool({
            name: "thu_get_news_channels",
            description: "列出可用的新闻频道（上游接口偶发 404，失败时可改用 thu_get_news 不带频道浏览）。",
            inputSchema: {},
            handler: async () => ok(await run("get_news_channels", "read", (h) => h.getNewsChannelList(false))),
        }),
        tool({
            name: "thu_search_news",
            description: "按关键词搜索信息门户新闻。",
            inputSchema: {
                keyword: z.string().describe("关键词"),
                page: z.number().int().optional(),
            },
            handler: async ({ keyword, page }) =>
                ok(await run("search_news", "read", (h) => h.searchNewsList(page ?? 1, keyword))),
        }),
        tool({
            name: "thu_get_news_detail",
            description: "获取某条新闻的正文（url 从新闻列表/搜索结果里拿）。",
            inputSchema: { url: z.string().describe("新闻 url") },
            handler: async ({ url }) => {
                const [title, content, abstract] = await run("get_news_detail", "read", (h) => h.getNewsDetail(url as string));
                return ok({ title, abstract, content: content.slice(0, 8000) });
            },
        }),
        tool({
            name: "thu_get_news_subscriptions",
            description: "列出我的新闻订阅（关键词/频道/信息源及对应 id）。",
            inputSchema: {},
            handler: async () => ok(await run("get_news_subscriptions", "read", (h) => h.getNewsSubscriptionList())),
        }),
        tool({
            name: "thu_get_thos_tasks",
            description: "查询 THOS 线上服务待办/在办/已办事项。",
            inputSchema: {
                kind: z.enum(["active", "todo", "completed", "drafts", "unread", "phases"]).optional().describe("缺省 todo"),
            },
            handler: async ({ kind }) => {
                const counts = await run("prepare_thos", "read", (h) => h.prepareThosSession());
                const page = await run("get_thos_tasks", "read", (h) => h.getThosTasks(kind ?? "todo"));
                return ok({ counts, total: page.total, tasks: page.items });
            },
        }),
        tool({
            name: "thu_get_thos_services",
            description: "浏览 THOS 可办理的线上服务目录（各服务的深链）。",
            inputSchema: {},
            handler: async () => ok(await run("get_thos_services", "read", (h) => h.getThosServices())),
        }),
        tool({
            name: "thu_search_git_projects",
            description: "搜索清华 GitLab 上的项目。",
            inputSchema: {
                query: z.string().describe("搜索关键词"),
                page: z.number().int().optional(),
            },
            handler: async ({ query, page }) =>
                ok(await run("search_git_projects", "read", (h) => h.searchGitProjects(query as string, page ?? 1))),
        }),
    ];
}
