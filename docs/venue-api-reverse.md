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

## 登录链（CAS，status: check POST 调通前差一步）

1. `GET site/cas/address/list?redirectUrl=<encodeURIComponent(回跳地址)>`
   → `data[0]` = `site/authcenter/toLoginPage?redirectUrl=...&typeCode=&extInfo=cas:<uuid>`
2. GET 该地址 → 302 到 `https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/<hash>/0?/site/authce...`
   （id 的 CAS 登录页，含 `#sm2publicKey`；**SSO 已登录时并不会自动带票跳过**，实测仍出登录表单）
3. 凭据 POST：同 lib 现有 id 登录（`i_user` / `"04"+sm2.doEncrypt(password, sm2Key)` /
   `fingerPrint` / `fingerGenPrint:""` / `i_captcha:""`）。
   POST 目标 = `https://id.tsinghua.edu.cn/do/off/ui/auth/login/check`（lib 的 ID_LOGIN_URL）。
   ⚠️ 现状：脚本环境 POST 返回裸"出错了"页（gb2312）。待查：表单隐藏字段（页面 form 里
   可能还有 csrf/extInfo）、Referer、或 check 需要的额外字段。浏览器里手动登录正常，
   **下一步最佳路径：在 Chrome 实抓一次登录的 check 请求体与头做对照**。
4. 登录成功页含"登录成功。正在重定向到"+ `<a href=回跳ticket地址>`，GET 它即建立
   sports.tsinghua.edu.cn 会话 cookie（后续带 x-api-version 的签名请求即可）。

## 迁移方案（lib 侧，建议新模块 src/lib/venue.ts）

1. `venueSignFetch(path, extra)`：md5 签名 + x-api-version 头，走 uFetch（复用 cookie jar）。
2. `loginVenueSports(helper)`：上面 CAS 链，第 3 步调通后返回会话。
3. 只读三件套：`getVenueMenu()` → `getVenueScenes(menuUuid)` → `getVenuePeriods(...)`，
   重新接线 MCP `thu_get_sports_resources`（旧的 gymId/itemId 概念换成 menu→scene→site）。
4. 预约/付款/退订：`/api/reserve/addReserve` 等，含滑块验证码
   (`site/system/captcha/drag/get`)，二期再做；`src/lib/sports.ts` 旧实现标注废弃。
5. `MOCK_SPORTS_*` mock 数据同步更新。

## 浏览器抓包要点（继续逆向时用）
- Chrome devtools MCP 可直接打开 venue 页面抓 XHR（请求列表见 CDP network 面板）。
- 首页加载即弹 CAS 登录模态框（校内登录 tab → 统一身份认证登录按钮）。
- 首次访问会 POST `site/system/dev/lan/list`（设备注册，返回 200 但未见 set-cookie）。
