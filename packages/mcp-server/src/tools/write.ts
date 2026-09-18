import { z } from "zod";
import dayjs from "dayjs";
import { riskRank } from "@thu-agent/core";
import { ok } from "../util.js";
import { tool } from "../registry.js";
import type { Deps, ToolDef } from "../registry.js";
import type { RiskLevel } from "@thu-agent/core";
import type { InfoHelper } from "@thu-info/lib";
import { ScheduleType } from "@thu-info/lib/dist/models/schedule/schedule.js";
import type { Schedule } from "@thu-info/lib/dist/models/schedule/schedule.js";
import { scheduleTimeAdd } from "@thu-info/lib/dist/models/schedule/schedule.js";
import { CardRechargeType } from "@thu-info/lib/dist/models/card/recharge.js";
import { sportsIdInfoList } from "@thu-info/lib/dist/lib/sports.js";
import { uFetch } from "@thu-info/lib/dist/utils/network.js";

/**
 * 写操作层：两段式确认。
 *
 * 每个写操作 = prepare 工具（校验 + 锁定参数 + 生成确认码，不执行）
 *            + thu_confirm_action {code}（真正执行）。
 * 确认码 5 分钟过期；参数在 prepare 时锁定并存入 SQLite，confirm 无法篡改。
 * 需要额外人工确认的高危动作（挂失/退课）还要求 confirmPhrase 原样复述。
 * 另有进程级闸门 THU_AGENT_MAX_RISK：超限工具不注册，confirm 执行前二次校验。
 */

type Executor = (h: InfoHelper, params: any) => Promise<unknown>;

