import { loadConfig, SessionManager, State } from "@thu-agent/core";

function usage(): never {
    console.log(`用法: pnpm cli <命令>

命令:
  status    会话状态（登录与否、mock 模式、数据目录）
  smoke     mock 模式全只读工具冒烟测试（离线）
  login     真实登录测试（读取 .env 凭据，验证 SM2 登录 + roam）
  totp      生成当前二次认证码（与手机验证器App对码，验证 THU_TOTP_SECRET 配置正确）
  totp-test 12种TOTP参数组合全扫描（手机码和agent码不一致时用来定位参数）
`);
    process.exit(1);
}

async function main() {
    const cmd = process.argv[2];
    if (!cmd) usage();

    const config = loadConfig();
    const state = new State(config.dataDir);
    const session = new SessionManager(config, state, true);

    switch (cmd) {
        case "status": {
            console.log(`mock 模式: ${config.mock ? "是" : "否"}`);
            console.log(`数据目录:  ${config.dataDir}`);
            console.log(`凭据:      ${config.userId ? `已配置 (${config.userId})` : "未配置"}`);
            console.log(`TOTP:      ${config.totpSecret ? "已配置" : "未配置"}`);
            console.log(`会话:      ${session.sessionAgeMs() >= 0 ? "已建立" : "未登录"}`);
            break;
        }
        case "smoke": {
            // 冒烟测试是离线的：强制 mock 模式，不依赖 .env
            const smokeConfig = loadConfig({ ...process.env, THU_AGENT_MOCK: "1" });
            const smokeState = new State(smokeConfig.dataDir);
            const smokeSession = new SessionManager(smokeConfig, smokeState, false);
            const { runSmoke } = await import("./smoke.js");
            process.exitCode = await runSmoke(smokeSession);
            smokeState.close();
            break;
        }
        case "login": {
            if (config.mock) {
                console.log("当前是 mock 模式（THU_AGENT_MOCK=1），改用真实凭据请 unset 该变量。");
            }
            const t0 = Date.now();
            await session.run("login", "read", (h) => h.getUserInfo());
            console.log(`登录并校验成功，耗时 ${Date.now() - t0}ms`);
            break;
        }
        case "totp": {
            const t = session.currentTotp();
            if (!t) {
                console.log("未配置 THU_TOTP_SECRET。获取方式见 .env.example 顶部说明。");
                break;
            }
            console.log(`当前验证码: ${t.code}（${t.expiresInSec}s 后刷新）`);
            console.log("与手机验证器 App 显示一致 = secret 配置正确。");
            break;
        }
        case "totp-test": {
            const { runTotpTest } = await import("./totp-test.js");
            runTotpTest(config.totpSecret);
            break;
        }
        case "check": {
            // 真实环境数据源抽查：门户 / 校历 / 校园卡 / 课表 / 宿舍电费
            type Helper = Parameters<Parameters<typeof session.run>[2]>[0];
            const probes: [string, (h: Helper) => Promise<unknown>][] = [
                ["门户身份", (h) => h.getUserInfo()],
                ["校历", (h) => h.getCalendar()],
                ["校园卡", (h) => h.getCampusCardInfo()],
                ["课表", async (h) => ({ 课程数: (await h.getSchedule()).schedule.length })],
                ["宿舍电费", (h) => h.getEleRemainder()],
            ];
            for (const [label, fn] of probes) {
                try {
                    const r = await session.run(`check:${label}`, "read", fn);
                    console.log(`✓ ${label}: ${JSON.stringify(r).slice(0, 120)}`);
                } catch (e) {
                    console.log(`✗ ${label}: ${(e as Error).message.slice(0, 120)}`);
                }
            }
            break;
        }
        default:
            usage();
    }
    state.close();
}

main().catch((e: Error) => {
    console.error(`错误: ${e.message}`);
    process.exit(1);
});
