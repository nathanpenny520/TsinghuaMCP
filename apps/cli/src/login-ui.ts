import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { loadConfig, SessionManager, State, saveSecrets, stripDotEnvSecrets, repoRoot } from "@thu-agent/core";
import type { Config } from "@thu-agent/core";

/**
 * `pnpm login` 图形化登录向导。
 *
 * 流程：本地起一个只监听 127.0.0.1 的临时页面（带随机路径防串扰）→ 浏览器
 * 里填学号/密码 → 需要时在页面上完成二次认证（微信/短信验证码；若粘贴了
 * TOTP secret 则全自动）→ 成功后把凭据写入 OS 凭据存储（macOS 钥匙串 /
 * Windows 凭据管理器），并提示清理 .env 里的明文凭据行。
 *
 * 凭据只经过内存，不落盘（除 OS 凭据存储本身）、不打日志、不回显到页面。
 */

type Phase =
    | { step: "form"; mockNote: string | null }
    | { step: "starting" }
    | { step: "2fa-method"; hasWeChat: boolean }
    | { step: "2fa-code"; method: string }
    | { step: "success"; stored: string[]; envCleanup: string }
    | { step: "error"; message: string };

const PAGE_TTL_MS = 30 * 60 * 1000; // 向导最长存活时间
const WAITER_TIMEOUT_MS = 5 * 60 * 1000; // 每一步等人操作的超时

