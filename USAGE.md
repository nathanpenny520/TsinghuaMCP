# USAGE — 把清华事务挂进你的 AI

一个本机 MCP server，暴露 **64 个工具**，让本机 AI 客户端（Claude Code、Claude
Desktop、Cursor、Codex CLI 等）帮你查事务、办事务、盯事务。读操作直接执行；
写操作两段式确认；资金类还有进程级闸门。本指南面向"想把它接进自己 AI"的使用者。

---

## 0. 开始前必读（安全须知）

- **密码即卡密**：清华一码通，`INFO 门户密码 ≈ 校园卡交易密码`。密码泄漏 ≈
  卡内资金可被操作。因此**凭据不进任何明文文件**：默认走 OS 凭据存储
  （macOS 钥匙串 / Windows 凭据管理器），见 §1 的 `pnpm login-ui`。
- **写操作不是提示词约定，是代码强制**：任何写动作必须先 `prepare`（锁定参数、
  生成 5 分钟确认码）→ 你在对话里明确同意 → `confirm` 才会执行。参数在
  prepare 时锁定，confirm 无法篡改。高危动作（退课/挂失/解挂）额外要求你
  **原样说出确认短语**（如"确认挂失"）。
- **资金操作天然有人工闸**：充值/缴费类确认后返回的是支付宝付款码，钱由你
  本人扫码支付，AI 无法替你付。
- **一切调用有审计**：SQLite `action_log` 留痕（谁在何时调了什么）。
- **最小权限可用**：`THU_AGENT_MAX_RISK` 可把 server 限制成只读或隐藏资金类
  工具（见 §4），给不信任的客户端用时建议调低。

---

## 1. 环境准备

要求：Node.js ≥ 22、pnpm。

```bash
git clone <你的仓库地址> Tsinghua-agent   # 或已有仓库直接进入
cd Tsinghua-agent
pnpm install
pnpm build:lib     # 编译 vendored 协议库（仅首次需要）
```

### 配置凭据（图形化向导，推荐）

```bash
pnpm login-ui
```

会自动打开浏览器，在本地页面（只监听 127.0.0.1，带随机路径）里：

1. 填学号、门户密码；可选填 TOTP 密钥（填了 2FA 全自动）和单独的卡密；
2. 需要二次认证时在页面上选微信推送/短信并输入验证码；
3. 成功后凭据自动写入 **OS 凭据存储**，并自动清理 `.env` 里的明文凭据行
   （备份到 `.env.bak`）。本设备同时注册为受信设备——之后登录不再需要
   二次认证，会话过期时 agent 用存储的凭据静默重登。

密码只经过内存与 OS 凭据存储，不落明文盘、不进日志。想换号/撤销就用
`pnpm cli login` 重登，或删掉凭据存储里的 `thu-agent` 条目。

> 试跑向导页面而不真实登录：`THU_LOGIN_MOCK=1 pnpm login-ui`。

### 迁移期回退（不推荐）

`.env` 里的 `THU_USER_ID` / `THU_PASSWORD` / `THU_TOTP_SECRET` /
`THU_CARD_PASSWORD` 仍然生效（优先级低于凭据存储），用于还没跑向导的老环境；
跑一次 `pnpm login-ui` 即可彻底移除。`.env` 现在只放非敏感配置
（`THU_AGENT_MOCK`、阈值、通知渠道等）。

**真实使用前把 `.env` 里的 `THU_AGENT_MOCK` 改为 `0`**（示例文件里默认 `1`
是离线假数据模式；向导成功后会自动移除该标记）。

首次登录验证（真实交互）：

```bash
pnpm cli login    # 用已存凭据真实登录，验证 SM2 登录 + roam
pnpm cli check    # 五路真实数据源抽查（成绩/课表/卡/电费/校历）
pnpm cli status   # 查看配置、凭据来源与会话状态
```

### AI 侧防误读加固（可选，推荐）

`pnpm login-ui` 之后明文凭据已不存在，但 OS 凭据存储里的条目理论上仍可被
同用户进程查询。给 Claude Code 加两道闸（防 AI 手滑把凭据捞进对话记录）：

1. `permissions.deny`：禁止 Read/Edit/Write `**/.env` 与凭据存储目录；
2. PreToolUse hook：Bash 命令里出现 `find-generic-password`、`THU_PASSWORD`、
   `cat .env` 等模式时直接拒绝执行。

安装（仓库自带脚本）：

