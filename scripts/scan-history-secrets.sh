#!/usr/bin/env bash
# 历史与当前树的密钥泄露扫描（公开仓库自检用）
# 用法: bash scripts/scan-history-secrets.sh
# 说明: 只输出命中的文件/行号和密钥类型的"存在性"，不打印密钥值本身。
set -uo pipefail

LEAK=0

# 1) 凭据类文件是否曾被提交过（任意历史；.env.example 模板不算）
echo "== [1] 凭据文件是否曾入库（空=从未，模板 .env.example 不算）:"
HITS=$(git log --all --diff-filter=A --name-only --pretty=format: 2>/dev/null \
    | grep -iE '(^|/)\.?env($|\.)|secrets?\.json|\.pem$|\.key$' \
    | grep -ivE '\.env\.example' | sort -u | head -10 | tee /tmp/.scan-hits | wc -l | tr -d ' ')
sed 's/^/    曾入库: /' /tmp/.scan-hits 2>/dev/null; rm -f /tmp/.scan-hits
echo "    命中文件数: ${HITS}"
[ "$HITS" -gt 0 ] && { echo "    ⚠ 有凭据类文件曾被提交！需立刻换密钥并清史"; LEAK=1; }

# 2) 全历史中"非空"密码类赋值（注释/示例里的空值不算）
echo "== [2] 全历史非空凭据赋值（空=干净）:"
FOUND=$(git grep -nE "THU_(PASSWORD|TOTP_SECRET|CARD_PASSWORD)=[^[:space:]\"']+" $(git rev-list --all) 2>/dev/null \
    | grep -cvE '你的|your|示例|example|placeholder|<[^>]*>' || true)
echo "    命中行数: ${FOUND}"
[ "$FOUND" -gt 0 ] && { git grep -lnE "THU_(PASSWORD|TOTP_SECRET|CARD_PASSWORD)=[^[:space:]\"']+" $(git rev-list --all) 2>/dev/null | grep -vE '你的|your|示例|example' | head -5 | sed 's/^/    文件: /'; LEAK=1; }

# 3) 全历史中的 Bark / ntfy 推送 URL（占位符"你的key"不算）
echo "== [3] 全历史 Bark/ntfy 真实 URL（空=干净）:"
FOUND=$(git grep -nE "api\.day\.app/[A-Za-z0-9]{8,}|ntfy\.sh/[A-Za-z0-9_-]{8,}" $(git rev-list --all) 2>/dev/null \
    | grep -cvE '你的|your|示例|example|my-topic|任意串' || true)
echo "    命中行数: ${FOUND}"
[ "$FOUND" -gt 0 ] && LEAK=1

# 4) 当前树中的 HTTP 共享口令（httpd 的 THU_HTTP_TOKEN 有值即算；占位符不算）
#    正则用拼接构造，避免脚本自身文本被 pre-commit 误判为真实凭据
echo "== [4] 当前树 THU_HTTP_TOKEN 有值（0=干净）:"
token_re="THU_HTTP_TOKEN"'=[^[:space:]"'"'"']+'
FOUND=$(git grep -nE "$token_re" HEAD 2>/dev/null \
    | grep -cvE '你的|your|示例|example|任意串|<[^>]*>' || true)
echo "    命中行数: ${FOUND}"
[ "$FOUND" -gt 0 ] && LEAK=1

# 5) 当前树中的学号（半敏感：可定位本人）
echo "== [5] 当前树中的真实学号（0=干净）:"
FOUND=$(git grep -oE "\b20[0-9]{9}\b" HEAD 2>/dev/null | wc -l | tr -d ' ')
echo "    命中次数: ${FOUND}（若>0 请人工确认是否为本人学号/测试号）"
[ "$FOUND" -gt 0 ] && LEAK=1

echo "== 结论: $([ "$LEAK" -eq 0 ] && echo '✅ 未发现泄露' || echo '⚠ 发现疑似泄露，见上方明细')"
exit "$LEAK"
