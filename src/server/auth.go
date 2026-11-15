package main

import (
	"crypto/tls"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ---------------- DSM 会话校验（带缓存，fail-closed） ----------------

type sessionState struct {
	ok    bool
	admin bool
	user  string
	until time.Time
}

var (
	sessMu sync.Mutex
	sessKV = map[string]sessionState{}
)

var client = &http.Client{
	Timeout: 4 * time.Second,
	Transport: &http.Transport{
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     30 * time.Second,
	},
}

// DSM 的 Web 端口因机器而异（5000/5001 或 5500/5501），启动后自动探测
var (
	dsmMu     sync.Mutex
	dsmPicked string
)

func dsmBases() []string {
	if *dsmBase != "" {
		return strings.Split(*dsmBase, ",")
	}
	return []string{
		"http://127.0.0.1:5000",
		"http://127.0.0.1:5500",
		"https://127.0.0.1:5001",
		"https://127.0.0.1:5501",
	}
}

func pickDSM() string {
	dsmMu.Lock()
	defer dsmMu.Unlock()
	if dsmPicked != "" {
		return dsmPicked
	}
	for _, base := range dsmBases() {
		req, err := http.NewRequest("GET", strings.TrimRight(base, "/")+"/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth", nil)
		if err != nil {
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		resp.Body.Close()
		if resp.StatusCode == 200 && strings.Contains(string(body), `"success"`) {
			dsmPicked = strings.TrimRight(base, "/")
			log.Printf("dsm endpoint: %s", dsmPicked)
			return dsmPicked
		}
	}
	return ""
}

func dsmOK(sid, path, clientIP, token string) bool {
	return dsmOKFrom(sid, path, clientIP, token)
}

func dsmGet(sid, path, clientIP, token string) ([]byte, bool) {
	base := pickDSM()
	if base == "" {
		log.Printf("dsm endpoint not reachable")
		return nil, false
	}
	req, err := http.NewRequest("GET", base+path, nil)
	if err != nil {
		return nil, false
	}
	req.AddCookie(&http.Cookie{Name: "id", Value: sid})
	if token != "" {
		// DSM 的浏览器会话默认启用 SynoToken，API 调用必须带这个头
		req.Header.Set("X-SYNO-TOKEN", token)
	}
	if clientIP != "" {
		req.Header.Set("X-Forwarded-For", clientIP)
		req.Header.Set("X-Real-IP", clientIP)
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("dsm api %s: %v", path, err)
		return nil, false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if resp.StatusCode != 200 {
		return body, false
	}
	var v struct {
		Success bool `json:"success"`
	}
	if err := json.Unmarshal(body, &v); err == nil {
		if !v.Success {
			log.Printf("dsm api %s -> %s", path, snippet(body))
		}
		return body, v.Success
	}
	return body, strings.Contains(string(body), `"success":true`)
}

func dsmOKFrom(sid, path, clientIP, token string) bool {
	_, ok := dsmGet(sid, path, clientIP, token)
	return ok
}

// 返回值：会话是否有效、是否管理员
func checkSession(sid, clientIP, token string) (ok bool, user string, admin bool) {
	if sid == "" {
		return false, "", false
	}
	// 一次调用同时拿到“会话是否有效 / 当前用户名 / 是否管理员”。
	// 注意：Initdata 对未登录请求也会返回 success:true（isLogined=false、无 user），
	// 所以必须同时要求 isLogined 且 user 非空，否则不能当成有效会话。
	if body, ok := dsmGet(sid, "/webapi/entry.cgi?api=SYNO.Core.Desktop.Initdata&version=1&method=get", clientIP, token); ok {
		var v struct {
			Data struct {
				Session struct {
					User      string `json:"user"`
					IsAdmin   bool   `json:"is_admin"`
					IsLogined bool   `json:"isLogined"`
				} `json:"Session"`
			} `json:"data"`
		}
		if json.Unmarshal(body, &v) == nil && v.Data.Session.IsLogined && v.Data.Session.User != "" {
			return true, v.Data.Session.User, v.Data.Session.IsAdmin
		}
		log.Printf("dsm Initdata 返回未登录（isLogined=%v user=%q），继续用需要会话的接口复核",
			v.Data.Session.IsLogined, v.Data.Session.User)
	}
	// 兜底 / 复核：这两个接口对无效会话会返回 {"error":{"code":119}}，可信
	if dsmOKFrom(sid, "/webapi/entry.cgi?api=SYNO.FileStation.Info&version=2&method=get", clientIP, token) {
		admin = dsmOKFrom(sid, "/webapi/entry.cgi?api=SYNO.Core.System&version=1&method=info", clientIP, token)
		return true, "", admin
	}
	if dsmOKFrom(sid, "/webapi/entry.cgi?api=SYNO.Core.System&version=1&method=info", clientIP, token) {
		return true, "", true // 能调 System.info 的一定是管理员
	}
	return false, "", false
}

func lookupSession(sid, clientIP, token string) (ok bool, user string, admin bool) {
	if sid == "" {
		return false, "", false
	}
	key := sid + "|" + token
	sessMu.Lock()
	st, hit := sessKV[key]
	sessMu.Unlock()
	if hit && time.Now().Before(st.until) {
		return st.ok, st.user, st.admin
	}
	ok, user, admin = checkSession(sid, clientIP, token)
	d := *cacheTTL
	if !ok {
		d = *cacheNegTTL
	}
	sessMu.Lock()
	sessKV[key] = sessionState{ok: ok, admin: admin, user: user, until: time.Now().Add(d)}
	if len(sessKV) > 4096 {
		now := time.Now()
		for k, v := range sessKV {
			if now.After(v.until) {
				delete(sessKV, k)
			}
		}
	}
	sessMu.Unlock()
	return ok, user, admin
}

func sessionID(r *http.Request) string {
	c, err := r.Cookie("id")
	if err != nil {
		return ""
	}
	return c.Value
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	return r.RemoteAddr
}

type authInfo struct {
	result authResult
	user   string
	admin  bool
}

type authResult int

const (
	authOK authResult = iota
	authNoSession
	authNotAdmin
)

func authorize(r *http.Request) authInfo {
	sid := sessionID(r)
	tok := r.URL.Query().Get("t")
	ok, user, admin := lookupSession(sid, clientIP(r), tok)
	if !ok && tok != "" {
		// token 过期时回退一次（不支持 token 的会话仍可只靠 cookie）
		ok, user, admin = lookupSession(sid, clientIP(r), "")
	}
	if !ok {
		log.Printf("deny(no-session): path=%s cookie=%v sidLen=%d token=%v ip=%s ua=%q ref=%q",
			r.URL.Path, sid != "", len(sid), tok != "", clientIP(r),
			truncate(r.UserAgent(), 60), truncate(r.Referer(), 80))
		return authInfo{result: authNoSession}
	}
	if *adminOnly && !admin {
		log.Printf("deny(non-admin): path=%s sid=%s ua=%q", r.URL.Path, mask(sid), truncate(r.UserAgent(), 60))
		return authInfo{result: authNotAdmin, user: user}
	}
	return authInfo{result: authOK, user: user, admin: admin}
}


func snippet(b []byte) string { return truncate(string(b), 160) }

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func mask(s string) string {
	if len(s) <= 6 {
		return "***"
	}
	return s[:6] + "***"
}