```bash
mkdir -p ~/.claude/hooks && cp scripts/secret-guard.mjs ~/.claude/hooks/
# 然后按 scripts/secret-guard.settings-snippet.json 合并进 ~/.claude/settings.json
```

hook 只是防误读的护栏，不是对抗性防线：AI 仍可能在你批准权限时做别的事，
弹出的授权请求看清楚再点。

### 公开仓库防泄露（本仓库适用）

仓库是公开的，防泄露分四层，前三层已内置：

1. **架构层**：密码/TOTP/卡密只在 OS 凭据存储，根本不进仓库；`.env` 只放
   非敏感配置，且被 `.gitignore` 排除。
2. **提交闸**（pre-commit，已启用）：`git config core.hooksPath scripts/githooks`
   已设置——每次提交自动扫描暂存内容，疑似真实凭据（`THU_*` 带值、
   api.day.app/ntfy.sh 真实 URL）直接拒绝。文档占位请写空值或"你的key"样式。
3. **自检**：`bash scripts/scan-history-secrets.sh` 可随时全量扫描全部历史
   （2026-09-19 首次审计：零泄露）。clone 新机器后建议先跑一次。
4. **人这一层**：扫描器拦不住"手动把真实值粘贴进文档/issue/截图"——
   GitHub 侧建议顺手开启 Settings → Code security → Push protection。

紧急预案：万一真实凭据入库，处置顺序 = 立刻换密钥（Bark 换 key 重装即可、
THU 密码去 change.tsinghua.edu.cn 改、TOTP 解绑重绑）→ 再清 git 历史
（filter-repo）→ 强推。密钥作废优先于清史。

### Windows 用户

全流程支持，差异如下：

| 环节 | macOS | Windows |
|---|---|---|
| 凭据存储 | 钥匙串（Keychain） | 凭据管理器（控制面板 → 凭据管理器 → Windows 凭据，条目名 `thu-agent`；不随微软账户漫游） |
| 登录向导 | `open` 打开浏览器 | `start` 打开浏览器，其余完全一致 |
| 常驻 daemon | launchd | 任务计划程序（`schtasks`）或 NSSM 包一层 `pnpm httpd` |
| Claude Code 沙箱 | Seatbelt 可用 | 无沙箱实现，防误读更依赖上面的 hook + deny（两者在 Windows 同样可用） |

注意：Windows 凭据管理器没有 macOS 那样的"应用访问确认"弹层，同用户进程
可静默读取，因此 Windows 上 hook/deny 加固建议从"可选"升级为"必做"。

---

## 2. 接入你的 AI 客户端

server 启动命令（stdio 传输，把路径换成你的实际仓库路径）：

```bash
pnpm --dir /path/to/Tsinghua-agent --filter @thu-agent/mcp-server start
```

> server 可从任意目录启动：数据目录默认解析到仓库内 `data/`，与当前工作目录
> 无关。

### Claude Code

在本仓库内开发时：仓库根已带 [.mcp.json](.mcp.json)，启动 Claude Code 启用
`thu-agent` 即可。

在**其他项目/任意目录**使用：

```bash
claude mcp add thu-agent -- pnpm --dir /path/to/Tsinghua-agent --filter @thu-agent/mcp-server start
```

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "thu-agent": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/Tsinghua-agent", "--filter", "@thu-agent/mcp-server", "start"]
    }
  }
}
```

### Cursor

编辑 `~/.cursor/mcp.json`（全局）或项目内 `.cursor/mcp.json`，格式同上。

### Codex CLI

```bash
codex mcp add thu-agent -- pnpm --dir /path/to/Tsinghua-agent --filter @thu-agent/mcp-server start
```

或编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.thu-agent]
command = "pnpm"
args = ["--dir", "/path/to/Tsinghua-agent", "--filter", "@thu-agent/mcp-server", "start"]

[mcp_servers.thu-agent.env]
THU_AGENT_MAX_RISK = "read"   # 给第三方模型建议只读
```

### 豆包桌面版（HTTP 连接器）

豆包只支持 HTTP 传输，用本机 HTTP 入口（`packages/mcp-server/src/http.ts`）。

**① 启动服务**（`pnpm httpd`，等价于 `bash scripts/httpd.sh`）：

```bash
pnpm httpd start     # 后台启动（日志: data/http-server.log）
pnpm httpd status    # 查看状态（含 endpoint 健康检查）
pnpm httpd restart   # 重启（改 .env 配置后用它生效）
pnpm httpd stop      # 停止
```

