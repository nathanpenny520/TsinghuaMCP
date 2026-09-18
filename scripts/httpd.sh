#!/usr/bin/env bash
# thu-agent HTTP MCP server 开关（豆包等 HTTP 客户端的本地入口）
# 用法: pnpm httpd start|stop|restart|status
#   启动配置读 .env（THU_AGENT_MOCK / THU_AGENT_MAX_RISK）；
#   端口/口令：THU_HTTP_PORT（默认 9876）、THU_HTTP_TOKEN（可选共享口令）。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/data/http-server.pid"
LOG_FILE="$ROOT/data/http-server.log"
PORT="${THU_HTTP_PORT:-9876}"

is_running() {
    [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start() {
    if is_running; then
        echo "已在运行 (PID $(cat "$PID_FILE")) —— http://127.0.0.1:${PORT}/mcp"
        return 0
    fi
    rm -f "$PID_FILE"
    mkdir -p "$ROOT/data"
    (
        cd "$ROOT/packages/mcp-server"
        # exec 使记录的 PID 即 server 进程本身（tsx 直接作为服务进程）
        exec nohup ../../node_modules/.bin/tsx src/http.ts >> "$LOG_FILE" 2>&1
    ) &
    echo $! > "$PID_FILE"
    sleep 1.5
    if is_running; then
        echo "已启动 (PID $(cat "$PID_FILE")) —— http://127.0.0.1:${PORT}/mcp"
        echo "日志: $LOG_FILE"
    else
        echo "启动失败，最近日志："
        tail -5 "$LOG_FILE"
        rm -f "$PID_FILE"
        return 1
    fi
}

stop() {
    if is_running; then
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        echo "已停止 (PID $(cat "$PID_FILE"))"
    else
        echo "未在运行（清理 pid 文件）"
    fi
    rm -f "$PID_FILE"
    # 兜底清理游离的 http server 进程（tsx 的实际命令行是 node .../tsx/dist/cli.mjs src/http.ts）
    pkill -f "src/http.ts" 2>/dev/null && echo "清理了游离进程" || true
    return 0
}

status() {
    if is_running; then
        echo "运行中 (PID $(cat "$PID_FILE")) —— http://127.0.0.1:${PORT}/mcp"
        code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PORT}/mcp" \
            -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
            -d '{"jsonrpc":"2.0","id":0,"method":"ping"}' 2>/dev/null || echo "no-response")
        echo "endpoint 响应: HTTP ${code}（200=正常；no-response=进程在但没应答，看日志）"
    else
        echo "未运行"
        return 1
    fi
}

case "${1:-status}" in
    start) start ;;
    stop) stop ;;
    restart) stop; sleep 0.5; start ;;
    status) status ;;
    *) echo "用法: pnpm httpd start|stop|restart|status"; exit 1 ;;
esac
