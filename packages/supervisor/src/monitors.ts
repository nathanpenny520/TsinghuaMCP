import dayjs from "dayjs";
import { flattenDay, weekOf } from "@thu-agent/core";
import type { SessionManager, State, Config } from "@thu-agent/core";
import { notify } from "./notify.js";

/**
 * 确定性监控器：每轮由 supervisor 定时调用。
 * 设计原则：监控/等待用确定性代码，不烧 LLM token；发现事件 → 推送通知。
 * 所有快照与冷却时间存在 SQLite kv，重启不丢。
 */

const COOLDOWN_MS = 12 * 3600e3; // 阈值类重复提醒的冷却

interface Env {
    session: SessionManager;
    state: State;
    config: Config;
}

async function withCooldown(state: State, key: string, cooldownMs: number): Promise<boolean> {
    const last = Number(state.kvGet(key) ?? 0);
    if (Date.now() - last < cooldownMs) return false;
    state.kvSet(key, String(Date.now()));
    return true;
}

/** 成绩快照 diff：出现新（学期,课程,成绩）组合 → 通知 */
async function checkScores({ session, state }: Env): Promise<string[]> {
    const events: string[] = [];
    await session.run("mon_scores", "read", async (h) => {
        const courses = await h.getReport(false, true, 1);
        const keys = new Map(courses.map((c) => [`${c.semester}|${c.name}|${c.grade}`, `${c.name}：${c.grade}（${c.credit}学分，${c.semester}）`]));
        const raw = state.kvGet("score_snapshot");
        const prev = JSON.parse(raw ?? "{}") as Record<string, boolean>;
        const existed = raw !== undefined; // 首次运行只建基线，不把历史成绩当新成绩
        for (const [key, label] of keys) {
            if (!(key in prev)) {
                if (existed) events.push(`📊 新成绩 ${label}`);
                prev[key] = true;
            }
        }
        state.kvSet("score_snapshot", JSON.stringify(prev));
    });
    return events;
}

/** 校园卡余额阈值 */
async function checkCard({ session, state, config }: Env): Promise<string[]> {
    try {
        const info = await session.run("mon_card", "read", (h) => h.getCampusCardInfo());
        if (info.balance < config.cardThreshold) {
            if (await withCooldown(state, "card_notify_at", COOLDOWN_MS)) {
                return [`💳 校园卡余额仅剩 ${info.balance} 元，低于阈值 ${config.cardThreshold} 元`];
            }
        }
    } catch {
        // 网络失败静默，下轮再试
    }
    return [];
}

/** 宿舍电费阈值 */
async function checkEle({ session, state, config }: Env): Promise<string[]> {
    try {
        const ele = await session.run("mon_ele", "read", (h) => h.getEleRemainder());
        if (!Number.isNaN(ele.remainder) && ele.remainder < config.eleThreshold) {
            if (await withCooldown(state, "ele_notify_at", COOLDOWN_MS)) {
                return [`⚡ 宿舍电费仅剩 ${ele.remainder} 度，低于阈值 ${config.eleThreshold} 度`];
            }
        }
    } catch {
        // 同上
    }
    return [];
}

/** 新闻关键词监控（agent 用 thu_add_news_watch 注册的规则） */
async function checkNews({ session, state }: Env): Promise<string[]> {
    const events: string[] = [];
    const rules = state.enabledMonitors("news_keyword");
    for (const rule of rules) {
        const { keyword } = rule.value as { keyword: string };
        try {
            const list = await session.run(`mon_news:${keyword}`, "read", (h) => h.searchNewsList(1, keyword));
            const seenKey = `news_seen:${keyword}`;
            const seen = new Set(JSON.parse(state.kvGet(seenKey) ?? "[]") as string[]);
            const isNew = list.filter((n) => !seen.has(n.xxid));
            // 首次运行只记录基线，不通知历史
            const baseline = state.kvGet(seenKey) === null;
            for (const n of isNew.slice(0, 3)) {
                if (!baseline) events.push(`📰 新闻匹配"${keyword}"：${n.name}（${n.date}）`);
                seen.add(n.xxid);
            }
            const capped = [...seen].slice(-300);
            state.kvSet(seenKey, JSON.stringify(capped));
        } catch {
            // 单个关键词失败不影响其他
        }
    }
    return events;
}

