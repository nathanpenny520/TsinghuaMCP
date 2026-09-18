import { z } from "zod";
import dayjs from "dayjs";
import { ok } from "../util.js";
import { flattenWeek, weekOf } from "../util.js";
import { tool } from "../registry.js";
import type { Deps, ToolDef } from "../registry.js";

// ClassroomStatus.AVAILABLE = 5（0教学 1考试 2借用 3禁用 4保留 5空闲）
const AVAILABLE = 5;

export function academicTools({ session }: Deps): ToolDef[] {
    const run = session.run.bind(session);

    const latestSemester = async (): Promise<string | undefined> => {
        const sems = await run("get_cr_semesters", "read", (h) => h.getCrAvailableSemesters());
        return sems[sems.length - 1]?.id;
    };

    return [
        tool({
            name: "thu_get_schedule",
            description:
                "查询个人课表（含课程/考试/自定义日程）。默认返回当前周；week 参数可查任意周（如 20=期末周）。返回按日期排序的课次列表。",
            inputSchema: { week: z.number().int().min(1).max(30).optional().describe("教学周次，缺省为本周") },
            handler: async ({ week }) => {
                const { schedule, calendar } = await run("get_schedule", "read", (h) => h.getSchedule());
                const firstDay = calendar.firstDay;
                const w = week ?? weekOf(firstDay, calendar.weekCount);
                return ok({
                    semester: calendar.semesterName,
                    firstDay,
                    weekCount: calendar.weekCount,
                    week: w,
                    isCurrentWeek: w === weekOf(firstDay, calendar.weekCount),
                    weekStartDate: dayjs(firstDay).startOf("day").add((w - 1) * 7, "day").format("YYYY-MM-DD"),
                    occurrences: flattenWeek(schedule, firstDay, w),
                });
            },
        }),
        tool({
            name: "thu_get_transcript",
            description: "查询成绩单（各学期课程、学分、绩点），并汇总平均绩点与总学分。",
            inputSchema: {
                flag: z.number().int().optional().describe("1=主修(默认) 2=二学位 3=辅修"),
                bx: z.boolean().optional().describe("仅必限课（只对主修有效），默认 false"),
                newGPA: z.boolean().optional().describe("新绩点方案，默认 true"),
            },
            handler: async ({ flag, bx, newGPA }) => {
                const courses = await run("get_transcript", "read", (h) =>
                    h.getReport(bx ?? false, newGPA ?? true, flag ?? 1));
                let totalCredits = 0;
                let gradedCredits = 0;
                let weighted = 0;
                let gradedCount = 0;
                for (const c of courses) {
                    totalCredits += c.credit;
                    // P 等无绩点成绩的 point 为 NaN（JSON 序列化成 null），不计入 GPA
                    if (Number.isFinite(c.point)) {
                        weighted += c.point * c.credit;
                        gradedCredits += c.credit;
                        gradedCount++;
                    }
                }
                return ok({
                    summary: {
                        totalCourses: courses.length,
                        totalCredits: Number(totalCredits.toFixed(1)),
                        gradedCredits: Number(gradedCredits.toFixed(1)),
                        gpa: gradedCredits > 0 ? Number((weighted / gradedCredits).toFixed(3)) : null,
                        note: "GPA 仅统计有绩点数值的课程（P 等无绩点成绩不计入）",
                    },
                    courses,
                });
            },
        }),
        tool({
            name: "thu_get_calendar",
            description: "查询校历：当前学期起止、周数、以及未来学期列表。",
            inputSchema: {},
            handler: async () => ok(await run("get_calendar", "read", (h) => h.getCalendar())),
        }),
        tool({
            name: "thu_get_assessment_list",
            description: "查询教学评估列表：哪些课程还没评教。",
            inputSchema: {},
            handler: async () => {
                const list = await run("get_assessment_list", "read", (h) => h.getAssessmentList());
                return ok({
                    pending: list.filter(([, done]) => !done).map(([name]) => name),
                    done: list.filter(([, done]) => done).map(([name]) => name),
                });
            },
        }),
        tool({
            name: "thu_list_classroom_buildings",
            description: "列出可查询空教室的教学楼名单（供 thu_get_classroom_state 的 building 参数使用）。",
            inputSchema: {},
            handler: async () => {
                const list = await run("get_classroom_list", "read", (h) => h.getClassroomList());
                return ok(list.map((c) => ({ name: c.name })));
            },
        }),
        tool({
            name: "thu_get_classroom_state",
            description:
                "查询教学楼空教室（按周/按天）。building 用楼名（如 六教），不确定就先调 thu_list_classroom_buildings。注意：学校系统只覆盖 1-6 节白天时段，晚间无数据。",
            inputSchema: {
                building: z.string().describe("教学楼名，如 六教"),
                week: z.number().int().optional().describe("周次，缺省当前周"),
                dayOfWeek: z.number().int().min(1).max(7).optional().describe("只看星期几（1=周一），缺省整周"),
            },
            handler: async ({ building, week, dayOfWeek }) => {
                const classrooms = await run("get_classroom_list", "read", (h) => h.getClassroomList());
                const target = classrooms.find((c) => c.name.includes(building) || building.includes(c.name.replace(/[区段]/g, "")));
                if (!target) {
                    return ok({ error: `未找到教学楼"${building}"`, available: classrooms.map((c) => c.name) });
                }
                const state = await run("get_classroom_state", "read", (h) =>
                    h.getClassroomState(target.searchName, week ?? target.weekNumber));
                const days = state.datesOfCurrentWeek.map((date, i) => {
                    const weekday = i + 1;
                    const rooms = state.classroomStates
                        .map((c) => {
                            const freePeriods: number[] = [];
                            for (let p = 0; p < 6; p++) {
                                if (c.status[i * 6 + p] === AVAILABLE) freePeriods.push(p + 1);
                            }
                            return { name: c.name, freePeriods };
                        })
                        .filter((c) => c.freePeriods.length > 0);
                    return { weekday, date, rooms };
                });
                return ok({
                    building: target.name,
                    week: week ?? state.currentWeekNumber,
                    days: dayOfWeek ? days.filter((d) => d.weekday === dayOfWeek) : days,
                    meaning: "freePeriods 是空着的节次（1-6 节 ≈ 白天 8:00-17:50）",
                });
            },
        }),
        tool({
            name: "thu_get_degree_program",
            description: "查询培养方案完成度：各课组要求学分与已修学分。",
            inputSchema: {},
            handler: async () => ok(await run("get_degree_program", "read", (h) => h.getDegreeProgramCompletion())),
        }),
        tool({
            name: "thu_get_cr_timetable",
            description: "查询选课时间轴：各选课阶段起止时间和提示（补退选窗口等）。",
            inputSchema: {},
            handler: async () => ok(await run("get_cr_timetable", "read", (h) => h.getCrTimetable())),
        }),
        tool({
            name: "thu_get_selected_courses",
            description: "查询已选课程列表。",
            inputSchema: { semesterId: z.string().optional().describe("学年学期，如 2026-2027-1，缺省校历当前学期") },
            handler: async ({ semesterId }) => {
                // 已选课程默认当前学期；CR 可选学期列表（latestSemester）在选课期外
                // 可能不含当前学期，只应给选课/退课等写操作用。
                const sem = semesterId ?? (await run("get_calendar", "read", (h) => h.getCalendar())).semesterId;
                if (!sem) return ok({ error: "没有可选学期" });
                const courses = await run("get_selected_courses", "read", (h) => h.getSelectedCourses(sem));
                return ok({ semesterId: sem, courses });
            },
        }),
        tool({
            name: "thu_search_courses",
            description: "搜索选课系统课程：开课信息与课余量（能看出还剩没有名额）。",
            inputSchema: {
                name: z.string().optional().describe("课程名关键词，如 大学物理"),
                id: z.string().optional().describe("课程号"),
                dayOfWeek: z.number().int().min(1).max(7).optional(),
                period: z.number().int().min(1).max(6).optional().describe("白天节次 1-6"),
                semesterId: z.string().optional(),
                page: z.number().int().optional(),
            },
            handler: async ({ name, id, dayOfWeek, period, semesterId, page }) => {
                const sem = semesterId ?? (await latestSemester());
                if (!sem) return ok({ error: "没有可选学期" });
                const result = await run("search_cr_courses", "read", (h) =>
                    h.searchCrCourses({ semester: sem, name, id, dayOfWeek, period, page: page ?? 1 } as never));
                return ok({ semesterId: sem, result });
            },
        }),
        tool({
            name: "thu_get_cr_status",
            description: "查询选课状态：当前阶段、我的排队情况、余量统计发布时间。",
            inputSchema: { semesterId: z.string().optional() },
            handler: async ({ semesterId }) => {
                const sem = semesterId ?? (await latestSemester());
                if (!sem) return ok({ error: "没有可选学期" });
                const [stage, queue, meta] = await Promise.all([
                    run("get_cr_current_stage", "read", (h) => h.getCrCurrentStage(sem)),
                    run("get_queue_info", "read", (h) => h.getQueueInfo(sem)).catch(() => null),
                    run("get_cr_priority_meta", "read", (h) => h.searchCoursePriorityMeta(sem)).catch(() => null),
                ]);
                return ok({ semesterId: sem, stage, queue, priorityMeta: meta });
            },
        }),
    ];
}
