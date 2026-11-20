#!/bin/sh
# 本地打包（不依赖 spksrc / GitHub Actions）
#
# 原理：以“上一个官方 SPK”为底座，复用其中的 tmux 二进制、lib、terminfo 等
#       预编译产物，只替换我们自己会变的部分（terminal-server、app、etc、scripts），
#       重算 INFO 里的 version / checksum 后重新打包。
#
# 用法：
#   BASE_SPK=/path/to/terminal_x64-7.0_5.0-1.spk ./tools/local-pack.sh
#   （GO=/usr/local/go/bin/go 可指定 go 路径；OUT=dist 可指定输出目录）
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
BASE_SPK=${BASE_SPK:-}
OUT=${OUT:-$REPO/dist}
GO=${GO:-go}

[ -n "$BASE_SPK" ] || { echo "用法: BASE_SPK=/path/to/base.spk $0"; exit 1; }
[ -f "$BASE_SPK" ] || { echo "找不到底座 SPK: $BASE_SPK"; exit 1; }
command -v "$GO" >/dev/null 2>&1 || { echo "找不到 go（可用 GO=/path/to/go）"; exit 1; }

VERS=$(sed -n 's/^SPK_VERS *= *//p' "$REPO/Makefile" | head -1 | tr -d ' ')
REV=$(sed -n 's/^SPK_REV *= *//p' "$REPO/Makefile" | head -1 | tr -d ' ')
if [ "${REV}" = "0" ] || [ -z "${REV}" ]; then
  VER="${VERS}"
else
  VER="${VERS}-${REV}"
fi

W=$(mktemp -d /tmp/localpack.XXXXXX)
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/base" "$W/pkg" "$OUT"

echo "==> 展开底座: $BASE_SPK"
tar -xf "$BASE_SPK" -C "$W/base"
tar -xzf "$W/base/package.tgz" -C "$W/pkg"

echo "==> 编译 terminal-server ($VER)"
( cd "$REPO/src/server" &&
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "$GO" build -mod=vendor -trimpath -ldflags "-s -w" -o "$W/pkg/bin/terminal-server" . )

echo "==> 覆盖 app / etc / scripts"
# 底座里 spksrc 自动生成了多尺寸图标（terminal-16/24/32…），本地打包要保留
mkdir -p "$W/icons-base"
cp -a "$W/pkg/app/images/." "$W/icons-base/" 2>/dev/null || true
rm -rf "$W/pkg/app"
cp -a "$REPO/src/app" "$W/pkg/app"
[ -d "$W/icons-base" ] && cp -a "$W/icons-base/." "$W/pkg/app/images/" 2>/dev/null || true
cp -a "$REPO/src/etc/." "$W/pkg/etc/"
cp -a "$REPO/src/service-setup.sh" "$W/base/scripts/service-setup"
cp -a "$REPO/src/start-stop-status.sh" "$W/base/scripts/start-stop-status"
chmod 755 "$W/base/scripts/"*

echo "==> 重新打包 package.tgz"
( cd "$W/pkg" && tar -czf "$W/base/package.tgz" . )

MD5=$(md5sum "$W/base/package.tgz" | awk '{print $1}')

# INFO 里的描述/维护者/主页也要跟 Makefile 同步（否则会沿用底座 SPK 的旧内容）
python3 "$REPO/tools/sync-info.py" "$REPO/Makefile" "$W/base/INFO" "$VER" "$MD5"

OUTFILE="$OUT/terminal_${VER}.spk"
( cd "$W/base" && tar -cf "$OUTFILE" package.tgz INFO scripts conf LICENSE WIZARD_UIFILES ./*.PNG 2>/dev/null )

echo "==> 完成: $OUTFILE ($(du -h "$OUTFILE" | awk '{print $1}'))"
echo "    version=${VER}  checksum=${MD5}"
