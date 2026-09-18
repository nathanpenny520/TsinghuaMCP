import type { RiskLevel } from "@thu-agent/core";

/**
 * 工具风险分级表 —— 全部非只读工具的唯一登记处。
 *
 * 规则（fail-safe）：
 *  - 名字命中 READ_PREFIXES 的工具默认按 read 处理；
 *  - 其余工具必须在此登记，漏登记 → index.ts 启动时直接拒绝启动；
 *  - 新增写工具时先来这里登记 risk（必要时 destructive），否则 server 起不来。
 *
 * 分级语义：
 *  - read      : 只读上游/本地，不改变任何状态
 *  - write     : 改变上游状态（选课/预约/发信/会话）或本地规则库
 *  - write+pay : 涉及资金或卡片资金状态（充值/缴费/挂失）
 */

export interface ToolRisk {
    risk: RiskLevel;
    /** 破坏性操作（退课/挂失/删除/取消类）→ 客户端权限 UI 会更强提示 */
    destructive?: boolean;
}

const READ_PREFIXES = ["thu_get_", "thu_list_", "thu_search_", "thu_context"];

export const TOOL_RISK: Record<string, ToolRisk> = {
    // ── 确认流 ──────────────────────────────────────────────────────
    // confirm 执行什么由 pending 记录决定（可能含 write+pay），
    // 这里按 write 登记；write+pay 的拦截在 confirm 处理器内二次校验。
    thu_confirm_action: { risk: "write", destructive: true },
    thu_cancel_pending: { risk: "write" },
    thu_list_pending: { risk: "read" },

    // ── 选课 ────────────────────────────────────────────────────────
    thu_prepare_select_course: { risk: "write" },
    thu_prepare_delete_course: { risk: "write", destructive: true },
    thu_prepare_change_will: { risk: "write" },
    thu_prepare_set_pf: { risk: "write" },

    // ── 图书馆 ──────────────────────────────────────────────────────
    thu_prepare_book_seat: { risk: "write" },
    thu_prepare_cancel_seat_booking: { risk: "write", destructive: true },
    thu_prepare_book_room: { risk: "write" },
    thu_prepare_cancel_room_booking: { risk: "write", destructive: true },

    // ── 日程 ────────────────────────────────────────────────────────
    thu_prepare_add_schedule_entry: { risk: "write" },
    thu_prepare_delete_schedule_entry: { risk: "write", destructive: true },

    // ── 邮件 / 新闻 ─────────────────────────────────────────────────
    thu_prepare_send_mail: { risk: "write" },
    thu_prepare_add_news_subscription: { risk: "write" },
    thu_prepare_remove_news_subscription: { risk: "write", destructive: true },

    // ── 体育（订场/付款涉及资金）───────────────────────────────────
    thu_prepare_sports_booking: { risk: "write+pay" },
    thu_prepare_sports_unsubscribe: { risk: "write", destructive: true },
    thu_prepare_sports_pay: { risk: "write+pay" },

    // ── 宿舍电费 / 校园卡（资金类，全部 write+pay）──────────────────
    thu_prepare_ele_recharge: { risk: "write+pay" },
    thu_prepare_card_recharge: { risk: "write+pay" },
    thu_prepare_card_report_loss: { risk: "write+pay", destructive: true },
    thu_prepare_card_cancel_loss: { risk: "write+pay" },

    // ── 网络 / 监控 ─────────────────────────────────────────────────
    thu_usereg_login: { risk: "write" },
    thu_add_course_watch: { risk: "write" },
    thu_add_news_watch: { risk: "write" },
    thu_remove_monitor: { risk: "write", destructive: true },

    // ── 不带 read 前缀的只读工具（显式登记以满足 fail-safe 校验）────
    thu_find_study_rooms: { risk: "read" },
    thu_get_captcha: { risk: "read" },
};

/** 查工具风险；未登记的工具一律默认最高警惕，由 assertClassified 保证不出现 */
export function toolRisk(name: string): ToolRisk {
    return TOOL_RISK[name] ?? { risk: "read" };
}

/**
 * fail-safe 启动检查：任何不属于已知只读前缀、又未在 TOOL_RISK 登记的工具
 * 都视为"未定级的高危"，直接拒绝启动，绝不允许静默按 read 暴露。
 */
export function assertClassified(names: string[]): void {
    const unclassified = names.filter(
        (n) => !TOOL_RISK[n] && !READ_PREFIXES.some((p) => n.startsWith(p)),
    );
    if (unclassified.length > 0) {
        throw new Error(
            `以下工具未做风险分级，拒绝启动（请到 src/risk.ts 补登记）：${unclassified.join(", ")}`,
        );
    }
}
