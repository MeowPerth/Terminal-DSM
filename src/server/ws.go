package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

type controlMsg struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  32 * 1024,
	WriteBufferSize: 32 * 1024,
	// 只允许同源页面发起（等价 ttyd -O，防跨站 WebSocket 劫持）
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // 非浏览器客户端
		}
		return sameHost(origin, r.Host)
	},
}

// 只允许同源页面发起 WebSocket（防跨站劫持）
//
// 注意：nginx 的 $host 不含端口，所以除了精确比较，还要兼容 host 无端口的情况。
func sameHost(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	if u.Host == host {
		return true
	}
	if !strings.Contains(host, ":") && u.Hostname() == host {
		return true
	}
	return false
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	info := authorize(r)
	if info.result != authOK {
		if info.result == authNotAdmin {
			http.Error(w, "administrator permission required", http.StatusForbidden)
			return
		}
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}
	defer conn.Close()

	cmd := exec.Command("/bin/sh", "-c", *cmdline)
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERMINFO="+*terminfo,
	)

	// 管理员：直接 root；普通用户：降权到自己的账号（等价于用自己的账号登录）
	if !info.admin {
		// 注：不按 /etc/passwd 的 nologin 拒绝——那是限制 SSH/Telnet 的，
		// 这里的准入门槛是“能登录 DSM”（会话有效），DSM 禁用账号根本无法登录。
		if info.user == "" {
			log.Printf("deny: cannot determine DSM account for non-admin session")
			http.Error(w, "cannot determine your DSM account", http.StatusForbidden)
			return
		}
		u, err := user.Lookup(info.user)
		if err != nil {
			log.Printf("lookup user %q: %v", info.user, err)
			http.Error(w, "unknown account", http.StatusForbidden)
			return
		}
		uid, err1 := strconv.Atoi(u.Uid)
		gid, err2 := strconv.Atoi(u.Gid)
		if err1 != nil || err2 != nil {
			http.Error(w, "invalid account id", http.StatusForbidden)
			return
		}
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)},
		}
		if u.HomeDir != "" {
			if st, err := os.Stat(u.HomeDir); err == nil && st.IsDir() {
				cmd.Dir = u.HomeDir
			}
		}
		cmd.Env = append(cmd.Env,
			"HOME="+u.HomeDir,
			"USER="+u.Username,
			"LOGNAME="+u.Username,
			"SHELL=/bin/bash",
		)
		log.Printf("shell as %s (uid=%d gid=%d)", u.Username, uid, gid)
	} else {
		cmd.Env = append(cmd.Env, "HOME=/root", "USER=root", "LOGNAME=root", "SHELL=/bin/bash")
	}
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		log.Printf("pty start: %v", err)
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","msg":"cannot start terminal"}`))
		return
	}
	defer func() { _ = f.Close() }()

	var writeMu sync.Mutex
	write := func(mt int, b []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteMessage(mt, b)
	}

	// pty -> ws
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			n, err := f.Read(buf)
			if n > 0 {
				if werr := write(websocket.BinaryMessage, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// ws -> pty
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		switch mt {
		case websocket.BinaryMessage:
			if _, err := f.Write(data); err != nil {
				goto end
			}
		case websocket.TextMessage:
			var m controlMsg
			if json.Unmarshal(data, &m) == nil && m.Type == "resize" && m.Cols > 0 && m.Rows > 0 {
				_ = pty.Setsize(f, &pty.Winsize{Cols: m.Cols, Rows: m.Rows})
			}
		case websocket.PingMessage, websocket.PongMessage:
			// 忽略
		}
	}
end:
	_ = f.Close()
	<-done
	_ = cmd.Wait()
}
