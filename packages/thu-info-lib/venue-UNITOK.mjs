import fs from "node:fs";
import crypto from "node:crypto";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sm2 } from "sm-crypto";
import * as cheerio from "cheerio";
import { InfoHelper } from "./src/index.ts";
import { uFetch, cookies, updateCookiesFromHeaders } from "./src/utils/network.ts";
import { ID_LOGIN_URL, DOUBLE_AUTH_URL } from "./src/constants/strings.ts";

const env = Object.fromEntries(
    fs.readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n").map(l => l.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*)\s*$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const db = new DatabaseSync(new URL("../../data/state.sqlite", import.meta.url).pathname, { readOnly: true });
const fingerprint = db.prepare("SELECT value FROM kv WHERE key='fingerprint'").get()?.value; db.close();
const b32d = (s)=>{const B32="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let b=0,v=0;const o=[];for(const c of s.toUpperCase().replace(/[=\s-]/g,"")){const i=B32.indexOf(c);if(i===-1)throw new Error("b32");v=(v<<5)|i;b+=5;if(b>=8){o.push((v>>>(b-8))&0xff);b-=8;}}return Buffer.from(o);};
const totp = (sec)=>{const k=b32d(sec);const c=Math.floor(Date.now()/30000);const buf=Buffer.alloc(8);buf.writeUInt32BE(Math.floor(c/2**32),0);buf.writeUInt32BE(c%2**32,4);const H2=createHmac("sha1",k).update(buf).digest();const o=H2[19]&0xf;return String(((H2.readUInt32BE(o)&0x7fffffff)%1e6)).padStart(6,"0");};
const h = new InfoHelper();
h.fingerprint = fingerprint;
h.twoFactorMethodHook = async (_w,_p,t)=>{ if(t&&env.THU_TOTP_SECRET) return "totp"; throw new Error("无TOTP"); };
h.twoFactorAuthHook = async ()=>totp(env.THU_TOTP_SECRET);
h.trustFingerprintHook = async ()=>true;
h.trustFingerprintNameHook = async ()=>"THU Info APP (thu-agent@dump-tmp)";
await h.login({ userId: env.THU_USER_ID, password: env.THU_PASSWORD });

const APP_ID = "1497016617475903488", KEY = "57325972627c40bd8c77296d39293705";
const CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz0123456789";
const vqs = (extra="") => { const t=Date.now(), n=Array.from({length:32},()=>CHARS[Math.floor(Math.random()*CHARS.length)]).join(""); const s=crypto.createHash("md5").update(`appId=${APP_ID}&nonce=${n}&timeStamp=${t}&key=${KEY}`).digest("hex"); return `appId=${APP_ID}&timeStamp=${t}&nonce=${n}&sign=${s}${extra}`; };
const VH = { "x-api-version": "2.0.0", "language-set": "CN" };
const BASE = "https://www.sports.tsinghua.edu.cn/venue";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const cookieHeader = () => Object.keys(cookies).map((k) => `${k}=${cookies[k]}`).join("; ");

const cas = JSON.parse(await uFetch(`${BASE}/site/cas/address/list?${vqs(`&redirectUrl=${encodeURIComponent(BASE+"/#/home")}`)}`, undefined, 60000, undefined, VH));
const formHtml = await uFetch(cas.data[0], undefined, 60000, undefined, VH);
const sm2Key = cheerio.load(formHtml)("#sm2publicKey").text();
const checkRes = await fetch(ID_LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://id.tsinghua.edu.cn", "Referer": cas.data[0], "User-Agent": UA, "Cookie": cookieHeader() },
    body: new URLSearchParams({ i_user: env.THU_USER_ID, i_pass: "04" + sm2.doEncrypt(env.THU_PASSWORD, sm2Key), singleLogin: "on", fingerPrint: fingerprint, fingerGenPrint: "", fingerGenPrint3: "", deviceName: "macOS,thu-agent", i_captcha: "" }).toString(),
    redirect: "manual",
});
updateCookiesFromHeaders(checkRes.headers);
const loginHtml = await checkRes.text();
if (loginHtml.includes("二次认证")) {
    await uFetch(DOUBLE_AUTH_URL, { action: "FIND_APPROACHES" });
    await uFetch(DOUBLE_AUTH_URL, { action: "VERITY_TOTP_CODE", vericode: totp(env.THU_TOTP_SECRET) });
}
const jump = cheerio.load(loginHtml)("a").attr("href");
const hop = await fetch(jump, { headers: { "User-Agent": UA, "Cookie": cookieHeader() }, redirect: "manual" });
updateCookiesFromHeaders(hop.headers);
const loc = hop.headers.get("location") ?? "";
const uniToken = loc.match(/uniToken=([^&]+)/)?.[1];
console.log("[1] uniToken:", uniToken ? uniToken.slice(0, 16) + "..." : "无! loc=" + loc.slice(0, 80));

const H2 = { ...VH, "token": uniToken };
const scene = JSON.parse(await uFetch(`${BASE}/site/api/site/scene/list?${vqs("&menuUuid=de6ee04a27c940029d13b7d5f1ef8ce4")}`, undefined, 60000, undefined, H2));
console.log("[2] scene/list:", JSON.stringify(scene)?.slice(0, 1200));
fs.writeFileSync("/tmp/venue-unitoken.txt", uniToken ?? "");
process.exit(0);
