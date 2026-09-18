# Tsinghua Agent

长程执行的清华事务个人 AI Agent。方案见 [PLAN.md](PLAN.md)，**使用指南见 [USAGE.md](USAGE.md)**（接入各客户端、权限模式、工具目录、排障）。

> 依赖 vendored 的 [@thu-info/lib](packages/thu-info-lib/)（来自
> thu-info-community/thu-info-app，BSL 1.1 许可证）。**仅限个人非商业使用，请勿分发。**

## 结构

```
packages/
  thu-info-lib/    协议层（vendored，勿手改）
  agent-core/      会话管理、SQLite 状态（审计/待确认/监控规则）、配置、课表工具
  mcp-server/      MCP server：34 个只读工具 + 30 个写/监控工具
  supervisor/      常驻守护：会话保活、成绩/电费/卡余额/新闻/抢课监控、每日摘要、通知推送
apps/
  cli/             开发用 CLI（status / smoke / login / totp / totp-test / check）
```

## 快速开始

```bash
pnpm install
pnpm build:lib     # 编译 vendored lib
pnpm smoke         # mock 全量冒烟（离线）
pnpm cli status    # 配置/会话状态
```

配置凭据：`cp .env.example .env`，填 `THU_USER_ID` / `THU_PASSWORD`，
建议配 `THU_TOTP_SECRET`（二次认证全自动，获取方法见文件内注释）。

真实登录验证：

```bash
pnpm cli login     # 需先 THU_AGENT_MOCK=0
pnpm cli check     # 五路真实数据源抽查
pnpm cli totp      # 与手机验证器对码
pnpm cli totp-test # TOTP 参数扫描（码对不上时用）
```

## 挂进本机 AI 客户端

面向**本机 agent**（stdio 传输）：Claude Code、Claude Desktop、Cursor、Codex CLI 等。
命令均为（把路径换成你的仓库位置）：

```bash
pnpm --dir /path/to/Tsinghua-agent --filter @thu-agent/mcp-server start
```

- **Claude Code**：仓库根已带 [.mcp.json](.mcp.json)，打开本项目启用 `thu-agent` 即可；
  其他项目可用 `claude mcp add thu-agent -- pnpm --dir /path/to/Tsinghua-agent --filter @thu-agent/mcp-server start`
- **Claude Desktop / Cursor**：在 MCP 配置里加
  ```json
  { "mcpServers": { "thu-agent": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/Tsinghua-agent", "--filter", "@thu-agent/mcp-server", "start"]
  } } }
  ```
- **Codex CLI**：`codex mcp add thu-agent -- pnpm --dir /path/to/Tsinghua-agent --filter @thu-agent/mcp-server start`
- **仅支持 HTTP 的客户端（豆包桌面版等）**：先 `pnpm httpd start` 启动本机
  HTTP 入口，连接器填 `http://127.0.0.1:9876/mcp`（开关/自启见 USAGE §2）

约 64 个工具，系统提示已内置两段式确认协议与验证码协同流程。
验证码工具返回内嵌图片内容 + 本地 PNG 路径，本机 agent 可直接看图转述给用户。

> 云端-only 客户端（手机豆包 App、ChatGPT 网页自定义 connector）需要远程 HTTP
> 传输，暂不支持；工具层与传输层解耦，以后需要时再加 transport 入口即可。

## 权限管控

- **三级风险分级**（登记在 [risk.ts](packages/mcp-server/src/risk.ts)，fail-safe：
  新工具不登记直接拒绝启动）：`read`（只读）/ `write`（改状态：选课、订座、发信）/
  `write+pay`（资金与卡状态：充值、缴费、挂失）。
- **MCP annotations**：read 工具标注 `readOnlyHint`，破坏性操作（退课/挂失/删除/取消）
  标注 `destructiveHint`，客户端权限 UI 据此提示。
- **进程级闸门 `THU_AGENT_MAX_RISK`**（默认 `write+pay`）：调低后超限工具对客户端
  **彻底不注册**，且 confirm 执行前按当前配置二次校验（旧配置遗留的待确认单也拦住）。
  按客户端分配：给不受信任的客户端配 `"env": { "THU_AGENT_MAX_RISK": "read" }`。
- **两段式确认门**（代码级，非提示词约定）：写操作必须先 `thu_prepare_X` 锁定参数 →
  5 分钟确认码 → `thu_confirm_action` 执行；高危动作（退课/挂失/解挂）还要用户原样
  说出确认短语。所有调用留痕于 SQLite action_log。
- 全流程自检（离线 mock，零真实写操作）：`pnpm perm-check`。

### 工具分类

- **上下文**：`thu_context`（今明课程/第几周/卡余额/电费/待办一次拿全）
- **只读**（34）：课表（任意周）、成绩单+GPA、空教室、校历、评教、培养方案、
  选课余量/已选/阶段、卡余额/流水、发票、发放记录、电费、卫生评分、
  图书馆馆-层-区-座、我的预约、研读间、体育场馆、新闻、THOS、GitLab、校园网
- **写操作**（两段式）：`thu_prepare_X` 校验+锁定参数+给确认码 →
  用户同意 → `thu_confirm_action{code}` 执行。高危动作（退课/挂失/解挂）
  额外要求用户原样说出确认短语。确认码 5 分钟过期，参数锁定不可篡改。
- **验证码协同**：`thu_get_captcha(kind=sports|cr|usereg)` 存本地 PNG →
  用户看图报码 → 带码继续（订场/选课/网络自助）
- **长程监控**：`thu_add_course_watch`（抢课盯梢）、`thu_add_news_watch`（新闻关键词）、
  `thu_list_monitors` / `thu_remove_monitor`

## 长程执行（supervisor）

```bash
pnpm supervisor    # 常驻：保活 + 监控轮询（默认10min）+ 每日08:00摘要
```

- 监控：新成绩发布、卡余额阈值、电费阈值、新闻关键词、抢课余量（无→有即推）、
  选课阶段临近提醒
- 通知：配置 Bark / ntfy / 通用 webhook 任一（见 .env.example）；
  未配置时仅记日志（可在 SQLite action_log 追溯）
- 规则由 agent 通过 MCP 工具增删，存 SQLite，重启不丢；agent 与 supervisor 解耦

## 已知边界

- 一个进程一个会话（lib cookie jar 为进程级全局）；supervisor 与 MCP server 是两个独立会话
- 上游偶发失败（期外拒绝/解析失败）属正常，工具层已做降级与干净报错
- 新闻订阅接口上游部分损坏（频道列表 404、关键词订阅不生效）
- GitLab 工具需校园网（不走 WebVPN）
- 写端点执行路径与 thu-info-app 完全同源；mock 覆盖选课/日程等，部分端点（电费充值）仅真实环境可验
