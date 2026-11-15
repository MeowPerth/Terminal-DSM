# ---------------------------------------------------------------------------
# Terminal-DSM —— 群晖 DSM 窗口化终端（单二进制 + tmux）
#
#   本仓库：https://github.com/MeowPerth/Terminal-DSM
#   维护者：MeowPerth
#
#   上游基础：RROrg/syno-apps 的 terminal 套件（原作者 wjz304 / Ing）
#     https://github.com/RROrg/syno-apps/tree/main/src/spk/terminal
#   1.0.0 起重写：不再使用 ttyd，认证/页面/终端合并为一个 Go 二进制。
#   原始代码版权归原作者，按 GPLv3 分发（见 LICENSE）。
# ---------------------------------------------------------------------------
SPK_NAME = terminal
SPK_VERS = 1.0.0
SPK_REV = 2
SPK_ICON = src/$(SPK_NAME).png

DEPENDS = cross/tmux
SPK_DEPENDS =
# 终端服务端是 Go 静态二进制，随架构构建（当前仅 x86_64）
SPK_PACKAGE_ARCHS = apollolake avoton braswell broadwell broadwellnk broadwellnkv2 broadwellntbap bromolow cedarview denverton epyc7002 epyc7003 epyc7003ntb geminilake geminilakenk grantley icelaked kvmx64 purley r1000 r1000nk v1000 v1000nk x86 x86_64

MAINTAINER = MeowPerth
MAINTAINER_URL = https://github.com/MeowPerth/Terminal-DSM
DISTRIBUTOR = MeowPerth
DISTRIBUTOR_URL = https://github.com/MeowPerth/Terminal-DSM
DISABLE_GITHUB_MAINTAINER = 1

DESCRIPTION = "Terminal that runs inside the DSM desktop window. Authentication is the DSM login itself (no extra port, no standalone web page): administrators get a root shell, other users get their own account. tmux keeps sessions alive with multi-window and split panes, and clipboard copy/paste works in the browser."
DESCRIPTION_CHS = "直接在 DSM 桌面窗口中使用的终端。认证完全走 DSM 登录（不占用额外端口、不开放独立网页）：管理员打开即 root，普通用户以本人账号登录；tmux 保持会话与多窗口/分屏，浏览器内可正常复制粘贴。"
DISPLAY_NAME = Terminal

HOMEPAGE = https://github.com/MeowPerth/Terminal-DSM
LICENSE = GPLv3
LICENSE_FILE = LICENSE

DSM_UI_DIR = app
DSM_UI_CONFIG = src/app/config
DSM_APP_NAME = MeowPerth.Terminal.AppInstance

WIZARDS_DIR = src/wizard

STARTABLE = yes
SERVICE_SETUP = src/service-setup.sh
SSS_SCRIPT = src/start-stop-status.sh

POST_STRIP_TARGET = terminal_strip_target

include ../../mk/spksrc.spk.mk

.PHONY: terminal_strip_target
terminal_strip_target:
	@[ -x src/server/bin/terminal-server ] || { \
		echo "ERROR: 缺少 src/server/bin/terminal-server"; \
		echo "       请先执行: src/server/build.sh（或由 CI 构建）"; \
		exit 1; \
	}
	install -m 755 -d $(STAGING_DIR)/bin
	install -m 755 src/server/bin/terminal-server $(STAGING_DIR)/bin/terminal-server

	install -m 755 -d $(STAGING_DIR)/etc/
	install -m 644 src/etc/alias.terminal.conf $(STAGING_DIR)/etc/alias.terminal.conf
	install -m 644 src/etc/terminal_tmux.conf $(STAGING_DIR)/etc/terminal_tmux.conf
	install -m 644 src/etc/terminal_bashrc $(STAGING_DIR)/etc/terminal_bashrc

	install -m 755 -d $(STAGING_DIR)/app/
	install -m 644 src/app/config $(STAGING_DIR)/app/config
	install -m 644 src/app/helptoc.conf $(STAGING_DIR)/app/helptoc.conf
	install -m 644 src/app/terminal.js $(STAGING_DIR)/app/terminal.js

	install -m 755 -d $(STAGING_DIR)/app/help
	for language in chs enu; do \
		install -m 755 -d $(STAGING_DIR)/app/help/$${language}; \
		install -m 644 src/app/help/$${language}/terminal_index.html $(STAGING_DIR)/app/help/$${language}/terminal_index.html; \
	done
	install -m 755 -d $(STAGING_DIR)/app/texts
	for language in chs enu; do \
		install -m 755 -d $(STAGING_DIR)/app/texts/$${language}; \
		install -m 644 src/app/texts/$${language}/strings $(STAGING_DIR)/app/texts/$${language}/strings; \
	done
	install -m 755 -d $(STAGING_DIR)/app/images/
	install -m 644 src/app/images/*.png $(STAGING_DIR)/app/images/
