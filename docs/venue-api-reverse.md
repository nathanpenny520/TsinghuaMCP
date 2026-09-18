# 体育场馆预约系统（新版）逆向笔记

> 2026-09-18 实测。旧版 gymbook（WebVPN 应用 `...a5a70f8834396657761d88e29d51367b6a00`）已整体下线，
> lib 里 `src/lib/sports.ts` 全部端点失效（页面返回 WebVPN"该网站无法访问"）。
> 新系统：https://www.sports.tsinghua.edu.cn/venue/#/home （Vue SPA，正元智慧集团技术支持）。

## 请求签名（已破解并验证）

每个 API 请求（GET/POST 一样）都带 query 参数：

```
appId=1497016617475903488
timeStamp=<毫秒时间戳>
nonce=<32位随机串，字符集 ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz0123456789>
sign=<md5>
```

```
sign = md5(`appId=${appId}&nonce=${nonce}&timeStamp=${timeStamp}&key=${KEY}`)
KEY  = "57325972627c40bd8c77296d39293705"
```

KEY 的来源（SPA bundle chunk-common.js `getKeys()`，三段拼接）：
- u = "57325972627"（数组 [7,6,7,5,3,5] reverse 与 [7,2,9,2,2] 交错）
- n = "c40bd8c"（字符表 ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz0123456789 下标 28,56,52,27,29,60,28）
- s = "77296d39293705"（"752769392d3907" 奇偶位拆分交错）

另有两个**必需请求头**（缺了返回 HTTP 404）：
```
x-api-version: 2.0.0
language-set: CN
```

注意：KEY 属于"客户端内嵌密钥"，任何打开 devtools 的人可见，不构成保密。

SPA 还有 AES-CBC（key=getKeys().join("")，iv="0000000000000000"，Iso10126 padding）
的 encrypt/decrypt 工具函数，用于部分字段（如手机号）加解密——迁移预约流程时会用到。

## 端点清单（前缀 https://www.sports.tsinghua.edu.cn/venue/site）

### 公开（未登录可调）
- `GET api/site/menu` — 项目树（冰雪/游泳/篮球/羽毛球(气膜馆、综体、西体前后馆)/网球/壁球/操房/
  会议室/轮滑/教工之家/研讨间/匹克球/击剑…）。叶子项含 uuid（如气膜馆羽毛球
  `de6ee04a27c940029d13b7d5f1ef8ce4`）、singleReserveNum、linkStr。
- `GET api/ms/banner/list?kind=HOME_PAGE_BANNER` 等、`GET api/ms/news/list?pageSize=&pageNum=`、
  `GET api/ms/introduce/list?isShow=1`（实测 data 为空）。

### 需登录（未登录返回 JSON `{"errorCode":1130002,"code":500,"message":"登录过期，请重新登录"}`）
- `GET api/site/scene/list?menuUuid=<项目uuid>` — 场景列表（参数名待与浏览器实抓核对）
- `GET api/site/scene/detail` — 场景详情（含场地 site 列表，siteUuid/siteType 从这来）
- `GET api/site/choose`、`GET api/site/siteType`
- `POST api/reserve/current/period` — 时段查询，body：
  `{sceneUuid, siteUuid, siteType, resvKind:"PERIOD_RESERVE", reserveStartDate:"yyyy-MM-dd",
    reserveEndDate:"yyyy-MM-dd", startTime, endTime}`
- `POST api/reserve/addReserve` — 下单；`POST api/reserve/current/page` — 我的预约分页；
  `POST api/reserve/lockSite` / `unLockSite`；另有 `/api/reserve/custom/addReserve`。

## 登录链（✅ 已全链路调通，实现在 `src/lib/venue.ts`）

1. `GET site/cas/address/list?redirectUrl=<encodeURIComponent(回跳地址)>`
   → `data[0]` = `site/authcenter/toLoginPage?redirectUrl=...&typeCode=&extInfo=cas:<uuid>`
2. GET 该地址 → 302 到 `https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/<hash>/0?/site/authce...`
   （id 的 CAS 登录页，含 `#sm2publicKey`；**即使 id 有 SSO 会话也会出登录表单**，需凭据 POST）
