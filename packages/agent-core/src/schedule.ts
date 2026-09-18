import dayjs from "dayjs";
import { ScheduleType } from "@thu-info/lib/dist/models/schedule/schedule.js";
import type { Schedule } from "@thu-info/lib/dist/models/schedule/schedule.js";

/** 用 getSchedule 的 calendar 数据计算当前是第几周（1 起；假期为负或超界） */
export function weekOf(firstDay: string, weekCount: number, now = dayjs()): number {
    void weekCount;
    return Math.floor(now.startOf("day").diff(dayjs(firstDay).startOf("day"), "day") / 7) + 1;
}

export const TYPE_NAME: Record<ScheduleType, string> = {
    [ScheduleType.PRIMARY]: "课程",
    [ScheduleType.SECONDARY]: "二级课",
    [ScheduleType.EXAM]: "考试",
    [ScheduleType.CUSTOM]: "自定义",
};

export interface Occurrence {
    date: string; // yyyy-MM-dd
    weekday: number; // 1-7
    begin: string; // HH:mm
    end: string; // HH:mm
    name: string;
    location: string;
    type: string;
}

/** 把课表按周展平成"某周某天的课次"列表（课表的时间片带绝对日期） */
export function flattenWeek(schedules: Schedule[], firstDay: string, week: number): Occurrence[] {
    const start = dayjs(firstDay).startOf("day").add((week - 1) * 7, "day");
    const end = start.add(6, "day");
    const out: Occurrence[] = [];
    for (const s of schedules) {
        for (const slice of s.activeTime.base) {
            const d = dayjs(slice.beginTime);
            if (d.isBefore(start) || d.isAfter(end)) continue;
            out.push({
                date: d.format("YYYY-MM-DD"),
                weekday: slice.dayOfWeek,
                begin: d.format("HH:mm"),
                end: dayjs(slice.endTime).format("HH:mm"),
                name: s.name,
                location: s.location,
                type: TYPE_NAME[s.type] ?? String(s.type),
            });
        }
    }
    return out.sort((a, b) => (a.date + a.begin).localeCompare(b.date + b.begin));
}

/** 某一天的课次 */
export function flattenDay(schedules: Schedule[], date: string): Occurrence[] {
    const out: Occurrence[] = [];
    for (const s of schedules) {
        for (const slice of s.activeTime.base) {
            if (dayjs(slice.beginTime).format("YYYY-MM-DD") !== date) continue;
            out.push({
                date,
                weekday: slice.dayOfWeek,
                begin: dayjs(slice.beginTime).format("HH:mm"),
                end: dayjs(slice.endTime).format("HH:mm"),
                name: s.name,
                location: s.location,
                type: TYPE_NAME[s.type] ?? String(s.type),
            });
        }
    }
    return out.sort((a, b) => a.begin.localeCompare(b.begin));
}
