import { loadConfig, SessionManager, State } from "@thu-agent/core";
import { runMonitors, runDigest, shouldDigest } from "./monitors.js";

/**
 * 常驻守护进程：会话保活 + 长程监控 + 每日摘要。
 * 监控规则由 agent 通过 MCP 工具（thu_add_news_watch 等）写入 SQLite，
 * 本进程每轮读取执行——agent 与 supervisor 通过 SQLite 解耦。
 */

const config = loadConfig();
const state = new State(config.dataDir);
const session = new SessionManager(config, state, false);

const MONITOR_INTERVAL_MIN = Number(process.env.THU_MONITOR_INTERVAL_MIN ?? 10);

async function main() {
    console.log(`[supervisor] 启动 (mock=${config.mock}, data=${config.dataDir}, 监控间隔=${MONITOR_INTERVAL_MIN}min)`);
    console.log(`[supervisor] 通知渠道: ${[config.notifyBark && "bark", config.notifyNtfy && "ntfy", config.notifyWebhook && "webhook"].filter(Boolean).join("+") || "无（仅日志）"}`);

    await session.ensureLogin();
    console.log("[supervisor] 会话已建立");
    session.startKeepalive(60 * 60 * 1000);

    let lastMonitorRun = 0;

    const tick = async () => {
        // 到点的监控轮
        if (Date.now() - lastMonitorRun >= MONITOR_INTERVAL_MIN * 60e3) {
            lastMonitorRun = Date.now();
            await runMonitors({ session, state, config });
        }
        // 每日摘要
        if (shouldDigest(state)) {
            await runDigest({ session, state, config });
        }
    };

    // 立即跑一轮，然后每分钟检查是否到点
    await tick().catch((e: Error) => console.log(`[supervisor] 首轮异常: ${e.message}`));
    const timer = setInterval(() => void tick().catch((e: Error) => console.log(`[supervisor] 轮询异常: ${e.message}`)), 60e3);
    timer.unref();

    const shutdown = (signal: string) => {
        console.log(`[supervisor] 收到 ${signal}，关闭`);
        session.stopKeepalive();
        state.close();
        process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e: Error) => {
    console.error(`[supervisor] 启动失败: ${e.message}`);
    process.exit(1);
});
