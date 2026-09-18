import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Central configuration, sourced from environment variables (loaded via
 * `node --env-file=.env` or a real process environment).
 *
 * Keep this the single place that reads process.env for credentials.
 */

/** 工具风险级别：read=只读；write=改上游/本地状态；write+pay=涉及资金或卡片状态 */
export type RiskLevel = "read" | "write" | "write+pay";

export const RISK_LEVELS: RiskLevel[] = ["read", "write", "write+pay"];

export function riskRank(r: RiskLevel): number {
    return RISK_LEVELS.indexOf(r);
}

export interface Config {
    userId: string;
    password: string;
    /** base32 TOTP secret for 二次认证; empty means 2FA cannot be auto-solved */
    totpSecret: string;
    /** 校园卡交易密码 — only needed by high-risk card operations */
    cardPassword: string;
    /** true when running against the built-in mock account (8888) */
    mock: boolean;
    /** directory holding state.sqlite and other durable agent state */
    dataDir: string;
    /** optional manually-pinned device fingerprint (32 hex chars) */
    fingerprint?: string;
    /**
     * 本进程允许暴露/执行的最高风险级别（env THU_AGENT_MAX_RISK，默认 write+pay）。
     * 调低后：更高风险的工具不注册，且 confirm 阶段二次校验拒绝执行。
     */
    maxRisk: RiskLevel;
    // ── supervisor 通知与监控 ──────────────────────────────────────────
    /** Bark 推送基底，如 https://api.day.app/yourkey */
    notifyBark?: string;
    /** ntfy 主题完整 URL，如 https://ntfy.sh/my-topic */
    notifyNtfy?: string;
    /** 通用 webhook（POST JSON {title, body}） */
    notifyWebhook?: string;
    /** 校园卡余额提醒阈值（元），默认 50 */
    cardThreshold: number;
    /** 宿舍电费提醒阈值（度），默认 30 */
    eleThreshold: number;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * Minimal .env loader (zero-dep). Real environment variables always win.
 * Loads <repo>/.env once per process so that every entrypoint (CLI, MCP
 * server, supervisor) shares the same credential source.
 */
function loadDotEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = { ...env };
    try {
        const raw = fs.readFileSync(path.join(REPO_ROOT, ".env"), "utf8");
        for (const line of raw.split("\n")) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
            if (!m) continue;
            const key = m[1];
            const value = m[2].replace(/^["']|["']$/g, "");
            if (merged[key] === undefined || merged[key] === "") merged[key] = value;
        }
    } catch {
        // no .env — fine, mock mode or real env vars
    }
    return merged;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    env = loadDotEnv(env);
    const mock = env.THU_AGENT_MOCK === "1" || env.THU_AGENT_MOCK === "true";
    const maxRiskRaw = env.THU_AGENT_MAX_RISK ?? "write+pay";
    if (!RISK_LEVELS.includes(maxRiskRaw as RiskLevel)) {
        throw new Error(`THU_AGENT_MAX_RISK 无效: "${maxRiskRaw}"（可选 ${RISK_LEVELS.join(" / ")}）`);
    }
    const userId = mock ? "8888" : env.THU_USER_ID ?? "";
    const password = mock ? "8888" : env.THU_PASSWORD ?? "";
    const dataDir = env.THU_AGENT_DATA_DIR
        ? path.resolve(env.THU_AGENT_DATA_DIR)
        : // default: <repo>/data — resolved relative to this package, stable no matter the cwd
          path.resolve(import.meta.dirname, "../../../data");
    fs.mkdirSync(dataDir, { recursive: true });
    return {
        userId,
        password,
        totpSecret: (env.THU_TOTP_SECRET ?? "").replace(/\s+/g, "").toUpperCase(),
        // 清华一码通：校园卡交易密码与统一身份认证密码相同（若未单独设置）。
        // 因此 .env 里的 THU_PASSWORD 实际等效于卡密——务必保持本机文件权限收紧。
        cardPassword: env.THU_CARD_PASSWORD || password,
        mock,
        maxRisk: maxRiskRaw as RiskLevel,
        dataDir,
        fingerprint: env.THU_FINGERPRINT?.replace(/-/g, "") || undefined,
        notifyBark: env.THU_NOTIFY_BARK || undefined,
        notifyNtfy: env.THU_NOTIFY_NTFY || undefined,
        notifyWebhook: env.THU_NOTIFY_WEBHOOK || undefined,
        cardThreshold: Number(env.THU_CARD_THRESHOLD ?? 50),
        eleThreshold: Number(env.THU_ELE_THRESHOLD ?? 30),
    };
}

/** Device label registered as a trusted device on id.tsinghua.edu.cn. */
export function trustedDeviceName(): string {
    // MUST keep the "THU Info APP" prefix: lib's forgetDevice() only recycles
    // trusted devices whose name starts with that string.
    return `THU Info APP (thu-agent@${os.hostname()})`;
}
