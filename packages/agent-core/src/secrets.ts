import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * OS 级凭据存储——替代 `.env` 存放密码类配置的唯一入口。
 *
 * 平台映射（经 @napi-rs/keyring，按需 require，原生层不可用时回退本地文件）：
 *   - macOS   → 钥匙串（Keychain）
 *   - Windows → 凭据管理器（Credential Manager，凭据不随微软账户漫游）
 *   - Linux   → Secret Service（gnome-keyring/KWallet），无桌面环境回退内核 keyring
 *
 * 设计约束：
 *   - 错误信息与日志只含条目名，绝不含 secret 值；
 *   - 凭据不进仓库目录（不随 repo 备份/同步），不进进程启动环境；
 *   - 文件兜底用 0600 权限 + HOME 外目录，并在状态里如实标注 store 种类。
 */

export const SERVICE = "thu-agent";

export type SecretKey = "userId" | "password" | "totpSecret" | "cardPassword";

export const SECRET_KEYS: SecretKey[] = ["userId", "password", "totpSecret", "cardPassword"];

/** 存储后端种类，用于状态展示与排障 */
export type StoreKind = "keyring" | "file";

export interface StoredSecrets {
    userId?: string;
    password?: string;
    totpSecret?: string;
    cardPassword?: string;
}

interface Backend {
    kind: StoreKind;
    get(key: SecretKey): string | undefined;
    set(key: SecretKey, value: string): void;
    delete(key: SecretKey): void;
}

let cachedBackend: Backend | null | undefined; // undefined=未探测, null=探测失败

// ── keyring 后端 ────────────────────────────────────────────────────

function keyringBackend(): Backend | null {
    try {
        const require = createRequire(import.meta.url);
        const { Entry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
        const entry = (key: SecretKey) => new Entry(SERVICE, key);
        const wrap = <T>(fn: () => T, key: string): T => {
            try {
                return fn();
            } catch (e) {
                throw new Error(`凭据存储读取失败（${SERVICE}/${key}）：${(e as Error).message}`);
            }
        };
        return {
            kind: "keyring",
            get: (key) => {
                const v = wrap(() => entry(key).getPassword(), key);
                return v == null || v === "" ? undefined : v;
            },
            set: (key, value) => {
                wrap(() => entry(key).setPassword(value), key);
            },
            delete: (key) => {
                wrap(() => entry(key).deleteCredential(), key);
            },
        };
    } catch {
        return null; // 原生模块缺失/平台不支持 → 文件兜底
    }
}

// ── 文件兜底后端 ────────────────────────────────────────────────────

function secretsFilePath(): string {
    return path.join(os.homedir(), ".thu-agent", "secrets.json");
}

function fileBackend(): Backend {
    const readAll = (): Partial<Record<SecretKey, string>> => {
        try {
            return JSON.parse(fs.readFileSync(secretsFilePath(), "utf8"));
        } catch {
            return {};
        }
    };
    return {
        kind: "file",
        get: (key) => readAll()[key],
        set: (key, value) => {
            const all = readAll();
            all[key] = value;
            writeAll(all);
        },
        delete: (key) => {
            const all = readAll();
            delete all[key];
            writeAll(all);
        },
    };
}

function writeAll(all: Partial<Record<SecretKey, string>>): void {
    const file = secretsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    try {
        fs.chmodSync(file, 0o600); // 已存在时 writeFileSync 不改权限，补一次
    } catch {
        // Windows 无 POSIX 权限模型：用户主目录默认 ACL 已限制为本人可读
    }
}

// ── 对外 API ────────────────────────────────────────────────────────

function backend(): Backend | null {
    if (cachedBackend === undefined) cachedBackend = keyringBackend() ?? fileBackend();
    return cachedBackend;
}

/** 当前实际使用的存储后端（keyring 不可用时为 file） */
export function storeKind(): StoreKind {
    return backend()?.kind ?? "file";
}

/** 读取已存的凭据（只取非空项）。任何错误都以“无凭据”处理，不阻塞启动。 */
export function loadStoredSecrets(): StoredSecrets {
    const b = backend();
    if (!b) return {};
    const out: StoredSecrets = {};
    for (const key of SECRET_KEYS) {
        try {
            const v = b.get(key);
            if (v) out[key] = v;
        } catch {
            // 单项读取失败不致命：让上层走 env 回退并提示
        }
    }
    return out;
}

/** 批量写入凭据（登录向导成功后调用）。值为空的项跳过、不覆盖旧值。 */
export function saveSecrets(secrets: StoredSecrets): SecretKey[] {
    const b = backend();
    if (!b) throw new Error("凭据存储不可用");
    const written: SecretKey[] = [];
    for (const key of SECRET_KEYS) {
        const v = secrets[key];
        if (v) {
            b.set(key, v);
            written.push(key);
        }
    }
    return written;
}

/** 清除全部凭据（logout / 换号场景用） */
export function removeSecrets(keys: SecretKey[] = SECRET_KEYS): void {
    const b = backend();
    if (!b) return;
    for (const key of keys) {
        try {
            b.delete(key);
        } catch {
            // 不存在时删除报错属正常
        }
    }
}

/**
 * 从 <repoRoot>/.env 删除凭据行（THU_USER_ID / THU_PASSWORD / THU_TOTP_SECRET /
 * THU_CARD_PASSWORD，可加 extraKeys），其余行原样保留。删除前备份到 .env.bak
 * （已被 .gitignore 覆盖）。返回 null 表示没有 .env 或没有需要删的行。
 */
export function stripDotEnvSecrets(
    repoRoot: string,
    extraKeys: string[] = [],
): { backupPath: string; removed: string[] } | null {
    const file = path.join(repoRoot, ".env");
    let raw: string;
    try {
        raw = fs.readFileSync(file, "utf8");
    } catch {
        return null;
    }
    const names = ["THU_USER_ID", "THU_PASSWORD", "THU_TOTP_SECRET", "THU_CARD_PASSWORD", ...extraKeys];
    const re = new RegExp(`^\\s*(${names.join("|")})\\s*=`);
    const removed: string[] = [];
    const kept: string[] = [];
    for (const line of raw.split("\n")) {
        if (re.test(line)) {
            removed.push(line.split("=")[0].trim());
        } else {
            kept.push(line);
        }
    }
    if (removed.length === 0) return null;
    const backupPath = file + ".bak";
    fs.writeFileSync(backupPath, raw, { mode: 0o600 });
    fs.writeFileSync(file, kept.join("\n").replace(/\n{3,}$/, "\n\n"), { mode: 0o600 });
    try {
        fs.chmodSync(file, 0o600);
        fs.chmodSync(backupPath, 0o600);
    } catch {
        // Windows：用户主目录默认 ACL 已足够
    }
    return { backupPath, removed };
}
