#!/usr/bin/env bash
#
# Terminal-DSM —— 群晖 DSM 窗口化终端
#   单二进制 terminal-server（认证 + UI + 终端）+ tmux（会话保持/多窗口）
#
# Copyright (C) 2022 Ing <https://github.com/wjz304>（上游 4.0 基础）
# 1.0.0 重写：https://github.com/MeowPerth/Terminal-DSM
#

CONF_FILE() { echo "${SYNOPKG_PKGVAR}/terminal.conf"; }

write_default_config() {
  mkdir -p "${SYNOPKG_PKGVAR}"
  if [ ! -f "$(CONF_FILE)" ]; then
    cat >"$(CONF_FILE)" <<EOT
# true（默认）= 管理员进 root，普通用户进自己的账号
# false        = 只有 administrators 能用
ALLOW_ALL_USERS=true
EOT
  fi
}

service_postinst() {
  echo "service_postinst ${SYNOPKG_PKG_STATUS}"
  write_default_config
}

service_postupgrade() {
  echo "service_postupgrade ${SYNOPKG_PKG_STATUS}"
  write_default_config
}

service_prestart() {
  echo "service_prestart: Before service start"

  local pkg="${SYNOPKG_PKGDEST}"
  local var="${SYNOPKG_PKGVAR}"
  local sock="${var}/terminal-server.sock"

  local ALLOW_ALL_USERS="false"
  [ -r "$(CONF_FILE)" ] && . "$(CONF_FILE)"

  local admin_flag="-admin-only=true"
  [ "${ALLOW_ALL_USERS}" = "true" ] && admin_flag="-admin-only=false"

  # 清理上次残留
  rm -f "${sock}"
  "${pkg}/bin/tmux" -u kill-session -t terminal >/dev/null 2>&1 || true

  # 启动终端服务（只监听 unix socket，不占 TCP 端口）
  LD_LIBRARY_PATH="${pkg}/bin:${pkg}/lib:${LD_LIBRARY_PATH:-}" \
    nohup "${pkg}/bin/terminal-server" \
    -socket "${sock}" \
    -cmd "${pkg}/bin/tmux -u -f ${pkg}/etc/terminal_tmux.conf new -A -s terminal" \
    -terminfo "${pkg}/share/terminfo" \
    -app "MeowPerth.Terminal.AppInstance" \
    ${admin_flag} \
    >"${LOG_FILE}" 2>&1 &
  echo $! >"${PID_FILE}"

  # nginx 以 http 用户运行，socket 需要可读写
  local i=0
  while [ ${i} -lt 20 ]; do
    [ -S "${sock}" ] && break
    i=$((i + 1))
    sleep 0.5
  done
  [ -S "${sock}" ] && chmod 666 "${sock}" 2>/dev/null

  # nginx 反代
  ln -sf "${pkg}/etc/alias.terminal.conf" /etc/nginx/conf.d/alias.terminal.conf
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
  else
    rm -f /etc/nginx/conf.d/alias.terminal.conf
    echo "nginx configuration error"
  fi
}

service_poststop() {
  echo "service_poststop: After service stop"

  rm -f /etc/nginx/conf.d/alias.terminal.conf
  systemctl reload nginx

  "${SYNOPKG_PKGDEST}/bin/tmux" -u kill-session -t terminal >/dev/null 2>&1 || true
  rm -f "${SYNOPKG_PKGVAR}/terminal-server.sock" 2>/dev/null

  if [ -n "${PID_FILE}" ] && [ -r "${PID_FILE}" ]; then
    for pid in $(cat "${PID_FILE}"); do
      kill -TERM "${pid}" 2>/dev/null
      wait_for_status 1 "${SVC_WAIT_TIMEOUT:=20}" "${pid}" || kill -KILL "${pid}" 2>/dev/null
    done
    rm -f "${PID_FILE}"
  fi
}
