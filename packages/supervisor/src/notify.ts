import type { Config } from "@thu-agent/core";

/**
 * 通知器：把事件推给用户。支持三种渠道（在 .env 配置，可同时用）：
 *  - Bark（iOS）：THU_NOTIFY_BARK=https://api.day.app/<key>
 *  - ntfy：      THU_NOTIFY_NTFY=https://ntfy.sh/<topic>
 *  - 通用 webhook：THU_NOTIFY_WEBHOOK=<url>（POST JSON {title, body}）
 * 都没配时只打日志（监控仍在跑，历史可从 action_log 查）。
 */
export async function notify(config: Config, title: string, body: string): Promise<void> {
    const results: string[] = [];

    if (config.notifyBark) {
        try {
            const url = `${config.notifyBark.replace(/\/$/, "")}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=thu-agent`;
            const res = await fetch(url);
            results.push(`bark:${res.ok ? "ok" : res.status}`);
        } catch (e) {
            results.push(`bark:${(e as Error).message}`);
        }
    }

    if (config.notifyNtfy) {
        try {
            const res = await fetch(config.notifyNtfy, {
                method: "POST",
                headers: { Title: encodeURIComponent(title), Tags: "school" },
                body,
            });
            results.push(`ntfy:${res.ok ? "ok" : res.status}`);
        } catch (e) {
            results.push(`ntfy:${(e as Error).message}`);
        }
    }

    if (config.notifyWebhook) {
        try {
            const res = await fetch(config.notifyWebhook, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, body }),
            });
            results.push(`webhook:${res.ok ? "ok" : res.status}`);
        } catch (e) {
            results.push(`webhook:${(e as Error).message}`);
        }
    }

    const line = `[notify] ${title} — ${body}${results.length ? ` (${results.join(", ")})` : " (未配置通知渠道，仅记录)"}`;
    console.log(line);
}