export async function runLoginUi(): Promise<void> {
    // 向导默认永远走真实登录并保存凭据（这正是它的用途），临时压掉 mock 标记。
    // 试运行（走 mock 登录、不写凭据存储、不动 .env，用来验证页面流程）：
    //   THU_LOGIN_MOCK=1 pnpm login   （pnpm 会拦截 --mock 这类旗标，所以走环境变量）
    const forceMock = process.argv.includes("--mock") || process.env.THU_LOGIN_MOCK === "1";
    const envMock = process.env.THU_AGENT_MOCK === "1";
    const config: Config = loadConfig({ ...process.env, THU_AGENT_MOCK: forceMock ? "1" : "0" });
    const nonce = crypto.randomBytes(12).toString("hex");

    const mockNote = forceMock
        ? "mock 试运行：不真实登录、不保存凭据、不动 .env"
        : envMock
          ? "检测到 THU_AGENT_MOCK=1：本次仍真实登录并保存凭据，成功后自动移除该标记"
          : null;
    let phase: Phase = { step: "form", mockNote };
    let methodWaiter: ((m: "wechat" | "mobile") => void) | null = null;
    let codeWaiter: ((code: string) => void) | null = null;
    let finished = false;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1`);
        if (!url.pathname.startsWith(`/${nonce}`)) {
            res.writeHead(404).end();
            return;
        }
        const route = url.pathname.slice(nonce.length + 1);
        void handle(req, res, route).catch(() => res.writeHead(500).end("internal error"));
    });

    async function handle(req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<void> {
        if (route === "/" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(pageHtml(nonce));
            return;
        }
        if (route === "/api/state" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(phase));
            return;
        }
        if (route === "/api/login" && req.method === "POST") {
            const body = await readJson(req);
            if (phase.step !== "form") {
                res.writeHead(409, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "登录已在进行中，请刷新页面" }));
                return;
            }
            const userId = String(body.userId ?? "").trim();
            const password = String(body.password ?? "");
            const totpSecret = String(body.totpSecret ?? "").replace(/\s+/g, "").toUpperCase();
            const cardPassword = String(body.cardPassword ?? "");
            if (!userId || !password) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "学号和密码都要填" }));
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            phase = { step: "starting" }; // 同步置位，防并发二次提交
            void doLogin({ userId, password, totpSecret, cardPassword });
            return;
        }
        if (route === "/api/2fa-method" && req.method === "POST") {
            const body = await readJson(req);
            const method = body.method === "wechat" ? "wechat" : body.method === "mobile" ? "mobile" : null;
            if (phase.step !== "2fa-method" || !method) {
                res.writeHead(409, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "当前不在选择二次认证方式的阶段" }));
                return;
            }
            phase = { step: "2fa-code", method: method === "wechat" ? "微信推送" : "短信" };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            methodWaiter?.(method);
            methodWaiter = null;
            return;
        }
        if (route === "/api/2fa-code" && req.method === "POST") {
            const body = await readJson(req);
            const code = String(body.code ?? "").trim();
            if (phase.step !== "2fa-code" || !/^\d{6}$/.test(code)) {
                res.writeHead(409, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "请输入 6 位数字验证码" }));
                return;
            }
            phase = { step: "starting" };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            codeWaiter?.(code);
            codeWaiter = null;
            return;
        }
        if (route === "/api/finish" && req.method === "POST") {
            finished = true;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
        }
        res.writeHead(404).end();
    }

    function waiter<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
        let resolve!: (v: T) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            setTimeout(() => rej(new Error("等待操作超时（5 分钟无操作）")), WAITER_TIMEOUT_MS).unref();
        });
        return { promise, resolve };
    }

    async function doLogin(creds: { userId: string; password: string; totpSecret: string; cardPassword: string }): Promise<void> {
        try {
            // loadConfig 返回的是普通对象，SessionManager 按引用持有 —— 直接改字段即可。
            // mock 模式下不覆盖凭据：lib 认 8888 mock 账号，换别的学号会打到真实登录接口。
            if (!config.mock) {
                config.userId = creds.userId;
                config.password = creds.password;
                config.totpSecret = creds.totpSecret;
                if (creds.cardPassword) config.cardPassword = creds.cardPassword;
            }

            const state = new State(config.dataDir);
            const session = new SessionManager(config, state, true);

            // 覆盖 SessionManager 的终端交互 hooks：改成等浏览器操作。
            // 表单里给了 TOTP secret 时 method hook 自动选 totp，auth hook 自动出码，
            // 全程不经过浏览器；没给 secret 时才让用户在页面上选微信/短信并输码。
            const methodW = waiter<"wechat" | "mobile">();
            const codeW = waiter<string>();
            session.helper.twoFactorMethodHook = async (hasWeChat, _phone, hasTotp) => {
                if (hasTotp && config.totpSecret) return "totp";
                phase = { step: "2fa-method", hasWeChat };
                return await methodW.promise;
            };
            session.helper.twoFactorAuthHook = async () => {
                const auto = session.currentTotp();
                if (auto) return auto.code;
                return await codeW.promise;
            };
            methodWaiter = methodW.resolve;
            codeWaiter = codeW.resolve;

            await session.run("login-ui", "read", (h) => h.getUserInfo());

            if (forceMock) {
                phase = { step: "success", stored: [], envCleanup: "mock 试运行：未写入凭据存储，.env 未改动" };
            } else {
                const stored = saveSecrets({
                    userId: creds.userId,
                    password: creds.password,
                    totpSecret: creds.totpSecret || undefined,
                    cardPassword: creds.cardPassword || undefined,
                });
                const extra = envMock ? ["THU_AGENT_MOCK"] : [];
                const cleanup = stripDotEnvSecrets(repoRoot(), extra);
                const envCleanup = cleanup
                    ? `已从 .env 移除 ${cleanup.removed.join("、")}（备份：${cleanup.backupPath}）`
                    : ".env 里没有明文凭据，无需清理";
                phase = { step: "success", stored, envCleanup };
            }
            console.log("[login] 登录成功，凭据已保存。");
            state.close();
        } catch (e) {
            if (phase.step === "success") return; // 已成功，迟到的等待器超时不覆盖结果
            const msg = e instanceof Error ? e.message : String(e);
            // 兜底：错误信息理论上不含凭据，但保险起见过滤一遍
            phase = { step: "error", message: msg.replace(creds.password, "******") };
            console.error(`[login] 失败：${msg}`);
        }
    }

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            const url = `http://127.0.0.1:${port}/${nonce}/`;
            console.log(`登录向导已启动：${url}`);
            console.log("浏览器没有自动打开的话，手动访问上面的地址。");
            const opener =
                process.platform === "darwin"
                    ? `open "${url}"`
                    : process.platform === "win32"
                      ? `start "" "${url}"`
                      : `xdg-open "${url}"`;
            exec(opener, () => undefined);
            setTimeout(() => {
                console.log("[login] 向导超时退出。");
                process.exit(0);
            }, PAGE_TTL_MS).unref();
            const poll = setInterval(() => {
                if (finished) {
                    clearInterval(poll);
                    server.close(() => resolve());
                    process.exit(0);
                }
            }, 500);
            poll.unref();
        });
    });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
        req.on("end", () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

// ── 页面 ────────────────────────────────────────────────────────────

function pageHtml(nonce: string): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>thu-agent 登录</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; display: flex; justify-content: center; padding-top: 8vh; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08);
          padding: 32px 36px; width: 380px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 20px; }
  label { display: block; font-size: 13px; color: #444; margin: 14px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 10px; font-size: 15px;
          border: 1px solid #d0d3d8; border-radius: 8px; }
  input:focus { outline: 2px solid #6c5ce7; border-color: transparent; }
  button { margin-top: 20px; width: 100%; padding: 11px; font-size: 15px; border: 0;
           border-radius: 8px; background: #5754a8; color: #fff; cursor: pointer; }
  button:disabled { background: #b7b5d9; }
  button.ghost { background: #eef0f3; color: #444; margin-top: 10px; }
  .methods { display: flex; gap: 10px; margin-top: 16px; }
  .methods button { margin-top: 0; }
  .status { margin-top: 16px; font-size: 14px; color: #555; }
  .err { color: #c0392b; }
  .ok { color: #1e8e5a; }
  ul { padding-left: 20px; font-size: 14px; color: #444; }
  .note { font-size: 12px; color: #999; margin-top: 18px; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>thu-agent 登录</h1>
  <div class="sub">凭据只写入本机 OS 凭据存储（钥匙串/凭据管理器），不经手任何明文文件</div>
  <div id="mock" class="status err hidden"></div>
  <div id="view"></div>
  <div class="note">本页面只监听 127.0.0.1，进程退出后随机地址即失效。</div>
</div>
<script>
const BASE = "/${nonce}";
let busy = false;
async function api(path, body) {
  const r = await fetch(BASE + path, { method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function render(p) {
  const v = document.getElementById("view");
  const mockDiv = document.getElementById("mock");
  if (p.mockNote) { mockDiv.textContent = "⚠ " + p.mockNote; mockDiv.classList.remove("hidden"); }
  else mockDiv.classList.add("hidden");
  if (p.step === "form") {
    v.innerHTML = \`
      <label>学号</label><input id="userId" autocomplete="username">
      <label>INFO 门户密码（≈校园卡交易密码）</label><input id="password" type="password" autocomplete="current-password">
      <label>TOTP 密钥（选填，绑定过验证器可填，填了 2FA 全自动）</label><input id="totpSecret" placeholder="base32，如 JBSWY3DPEHPK3PXP">
      <label>校园卡交易密码（选填，与门户密码相同时不用填）</label><input id="cardPassword" type="password">
      <button id="go">登录</button><div class="status" id="msg"></div>\`;
    document.getElementById("go").onclick = submit;
    v.querySelectorAll("input").forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") submit(); }));
  } else if (p.step === "starting") {
    v.innerHTML = '<div class="status">正在登录（SM2 握手 + 各系统漫游，可能要十几秒）…</div>';
  } else if (p.step === "2fa-method") {
    v.innerHTML = \`
      <div class="status">需要二次认证，选择方式：</div>
      <div class="methods">
        \${p.hasWeChat ? '<button id="mWeChat">微信推送</button>' : ''}
        <button id="mSms">短信</button>
      </div>\`;
    const go = (m) => api("/api/2fa-method", { method: m }).catch(showErr);
    if (document.getElementById("mWeChat")) document.getElementById("mWeChat").onclick = () => go("wechat");
    document.getElementById("mSms").onclick = () => go("mobile");
  } else if (p.step === "2fa-code") {
    v.innerHTML = \`
      <div class="status">已发送（\${esc(p.method)}）。输入 6 位验证码：</div>
      <input id="code" inputmode="numeric" maxlength="6" style="margin-top:10px;letter-spacing:4px">
      <button id="go">提交</button><div class="status" id="msg"></div>\`;
    document.getElementById("code").focus();
    const go = () => api("/api/2fa-code", { code: document.getElementById("code").value }).catch(showErr);
    document.getElementById("go").onclick = go;
    document.getElementById("code").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  } else if (p.step === "success") {
    v.innerHTML = \`
      <div class="status ok">✅ 登录成功！</div>
      <ul>
        <li>已写入凭据存储：\${p.stored.length ? p.stored.map(esc).join("、") : "（mock 模式，跳过）"}</li>
        <li>\${esc(p.envCleanup)}</li>
        <li>本设备已注册为受信设备，之后登录不再需要二次认证</li>
      </ul>
      <button id="done">完成</button>
      <div class="status">重启 thu-agent 服务/客户端后生效（pnpm httpd restart，或重启 Claude 会话）。</div>\`;
    document.getElementById("done").onclick = () => api("/api/finish", {}).then(() => window.close());
  } else if (p.step === "error") {
    v.innerHTML = \`
      <div class="status err">登录失败：\${esc(p.message)}</div>
      <button id="retry">返回重试</button>\`;
    document.getElementById("retry").onclick = () => location.reload();
  }
}
function showErr(e) { const m = document.getElementById("msg"); if (m) m.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
async function submit() {
  if (busy) return; busy = true;
  try {
    await api("/api/login", {
      userId: document.getElementById("userId").value,
      password: document.getElementById("password").value,
      totpSecret: document.getElementById("totpSecret").value,
      cardPassword: document.getElementById("cardPassword").value,
    });
  } catch (e) { showErr(e); }
  busy = false;
}
let lastKey = "";
async function poll() {
  try {
    const p = await api("/api/state");
    const k = JSON.stringify(p);
    if (k !== lastKey) { lastKey = k; render(p); }  // 阶段没变就不重建 DOM，否则正在输入的内容会被轮询清掉
  } catch {}
}
poll();
setInterval(poll, 700);
</script>
</body>
</html>`;
}