export function writeTools({ session, state, config, dataDir }: Deps): ToolDef[] {
    const run = session.run.bind(session);

    // ── 执行器注册表：action 名 → 真正的 lib 调用 ─────────────────────
    const executors: Record<string, Executor> = {
        select_course: (h, p) => h.selectCourse(p.semesterId, p.priority, p.courseId, p.courseSeq, p.will),
        delete_course: (h, p) => h.deleteCourse(p.semesterId, p.courseId, p.courseSeq),
        change_will: (h, p) => h.changeCourseWill(p.semesterId, p.courseId, p.courseSeq, p.will),
        set_pf: (h, p) => (p.set ? h.setCoursePF(p.semesterId, p.courseId) : h.cancelCoursePF(p.semesterId, p.courseId)),
        book_seat: (h, p) => h.bookLibrarySeat(p.seat, p.section, p.dateChoice),
        cancel_seat_booking: (h, p) => h.cancelBooking(p.bookingId),
        book_room: (h, p) => h.bookLibraryRoom(p.roomRes, p.start, p.end, p.memberList ?? []),
        cancel_room_booking: (h, p) => h.cancelLibraryRoomBooking(p.uuid),
        send_mail: (h, p) => h.naiveSendMail(p.subject, p.body, p.to),
        add_news_subscription: (h, p) => h.addNewsSubscription(p.channel, p.sourceId, p.keyword),
        remove_news_subscription: (h, p) => h.removeNewsSubscription(p.subscriptionId),
        add_schedule_entry: (h, p) => h.saveCustomSchedule(p.schedules),
        delete_schedule_entry: (h, p) => h.deleteCustomSchedule(p.schedules),
        ele_recharge: (h, p) => h.getEleRechargePayCode(p.money),
        sports_booking: (h, p) =>
            h.makeSportsReservation(p.totalCost, p.phone, undefined, p.gymId, p.itemId, p.date, p.captchaCode, p.resHashId, false),
        sports_unsubscribe: (h, p) => h.unsubscribeSportsReservation(p.bookId),
        sports_pay: (h, p) => h.paySportsReservation(p.payId, undefined),
        card_recharge: (h, p) => h.rechargeCampusCard(p.amount, config.cardPassword, p.type),
        card_report_loss: (h, p) => h.reportCampusCardLoss(config.cardPassword),
        card_cancel_loss: (h, p) => h.cancelCampusCardLoss(config.cardPassword),
    };

    /** 构造一个 prepare 工具：校验/解析参数 → 存待确认 → 返回确认码 */
    const makeWrite = (def: {
        name: string;
        action: string;
        description: string;
        inputSchema: Record<string, z.ZodType>;
        risk: "write" | "write+pay";
        /** 返回 [锁定参数, 给人看的执行摘要, 可选额外确认语] */
        prepare: (args: any) => Promise<[unknown, string, string?]>;
    }): ToolDef =>
        tool({
            name: def.name,
            description: def.description,
            inputSchema: def.inputSchema,
            handler: async (args) => {
                const [params, summary, phrase] = await def.prepare(args);
                const code = state.createPending(def.action, params, def.risk, summary);
                return ok({
                    confirmCode: code,
                    willExecute: summary,
                    risk: def.risk,
                    expiresInMinutes: 5,
                    ...(phrase ? { confirmPhraseRequired: phrase } : {}),
                    next: "把以上内容展示给用户；用户同意后调用 thu_confirm_action 传此 code（高危动作还需原样传 confirmPhraseRequired）",
                });
            },
        });

    const latestSemester = async (): Promise<string | undefined> => {
        const sems = await run("get_cr_semesters", "read", (h) => h.getCrAvailableSemesters());
        return sems[sems.length - 1]?.id;
    };

    return [
        // ── 确认流 ──────────────────────────────────────────────────
        tool({
            name: "thu_confirm_action",
            description:
                "确认执行一个待执行的写操作（凭 prepare 工具返回的确认码）。高危动作需原样传 confirmPhrase。执行前务必已获得用户明确同意。",
            inputSchema: {
                code: z.string().describe("prepare 返回的确认码"),
                confirmPhrase: z.string().optional().describe("高危动作要求的确认短语，须由用户原样说出"),
            },
            handler: async ({ code, confirmPhrase }) => {
                const pending = state.getPending(code as string);
                if (!pending) return ok({ error: "确认码不存在、已使用或已过期（有效期 5 分钟）", hint: "请重新 prepare" });
                // 纵深防御：pending 可能是在更宽松的 maxRisk 下创建的（如改配置重启后），
                // 执行前按当前配置再拦一次，确保 write+pay 永远无法在受限模式下漏过。
                if (riskRank(pending.risk as RiskLevel) > riskRank(config.maxRisk)) {
                    return ok({
                        error: `本 server 限定了 THU_AGENT_MAX_RISK=${config.maxRisk}，拒绝执行风险为 ${pending.risk} 的动作`,
                        status: "仍待确认",
                        hint: "确需执行：调高 THU_AGENT_MAX_RISK 后重启 server，重新 prepare",
                    });
                }
                const phraseMatch = (pending.params as { confirmPhrase?: string } | null)?.confirmPhrase;
                if (typeof phraseMatch === "string" && confirmPhrase !== phraseMatch) {
                    return ok({ error: `高危操作需要用户原样说出确认短语："${phraseMatch}"`, status: "仍待确认" });
                }
                const executor = executors[pending.action];
                if (!executor) return ok({ error: `未知的动作类型 ${pending.action}` });
                const result = await run(`confirm:${pending.action}`, pending.risk as "write" | "write+pay", (h) =>
                    executor(h, pending.params));
                state.consumePending(code as string);
                return ok({ executed: pending.action, result });
            },
        }),
        tool({
            name: "thu_cancel_pending",
            description: "取消一个待执行的写操作。",
            inputSchema: { code: z.string() },
            handler: async ({ code }) => ok({ cancelled: state.cancelPending(code as string) }),
        }),
        tool({
            name: "thu_list_pending",
            description: "列出所有待确认的写操作。",
            inputSchema: {},
            handler: async () => ok(state.listPending()),
        }),

        // ── 选课 ────────────────────────────────────────────────────
        makeWrite({
            name: "thu_prepare_select_course",
            action: "select_course",
            risk: "write",
            description: "准备选课（不执行）。返回确认码，用户同意后用 thu_confirm_action 执行。",
            inputSchema: {
                courseId: z.string().describe("课程号"),
                courseSeq: z.string().describe("课序号"),
                priority: z.enum(["bx", "xx", "rx", "ty", "xwk", "fxwk", "tyk", "cx"]).describe("课程属性"),
                will: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe("志愿 1/2/3"),
                semesterId: z.string().optional(),
            },
            prepare: async (a) => {
                const sem = a.semesterId ?? (await latestSemester());
                if (!sem) throw new Error("没有可选学期");
                return [
                    { semesterId: sem, courseId: a.courseId, courseSeq: a.courseSeq, priority: a.priority, will: a.will },
                    `选课：${a.courseId}-${a.courseSeq}（${a.priority}，志愿${a.will}）@ ${sem}`,
                ];
            },
        }),
        makeWrite({
            name: "thu_prepare_delete_course",
            action: "delete_course",
            risk: "write",
            description: "准备退课（不执行）。高危：需要用户原样说出确认短语。",
            inputSchema: {
                courseId: z.string(),
                courseSeq: z.string(),
                semesterId: z.string().optional(),
            },
            prepare: async (a) => {
                const sem = a.semesterId ?? (await latestSemester());
                return [
                    { semesterId: sem, courseId: a.courseId, courseSeq: a.courseSeq, confirmPhrase: "确认退课" },
                    `退课：${a.courseId}-${a.courseSeq} @ ${sem}`,
                    "确认退课",
                ];
            },
        }),
        makeWrite({
            name: "thu_prepare_change_will",
            action: "change_will",
            risk: "write",
            description: "准备修改选课志愿（不执行）。",
            inputSchema: {
                courseId: z.string(),
                courseSeq: z.string(),
                will: z.union([z.literal(1), z.literal(2), z.literal(3)]),
                semesterId: z.string().optional(),
            },
            prepare: async (a) => {
                const sem = a.semesterId ?? (await latestSemester());
                return [
                    { semesterId: sem, courseId: a.courseId, courseSeq: a.courseSeq, will: a.will },
                    `改志愿：${a.courseId}-${a.courseSeq} → 志愿${a.will} @ ${sem}`,
                ];
            },
        }),
        makeWrite({
            name: "thu_prepare_set_pf",
            action: "set_pf",
            risk: "write",
            description: "准备设置/取消课程的 PF（Pass/Fail）标记（不执行）。",
            inputSchema: {
                courseId: z.string(),
                set: z.boolean().describe("true=设为PF，false=取消PF"),
                semesterId: z.string().optional(),
            },
            prepare: async (a) => {
                const sem = a.semesterId ?? (await latestSemester());
                return [
                    { semesterId: sem, courseId: a.courseId, set: a.set },
                    `${a.set ? "设置" : "取消"} PF：${a.courseId} @ ${sem}`,
                ];
            },
        }),

        // ── 图书馆 ──────────────────────────────────────────────────
        makeWrite({
            name: "thu_prepare_book_seat",
            action: "book_seat",
            risk: "write",
            description: "准备预订图书馆座位（不执行）。按名称解析馆区/区域/座位，先查后订。",
            inputSchema: {
                library: z.string().describe("馆名关键词，如 李文正"),
                section: z.string().describe("区域名关键词，如 三层A区"),
                seatNo: z.string().describe("座位号，如 043"),
                tomorrow: z.boolean().optional().describe("订明天的座位，默认今天"),
            },
            prepare: async (a) => {
                const dateChoice = (a.tomorrow ? 1 : 0) as 0 | 1;
                const libraries = await run("book_seat_libs", "read", (h) => h.getLibraryList());
                const lib = libraries.find((l) => l.zhName.includes(a.library));
                if (!lib) throw new Error(`未找到馆区 "${a.library}"`);
                const floors = await run("book_seat_floors", "read", (h) => h.getLibraryFloorList(lib, dateChoice));
                for (const f of floors) {
                    const sections = await run("book_seat_sections", "read", (h) => h.getLibrarySectionList(f, dateChoice));
                    const sec = sections.find((s) => s.zhName.includes(a.section));
                    if (!sec) continue;
                    const seats = await run("book_seat_seats", "read", (h) => h.getLibrarySeatList(sec, dateChoice));
                    const seat = seats.find((s) => s.zhName.includes(String(a.seatNo)));
                    if (seat) {
                        return [
                            { seat, section: sec, dateChoice },
                            `订座：${lib.zhName} ${sec.zhName} ${seat.zhName}（${dateChoice === 0 ? "今天" : "明天"}）`,
                        ];
                    }
                }
                throw new Error(`没找到座位 "${a.seatNo}"——请先用 thu_get_library_seats 核对区域与座位号`);
            },
        }),
        makeWrite({
            name: "thu_prepare_cancel_seat_booking",
            action: "cancel_seat_booking",
            risk: "write",
            description: "准备取消图书馆座位预约（不执行）。不传 id 则默认取消最早的一条。",
            inputSchema: { bookingId: z.string().optional() },
            prepare: async (a) => {
                const records = await run("cancel_seat_records", "read", (h) => h.getBookingRecords());
                if (records.length === 0) throw new Error("当前没有座位预约");
                const target = a.bookingId ? records.find((r) => r.id === a.bookingId) : records[0];
                if (!target) throw new Error(`没有 id 为 ${a.bookingId} 的预约`);
                return [{ bookingId: target.id }, `取消订座：${target.pos} @ ${target.time}`];
            },
        }),
        makeWrite({
            name: "thu_prepare_book_room",
            action: "book_room",
            risk: "write",
            description: "准备预订研读间/研讨间（不执行）。需指定日期与 5 分钟对齐的起止时间。",
            inputSchema: {
                room: z.string().describe("房间名关键词，如 北馆3F-01"),
                date: z.string().describe("yyyy-MM-dd"),
                start: z.string().describe("HH:mm，5分钟对齐"),
                end: z.string().describe("HH:mm，5分钟对齐"),
                memberIds: z.array(z.number()).optional().describe("同组成员学号列表，缺省仅自己"),
            },
            prepare: async (a) => {
                await run("book_room_login", "read", (h) => h.loginLibraryRoomBooking()).catch(() => undefined);
                const compact = String(a.date).replaceAll("-", "");
                const kinds = await run("book_room_info", "read", (h) => h.getLibraryRoomBookingInfoList());
                for (const kind of kinds) {
                    const rooms = await run("book_room_res", "read", (h) =>
                        h.getLibraryRoomBookingResourceList(compact, kind.kindId)).catch(() => [] as never[]);
                    const room = rooms.find((r) => (r.roomName || r.devName).includes(a.room));
                    if (!room) continue;
                    const start = dayjs(`${a.date} ${a.start}`);
                    const end = dayjs(`${a.date} ${a.end}`);
                    const conflict = room.usage.some((u) => dayjs(u.start).isBefore(end) && start.isBefore(dayjs(u.end)));
                    if (conflict) throw new Error(`${room.roomName || room.devName} 在该时段已被占用`);
                    const minutes = end.diff(start, "minute");
                    if (minutes < room.minMinute || minutes > room.maxMinute) {
                        throw new Error(`时长需在 ${room.minMinute}-${room.maxMinute} 分钟之间，当前 ${minutes} 分钟`);
                    }
                    return [
                        {
                            roomRes: room,
                            start: start.format("YYYY-MM-DD HH:mm") + ":00",
                            end: end.format("YYYY-MM-DD HH:mm") + ":00",
                            memberList: a.memberIds ?? [],
                        },
                        `订研读间：${room.roomName || room.devName} ${a.date} ${a.start}-${a.end}（${minutes} 分钟）`,
                    ];
                }
                throw new Error(`没找到房间 "${a.room}"，请先用 thu_find_study_rooms 核对`);
            },
        }),
        makeWrite({
            name: "thu_prepare_cancel_room_booking",
            action: "cancel_room_booking",
            risk: "write",
            description: "准备取消研读间预约（不执行）。不传 uuid 则默认取消最早的一条。",
            inputSchema: { uuid: z.string().optional() },
            prepare: async (a) => {
                const records = await run("cancel_room_records", "read", (h) => h.getLibraryRoomBookingRecord());
                if (records.length === 0) throw new Error("当前没有研读间预约");
                const target = a.uuid ? records.find((r) => r.uuid === a.uuid) : records[0];
                if (!target) throw new Error(`没有 uuid 为 ${a.uuid} 的预约`);
                return [{ uuid: target.uuid }, `取消研读间预约：${JSON.stringify(target).slice(0, 120)}`];
            },
        }),

        // ── 日程 / 邮件 / 新闻 ──────────────────────────────────────
        makeWrite({
            name: "thu_prepare_add_schedule_entry",
            action: "add_schedule_entry",
            risk: "write",
            description: "准备把自定义日程写入学教务个人日历（不执行）。一次性日程给 date；每周重复给 dayOfWeek+weeks。",
            inputSchema: {
                title: z.string().min(1),
                location: z.string().optional(),
                date: z.string().optional().describe("一次性日程：yyyy-MM-dd"),
                dayOfWeek: z.number().int().min(1).max(7).optional().describe("每周重复：星期几（1=周一）"),
                weeks: z.array(z.number().int().min(1).max(30)).optional().describe("重复周次，缺省全学期"),
                beginTime: z.string().regex(/^\d{2}:\d{2}$/),
                endTime: z.string().regex(/^\d{2}:\d{2}$/),
            },
            prepare: async (a) => {
                const { schedule, calendar } = await run("add_sched_ctx", "read", (h) => h.getSchedule());
                const firstDay = calendar.firstDay;
                const weekCount = calendar.weekCount;
                const sched: Schedule = {
                    name: a.title,
                    location: a.location ?? "",
                    hash: "",
                    type: ScheduleType.CUSTOM,
                    activeTime: { base: [] },
                    delOrHideTime: { base: [] },
                };
                const when =
                    a.date && /^\d{4}-\d{2}-\d{2}$/.test(a.date)
                        ? [a.date]
                        : a.dayOfWeek
                          ? (a.weeks ?? Array.from({ length: weekCount }, (_, k) => k + 1)).map(
                                (w: number) => dayjs(firstDay).add((w - 1) * 7 + (a.dayOfWeek - 1), "day").format("YYYY-MM-DD"),
                            )
                          : null;
                if (!when) throw new Error("需要 date（一次性）或 dayOfWeek（每周重复）");
                for (const d of when) {
                    scheduleTimeAdd(sched.activeTime, {
                        dayOfWeek: dayjs(d).day() === 0 ? 7 : dayjs(d).day(),
                        beginTime: dayjs(`${d} ${a.beginTime}`),
                        endTime: dayjs(`${d} ${a.endTime}`),
                    });
                }
                const repeat = a.date ? a.date : `每周${"一二三四五六日"[a.dayOfWeek - 1]}，共${when.length}次`;
                return [{ schedules: [sched] }, `加入日历：${a.title} @ ${a.location ?? ""}（${repeat} ${a.beginTime}-${a.endTime}）`];
            },
        }),
        makeWrite({
            name: "thu_prepare_delete_schedule_entry",
            action: "delete_schedule_entry",
            risk: "write",
            description: "准备从个人日历删除自定义日程（不执行）。按名称（可选日期）匹配。",
            inputSchema: {
                title: z.string().describe("日程名称（需完全一致）"),
                date: z.string().optional().describe("只删该日期的场次：yyyy-MM-dd"),
            },
            prepare: async (a) => {
                const { schedule } = await run("del_sched_ctx", "read", (h) => h.getSchedule());
                const matched = schedule.filter(
                    (s) =>
                        (s.type === ScheduleType.CUSTOM || s.category === "个人日历") &&
                        s.name === a.title &&
                        (!a.date || s.activeTime.base.some((t) => dayjs(t.beginTime).format("YYYY-MM-DD") === a.date)),
                );
                if (matched.length === 0) throw new Error(`没有找到名为 "${a.title}" 的自定义日程`);
                return [
                    { schedules: matched },
                    `删除日程：${a.title}${a.date ? `（${a.date}）` : ""}，共 ${matched.reduce((n, s) => n + s.activeTime.base.length, 0)} 个场次`,
                ];
            },
        }),
        makeWrite({
            name: "thu_prepare_send_mail",
            action: "send_mail",
            risk: "write",
            description: "准备用清华邮箱发一封邮件（不执行，单收件人）。",
            inputSchema: {
                to: z.string().describe("收件人邮箱"),
                subject: z.string().min(1),
                body: z.string().min(1),
            },
            prepare: async (a) => [
                { to: a.to, subject: a.subject, body: a.body },
                `发邮件至 ${a.to}：${a.subject}`,
            ],
        }),
        makeWrite({
            name: "thu_prepare_add_news_subscription",
            action: "add_news_subscription",
            risk: "write",
            description: "准备添加新闻订阅（关键词/频道/信息源，不执行）。",
            inputSchema: {
                keyword: z.string().optional(),
                channel: z.string().optional(),
                sourceId: z.string().optional(),
            },
            prepare: async (a) => {
                if (!a.keyword && !a.channel && !a.sourceId) throw new Error("keyword/channel/sourceId 至少给一个");
                return [{ keyword: a.keyword, channel: a.channel, sourceId: a.sourceId }, `订阅新闻：${a.keyword ?? a.channel ?? a.sourceId}`];
            },
        }),
        makeWrite({
            name: "thu_prepare_remove_news_subscription",
            action: "remove_news_subscription",
            risk: "write",
            description: "准备删除一条新闻订阅（不执行）。",
            inputSchema: { subscriptionId: z.string() },
            prepare: async (a) => [{ subscriptionId: a.subscriptionId }, `删除新闻订阅 ${a.subscriptionId}`],
        }),

        // ── 缴费类（确认后返回支付码，付款本身由人在支付宝完成）──────
        makeWrite({
            name: "thu_prepare_ele_recharge",
            action: "ele_recharge",
            risk: "write+pay",
            description: "准备宿舍电费充值（不执行）。确认后返回支付宝支付码，需用户自行扫码付款。",
            inputSchema: { money: z.number().int().min(1).describe("金额（元，整数）") },
            prepare: async (a) => [{ money: a.money }, `电费充值 ${a.money} 元（确认后给支付宝码）`],
        }),
        makeWrite({
            name: "thu_prepare_sports_booking",
            action: "sports_booking",
            risk: "write+pay",
            description:
                "准备预订体育场馆（不执行）。需要验证码：先调 thu_get_captcha(kind=sports) 拿图片给用户看，把用户报的码填进 captchaCode。",
            inputSchema: {
                gym: z.string().describe("场馆关键词，如 羽毛球"),
                date: z.string().describe("yyyy-MM-dd"),
                time: z.string().describe("时段，如 19:00-20:00"),
                phone: z.string().optional().describe("联系电话，缺省用系统里存的"),
                captchaCode: z.string().describe("验证码（先调 thu_get_captcha）"),
            },
            prepare: async (a) => {
                const gyms = sportsIdInfoList.filter((g) => g.name.includes(a.gym));
                if (gyms.length === 0) throw new Error(`未找到场馆 "${a.gym}"`);
                for (const g of gyms) {
                    const info = await run("sports_res", "read", (h) => h.getSportsResources(g.gymId, g.itemId, a.date));
                    const slot = info.data.find(
                        (s) => s.timeSession === a.time && s.canNetBook && !s.locked && !s.userType,
                    );
                    if (slot) {
                        return [
                            {
                                gymId: g.gymId,
                                itemId: g.itemId,
                                date: a.date,
                                time: a.time,
                                totalCost: slot.cost ?? 0,
                                resHashId: slot.resHash,
                                phone: a.phone ?? info.phone ?? "",
                                captchaCode: a.captchaCode,
                            },
                            `订场：${g.name} ${a.date} ${a.time}，${slot.cost ?? 0} 元（${slot.fieldName}）`,
                        ];
                    }
                }
                throw new Error("该时段不可订（已被占/未开放/不可网上订），先用 thu_get_sports_resources 查可订时段");
            },
        }),
        makeWrite({
            name: "thu_prepare_sports_unsubscribe",
            action: "sports_unsubscribe",
            risk: "write",
            description: "准备退订体育预约（不执行；只能退未支付的）。不传 bookId 默认退最早一条未支付。",
            inputSchema: { bookId: z.string().optional() },
            prepare: async (a) => {
                const records = await run("sports_records", "read", (h) => h.getSportsReservationRecords());
                const unpaid = records.filter((r) => r.bookId);
                if (unpaid.length === 0) throw new Error("没有可退订的预约");
                const target = a.bookId ? unpaid.find((r) => r.bookId === a.bookId) : unpaid[0];
                if (!target) throw new Error("未找到该预约");
                return [{ bookId: target.bookId }, `退订：${target.name} ${target.field} ${target.time}`];
            },
        }),
        makeWrite({
            name: "thu_prepare_sports_pay",
            action: "sports_pay",
            risk: "write+pay",
            description: "准备支付一笔未支付的体育预约（确认后返回支付宝码）。",
            inputSchema: { bookId: z.string().optional() },
            prepare: async (a) => {
                const records = await run("sports_pay_records", "read", (h) => h.getSportsReservationRecords());
                const unpaid = records.filter((r) => r.payId);
                if (unpaid.length === 0) throw new Error("没有待支付的预约");
                const target = a.bookId ? unpaid.find((r) => r.payId === a.bookId) : unpaid[0];
                if (!target) throw new Error("未找到该预约");
                return [{ payId: target.payId }, `支付：${target.name} ${target.field} ${target.time}（${target.price}）`];
            },
        }),
        makeWrite({
            name: "thu_prepare_card_recharge",
            action: "card_recharge",
            risk: "write+pay",
            description: "准备校园卡充值（不执行）。确认后返回支付链接，需用户自行完成付款。",
            inputSchema: {
                amount: z.number().int().min(1).describe("金额（元）"),
                channel: z.enum(["alipay", "wechat"]).optional().describe("默认支付宝"),
            },
            prepare: async (a) => [
                { amount: a.amount, type: a.channel === "wechat" ? CardRechargeType.Wechat : CardRechargeType.Alipay },
                `校园卡充值 ${a.amount} 元（${a.channel ?? "alipay"}，确认后给支付链接）`,
            ],
        }),
        makeWrite({
            name: "thu_prepare_card_report_loss",
            action: "card_report_loss",
            risk: "write+pay",
            description: "准备校园卡挂失（不执行）。高危：卡将立即停用，需要用户原样说出确认短语。",
            inputSchema: {},
            prepare: async () => [{ confirmPhrase: "确认挂失" }, "校园卡挂失（卡立即停用）", "确认挂失"],
        }),
        makeWrite({
            name: "thu_prepare_card_cancel_loss",
            action: "card_cancel_loss",
            risk: "write+pay",
            description: "准备解除校园卡挂失（不执行）。需要用户原样说出确认短语。",
            inputSchema: {},
            prepare: async () => [{ confirmPhrase: "确认解挂" }, "解除校园卡挂失", "确认解挂"],
        }),

        // ── 验证码与 usereg ─────────────────────────────────────────
        tool({
            name: "thu_get_captcha",
            description:
                "获取写操作所需的图形验证码图片（kind: sports=订场, cr=选课, usereg=网络自助）。返回内嵌图片内容 + 本地 PNG 路径，请让用户查看并口头报码。",
            inputSchema: { kind: z.enum(["sports", "cr", "usereg"]) },
            handler: async ({ kind }) => {
                const url =
                    kind === "sports"
                        ? (await import("@thu-info/lib/dist/lib/sports.js")).getSportsCaptchaUrlMethod()
                        : kind === "cr"
                          ? await run("cr_captcha_url", "read", (h) => h.getCrCaptchaUrl())
                          : await run("usereg_captcha_url", "read", (h) => h.getNetworkVerificationImageUrl());
                if (!url) throw new Error("无法构造验证码地址");
                const b64 = await run(`captcha_${kind}`, "read", () => uFetch(url as string));
                const fs = await import("node:fs");
                const path = await import("node:path");
                const file = path.join(dataDir, `captcha-${kind}.png`);
                fs.writeFileSync(file, Buffer.from(b64, "base64"));
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    image: file,
                                    note: "结果含内嵌验证码图片（上方 image 块）与本地 PNG 路径；让用户查看图片并输入图中数字/字母",
                                    expiresIn: "验证码有效期通常几分钟",
                                },
                                null,
                                1,
                            ),
                        },
                        { type: "image", data: b64, mimeType: "image/png" },
                    ],
                };
            },
        }),
        tool({
            name: "thu_usereg_login",
            description: "登录网络自助服务（usereg）。需先用 thu_get_captcha(kind=usereg) 拿验证码图，用户报码后传入。登录后网络查询/设备管理工具才可用。",
            inputSchema: { code: z.string().describe("用户口述的验证码") },
            handler: async ({ code }) => {
                await run("usereg_login", "write", (h) => h.loginUsereg(code as string));
                return ok({ loggedIn: true, next: "现在可用 thu_get_network_balance / thu_get_online_devices / 设备管理" });
            },
        }),
    ];
}
