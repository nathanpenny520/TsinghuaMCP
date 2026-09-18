/**
 * 新版体育场馆预约平台（sports.tsinghua.edu.cn/venue，Vue SPA）。
 * 旧 gymbook 体系已下线，本模块为 2026-09 逆向重写，过程与端点详见
 * 仓库 docs/venue-api-reverse.md。
 *
 * 要点：
 *  - 请求签名：md5(`appId=..&nonce=..&timeStamp=..&key=..`)，密钥为前端公开常量；
 *  - 必带头：x-api-version: 2.0.0、language-set: CN（缺失部分接口直接 404）；
 *  - 登录：CAS 链（check POST 必须带 Referer/Origin，否则上游裸"出错了"），
 *    成功后经 doAuth 取 uniToken，POST /cas/token 换会话 token，
 *    之后所有 API 以 `token` 头鉴权（与会话 cookie 无关）。
 */
import crypto from "node:crypto";
import { sm2 } from "sm-crypto";
import * as cheerio from "cheerio";
import { InfoHelper } from "../index";
import { cookies, updateCookiesFromHeaders } from "../utils/network";
import { VenueAuthError } from "../utils/error";
import { ID_LOGIN_URL, DOUBLE_AUTH_URL, USER_AGENT } from "../constants/strings";
import { VenueDayPeriod, VenueRoom, VenueScene } from "../models/venue/venue";

const VENUE_BASE_URL = "https://www.sports.tsinghua.edu.cn/venue";
const VENUE_APP_ID = "1497016617475903488";
// 前端 bundle 内嵌常量（对任何打开 devtools 的用户可见，不构成保密）
const VENUE_SIGN_KEY = "57325972627c40bd8c77296d39293705";
const VENUE_NONCE_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz0123456789";

/** 会话 token 缓存（进程内单账号复用） */
let venueToken: string | null = null;

const venueSignQuery = (extra = ""): string => {
    const timeStamp = Date.now();
    const nonce = Array.from({length: 32}, () =>
        VENUE_NONCE_CHARS[Math.floor(Math.random() * VENUE_NONCE_CHARS.length)]).join("");
    const sign = crypto.createHash("md5")
        .update(`appId=${VENUE_APP_ID}&nonce=${nonce}&timeStamp=${timeStamp}&key=${VENUE_SIGN_KEY}`)
        .digest("hex");
    return `appId=${VENUE_APP_ID}&timeStamp=${timeStamp}&nonce=${nonce}&sign=${sign}${extra}`;
};

const cookieHeader = (): string =>
    Object.keys(cookies).map((key) => `${key}=${cookies[key]}`).join("; ");

const venueHeaders = (token?: string | null, json = false): Record<string, string> => ({
    "x-api-version": "2.0.0",
    "language-set": "CN",
    Referer: `${VENUE_BASE_URL}/`,
    "User-Agent": USER_AGENT,
    ...(json ? {"Content-Type": "application/json"} : {}),
    ...(token ? {token} : {}),
    Cookie: cookieHeader(),
});

/** 带签名与鉴权头的 venue API 调用；1130002 = 登录过期 */
const venueFetch = async (
    path: string,
    options: { query?: string; post?: unknown; token?: string | null } = {},
): Promise<any> => {
    const {query = "", post, token} = options;
    const res = await fetch(`${VENUE_BASE_URL}/site/${path}?${venueSignQuery(query)}`, {
        method: post === undefined ? "GET" : "POST",
        headers: venueHeaders(token, post !== undefined),
        body: post === undefined ? undefined : JSON.stringify(post),
    });
    updateCookiesFromHeaders(res.headers);
    const json = await res.json().catch(() => {
        throw new VenueAuthError(`venue 接口返回非 JSON（${res.status}）：${path}`);
    });
    if (json?.errorCode === 1130002) {
        throw new VenueAuthError();
    }
    return json;
};

/**
 * 完整 CAS 登录链，返回会话 token：
 * 1. cas/address/list 取登录入口 → 跳 id.tsinghua 登录表单（取 sm2 公钥）
 * 2. check POST（必须 Referer/Origin + singleLogin/deviceName 等完整字段）
 * 3. 如需二次认证，走 helper 的 2FA hooks（TOTP 自动化）
 * 4. 登录成功页回跳链接 → doAuth → uniToken → /cas/token 换会话 token
 */
