// terminal-server —— 群晖 DSM 终端（单二进制：认证 + UI + 终端）
//
//   nginx(/terminal) --unix socket--> terminal-server --pty--> tmux --shell
//
// 特点：
//   * 不监听任何 TCP 端口；
//   * 所有请求先校验 DSM 会话 cookie（未登录 302 到 DSM 登录页）；
//   * 内嵌 xterm.js 前端，不再需要 ttyd；
//   * tmux 负责会话保持与多窗口。
package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"sort"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed assets
var assetsFS embed.FS

var (
	assetVerOnce sync.Once
	assetVerVal  string

	listenSock = flag.String("socket", "/var/packages/terminal/var/terminal-server.sock", "监听 unix socket")
	listenAddr = flag.String("addr", "", "调试用：监听 TCP 地址（留空则只监听 unix socket）")
	dsmBase    = flag.String("dsm", "", "DSM 基地址，逗号分隔；留空自动探测 5000/5500/5001/5501")
	appID      = flag.String("app", "MeowPerth.Terminal.AppInstance", "登录后回跳的 DSM 应用 ID")
	cmdline    = flag.String("cmd", "/var/packages/terminal/target/bin/tmux -u -f /var/packages/terminal/target/etc/terminal_tmux.conf new -A -s terminal", "终端里启动的命令")
	terminfo   = flag.String("terminfo", "/var/packages/terminal/target/share/terminfo", "TERMINFO 路径")
	adminOnly  = flag.Bool("admin-only", true, "只允许 DSM administrators 组")
	cacheTTL   = flag.Duration("cache-ttl", 60*time.Second, "会话校验成功缓存")
	cacheNegTTL = flag.Duration("cache-neg-ttl", 15*time.Second, "会话校验失败缓存")
)

func main() {
	flag.Parse()

	sub, err := fs.Sub(assetsFS, "assets")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// 兼容两种部署：nginx 去掉前缀后是 /、/ws；直接访问时是 /terminal/xxx
		p := strings.TrimPrefix(r.URL.Path, "/")
		p = strings.TrimPrefix(p, "terminal")
		p = strings.TrimPrefix(p, "/")

		if p == "ws" {
			handleWS(w, r)
			return
		}
		isAsset := strings.HasPrefix(p, "assets/")
		if !isAsset {
			switch a := authorize(r); a.result {
			case authOK:
				// 放行
			case authNotAdmin:
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(forbiddenPage))
				return
			default:
				if isWS(r) {
					http.Error(w, "login required", http.StatusUnauthorized)
					return
				}
				http.Redirect(w, r, "/webman/index.cgi?launchApp="+*appID, http.StatusFound)
				return
			}
		}
		if p == "" || p == "index.html" {
			serveEmbedded(w, r, sub, "index.html", "text/html; charset=utf-8")
			return
		}
		if isAsset {
			// 静态资源不带版本号，避免升级后浏览器继续用旧文件
			w.Header().Set("Cache-Control", "no-cache, must-revalidate")
			ct := "application/octet-stream"
			switch path.Ext(p) {
			case ".js":
				ct = "application/javascript; charset=utf-8"
			case ".css":
				ct = "text/css; charset=utf-8"
			}
			serveEmbedded(w, r, sub, strings.TrimPrefix(p, "assets/"), ct)
			return
		}
		http.NotFound(w, r)
	})

	handler := withLogging(mux)

	if *listenAddr != "" {
		srv := &http.Server{Addr: *listenAddr, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
		log.Printf("terminal-server listening on tcp %s (cmd=%q)", *listenAddr, *cmdline)
		log.Fatal(srv.ListenAndServe())
	}

	_ = os.Remove(*listenSock)
	ln, err := net.Listen("unix", *listenSock)
	if err != nil {
		log.Fatalf("listen %s: %v", *listenSock, err)
	}
	_ = os.Chmod(*listenSock, 0666)
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("terminal-server listening on %s (cmd=%q, admin-only=%v)", *listenSock, *cmdline, *adminOnly)
	log.Fatal(srv.Serve(ln))
}

const forbiddenPage = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Terminal</title><style>
html,body{margin:0;height:100%;background:#1e1e1e;color:#ddd;
font:14px/1.8 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.box{max-width:640px;margin:12vh auto;padding:24px 28px;background:#252526;border-radius:8px}
h2{margin:0 0 12px;font-size:17px;color:#f0a020}
code{background:#3a3a3a;padding:1px 5px;border-radius:3px}
a{color:#4daafc}
</style></head><body><div class="box">
<h2>需要管理员权限</h2>
<p>当前处于「仅管理员」模式（<code>ALLOW_ALL_USERS=false</code>）。</p>
<p>改成 <code>true</code> 后：管理员登录得到 root shell，其他 DSM 用户以自己的账号登录。</p>
<p><code>sudo sed -i 's/ALLOW_ALL_USERS=false/ALLOW_ALL_USERS=true/' /var/packages/terminal/var/terminal.conf<br>
sudo synopkg restart terminal</code></p>
<p>当前账号：<span id="u">（DSM 已登录）</span></p>
</div></body></html>`

// assetVer 是内嵌静态资源的内容哈希，拼在 URL 后面做缓存失效
func assetVer() string {
	assetVerOnce.Do(func() {
		h := sha256.New()
		var names []string
		_ = fs.WalkDir(assetsFS, ".", func(p string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				names = append(names, p)
			}
			return nil
		})
		sort.Strings(names)
		for _, n := range names {
			b, err := fs.ReadFile(assetsFS, n)
			if err == nil {
				h.Write([]byte(n))
				h.Write(b)
			}
		}
		assetVerVal = hex.EncodeToString(h.Sum(nil))[:8]
	})
	return assetVerVal
}

func serveEmbedded(w http.ResponseWriter, r *http.Request, sub fs.FS, name, ct string) {
	if strings.HasSuffix(name, "index.html") {
		if page, err := fs.ReadFile(sub, name); err == nil {
			page = []byte(strings.ReplaceAll(string(page), "__VER__", assetVer()))
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Content-Length", strconv.Itoa(len(page)))
			w.Header().Set("Cache-Control", "no-cache, must-revalidate")
			_, _ = w.Write(page)
			return
		}
	}
	b, err := fs.ReadFile(sub, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	_, _ = w.Write(b)
}

func isWS(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}