配置（读 `.env`，也可启动前用环境变量覆盖）：
- `THU_HTTP_PORT`（默认 `9876`）、`THU_HTTP_TOKEN`（可选共享口令）
- `THU_AGENT_MOCK=0`（真实数据）、`THU_AGENT_MAX_RISK=read`（见 §3）

**② 豆包"新建自定义连接器"里填**：

| 字段 | 值 |
|---|---|
| 服务器名称 | `thu-agent` |
| 传输类型 | HTTP |
| 服务器 URL | `http://127.0.0.1:9876/mcp` |
| 自定义 Headers | 留空（若设了 `THU_HTTP_TOKEN`，加 `Authorization: Bearer <值>`） |

**③ 开机自启（可选，launchd）**：

```bash
cp scripts/com.thu-agent.mcp-http.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.thu-agent.mcp-http.plist
# 卸载: launchctl unload ~/Library/LaunchAgents/com.thu-agent.mcp-http.plist
```

注意：用 launchd 常驻后**不要再 `pnpm httpd start/stop` 手动开关**（launchd 会自动拉活），
改配置后用 `launchctl kickstart -k gui/$(id -u)/com.thu-agent.mcp-http` 重启；
`pnpm httpd status` 仍可用于查看。

**安全说明**：仅监听 `127.0.0.1`，凭据与学校会话不出本机；**豆包等第三方模型
建议保持 `THU_AGENT_MAX_RISK=read`**（当前 .env 即是）——26 个写/资金工具整体
不注册，只读最稳；可选设 `THU_HTTP_TOKEN=<任意串>`，连接器里加
`Authorization: Bearer <串>`，防本机其他进程调用。

### 豆包工作版等其他支持本地命令行 MCP 的客户端

判断标准：客户端设置里能否添加"**本地命令行（stdio）MCP server**"。能的话
按 Claude Desktop 同样的 JSON/表单填法接入，并在 env 里注入
`THU_AGENT_MAX_RISK=read`（不同模型对两段式确认协议的遵守程度不一，只读
模式把写工具整体隐藏，最稳）。

接好后重启客户端，问一句"我卡里还有多少钱"即可验证连通。

### 只支持云端 agent 的客户端？

手机豆包 App、ChatGPT 网页版自定义 connector 等纯云端客户端需要远程 HTTP 传
输，当前不支持（本 server 是本机 stdio 形态，这是刻意取舍：你的校园卡凭据不
出本机）。工具层与传输层解耦，未来需要时可加 HTTP 入口。

---

## 3. 权限模式：按客户端分配风险上限

每个客户端可以在自己的 server 配置里注入环境变量，独立设一道风险闸门：

| `THU_AGENT_MAX_RISK` | 暴露的工具 | 适用场景 |
|---|---|---|
| `read`（只读模式） | 仅 38 个只读工具，写工具**完全不可见** | 不太信任的客户端、给同学的演示 |
| `write` | 一般写（选课/订座/日程/发信），隐藏 6 个资金类工具 | 日常自用，少一道资金风险 |
| `write+pay`（默认） | 全部 64 个工具 | 自己的主力客户端 |

示例：给 Cursor 配只读模式——

```json
{
  "mcpServers": {
    "thu-agent": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/Tsinghua-agent", "--filter", "@thu-agent/mcp-server", "start"],
      "env": { "THU_AGENT_MAX_RISK": "read" }
    }
  }
}
```

纵深防御：即使某条待确认单是在宽松配置下创建的，`confirm` 执行前还会按当前
配置二次校验，超限动作一律拒绝。

---

## 4. 怎么用（对话即办事）

接好后直接用自然语言。以下都是真实可用的说法：

### 查询（直接执行）

- "今天第几周？我下一节什么课？"——AI 会先调 `thu_context` 拿时间上下文
- "我卡里还有多少钱？最近都花在哪了？"
- "下周三晚上六教有空的教室吗？"
- "出成绩了吗？我这学期 GPA 多少？"
- "图书馆现在哪个馆人少？" / "帮我看看明天的研读间"
- "宿舍还剩多少电？" / "有没有新的奖学金发放记录？"

### 写操作（你会先看到提案，确认才执行）

以订座为例，实际体验是：