export const loginVenueSports = async (helper: InfoHelper): Promise<string> => {
    const redirectUrl = encodeURIComponent(`${VENUE_BASE_URL}/#/home`);
    const cas = JSON.parse(await rawVenueGet(`cas/address/list?${venueSignQuery(`&redirectUrl=${redirectUrl}`)}`));
    const loginEntry: string = cas.data?.[0];
    if (!loginEntry) {
        throw new VenueAuthError("cas/address/list 未返回登录入口");
    }
    const formHtml = await rawVenueGet(loginEntry);
    const sm2Key = cheerio.load(formHtml)("#sm2publicKey").text();
    if (sm2Key === "") {
        throw new VenueAuthError("未取得 id 登录表单（sm2 公钥为空）");
    }
    const checkRes = await fetch(ID_LOGIN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: "https://id.tsinghua.edu.cn",
            Referer: loginEntry,
            "User-Agent": USER_AGENT,
            Cookie: cookieHeader(),
        },
        body: new URLSearchParams({
            i_user: helper.userId,
            i_pass: "04" + sm2.doEncrypt(helper.password, sm2Key),
            singleLogin: "on",
            fingerPrint: helper.fingerprint,
            fingerGenPrint: "",
            fingerGenPrint3: "",
            deviceName: "thu-agent",
            i_captcha: "",
        }).toString(),
        redirect: "manual",
    });
    updateCookiesFromHeaders(checkRes.headers);
    const loginHtml = await checkRes.text();
    if (loginHtml.includes("二次认证")) {
        const {result: r1, msg: m1, object: o1} = JSON.parse(await rawIdApi(DOUBLE_AUTH_URL, {action: "FIND_APPROACHES"}));
        if (r1 !== "success") {
            throw new VenueAuthError(`二次认证方式查询失败：${m1}`);
        }
        const method = helper.twoFactorMethodHook
            ? await helper.twoFactorMethodHook(o1.hasWeChatBool, o1.phone, o1.hasTotp)
            : undefined;
        if (method !== undefined && method !== "totp") {
            const {result: r2, msg: m2} = JSON.parse(await rawIdApi(DOUBLE_AUTH_URL, {action: "SEND_CODE", type: method}));
            if (r2 !== "success") {
                throw new VenueAuthError(`验证码发送失败：${m2}`);
            }
        }
        const code = helper.twoFactorAuthHook ? await helper.twoFactorAuthHook() : undefined;
        if (!code) {
            throw new VenueAuthError("无法获取二次认证验证码");
        }
        const {result: r3, msg: m3} = JSON.parse(await rawIdApi(DOUBLE_AUTH_URL, {
            action: method === "totp" ? "VERITY_TOTP_CODE" : "VERITY_CODE",
            vericode: code,
        }));
        if (r3 !== "success") {
            throw new VenueAuthError(`二次认证失败：${m3}`);
        }
    } else if (!loginHtml.includes("登录成功")) {
        throw new VenueAuthError(`id 登录失败：${loginHtml.slice(0, 80).replace(/\s+/g, " ")}`);
    }
    const jump = cheerio.load(loginHtml)("a").attr("href");
    if (!jump) {
        throw new VenueAuthError("登录成功页无回跳链接");
    }
    const hop = await fetch(jump, {headers: {"User-Agent": USER_AGENT, Cookie: cookieHeader()}, redirect: "manual"});
    updateCookiesFromHeaders(hop.headers);
    const uniToken = (hop.headers.get("location") ?? "").match(/uniToken=([^&]+)/)?.[1];
    if (!uniToken) {
        throw new VenueAuthError("doAuth 回跳未携带 uniToken");
    }
    const exch = JSON.parse(await rawVenueGet(`cas/token?${venueSignQuery()}`, JSON.stringify({
        platForm: "CAS",
        client: "PC",
        token: uniToken,
        extInfo: "",
    })));
    if (exch.code !== 0 || !exch.data?.token) {
        throw new VenueAuthError(`cas/token 兑换失败：${JSON.stringify(exch).slice(0, 120)}`);
    }
    venueToken = exch.data.token as string;
    return venueToken;
};

/** 确保可用会话 token：无则登录；1130002 时自动重登一次 */
const venueApi = async <T = any>(helper: InfoHelper, path: string, options: { query?: string; post?: unknown } = {}): Promise<T> => {
    if (helper.mocked()) {
        return mockedVenue(path);
    }
    if (!venueToken) {
        await loginVenueSports(helper);
    }
    try {
        return await venueFetch(path, {...options, token: venueToken});
    } catch (e) {
        if (e instanceof VenueAuthError) {
            venueToken = null;
            const fresh = await loginVenueSports(helper);
            return venueFetch(path, {...options, token: fresh});
        }
        throw e;
    }
};

// ── 对外查询 ─────────────────────────────────────────────────────────

