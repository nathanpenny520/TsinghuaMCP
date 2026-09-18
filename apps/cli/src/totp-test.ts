import { createHmac } from "node:crypto";

/**
 * TOTP 参数扫描诊断：对同一 secret 用 12 种常见参数组合各算一个码，
 * 与手机验证器 App 显示的码对照，命中的那一行即服务端使用的参数。
 * （otplib 默认 SHA1/6位/30s；若清华用非常规参数，这里能看出来。）
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s: string): Buffer {
    const clean = s.toUpperCase().replace(/[=\s-]/g, "");
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const c of clean) {
        const idx = B32.indexOf(c);
        if (idx === -1) throw new Error(`secret 含非 base32 字符: "${c}"（代码点 ${c.codePointAt(0)}）`);
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

function totp(key: Buffer, algo: string, step: number, digits: number, windowOffset = 0): string {
    const counter = Math.floor(Date.now() / 1000 / step) + windowOffset;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = createHmac(algo, key).update(buf).digest();
    const off = hmac[hmac.length - 1] & 0xf;
    const bin = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
    return String(bin % 10 ** digits).padStart(digits, "0");
}

export function runTotpTest(secret: string): void {
    if (!secret) {
        console.log("未配置 THU_TOTP_SECRET");
        return;
    }

    // secret 形状诊断（不显示内容本身）
    const clean = secret.replace(/\s/g, "");
    const bad = [...clean].filter((c) => !B32.includes(c.toUpperCase()));
    console.log(
        `secret 诊断: 长度 ${clean.length}，` +
            (bad.length === 0
                ? "全部字符都在 base32 字母表内 ✓"
                : `含 ${bad.length} 个非 base32 字符（如 "${bad[0]}"）⚠️ 若含 0/1/8/9 需重新复制`),
    );

    const key = base32Decode(clean);
    const now = Math.floor(Date.now() / 1000);
    const secIntoWindow30 = now % 30;
    console.log(`当前时间: 30s 窗口还剩 ${30 - secIntoWindow30}s（对照时注意同一窗口）\n`);
    console.log("算法    周期  位数  上一窗   当前窗   下一窗");
    console.log("──────  ────  ────  ───────  ───────  ───────");
    for (const algo of ["sha1", "sha256", "sha512"]) {
        for (const step of [30, 60]) {
            for (const digits of [6, 8]) {
                const w = (o: number) => totp(key, algo, step, digits, o);
                const mark = algo === "sha1" && step === 30 && digits === 6 ? " ←otplib默认" : "";
                console.log(
                    `${algo.padEnd(6)}  ${String(step).padEnd(4)}  ${String(digits).padEnd(4)}  ` +
                        `${w(-1)}  ${w(0)}  ${w(1)}${mark}`,
                );
            }
        }
    }
    console.log("\n与手机App当前显示一致的【当前窗】列即正确参数。");
    console.log("若三列都找不到，试想手机是否快/慢一窗（上一窗/下一窗列命中 = 时钟偏差）。");
}