> 你：帮我订明天下午北馆靠窗的座位
> AI：将执行：**预订图书馆座位 北馆·三层·靠窗区 041 号，09-19 13:00–17:00**
> （确认码 `XK3F2A`，5 分钟内有效）。确认吗？
> 你：可以
> AI：✓ 已订好。违约规则是 30 分钟内未签到将记违约，要我记得提醒你吗？

退课、挂失这类高危动作，除了口头同意，AI 还会让你**原样说出确认短语**：

> AI：这是高危操作（退课）。请原样回复"确认退课"以执行。
> 你：确认退课
> AI：✓ 已退。

### 需要图形验证码的流程（订场 / 选课 / 网络自助）

AI 会把验证码图片直接显示在对话里（内嵌图片 + 本地路径双保险），你报出图中
码即可继续。例如订羽毛球场地：AI 展示场地与价格 → 你确认 → AI 给验证码图 →
你报码 → 提交成功 → 如需付款，AI 给你支付宝码，**付款永远由你本人扫码**。

### 长期盯梢（注册一次，supervisor 替你盯着）

- "出单科成绩就告诉我"
- "盯着《编译原理》的名额，一有余量就推给我"
- "信息门户出现'交换'相关的新通知就提醒我"
- "卡余额低于 50 提醒我" / "电费低于 30 度提醒我"

这些规则存进 SQLite，重启不丢；用"列一下我的监控"（`thu_list_monitors`）查看，
"删掉抢课监控"（`thu_remove_monitor`）移除。推送走 supervisor（见 §5）。

---

## 5. 长程监控（supervisor 常驻进程）

MCP server 是按需启动的（客户端连了才在）；**轮询和推送由 supervisor 负责**，
想用"出分提醒/抢课盯梢"功能就需要它常驻：

```bash
pnpm supervisor   # 保活 + 监控轮询（默认 10 分钟）+ 每日 08:00 摘要
```

通知渠道（在 `.env` 里配任一即可，未配置时仅记日志）：

| 变量 | 说明 |
|---|---|
| `THU_NOTIFY_BARK` | Bark 推送（iOS），如 `https://api.day.app/你的key` |
| `THU_NOTIFY_NTFY` | ntfy 主题 URL |
| `THU_NOTIFY_WEBHOOK` | 通用 webhook（POST JSON `{title, body}`） |
| `THU_CARD_THRESHOLD` / `THU_ELE_THRESHOLD` | 卡余额/电费提醒阈值 |

监控内容：新成绩发布、卡余额/电费阈值、新闻关键词、抢课余量（无→有即推）、
选课阶段临近。建议用 launchd 让 supervisor 开机自启（macOS）。

> 注意：supervisor 与 MCP server 是两个独立会话（协议库限制：一个进程一个
> 会话），各自维护登录，互不干扰。

---

## 6. 工具目录（64 个）

### 上下文仪表盘
| 工具 | 说明 |
|---|---|
| `thu_context` | 今明课程/教学周/卡余额/电费/待办，一次拿全 |

### 学业（只读）
| 工具 | 说明 |
|---|---|
| `thu_get_schedule` | 课表（含考试/自定义日程），week 参数查任意周 |
| `thu_get_transcript` | 成绩单 + GPA 汇总 |
| `thu_get_calendar` | 校历与学期起止 |
| `thu_get_degree_program` | 培养方案完成度 |
| `thu_get_assessment_list` | 未完成的教学评估 |
| `thu_get_selected_courses` / `thu_search_courses` | 已选课程 / 搜课与余量 |
| `thu_get_cr_status` / `thu_get_cr_timetable` | 选课阶段 / 选课时间轴 |
| `thu_get_classroom_state` / `thu_list_classroom_buildings` | 空教室 / 教学楼列表 |
| `thu_find_study_rooms` | 研读间空闲时段 |
| `thu_get_thos_tasks` / `thu_get_thos_services` | THOS 待办 / 服务目录 |
| `thu_search_git_projects` | GitLab 项目搜索（需校园网） |

### 卡 / 财务 / 宿舍（只读）
| 工具 | 说明 |
|---|---|
| `thu_get_card_info` / `thu_get_card_transactions` | 卡余额与状态 / 消费流水 |
| `thu_get_invoices` / `thu_get_bank_payment` | 电子发票 / 银行卡发放记录 |
| `thu_get_ele_remainder` / `thu_get_ele_pay_record` | 电费余量 / 充值记录 |
| `thu_get_dorm_score` | 宿舍卫生评分（图片） |

