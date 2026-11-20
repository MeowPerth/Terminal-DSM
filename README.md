# Terminal-DSM

[![release](https://img.shields.io/github/v/release/MeowPerth/Terminal-DSM?style=flat-square&label=release&color=blue)](https://github.com/MeowPerth/Terminal-DSM/releases)
[![stars](https://img.shields.io/github/stars/MeowPerth/Terminal-DSM?style=flat-square&label=stars&color=blue)](https://github.com/MeowPerth/Terminal-DSM/stargazers)
[![issues](https://img.shields.io/github/issues/MeowPerth/Terminal-DSM?style=flat-square&label=issues&color=yellow)](https://github.com/MeowPerth/Terminal-DSM/issues)
[![pull requests](https://img.shields.io/github/issues-pr/MeowPerth/Terminal-DSM?style=flat-square&label=pull%20requests&color=yellow)](https://github.com/MeowPerth/Terminal-DSM/pulls)
[![downloads](https://img.shields.io/github/downloads/MeowPerth/Terminal-DSM/total?style=flat-square&label=downloads&color=green)](https://github.com/MeowPerth/Terminal-DSM/releases)
[![license](https://img.shields.io/github/license/MeowPerth/Terminal-DSM?style=flat-square&label=license&color=orange)](https://github.com/MeowPerth/Terminal-DSM/blob/main/LICENSE)

**在 DSM 桌面窗口里直接使用的终端套件**：认证走 DSM 登录，管理员打开即 `root`，
普通用户以本人账号登录，tmux 保持会话与多窗口/分屏，浏览器里复制粘贴正常工作。

- 不占用任何 TCP 端口（只监听 unix socket）
- 不开放独立的 Web 页面（只在 DSM 窗口里用）
- 不是 ttyd 的包装，而是**单个 Go 静态二进制**同时负责认证 / 界面 / 终端

> [!WARNING]
> **群晖上使用 Terminal 终端套件，请先评估风险再安装。**
>
> 这套件把 NAS 的 shell 通过 Web 暴露出来，而 **套件中的ttyd 时代的实现没有任何鉴权**：
>
> - **3.x（如 3.0-5）**：ttyd 直接监听 **TCP `17681`**（`-p 17681 -6 -a -W -b /terminal/`），同时 nginx 又把 `/terminal` 反代到同一个 ttyd。
>   也就是说，看到 `http://<NAS>:17681/terminal/` 或 `https://<NAS>:5001/terminal/` 的**任何人**都能直接进入 shell，**不需要 DSM 账号**。
>   而且 3.x 的 ttyd 直接运行 `tmux new -A -s terminal`，**所有人共用同一个 tmux 会话**：别人进来能看到你正在输入的内容，也能接管你的 root shell。
> - **4.0**：改为 unix socket（不再监听 17681），但入口**仍然没有鉴权**，反代时还会 `proxy_set_header Cookie ""` 主动丢弃 cookie；
>   默认 `USER_LOGIN=false` 会走 `login`（需要 root 密码），tmux 默认关闭（`WITH_TMUX=false`）。
> - **4.0 的 tmux 不建议开启**：它同样是 `tmux new -A -s terminal`，一旦开启，**所有访问者接入同一个会话**；
>   配上无鉴权的入口，等于把同一个 root shell 分享给所有能访问到这个地址的人。
>
> 如果 NAS 有公网访问（端口映射 / DDNS / QuickConnect），**不要使用 3.x，也不要在 4.0 里开启 tmux**。
> 套件默认以 root 运行，一旦暴露就等于把 NAS 的最高权限交出去。
>
> 本项目（1.1.1）把入口绑定到 DSM 会话（cookie + `SynoToken`）、只监听 unix socket、管理员与普通用户分别运行，
> 但**仍不建议把 DSM 管理端口直接暴露到公网**：请配合 VPN / 反向代理 + 访问控制，并开启强密码与两步验证。

> 本项目基于 [RROrg/syno-apps](https://github.com/RROrg/syno-apps) 里的 `terminal` 套件
> （4.0-2，原作者 [wjz304](https://github.com/wjz304)，基于 ttyd）重写而来，1.0.0 起为单二进制实现，1.1.0 起提供工具栏（1.1.1 修复终端右侧留白与关窗格时的提示闪烁）。
> 原始代码版权归原作者，本项目按 **GPLv3** 分发，详见 [LICENSE](LICENSE)。

---

## 目录

- [功能特性](#功能特性)
- [工作原理](#工作原理)
- [安装](#安装)
- [配置](#配置)
- [安全模型](#安全模型)
- [与原项目对比](#与原项目对比)
- [常见问题](#常见问题)
- [构建](#构建)
- [致谢](#致谢)

---

## 功能特性

### 认证与权限

| 能力 | 说明 |
|---|---|
| **DSM 登录即认证** | 校验 DSM 会话 cookie + `SynoToken`（浏览器会话默认启用），无需二次输入密码 |
| **未登录拦截** | 无有效会话一律 302 到 DSM 登录 / 应用窗口，不会出现"裸奔"页面 |
| **管理员 → root** | `administrators` 组成员打开即为 `root` shell |
| **普通用户 → 本人账号** | 其他 DSM 用户以自己的 uid/gid 运行，独立家目录、独立权限，`$` 提示符 |
| **可收紧** | `ALLOW_ALL_USERS=false` 时只有 administrators 能用（普通用户看到明确的 403 说明页） |

### 工具栏（1.1.0 起）

| 按钮 | 说明 |
|---|---|
| `A−` / 字号 / `A+` | 调整字号（9~28），记在浏览器本地，也支持 `Ctrl+滚轮` |
| 左右分屏 | 发送 `Ctrl+B %` |
| 上下分屏 | 发送 `Ctrl+B "` |
| 关闭窗格 | 带应用内确认框，确认后发送 `Ctrl+B x` + `y` |
| `? 帮助` | 快捷键说明（Esc 或点空白处关闭） |

右键保留浏览器原生菜单（复制/粘贴/检查元素），tmux 的右键菜单已抑制；除 `%` `"` `x` 外的 tmux 快捷键全部解绑。

### 终端

| 能力 | 说明 |
|---|---|
| **会话保持** | 后端是 tmux，关掉窗口/断网后重新打开会接回原来的现场（含历史输出） |
| **多窗口 / 分屏** | `Ctrl+B c` 新建窗口、`%` / `"` 分屏、方向键切换，状态栏显示窗口列表 |
| **5 万行历史** | tmux `history-limit 50000`，网页端再叠 1 万行回滚 |
| **提示符带路径** | `root@HServer:/volume1#` / `qaz@HServer:/volume1/homes/qaz$`，加载 `/etc/profile` 环境 |
| **右键菜单** | 终端内右键弹出 tmux 上下文菜单（分屏/杀窗格/缩放/粘贴 tmux 缓冲），松开右键不消失 |
| **状态栏置顶** | 可改回底部（一行配置） |

### 剪贴板

| 操作 | 方式 |
|---|---|
| 复制 | 鼠标拖选**自动复制**；或 `Ctrl+Shift+C` |
| 粘贴 | `Ctrl+Shift+V` |
| tmux 内复制 | 通过 **OSC 52** 直接写入系统剪贴板（`set-clipboard on`） |
| 浏览器右键菜单 | 已屏蔽（右键让给 tmux 菜单） |

### 部署与运维

- **零 TCP 端口**：`terminal-server` 只监听 `/var/packages/terminal/var/terminal-server.sock`
- **入口唯一**：nginx 的 `/terminal` location 是唯一入口，鉴权在应用内完成，不依赖 nginx 的 auth 模块（DSM 的 nginx 没有 `auth_request`）
- **WebSocket 同源校验**：阻断跨站 WebSocket 劫持（CSWSH）
- **静态资源带内容哈希**：升级后浏览器不会继续用旧的 `app.js`（不需要手动强刷）
- **失败可见**：非管理员、账号识别失败等情况会给出明确提示页，而不是空白窗口

---

## 工作原理

```
┌──────────────┐   HTTPS   ┌───────────────┐  unix socket  ┌──────────────────┐
│ DSM 桌面窗口  │ ────────► │ DSM 的 nginx  │ ────────────► │ terminal-server  │
│ (iframe)     │ ◄──────── │  /terminal    │ ◄──────────── │  (Go 单二进制)    │
└──────────────┘           └───────────────┘               └────────┬─────────┘
        ▲                                                            │ pty
        │ WebSocket（二进制帧=终端数据，文本帧=控制消息）              ▼
        └───────────────────────────────────────────────────  tmux  ──►  bash/root shell
```

`terminal-server` 每个请求的处理顺序：

1. 取 DSM 会话 cookie（`id`）与 `SynoToken`（窗口 URL 里的 `?t=`，由 DSM 应用 JS 注入）
2. 调本机 DSM API（`SYNO.Core.Desktop.Initdata`）确认会话有效、拿到**用户名**和**是否管理员**（结果缓存 60s）
3. 无效 → 302 到 DSM；有效但无权限 → 403 说明页
4. 通过后在 pty 里启动 tmux：
   - 管理员：以 root 运行
   - 普通用户：`syscall.Credential` 降权到该用户，`HOME`/cwd 设为其家目录
5. WebSocket 双向转发，tmux 负责会话保持

---

## 安装

### 从 Release 安装

1. 到 [Releases](https://github.com/MeowPerth/Terminal-DSM/releases) 下载对应架构的 `.spk`（目前提供 `x64-7.0`，即 DSM 7.x x86_64）
2. DSM → **套件中心 → 手动安装**
3. 安装后如果显示"需要 root 权限"，执行一次：

```sh
sudo sed -i 's/"package"/"root"/g; s/package/root/g' /var/packages/terminal/conf/privilege
sudo synopkg restart terminal
```

> 这是 DSM 的限制：套件升级/重装会把 `privilege` 重置成 `package`，而本套件需要 root 才能创建 pty 与 tmux。

### 打开方式

- DSM 左上角九宫格 → **Terminal**
- 或直接访问 `https://<NAS-IP>:5001/terminal/`（会自动打开 DSM 应用窗口）

首次打开若窗口空白，按 `Ctrl+Shift+R` 强刷一次 DSM 页面即可（DSM 前端缓存，之后版本的静态资源已带哈希，不再需要）。

---

## 配置

### 1. 权限：`/var/packages/terminal/var/terminal.conf`

```sh
# true（默认） = 管理员进 root，其他 DSM 用户进自己的账号
# false        = 只有 administrators 组能用（普通用户看到 403 说明页）
ALLOW_ALL_USERS=true
```

改完 `sudo synopkg restart terminal`。

### 2. tmux：`/var/packages/terminal/target/etc/terminal_tmux.conf`

| 配置 | 默认 | 说明 |
|---|---|---|
| `status-position` | `top` | 状态栏在顶/底 |
| `status-style` | `bg=green,fg=black` | 状态栏配色 |
| `mouse` | `on` | 鼠标选择/滚轮/右键菜单 |
| `set-clipboard` | `on` | tmux 内复制走 OSC 52 |
| `history-limit` | `50000` | tmux 回滚行数 |
| `base-index` | `1` | 窗口编号从 1 开始 |
| `default-command` | `bash --rcfile …/terminal_bashrc -i` | 窗格里跑什么 |

改完重开终端窗口生效。

### 3. Shell 环境：`/var/packages/terminal/target/etc/terminal_bashrc`

```bash
[ -f /etc/profile ] && . /etc/profile          # 登录环境（PATH 等）
PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
alias ll='ls -alF --color=auto'
```

### 4. 界面（写在代码里，改后需重新打包）

`fontSize`(14)、`fontFamily`、`scrollback`(10000)、`cursorBlink`、`theme`（深色）→ `src/server/assets/app.js`
窗口默认大小 `1160×620`、是否允许多开 → `src/app/terminal.js`、`src/app/config`

### 5. 服务端参数

`-socket`、`-addr`（调试用 TCP）、`-dsm`、`-app`、`-cmd`、`-terminfo`、`-admin-only`、`-cache-ttl`、`-cache-neg-ttl`
见 `src/service-setup.sh` 的启动参数。

---

## 安全模型

| 威胁 | 处理 |
|---|---|
| 未登录访问 `/terminal` | 302 到 DSM 登录页（无有效 cookie 直接拒绝） |
| 伪造 / 过期 cookie | 服务端调 DSM API 校验，失败即拒绝；结果缓存 60s（失败 15s） |
| 跨站 WebSocket（CSWSH） | 校验 `Origin` 与 `Host` 一致，不一致 403 |
| 外部直连终端 | 服务只监听 unix socket，**没有任何 TCP 监听** |
| 普通用户提权 | 非管理员以本人 uid/gid 运行，不是 root |
| 旧前端残留 | 静态资源带内容哈希 + `no-cache` |
| 会话校验被"假成功"绕过 | DSM 的 `SYNO.Core.Desktop.Initdata` 对未登录请求也返回 `success:true`（`isLogined:false`、无 `user`），因此校验要求 `isLogined` 且 `user` 非空，并再用需要会话的接口复核 |

> 管理员拿到的是 root shell，等价于 NAS 的最高权限。终端的安全性最终取决于 DSM 账号本身（强密码、两步验证），因此不建议把 DSM 管理端口直接暴露到公网。

---

## 与原项目对比

原项目：[RROrg/syno-apps · `src/spk/terminal`](https://github.com/RROrg/syno-apps/tree/main/src/spk/terminal)
（4.0-2，作者 wjz304），实现方式为 ttyd + 可选 tmux。下表对比两者的实现差异。

### 功能对照

| 维度 | 原项目 4.0-2（ttyd） | Terminal-DSM 1.1.1 |
|---|---|---|
| **入口认证** | ❌ 无。nginx 的 `location /terminal` 直接反代到 ttyd 的 unix socket，不做任何校验；而且 `proxy_set_header Cookie ""` **主动丢掉 cookie**，所以哪怕 DSM 已登录也传不进去 | ✅ 应用内校验 DSM 会话（cookie + `SynoToken`），未登录 302 到登录页 |
| **打开后要输密码** | ⚠️ 默认是 `login`（`USER_LOGIN=false`），会弹 `login:` 要 root 密码 | ✅ 打开即进 shell（认证已经由 DSM 完成） |
| **权限模型** | ⚠️ 只有一种：root（`login` 用 root 登录，或直接 root shell） | ✅ 管理员 → root；其他 DSM 用户 → **本人账号**（`syscall.Credential` 降权） |
| **谁能看到这个应用** | `allUsers: false`，只有 administrators 在 DSM 里看得到 | `allUsers: true`，再由 `ALLOW_ALL_USERS` 决定普通用户能否用 |
| **跨站 / CSRF 防护** | ❌ 响应头带 `Access-Control-Allow-Origin: *` + `Allow-Credentials: true`，且不校验 `Origin` | ✅ 移除全部 CORS 头；WebSocket 校验 `Origin` 与 `Host` 一致（防 CSWSH） |
| **网络暴露** | unix socket（不额外占端口），但入口对任何能访问 DSM 端口的人开放 | unix socket；入口有会话校验，无 TCP 监听 |
| **会话保持 / 多窗口** | ⚠️ tmux 是**可选**的（`WITH_TMUX`，安装向导未暴露，默认 `false`）→ 默认**没有**会话保持，关窗口即断 | ✅ 固定用 tmux：多窗口、分屏、`Ctrl+B d` 断开重连、5 万行历史 |
| **剪贴板** | ❌ ttyd 1.7.x 只支持 `document.execCommand('copy')` 选中复制；启动参数里的 `-t allow-clipboard-read/write` **不是 ttyd 的有效选项**（不生效），tmux 的 `set-clipboard` 也只在启用 tmux 时才有，且 ttyd 不支持 OSC 52 | ✅ OSC 52 + 选中自动复制 + `Ctrl+Shift+C/V` |
| **提示符** | ⚠️ `login` 后是 DSM 默认的 `HServer> `；非登录 shell 则是 `bash-4.4#`（不含路径） | ✅ `root@HNAS:/path#`、`user@HNAS:/path$` |
| **前端来源** | ttyd 自带页面 | 内嵌 xterm.js（和认证一起编译进同一个二进制） |
| **依赖** | ttyd +（可选）tmux + nginx 反代 | Go 单二进制 + tmux |
| **架构** | `SPK_PACKAGE_ARCHS = noarch`，但 ttyd 是 x86_64 预编译二进制 | 只出 `x64-7.0`（Go 二进制随架构构建） |
| **出错表现** | 页面白屏 / 502 / 无提示 | 明确的 302 / 403 说明页 + 服务端拒绝日志 |

### 相对原项目的主要差异

- **入口鉴权**：以 DSM 会话作为唯一准入条件；原项目入口不做校验，并在反代时主动丢弃 cookie
- **无需二次输入密码**：DSM 登录完成认证，打开即为 shell
- **权限分级**：administrators 得到 root，其他用户以本人账号运行
- **剪贴板**：OSC 52 + 选中即复制 + 快捷键
- **内建 tmux**：会话保持、多窗口、分屏均为默认能力，而非可选项
- **单二进制**：认证、界面、终端编译进同一个 Go 二进制，不依赖 ttyd 与页面注入
- **升级即生效**：静态资源 URL 带内容哈希

## 常见问题

**Q：打开是空白窗口？**
A：DSM 前端缓存。`Ctrl+Shift+R` 强刷一次；1.0.0 起资源带哈希，正常不会再出现。

**Q：提示 "This package requires root privileges"？**
A：执行一次 `sed -i 's/"package"/"root"/g; s/package/root/g' /var/packages/terminal/conf/privilege` 再 `synopkg restart terminal`。

**Q：右键没反应 / 菜单不弹？**
A：先确认页面是最新版本（强刷）；终端内右键应弹出 tmux 菜单，菜单项用左键点或按 `h/v/x/r/m/z`。

**Q：`Ctrl+V` 为什么不是粘贴？**
A：终端里 `Ctrl+V` 是 bash 的 quoted-insert（显示 `^V`），粘贴请用 `Ctrl+Shift+V`。

**Q：普通用户看不见 Terminal 图标？**
A：检查 `src/app/config` 的 `allUsers`（默认 `true`）与 `terminal.conf` 的 `ALLOW_ALL_USERS`。

**Q：会话会丢吗？**
A：不会。tmux 会话在服务端，关窗口/断线后重新打开会接回；重启套件或 NAS 才会重建。

**Q：怎么卸载干净？**
A：套件中心卸载即可；nginx 的 `alias.terminal.conf` 与 `@appstore/terminal` 会由卸载脚本删除。

---

## 构建

### 方式一：GitHub Actions（spksrc 完整构建）

仓库自带 `.github/workflows/build.yml`，手动 `workflow_dispatch` 触发（可选填 version），产物在 Release。

### 方式二：本地快速打包（推荐迭代时用）

以"上一个官方 SPK"为底座，复用其中的 tmux 二进制/lib/terminfo，只替换自己会变的部分：

```sh
BASE_SPK=/path/to/terminal_x64-7.0_<ver>.spk ./tools/local-pack.sh
# ==> dist/terminal_<ver>.spk
```

需要 `go`（可用 `GO=/usr/local/go/bin/go` 指定）。

---

## 致谢

- **上游项目**：[RROrg/syno-apps](https://github.com/RROrg/syno-apps) 的 `terminal` 套件，以及作者 [wjz304](https://github.com/wjz304) 的原始实现与打包脚本
- **spksrc**：SynoCommunity 的构建框架（套件打包流程的基础）
- **tmux**、**xterm.js**、**gorilla/websocket**、**creack/pty**

原项目为 GPLv3，本项目同样遵循 **GPLv3**。