/** 全部可预约场景（= 首页项目树叶子，如 气膜馆羽毛球/北体篮球/游泳…） */
export const getVenueScenes = async (helper: InfoHelper): Promise<VenueScene[]> => {
    const json = await venueApi(helper, "api/site/scene/list");
    return (json.data ?? []).map((s: any) => ({
        uuid: s.uuid,
        sceneName: s.sceneName,
        relatedType: s.relatedType,
        location: s.location,
        openTime: s.openTime,
    }));
};

/** 场地层级（楼宇→楼层→房间）展开为房间列表 */
export const getVenueSiteRooms = async (helper: InfoHelper, sceneUuid: string): Promise<VenueRoom[]> => {
    const choose = async (siteType: string, siteUuid?: string) => {
        const json = await venueApi(helper, "api/site/choose", {query: `&sceneUuid=${sceneUuid}&siteType=${siteType}${siteUuid ? `&siteUuid=${siteUuid}` : ""}`});
        if (process.env.THU_VENUE_DEBUG) {
            console.error(`[venue choose ${siteType}] ${JSON.stringify(json).slice(0, 200)}`);
        }
        return json.data ?? [];
    };
    const rooms: VenueRoom[] = [];
    for (const b of await choose("BUILDING")) {
        for (const f of await choose("FLOOR", b.uuid)) {
            for (const r of await choose("ROOM", f.uuid)) {
                rooms.push({uuid: r.uuid, siteName: r.siteName, siteType: r.siteType, building: b.siteName, floor: f.siteName});
            }
        }
    }
    return rooms;
};

/** 某场地某日期区间的开放时段与可约状态 */
export const getVenuePeriods = async (
    helper: InfoHelper,
    sceneUuid: string,
    siteUuid: string,
    siteType: string,
    beginDate: string,
    endDate: string,
): Promise<VenueDayPeriod[]> => {
    const json = await venueApi(helper, "api/reserve/current/period", {
        post: {
            sceneUuid,
            siteUuid,
            siteType,
            resvKind: "PERIOD_RESERVE",
            reserveStartDate: beginDate,
            reserveEndDate: endDate,
            startTime: "08:00",
            endTime: "22:00",
        },
    });
    return (json.data?.groupReserveVos ?? []).map((g: any) => ({
        currentDate: g.currentDate,
        openStatus: g.openRule?.openStatus,
        reserveStatus: g.reserveStatus?.reserveStatus,
        reserveStatusReason: g.reserveStatus?.reserveStatusReason,
        reserveInfo: g.reserveInfo ?? [],
    }));
};

/** 跨场景查询我的预约（current/page 按场景隔离，需逐场景轮询） */
export const getVenueMyReservations = async (helper: InfoHelper): Promise<Record<string, any>[]> => {
    const scenes = await getVenueScenes(helper);
    const out: Record<string, any>[] = [];
    for (const s of scenes) {
        const json = await venueApi(helper, "api/reserve/current/page", {
            post: {sceneUuid: s.uuid, pageNum: 1, pageSize: 20},
        });
        for (const row of json.data?.list ?? json.data?.records ?? []) {
            out.push({...row, sceneName: s.sceneName});
        }
    }
    return out;
};

// ── 底层工具 ─────────────────────────────────────────────────────────

const rawVenueGet = async (url: string, post?: string): Promise<string> => {
    const res = await fetch(url.startsWith("http") ? url : `${VENUE_BASE_URL}/site/${url}`, {
        method: post === undefined ? "GET" : "POST",
        headers: venueHeaders(undefined, post !== undefined),
        body: post,
    });
    updateCookiesFromHeaders(res.headers);
    return res.text();
};

const rawIdApi = async (url: string, post: unknown): Promise<string> => {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
            Cookie: cookieHeader(),
        },
        body: new URLSearchParams(post as Record<string, string>).toString(),
    });
    updateCookiesFromHeaders(res.headers);
    return res.text();
};

/** mock 模式最小数据 */
const mockedVenue = (path: string): any => {
    if (path.startsWith("api/site/scene/list")) {
        return {code: 0, data: [{uuid: "mock-scene", sceneName: "Mock羽毛球馆", relatedType: "DEV"}]};
    }
    if (path.startsWith("api/site/choose")) {
        return {code: 0, data: [{uuid: "mock-room", siteName: "Mock场地1", siteType: "ROOM"}]};
    }
    if (path.startsWith("api/reserve/current/period")) {
        return {
            code: 0,
            data: {groupReserveVos: [{currentDate: "2026-01-01", reserveStatus: "Y", reserveStatusReason: "", reserveInfo: []}]},
        };
    }
    return {code: 0, data: []};
};
