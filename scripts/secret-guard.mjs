#!/usr/bin/env node
/**
 * Claude Code PreToolUse guard —— 防止 AI 把凭据捞进对话记录。
 *
 * 注册方式（见 scripts/secret-guard.settings-snippet.json）：matcher 为 Bash，
 * 每条 Bash 命令执行前会以 stdin JSON 调用本脚本；exit 2 = 拦截（stderr 会
 * 展示给模型），exit 0 = 放行。解析失败时放行（fail-open，护栏不阻塞正常工作）。
 *
 * 拦的是"命令文本"层面的高风险模式，属于防误读护栏而非对抗性防线。
 */
import fs from "node:fs";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
    let cmd = "";
    try {
        const input = JSON.parse(raw || "{}");
        cmd = String(input?.tool_input?.command ?? "");
    } catch {
        process.exit(0); // fail-open
    }
    if (!cmd) process.exit(0);

    // .env.example 是模板、不含真实凭据，先剔除再判定
    const cmdNoExample = cmd.replace(/\.env\.example/g, "");

    const checks = [
        { re: /generic-password|dump-keychain|Library\/Keychains/, why: "钥匙串/keychain 查询" },
        { re: /PasswordVault|CredRead|CredWrite|\bcmdkey\b/, why: "Windows 凭据管理器查询" },
        // 只拦“可执行调用形态”（require/import），纯文本提及包名不算
        {
            re: /require\(\s*['"](keytar|@napi-rs\/keyring)['"]|from\s+['"](keytar|@napi-rs\/keyring)['"]/,
            why: "凭据存储库调用",
        },
        { re: /\bTHU_(PASSWORD|TOTP_SECRET|CARD_PASSWORD|USER_ID|NOTIFY_BARK)\b/, why: "凭据类环境变量" },
        { re: /(^|[^\w.])\.env/, why: "访问 .env（真实凭据曾存于此）" },
    ];

    for (const { re, why } of checks) {
        if (re.test(cmdNoExample)) {
            process.stderr.write(
                `[secret-guard] 已拦截：该命令涉及${why}，凭据应只经 OS 凭据存储（pnpm login-ui）。` +
                    `如确有需要（例如开发调试），请在 ~/.claude/settings.json 中调整本 hook。\n` +
                    `[secret-guard] 命令：${cmd.slice(0, 200)}\n`,
            );
            process.exit(2);
        }
    }
    process.exit(0);
});
// 防御性兜底：stdin 意外挂起时不阻塞工具调用
setTimeout(() => process.exit(0), 3000).unref();
