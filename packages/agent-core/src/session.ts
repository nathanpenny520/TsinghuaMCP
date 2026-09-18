import os from "node:os";
import { authenticator } from "otplib";
import { InfoHelper } from "@thu-info/lib";
import type { Config } from "./config.js";
import { trustedDeviceName } from "./config.js";
import type { State } from "./state.js";

/**
 * Owns the process-wide Tsinghua session.
 *
 * Constraints inherited from @thu-info/lib that shape this class:
 *  - The lib's cookie jar is a process-global singleton → exactly one session
 *    per process. All requests are serialized through a promise queue.
 *  - There is no refresh token: expired sessions are healed by the lib's
 *    roamingWrapper (probe + full re-login), which needs userId/password in
 *    memory. `login()` is expensive (SM2 handshake + per-system roam), so we
 *    also run a periodic keepalive.
 */
export class SessionManager {
    readonly helper: InfoHelper;
    private loginPromise: Promise<void> | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private keepaliveTimer: NodeJS.Timeout | null = null;
    private lastLoginAt = 0;

    constructor(
        private config: Config,
        private state: State,
        /** headless=false lets hooks fall back to interactive prompts (CLI) */
        private interactive = false,
    ) {
        this.helper = new InfoHelper();
        this.helper.fingerprint = this.fingerprint();
        this.wireHooks();
    }

    /** Serialize every lib call: the cookie jar and roam flows are not concurrency-safe. */
    run<T>(label: string, risk: "read" | "write" | "write+pay", fn: (helper: InfoHelper) => Promise<T>): Promise<T> {
        const task = this.queue.then(async () => {
            await this.ensureLogin();
            const result = await fn(this.helper);
            this.state.logAction(label, undefined, { ok: true }, risk);
            return result;
        });
        // keep the queue alive even if a task rejects
        this.queue = task.catch(() => undefined);
        return task;
    }

    async ensureLogin(): Promise<void> {
        if (this.helper.userId !== "") return; // lib heals expired sessions itself
        if (!this.loginPromise) {
            this.loginPromise = this.login().finally(() => {
                this.loginPromise = null;
            });
        }
        await this.loginPromise;
    }

    private async login(): Promise<void> {
        const { userId, password, mock } = this.config;
        if (!userId || !password) {
            throw new Error(
                "缺少凭据：请在 .env 中配置 THU_USER_ID / THU_PASSWORD（或设 THU_AGENT_MOCK=1 使用 mock 账号）",
            );
        }
        await this.helper.login({ userId, password });
        this.lastLoginAt = Date.now();
        if (!mock) {
            // Register this fingerprint as a trusted device right away so that
            // subsequent logins skip 2FA entirely. The lib only asks once the
            // login succeeded with 2FA; trusting here is a no-op if already trusted.
        }
    }

    /** Hourly light touch to keep WebVPN/portal cookies warm; errors are non-fatal. */
    startKeepalive(intervalMs = 60 * 60 * 1000): void {
        if (this.keepaliveTimer) return;
        this.keepaliveTimer = setInterval(() => {
            if (this.helper.userId === "") return;
            this.run("keepalive", "read", (h) => h.getUserInfo()).catch(() => undefined);
        }, intervalMs);
        this.keepaliveTimer.unref();
    }

    stopKeepalive(): void {
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
    }

    sessionAgeMs(): number {
        return this.helper.userId === "" ? -1 : Date.now() - this.lastLoginAt;
    }

    isMock(): boolean {
        return this.helper.mocked();
    }

    /**
     * Stable per-installation fingerprint, persisted so that id.tsinghua.edu.cn
     * keeps recognizing this agent as a trusted device.
     */
    private fingerprint(): string {
        const pinned = this.config.fingerprint;
        if (pinned) {
            this.state.kvSet("fingerprint", pinned);
            return pinned;
        }
        const existing = this.state.kvGet("fingerprint");
        if (existing) return existing;
        const fp = crypto.randomUUID().replace(/-/g, "");
        this.state.kvSet("fingerprint", fp);
        return fp;
    }

    private totpCode(): string | undefined {
        const secret = this.config.totpSecret;
        if (!secret) return undefined;
        return authenticator.generate(secret);
    }

    /**
     * 当前 TOTP 码及其剩余有效秒数 — 用于配置后与手机验证器人工对码。
     */
    currentTotp(): { code: string; expiresInSec: number } | undefined {
        const code = this.totpCode();
        if (!code) return undefined;
        return { code, expiresInSec: authenticator.timeRemaining() };
    }

    private wireHooks(): void {
        const h = this.helper;

        h.loginErrorHook = (e) => {
            if (this.interactive) {
                console.error(`[登录失败] ${e.message}`);
            }
            // rethrow path: the lib surfaces the error to the caller anyway
        };

        h.twoFactorMethodHook = async (hasWeChat, _phone, hasTotp) => {
            if (hasTotp && this.config.totpSecret) return "totp";
            if (this.interactive && process.stdin.isTTY) {
                const { choice } = await prompt2faMethod(hasWeChat, hasTotp);
                return choice;
            }
            throw new Error(twoFactorGuidance(hasTotp));
        };

        h.twoFactorAuthHook = async () => {
            const code = this.totpCode();
            if (code) return code;
            if (this.interactive && process.stdin.isTTY) {
                return prompt("请输入二次认证验证码（6位数字）：");
            }
            throw new Error("无法获取二次认证验证码：缺少 TOTP 密钥且处于非交互模式。");
        };

        h.twoFactorAuthLimitHook = async () => {
            // Trusted-device slots are full; recycle an old agent device.
            await h.forgetDevice();
        };

        h.trustFingerprintHook = async () => true;
        h.trustFingerprintNameHook = async () => trustedDeviceName();

        h.clearCookieHandler = async () => {
            // hook for future browser-cookie bridge; nothing to clear server-side
        };
    }
}

function twoFactorGuidance(hasTotp: boolean): string {
    if (!hasTotp) {
        return (
            "服务器报告该账号未绑定 TOTP（动态口令），无法自动完成二次认证。" +
            "解决：① 到 id.tsinghua.edu.cn → 账户/安全设置 → 二次认证管理 绑定动态口令，" +
            "把绑定二维码里的 secret 填入 .env 的 THU_TOTP_SECRET；" +
            "② 或在真实终端运行 pnpm cli login，选择微信推送手动完成首次登录" +
            "（成功后本设备受信，后续免 2FA）。"
        );
    }
    return (
        "账号已支持 TOTP，但 .env 未配置 THU_TOTP_SECRET（绑定验证器二维码里的 secret）。" +
        "配置后即可全自动二次认证。"
    );
}

async function prompt2faMethod(
    hasWeChat: boolean,
    hasTotp: boolean,
): Promise<{ choice: "wechat" | "mobile" | "totp" | undefined }> {
    const options = [
        hasWeChat ? "1) 微信推送" : null,
        "2) 短信",
        hasTotp ? "3) 验证器(TOTP)" : null,
    ].filter(Boolean);
    const answer = await prompt(`选择二次认证方式（${options.join(" / ")}）：`);
    const map: Record<string, "wechat" | "mobile" | "totp"> = { "1": "wechat", "2": "mobile", "3": "totp" };
    return { choice: map[answer.trim()] ?? undefined };
}

function prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
        process.stdout.write(question);
        let buf = "";
        const onData = (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            if (buf.includes("\n")) {
                process.stdin.removeListener("data", onData);
                resolve(buf.trim());
            }
        };
        process.stdin.on("data", onData);
    });
}

export function describeHost(): string {
    return `${os.hostname()}/${os.platform()}`;
}
