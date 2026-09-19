#!/usr/bin/env bash
# secret-guard.mjs 用例测试（拦截/放行行为回归）
# 用法: bash scripts/test-secret-guard.sh   （期望输出 12 PASS / 0 FAIL）
set -u
GUARD="$(dirname "$0")/secret-guard.mjs"
pass=0; fail=0
t() {
    local desc="$1" input="$2" want="$3" got
    got=$(printf '%s' "$input" | node "$GUARD" 2>/dev/null; echo "rc=$?")
    case "$got" in
        *"rc=$want"*) pass=$((pass+1)); echo "PASS $desc" ;;
        *) fail=$((fail+1)); echo "FAIL $desc (want rc=$want, got $got)" ;;
    esac
}

t "block generic-password" '{"tool_input":{"command":"security find-generic-password -s thu-agent -a password -w"}}' 2
t "block cat dotenv"       '{"tool_input":{"command":"cat .env"}}' 2
t "block dotenv bak"       '{"tool_input":{"command":"cat .env.bak"}}' 2
t "allow dotenv example"   '{"tool_input":{"command":"grep THU_ .env.example"}}' 0
t "block THU_PASSWORD var" '{"tool_input":{"command":"echo $THU_PASSWORD"}}' 2
t "block require keytar"   '{"tool_input":{"command":"node -e \"require('\''keytar'\'').getPassword()\""}}' 2
t "block import keyring"   '{"tool_input":{"command":"tsx -e \"import {Entry} from '\''@napi-rs/keyring'\''\""}}' 2
t "allow text mention"     '{"tool_input":{"command":"git commit -m \"用 @napi-rs/keyring 迁移凭据\""}}' 0
t "block cmdkey"           '{"tool_input":{"command":"cmdkey /list"}}' 2
t "allow normal ls"        '{"tool_input":{"command":"ls -la packages"}}' 0
t "allow core source grep" '{"tool_input":{"command":"grep -rn loadStoredSecrets packages/agent-core/src"}}' 0
t "garbage fail-open"      'not json' 0

echo "== $pass PASS / $fail FAIL"
[ "$fail" -eq 0 ]
