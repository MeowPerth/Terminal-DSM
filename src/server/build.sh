#!/bin/sh
# 构建终端服务端二进制（静态链接，x86_64）
# CI 里 go 已在 PATH；本地构建可用 GO=/path/to/go 指定
set -e
cd "$(dirname "$0")"
GO="${GO:-go}"
command -v "$GO" >/dev/null 2>&1 || { echo "go not found (set GO=/usr/local/go/bin/go)"; exit 1; }
mkdir -p bin
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  "$GO" build -mod=vendor -trimpath -ldflags "-s -w" -o bin/terminal-server .
echo "built: $(pwd)/bin/terminal-server"