### 图书馆 / 体育 / 网络 / 新闻（只读）
| 工具 | 说明 |
|---|---|
| `thu_get_library_overview` / `thu_get_library_seats` | 馆区楼层 / 座位空余 |
| `thu_get_my_bookings` | 我的预约（座位 + 研读间） |
| `thu_get_sports_resources` / `thu_get_sports_records` | 场馆时段价格 / 我的预约 |
| `thu_get_network_balance` / `thu_get_online_devices` | 网费余额 / 在线设备 |
| `thu_get_news` / `thu_search_news` / `thu_get_news_detail` | 新闻列表 / 搜索 / 正文 |
| `thu_get_news_channels` / `thu_get_news_subscriptions` | 频道列表 / 我的订阅 |

### 监控（写：本地规则库）
| 工具 | 说明 |
|---|---|
| `thu_add_course_watch` | 抢课盯梢：余量从无到有即推送 |
| `thu_add_news_watch` | 新闻关键词监控 |
| `thu_list_monitors` / `thu_remove_monitor` | 查看 / 删除监控规则 |

### 写操作（全部两段式：prepare → 你确认 → confirm）
| 领域 | 工具 |
|---|---|
| 选课 | `thu_prepare_select_course` / `delete_course`（高危）/ `change_will` / `set_pf` |
| 图书馆 | `thu_prepare_book_seat` / `cancel_seat_booking` / `book_room` / `cancel_room_booking` |
| 日历 | `thu_prepare_add_schedule_entry` / `delete_schedule_entry` |
| 邮件/新闻 | `thu_prepare_send_mail` / `add_news_subscription` / `remove_news_subscription` |
| 体育 | `thu_prepare_sports_booking` / `sports_unsubscribe` / `sports_pay`（付款码） |
| 资金类 | `thu_prepare_ele_recharge` / `card_recharge`（均返回支付宝码）/ `card_report_loss`（高危）/ `card_cancel_loss` |
| 确认流 | `thu_confirm_action`（执行）/ `thu_cancel_pending`（取消）/ `thu_list_pending`（查看） |

### 验证码协同
| 工具 | 说明 |
|---|---|
| `thu_get_captcha` | 取验证码图（内嵌图片 + 本地 PNG），kind: sports/cr/usereg |
| `thu_usereg_login` | 网络自助登录（报码后网络查询/设备管理可用） |

---

## 7. 自检与排障

### 自检命令（全部离线或只读）

```bash
pnpm perm-check            # 权限门禁自检：分级/maxRisk/确认短语/confirm 二次校验（mock）
pnpm --filter @thu-agent/mcp-server smoke   # MCP 协议层 mock 冒烟（64 工具全量）
pnpm smoke                 # 协议库 mock 冒烟
pnpm cli status            # 配置与会话状态
pnpm cli check             # 真实账号只读抽查（需 THU_AGENT_MOCK=0）
```

### 常见问题

| 现象 | 处理 |
|---|---|
| 提示二次认证无法完成 | 按 `.env.example` 注释绑定 TOTP 并填 `THU_TOTP_SECRET`；或在终端跑一次 `pnpm cli login` 用微信完成 2FA（成功后本设备受信） |
| 网络查询报错 | usereg 会话过期：让 AI 走 `thu_get_captcha(kind=usereg)` → 你报码 → `thu_usereg_login` |
| "业务期外"类拒绝 | 正常：评教/选课等有开放窗口，期外上游会拒 |
| 偶发超时/解析失败 | 上游是老式校内系统，重试即可；AI 会如实报错不会编数据 |
| GitLab 工具报错 | 需校园网环境（不走 WebVPN） |
| 新闻频道列表 404 | 上游接口半坏，改用 `thu_get_news` 不带频道浏览 |
| 工具比预期少 | 检查该客户端配置里的 `THU_AGENT_MAX_RISK`（read 模式只有 38 个） |
| 返回的全是假数据 | `.env` 里 `THU_AGENT_MOCK` 还是 `1`，改成 `0` |

---

## 8. 已知边界

- 仅本机 stdio 客户端；云端-only 客户端暂不支持（见 §2）
- 资金类写端点的真实执行路径（电费充值 confirm 等）未经真实环境回归，首次
  真实使用时请留心确认 AI 展示的提案内容
- 新闻订阅接口上游部分损坏（关键词订阅不生效）
- 一个进程一个上游会话；多客户端同时连接时各自 spawn 独立 server 进程
- 许可证 BSL 1.1（源自 thu-info-app）：仅限个人非商业使用，请勿分发
