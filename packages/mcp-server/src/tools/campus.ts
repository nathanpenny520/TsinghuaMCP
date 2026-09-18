import { z } from "zod";
import dayjs from "dayjs";
import fs from "node:fs";
import path from "node:path";
import { ok } from "../util.js";
import { tool } from "../registry.js";
import type { Deps, ToolDef } from "../registry.js";

export function campusTools({ session, dataDir }: Deps): ToolDef[] {
    const run = session.run.bind(session);

    return [
        tool({
            name: "thu_get_card_info",
            description: "查询校园卡：余额（元）、卡状态、有效期、单日/单笔限额。",
            inputSchema: {},
            handler: async () => {
                const info = await run("get_campus_card_info", "read", (h) => h.getCampusCardInfo());
                return ok({ balance: info.balance, cardStatus: info.cardStatus, effective: info.effectiveTimestamp, maxDaily: info.maxDailyTransactionAmount, maxOneTime: info.maxOneTimeTransactionAmount });
            },
        }),
        tool({
            name: "thu_get_card_transactions",
            description: "查询校园卡消费/充值/补助流水。",
            inputSchema: {
                days: z.number().int().optional().describe("查最近 N 天（默认30）"),
                start: z.string().optional().describe("起 yyyy-MM-dd（优先于 days）"),
                end: z.string().optional().describe("止 yyyy-MM-DD"),
                type: z.enum(["all", "consume", "recharge", "subsidy"]).optional(),
            },
            handler: async ({ days, start, end, type }) => {
                const endD = end ?? dayjs().format("YYYY-MM-DD");
                const startD = start ?? dayjs().subtract(days ?? 30, "day").format("YYYY-MM-DD");
                const typeMap: Record<string, number> = { all: -1, consume: 1, recharge: 2, subsidy: 3 };
                const list = await run("get_card_transactions", "read", (h) =>
                    h.getCampusCardTransactions(startD, endD, (typeMap[type ?? "all"]) as never));
                return ok({ start: startD, end: endD, count: list.length, transactions: list });
            },
        }),
        tool({
            name: "thu_get_invoices",
            description: "查询电子发票列表（分页）。",
            inputSchema: { page: z.number().int().optional().describe("页码，从1开始") },
            handler: async ({ page }) => ok(await run("get_invoice_list", "read", (h) => h.getInvoiceList(page ?? 1))),
        }),
        tool({
            name: "thu_get_bank_payment",
            description: "查询银行卡发放/代发记录（奖学金、补助等到账）。",
            inputSchema: {},
            handler: async () => ok(await run("get_bank_payment", "read", (h) => h.getBankPayment(false, true))),
        }),
        tool({
            name: "thu_get_ele_remainder",
            description: "查询宿舍电费剩余度数。",
            inputSchema: {},
            handler: async () => ok(await run("get_ele_remainder", "read", (h) => h.getEleRemainder())),
        }),
        tool({
            name: "thu_get_ele_pay_record",
            description: "查询宿舍电费充值记录。",
            inputSchema: {},
            handler: async () => ok(await run("get_ele_pay_record", "read", (h) => h.getElePayRecord())),
        }),
        tool({
            name: "thu_get_dorm_score",
            description: "查询宿舍卫生评分（返回一张图片文件路径，可用图片方式查看）。",
            inputSchema: {},
            handler: async () => {
                const b64 = await run("get_dorm_score", "read", (h) => h.getDormScore());
                const file = path.join(dataDir, "dorm-score.png");
                fs.writeFileSync(file, Buffer.from(b64, "base64"));
                return ok({ image: file, note: "已保存为本地 PNG，可用查看图片的方式打开" });
            },
        }),
        tool({
            name: "thu_get_library_overview",
            description: "查询图书馆：各馆区及楼层列表。",
            inputSchema: {},
            handler: async () => {
                const libraries = await run("get_library_list", "read", (h) => h.getLibraryList());
                return ok(libraries);
            },
        }),
        tool({
            name: "thu_get_library_seats",
            description: "查询图书馆各区域座位空余情况（今天/明天）。",
            inputSchema: {
                library: z.string().describe("馆名关键词，如 李文正"),
                floor: z.string().optional().describe("楼层名关键词，缺省查全部楼层"),
                tomorrow: z.boolean().optional().describe("true=查明天，默认今天"),
            },
            handler: async ({ library, floor, tomorrow }) => {
                const dateChoice = (tomorrow ? 1 : 0) as 0 | 1;
                const libraries = await run("get_library_list", "read", (h) => h.getLibraryList());
                const lib = libraries.find((l) => l.zhName.includes(library)) ?? libraries.find((l) => l.zhNameTrace.includes(library));
                if (!lib) return ok({ error: `未找到馆区"${library}"`, available: libraries.map((l) => l.zhName) });
                const floors = await run("get_library_floors", "read", (h) => h.getLibraryFloorList(lib, dateChoice));
                const matched = floor ? floors.filter((f) => f.zhName.includes(floor) || f.zhNameTrace.includes(floor)) : floors;
                const sections = [];
                for (const f of matched) {
                    const secs = await run("get_library_sections", "read", (h) => h.getLibrarySectionList(f, dateChoice));
                    sections.push({
                        floor: f.zhName,
                        total: secs.reduce((a, s) => a + s.total, 0),
                        available: secs.reduce((a, s) => a + s.available, 0),
                        sections: secs.map((s) => ({ name: s.zhName, total: s.total, available: s.available })),
                    });
                }
                return ok({ library: lib.zhName, date: tomorrow ? "明天" : "今天", floors: sections });
            },
        }),
        tool({
            name: "thu_get_my_bookings",
            description: "查询我的预约：图书馆座位预约 + 研读间预约记录。",
            inputSchema: {},
            handler: async () => {
                const [seats, rooms] = await Promise.all([
                    run("get_booking_records", "read", (h) => h.getBookingRecords()),
                    run("get_room_booking_records", "read", (h) => h.getLibraryRoomBookingRecord()).catch(() => null),
                ]);
                return ok({ seatBookings: seats, roomBookings: rooms });
            },
        }),
        tool({
            name: "thu_find_study_rooms",
            description: "查询研读间/研讨间空闲情况（某天各房间的已占用时段）。",
            inputSchema: { date: z.string().optional().describe("yyyy-MM-dd，默认明天") },
            handler: async ({ date }) => {
                const d = date ?? dayjs().add(1, "day").format("YYYY-MM-DD");
                const compact = d.replaceAll("-", "");
                // 研读间系统(cab.hs)需要先建立会话（app 同款流程）；失败不阻断，让后续调用报真实错误
                await run("cab_login", "read", (h) => h.loginLibraryRoomBooking()).catch(() => undefined);
                const kinds = await run("get_room_info_list", "read", (h) => h.getLibraryRoomBookingInfoList());
                const result = [];
                const errors: string[] = [];
                for (const kind of kinds) {
                    try {
                        const rooms = await run("get_room_resources", "read", (h) =>
                            h.getLibraryRoomBookingResourceList(compact, kind.kindId));
                        result.push({
                            kind: kind.kindName,
                            rooms: rooms.map((r) => ({
                                name: r.roomName || r.devName,
                                open: r.openStart && r.openEnd ? `${r.openStart}-${r.openEnd}` : null,
                                booked: r.usage.map((u) => `${dayjs(u.start).format("HH:mm")}-${dayjs(u.end).format("HH:mm")}`),
                            })),
                        });
                    } catch (e) {
                        // 个别房间类型上游会报错，跳过即可，不要拖垮整个工具
                        errors.push(`${kind.kindName}: ${(e as Error).message}`);
                    }
                }
                return ok({ date: d, kinds: result, ...(errors.length > 0 ? { skippedKinds: errors } : {}) });
            },
        }),
        tool({
            name: "thu_get_sports_resources",
            description:
                "查询体育场馆可订时段（新版体育平台，只查询，不预订）。gym 支持关键词，如 羽毛球 / 篮球 / 游泳 / 乒乓。",
            inputSchema: {
                gym: z.string().describe("场馆/项目关键词"),
                date: z.string().optional().describe("yyyy-MM-dd，默认今天"),
            },
            handler: async ({ gym, date }) => {
                const d = date ?? dayjs().format("YYYY-MM-DD");
                const scenes = await run("get_venue_scenes", "read", (h) => h.getVenueScenes());
                const matched = scenes.filter((s) => s.sceneName.includes(gym));
                if (matched.length === 0) {
                    return ok({ error: `未找到含"${gym}"的场景`, available: scenes.map((s) => s.sceneName) });
                }
                const results = [];
                for (const scene of matched.slice(0, 3)) {
                    const rooms = await run("get_venue_rooms", "read", (h) => h.getVenueSiteRooms(scene.uuid));
                    const fields = [];
                    for (const room of rooms.slice(0, 10)) {
                        const periods = await run("get_venue_periods", "read", (h) =>
                            h.getVenuePeriods(scene.uuid, room.uuid, room.siteType, d, d));
                        const day = periods.find((p) => p.currentDate === d) ?? periods[0];
                        fields.push({
                            site: `${room.building ?? ""} ${room.floor ?? ""} ${room.siteName}`.trim(),
                            open: day?.openStatus,
                            bookable: day?.reserveStatus === "Y",
                            reason: day?.reserveStatusReason,
                            periods: day?.reserveInfo ?? [],
                        });
                    }
                    results.push({ scene: scene.sceneName, date: d, fields });
                }
                return ok({ date: d, scenes: results });
            },
        }),
        tool({
            name: "thu_get_sports_records",
            description: "查询我的体育场馆预约记录（新版体育平台，跨全部场景）。",
            inputSchema: {},
            handler: async () => ok(await run("get_venue_my_reservations", "read", (h) => h.getVenueMyReservations())),
        }),
        tool({
            name: "thu_get_network_balance",
            description: "查询校园网账户余额与流量套餐。若报错，先用 thu_get_captcha(kind=usereg) + thu_usereg_login 登录。",
            inputSchema: {},
            handler: async () => {
                try {
                    return ok(await run("get_network_balance", "read", (h) => h.getNetworkBalance()));
                } catch (e) {
                    return ok({ error: (e as Error).message, hint: "usereg 会话可能过期：thu_get_captcha(kind=usereg) → thu_usereg_login 后重试" });
                }
            },
        }),
        tool({
            name: "thu_get_online_devices",
            description: "查询当前在线的网络设备列表。若报错，先用 thu_get_captcha(kind=usereg) + thu_usereg_login 登录。",
            inputSchema: {},
            handler: async () => {
                try {
                    return ok(await run("get_online_devices", "read", (h) => h.getOnlineDevices()));
                } catch (e) {
                    return ok({ error: (e as Error).message, hint: "usereg 会话可能过期：thu_get_captcha(kind=usereg) → thu_usereg_login 后重试" });
                }
            },
        }),
    ];
}