3. 凭据 POST 到 `ID_LOGIN_URL`（/do/off/ui/auth/login/check），**必须**：
   - 头带 `Referer: <登录入口URL>` 和 `Origin`（缺了上游返回裸"出错了"页）；
   - body 用完整字段：`i_user` / `"04"+sm2.doEncrypt(password, sm2Key)` / `singleLogin=on` /
     `fingerPrint` / `fingerGenPrint=` / `fingerGenPrint3=` / `deviceName` / `i_captcha=`
     （浏览器实抓对照发现；少 singleLogin/deviceName 就报"出错了"）
4. 如响应为"二次认证"页 → `/b/doubleAuth/login` 的 action 协议
   （FIND_APPROACHES → VERITY_TOTP_CODE，与 lib 现有 2FA 相同，TOTP 可全自动）
5. 登录成功页 `<a href>` = `venue/site/authcenter/doAuth/<uuid>?ticket=...`，GET 它
   → 302 到 `venue/#/home?uniToken=<token>`（**鉴权凭证是 uniToken，大小写敏感**）
6. `POST site/cas/token?签名`，**JSON body** `{platForm:"CAS", client:"PC", token:<uniToken>, extInfo:""}`
   → `data.token` = 会话 token
7. 之后所有 API 带请求头 `token: <会话token>`（SPA 拦截器从 localStorage 读，
   key 为 "token"；与会话 cookie 无关）

## 场地/时段 API（✅ 已调通）

- `GET api/site/scene/list` — 全部 33 个场景（scene uuid 与菜单叶子 uuid 相同）
- `POST api/site/choose`（实测 GET query 也可）— 场地层级，`siteType` 是枚举字符串：
  `BUILDING`（楼宇）→ 带 `siteUuid=<楼宇uuid>` 查 `FLOOR`（楼层）→ 再查 `ROOM`（场地）
- `POST api/reserve/current/period` — body：
  `{sceneUuid, siteUuid, siteType:"ROOM", resvKind:"PERIOD_RESERVE",
    reserveStartDate, reserveEndDate, startTime:"08:00", endTime:"22:00"}`
  → `data.groupReserveVos[]` 按日期：`openRule.openStatus`、`reserveStatus(Y/N)`、
  `reserveStatusReason`、`reserveInfo[]`（可约时段明细，状态为 N 时为空）
- `POST api/reserve/current/page` — 我的预约，**必须带 sceneUuid**（按场景隔离，需逐场景轮询）

实测注记：普通学生账号对部分场馆返回 `reserveStatus:"N" / 不满足预约条件`（reserveInfo 为空），
为上游对该账号的真实资格判定，与接口无关；同一账号在网页端的判定应一致。

## 迁移状态（lib 侧：src/lib/venue.ts，2026-09-18）

✅ 已完成：
- 签名与请求封装（venueSignQuery / venueFetch，含 1130002 自动重登）
- `loginVenueSports`：完整 CAS 链（含 TOTP 自动化）→ 会话 token
- `getVenueScenes` / `getVenueSiteRooms`（楼宇→楼层→房间展开）/ `getVenuePeriods` /
  `getVenueMyReservations`
- MCP 重接线：`thu_get_sports_resources`（gym 关键词→场景→场地→时段）、
  `thu_get_sports_records`（跨场景轮询）；mock 模式可用

⏳ 待做（预约写路径）：
- `POST api/reserve/addReserve` 下单体结构、`lockSite`/`unLockSite` 锁场、
  滑块验证码（`site/system/captcha/drag/get`，需图像滑块求解或人机协作）、
  在线支付（zjjsfw webPay）；对应 `thu_prepare_sports_booking/pay/unsubscribe`
  目前返回明确的"迁移中"错误，待上述逆向完成后恢复。

## 浏览器抓包要点（继续逆向时用）
- Chrome devtools MCP 可直接打开 venue 页面抓 XHR（请求列表见 CDP network 面板）。
- 首页加载即弹 CAS 登录模态框（校内登录 tab → 统一身份认证登录按钮）。
- 首次访问会 POST `site/system/dev/lan/list`（设备注册，返回 200 但未见 set-cookie）。