/** 选课余量监控（抢课盯梢） */
async function checkCrSeats({ session, state }: Env): Promise<string[]> {
    const events: string[] = [];
    const rules = state.enabledMonitors("cr_course");
    for (const rule of rules) {
        const v = rule.value as { courseId: string; courseSeq: string | null; name: string | null; semesterId: string | null };
        try {
            let semesterId = v.semesterId;
            if (!semesterId) {
                // 默认校历当前学期；CR 学期列表排序不保证最新在最后，不能用末尾
                const cal = await session.run(`mon_cr_cal`, "read", (h) => h.getCalendar());
                semesterId = cal.semesterId;
            }
            if (!semesterId) continue;
            const result = await session.run(`mon_cr:${v.courseId}`, "read", (h) =>
                h.searchCrRemaining({ semester: semesterId!, id: v.courseId } as never));
            const infos = ("remaining" in result ? result : []) as { seq: number; remaining: number; name: string; teacher: string }[];
            for (const info of infos) {
                if (v.courseSeq && String(info.seq) !== v.courseSeq) continue;
                const key = `cr_last:${semesterId}:${v.courseId}:${info.seq}`;
                const prev = state.kvGet(key);
                state.kvSet(key, String(info.remaining));
                if (info.remaining > 0 && (prev === null || Number(prev) <= 0)) {
                    events.push(`🎯 抢课机会：${v.name ?? info.name}（${v.courseId}-${info.seq} ${info.teacher}）余量 ${info.remaining}！`);
                }
            }
        } catch {
            // 选课系统期外会 500，静默
        }
    }
    return events;
}

/** 选课阶段临近提醒（24h 内开始的选课事件） */
async function checkCrStage({ session, state }: Env): Promise<string[]> {
    const events: string[] = [];
    try {
        const timetable = await session.run("mon_cr_timetable", "read", (h) => h.getCrTimetable());
        const notified = new Set(JSON.parse(state.kvGet("cr_stage_notified") ?? "[]") as string[]);
        for (const t of timetable) {
            for (const e of t.events) {
                const begin = dayjs(e.begin);
                const in24h = begin.isAfter(dayjs()) && begin.isBefore(dayjs().add(24, "hour"));
                const key = `${e.stage}|${e.begin}`;
                if (in24h && !notified.has(key)) {
                    events.push(`⏰ 选课阶段「${e.stage}」将于 ${e.begin} 开始${e.messages.length ? `（${e.messages[0]}）` : ""}`);
                    notified.add(key);
                }
            }
        }
        state.kvSet("cr_stage_notified", JSON.stringify([...notified].slice(-50)));
    } catch {
        // 期外 500 静默
    }
    return events;
}

/** 每日 08:00 摘要：今天课程 + 预约 + 状态 */
async function dailyDigest({ session }: Env): Promise<string[]> {
    const parts: string[] = [];
    try {
        const { schedule, calendar } = await session.run("digest_schedule", "read", (h) => h.getSchedule());
        const today = dayjs().format("YYYY-MM-DD");
        const classes = flattenDay(schedule, today);
        if (classes.length > 0) {
            parts.push(`今日 ${classes.length} 节安排：` + classes.map((o) => `${o.begin} ${o.name}${o.location ? `@${o.location}` : ""}`).join("；"));
        } else {
            parts.push(`今天没有课程安排（第${Math.max(weekOf(calendar.firstDay, calendar.weekCount), 0)}周）`);
        }
    } catch {
        // 忽略
    }
    try {
        const bookings = await session.run("digest_bookings", "read", (h) => h.getBookingRecords());
        if (bookings.length > 0) parts.push(`座位预约 ${bookings.length} 条：${bookings.map((b) => `${b.time} ${b.pos}`).join("；")}`);
    } catch {
        // 忽略
    }
    try {
        const card = await session.run("digest_card", "read", (h) => h.getCampusCardInfo());
        parts.push(`卡余额 ${card.balance} 元`);
    } catch {
        // 忽略
    }
    return parts.length > 0 ? [`☀️ 早安，今日摘要\n${parts.join("\n")}`] : [];
}

export async function runMonitors(env: Env): Promise<void> {
    const checks = [checkScores, checkCard, checkEle, checkNews, checkCrSeats, checkCrStage];
    for (const check of checks) {
        try {
            for (const event of await check(env)) {
                await notify(env.config, "清华 Agent", event);
                env.state.logAction("monitor:event", check.name, event, "read");
            }
        } catch (e) {
            console.log(`[monitor] ${check.name} 异常: ${(e as Error).message}`);
        }
    }
}

export function shouldDigest(state: State, now = dayjs()): boolean {
    if (now.hour() !== 8) return false;
    const last = state.kvGet("last_digest_date");
    return last !== now.format("YYYY-MM-DD");
}

export async function runDigest(env: Env): Promise<void> {
    for (const event of await dailyDigest(env)) {
        await notify(env.config, "清华 Agent 今日摘要", event);
    }
    env.state.kvSet("last_digest_date", dayjs().format("YYYY-MM-DD"));
}
