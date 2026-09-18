import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { State } from "@thu-agent/core";

/**
 * 权限管控自检 —— 完全离线：mock 模式 + 一次性临时数据目录。
 * 不做任何真实登录，不触碰任何真实写端点；被测对象是门禁本身。
 *
 *  1. fail-safe 分级检查：全部 64 工具已登记风险级别，默认配置下全部注册
 *  2. annotations：read 工具带 readOnlyHint，prepare 工具不带、destructive 标注正确
 *  3. maxRisk=read  ：只读模式，prepare/confirm/监控/网络写工具全部不可见
 *  4. maxRisk=write ：write+pay（充值/缴费/挂失）工具不可见
 *  5. confirm 纵深防御：maxRisk=write 下注入的 write+pay 待确认单被拒绝执行
 *  6. 确认短语门：缺短语/错短语的挂失 confirm 均被拒
 */

const ROOT = new URL("..", import.meta.url).pathname;

let pass = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = ""): void {
    if (cond) {
        pass++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    }
}

async function spawn(env: Record<string, string>): Promise<{ client: Client; close: () => Promise<void> }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thu-perm-"));
    const transport = new StdioClientTransport({
        command: "npx",
        args: ["tsx", "src/index.ts"],
        env: { ...process.env, THU_AGENT_MOCK: "1", THU_AGENT_DATA_DIR: dir, ...env },
        cwd: ROOT,
    });
    const client = new Client({ name: "thu-perm-check", version: "0.1.0" });
    await client.connect(transport);
    return { client, close: () => client.close() };
}

function names(tools: { name: string }[]): Set<string> {
    return new Set(tools.map((t) => t.name));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function text(res: any): string {
    const content = res?.content;
    if (!Array.isArray(content)) return "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("");
}

async function main() {
    // ── 1+2. 默认配置：全量注册 + annotations ─────────────────────────
    {
        const { client, close } = await spawn({});
        const { tools } = await client.listTools();
        check(`默认配置注册全量工具（${tools.length}）`, tools.length === 64, `实际 ${tools.length}`);
        const byName = new Map(tools.map((t) => [t.name, t]));
        check(
            "只读工具带 readOnlyHint=true",
            byName.get("thu_get_transcript")?.annotations?.readOnlyHint === true,
        );
        check(
            "prepare 工具 readOnlyHint=false 且破坏性类带 destructiveHint",
            byName.get("thu_prepare_select_course")?.annotations?.readOnlyHint === false &&
                byName.get("thu_prepare_delete_course")?.annotations?.destructiveHint === true &&
                byName.get("thu_prepare_select_course")?.annotations?.destructiveHint === false,
        );
        check(
            "confirm 工具 destructiveHint=true",
            byName.get("thu_confirm_action")?.annotations?.destructiveHint === true,
        );
        await close();
    }

    // ── 3. maxRisk=read：只读模式 ─────────────────────────────────────
    {
        const { client, close } = await spawn({ THU_AGENT_MAX_RISK: "read" });
        const set = names((await client.listTools()).tools);
        check(
            "read 模式：写工具全部不可见",
            [...set].every((n) => !n.startsWith("thu_prepare_") && n !== "thu_confirm_action" &&
                n !== "thu_usereg_login" && !n.startsWith("thu_add_") && n !== "thu_remove_monitor"),
            [...set].filter((n) => n.startsWith("thu_prepare_") || n === "thu_confirm_action").join(","),
        );
        check("read 模式：只读工具仍然可见", set.has("thu_get_transcript") && set.has("thu_context"));
        await close();
    }

    // ── 4. maxRisk=write：隐藏 write+pay ─────────────────────────────
    {
        const { client, close } = await spawn({ THU_AGENT_MAX_RISK: "write" });
        const set = names((await client.listTools()).tools);
        const payTools = [
            "thu_prepare_card_recharge",
            "thu_prepare_ele_recharge",
            "thu_prepare_sports_pay",
            "thu_prepare_sports_booking",
            "thu_prepare_card_report_loss",
            "thu_prepare_card_cancel_loss",
        ];
        check("write 模式：write+pay 工具全部隐藏", payTools.every((n) => !set.has(n)),
            payTools.filter((n) => set.has(n)).join(","));
        check("write 模式：普通写工具仍可见", set.has("thu_prepare_select_course") && set.has("thu_confirm_action"));
        await close();
    }

    // ── 5. confirm 纵深防御：write 模式拒绝执行 write+pay 待确认单 ────
    {
        // 在同一临时数据目录直接注入一条 write+pay pending（模拟旧配置遗留），
        // 再用 maxRisk=write 的 server 尝试 confirm —— 必须被代码级闸门拦下。
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thu-perm-"));
        const state = new State(dir);
        const code = state.createPending("card_recharge", { amount: 1 }, "write+pay", "perm-check 注入");
        const transport = new StdioClientTransport({
            command: "npx",
            args: ["tsx", "src/index.ts"],
            env: { ...process.env, THU_AGENT_MOCK: "1", THU_AGENT_DATA_DIR: dir, THU_AGENT_MAX_RISK: "write" },
            cwd: ROOT,
        });
        const client = new Client({ name: "thu-perm-check-gate", version: "0.1.0" });
        await client.connect(transport);
        const conf = await client.callTool({ name: "thu_confirm_action", arguments: { code } });
        check(
            "confirm 二次校验：write 模式拒绝执行 write+pay 动作",
            text(conf).includes("THU_AGENT_MAX_RISK"),
            text(conf).slice(0, 100),
        );
        await client.close();
    }

    // ── 6. 确认短语门（mock，真实端点不执行）──────────────────────────
    {
        const { client, close } = await spawn({});
        const pre = await client.callTool({ name: "thu_prepare_card_report_loss", arguments: {} });
        const code = (JSON.parse(text(pre)) as { confirmCode: string }).confirmCode;
        const noPhrase = await client.callTool({ name: "thu_confirm_action", arguments: { code } });
        check("缺确认短语 → 拒绝执行", text(noPhrase).includes("确认短语"), text(noPhrase).slice(0, 80));
        const badPhrase = await client.callTool({
            name: "thu_confirm_action",
            arguments: { code, confirmPhrase: "不挂失" },
        });
        check("错误确认短语 → 拒绝执行", text(badPhrase).includes("确认短语"), text(badPhrase).slice(0, 80));
        await client.callTool({ name: "thu_cancel_pending", arguments: { code } });
        await close();
    }

    console.log(`\n权限自检：${pass} 通过，${failed} 失败`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error("权限自检崩溃:", e);
    process.exit(1);
});
