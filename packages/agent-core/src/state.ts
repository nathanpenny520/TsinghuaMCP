import { DatabaseSync } from "node:sqlite";

/**
 * Durable agent state on SQLite (node:sqlite, built into Node 22+).
 *
 * Tables:
 *  - kv              — misc persistent values (device fingerprint, snapshots, cooldowns)
 *  - action_log      — audit trail of every tool invocation (what/when/params/result)
 *  - pending_actions — two-phase write confirmation store (prepare → confirm)
 *  - monitors        — long-running watch rules managed by the agent (news keyword, course seat, ...)
 */
export class State {
    private db: DatabaseSync;

    constructor(dataDir: string) {
        this.db = new DatabaseSync(`${dataDir}/state.sqlite`);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS action_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                tool TEXT NOT NULL,
                params TEXT,
                outcome TEXT,
                risk TEXT NOT NULL DEFAULT 'read'
            );
            CREATE TABLE IF NOT EXISTS pending_actions (
                code TEXT PRIMARY KEY,
                action TEXT NOT NULL,
                params TEXT NOT NULL,
                risk TEXT NOT NULL,
                summary TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                expires TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS monitors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                value TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            );
        `);
    }

    kvGet(key: string): string | undefined {
        const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
        return row?.value as string | undefined;
    }

    kvSet(key: string, value: string): void {
        this.db
            .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(key, value);
    }

    /** Persist an audit record; params/result are JSON-serialized. */
    logAction(tool: string, params: unknown, outcome: unknown, risk: "read" | "write" | "write+pay"): void {
        this.db
            .prepare("INSERT INTO action_log (tool, params, outcome, risk) VALUES (?, ?, ?, ?)")
            .run(tool, JSON.stringify(params) ?? null, JSON.stringify(outcome) ?? null, risk);
    }

    // ── pending actions（两段式写操作确认）──────────────────────────────

    /** 生成 6 位人类可输入的确认码（去掉易混淆的 I/L/O/0/1） */
    private newCode(): string {
        const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
        let code = "";
        for (let i = 0; i < 6; i++) code += alphabet[crypto.randomUUID()[i].charCodeAt(0) % alphabet.length];
        // ensure uniqueness
        const exists = this.db.prepare("SELECT 1 FROM pending_actions WHERE code = ?").get(code);
        return exists ? this.newCode() : code;
    }

    createPending(action: string, params: unknown, risk: "write" | "write+pay", summary: string, ttlMs = 5 * 60e3): string {
        this.purgeExpiredPending();
        const code = this.newCode();
        const expires = new Date(Date.now() + ttlMs).toISOString();
        this.db
            .prepare("INSERT INTO pending_actions (code, action, params, risk, summary, expires) VALUES (?, ?, ?, ?, ?, ?)")
            .run(code, action, JSON.stringify(params), risk, summary, expires);
        return code;
    }

    getPending(code: string): { action: string; params: unknown; risk: string; summary: string; status: string } | undefined {
        const row = this.db.prepare("SELECT action, params, risk, summary, status, expires FROM pending_actions WHERE code = ?").get(code) as
            | { action: string; params: string; risk: string; summary: string; status: string; expires: string }
            | undefined;
        if (!row) return undefined;
        if (row.status !== "pending") return undefined;
        if (new Date(row.expires).getTime() < Date.now()) {
            this.db.prepare("UPDATE pending_actions SET status = 'expired' WHERE code = ?").run(code);
            return undefined;
        }
        return { action: row.action, params: JSON.parse(row.params), risk: row.risk, summary: row.summary, status: row.status };
    }

    consumePending(code: string): boolean {
        const r = this.db.prepare("UPDATE pending_actions SET status = 'executed' WHERE code = ? AND status = 'pending'").run(code);
        return r.changes > 0;
    }

    cancelPending(code: string): boolean {
        const r = this.db.prepare("UPDATE pending_actions SET status = 'cancelled' WHERE code = ? AND status = 'pending'").run(code);
        return r.changes > 0;
    }

    listPending(): { code: string; action: string; summary: string; risk: string; created: string }[] {
        this.purgeExpiredPending();
        return this.db
            .prepare("SELECT code, action, summary, risk, created FROM pending_actions WHERE status = 'pending' ORDER BY created DESC")
            .all() as never;
    }

    /**
     * 清理过期待确认单。expires 存的是 JS toISOString()（UTC），
     * 必须用同格式比较——之前用 datetime('now','localtime') 生成
     * "YYYY-MM-DD HH:MM:SS"，与 ISO 串逐字符比较永远为 false，过期清理形同虚设。
     */
    private purgeExpiredPending(): void {
        this.db.prepare("DELETE FROM pending_actions WHERE expires < ?").run(new Date().toISOString());
    }

    // ── monitors（长程监控规则，agent 可增删）──────────────────────────

    addMonitor(type: string, value: unknown): number {
        const r = this.db.prepare("INSERT INTO monitors (type, value) VALUES (?, ?)").run(type, JSON.stringify(value));
        return Number(r.lastInsertRowid);
    }

    removeMonitor(id: number): boolean {
        const r = this.db.prepare("DELETE FROM monitors WHERE id = ?").run(id);
        return r.changes > 0;
    }

    listMonitors(type?: string): { id: number; type: string; value: unknown; enabled: number; created: string }[] {
        const rows = (type
            ? this.db.prepare("SELECT id, type, value, enabled, created FROM monitors WHERE type = ? ORDER BY id").all(type)
            : this.db.prepare("SELECT id, type, value, enabled, created FROM monitors ORDER BY id").all()) as {
            id: number;
            type: string;
            value: string;
            enabled: number;
            created: string;
        }[];
        return rows.map((r) => ({ ...r, value: JSON.parse(r.value) }));
    }

    enabledMonitors(type: string): { id: number; value: unknown }[] {
        return this.listMonitors(type)
            .filter((m) => m.enabled === 1)
            .map(({ id, value }) => ({ id, value }));
    }

    close(): void {
        this.db.close();
    }
}
