/* 终端前端：xterm.js + WebSocket，二进制帧=终端数据，文本帧=控制消息 */
(function () {
  "use strict";

  var term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", "Noto Sans Mono CJK SC", monospace',
    scrollback: 10000,
    allowProposedApi: true,
    theme: {
      background: "#1e1e1e", foreground: "#d4d4d4",
      cursor: "#ffffff", selectionBackground: "#264f78",
      black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
      blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
      brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
      brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
      brightCyan: "#29b8db", brightWhite: "#e5e5e5"
    }
  });

  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("terminal"));
  fit.fit();

  var toastEl = document.getElementById("toast");
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = "0"; }, 1400);
  }

  /* ---------- 剪贴板 ---------- */
  function writeClipboard(text) {
    if (!text) return;
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast("✓ 已复制 " + text.length + " 字符");
      }, function () { legacyCopy(text); });
    } else {
      legacyCopy(text);
    }
  }
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    toast(ok ? "✓ 已复制 " + text.length + " 字符" : "复制失败");
  }
  function readClipboard() {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) { if (t) term.paste(t); }, function () {});
    }
  }

  /* tmux / 程序通过 OSC 52 设置剪贴板（tmux set-clipboard on） */
  if (term.parser && term.parser.registerOscHandler) {
    term.parser.registerOscHandler(52, function (data) {
      var i = data.lastIndexOf(";");
      var b64 = i >= 0 ? data.slice(i + 1) : "";
      if (!b64) return true;
      try {
        var bin = atob(b64), bytes = new Uint8Array(bin.length);
        for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        writeClipboard(new TextDecoder("utf-8").decode(bytes));
      } catch (e) {}
      return true;
    });
  }

  /* 鼠标拖选后自动复制（与 ttyd 行为一致） */
  term.onSelectionChange(function () {
    var s = term.getSelection();
    if (s) writeClipboard(s);
  });

  /* Ctrl+Shift+C / Ctrl+Shift+V */
  term.attachCustomKeyEventHandler(function (e) {
    if (e.type !== "keydown") return true;
    if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
      writeClipboard(term.getSelection());
      return false;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
      readClipboard();
      return false;
    }
    return true;
  });

  /* 右键：一按就弹出 tmux 上下文菜单，松开不消失。
     做法：右键的按下/松开全部拦下来，不让 xterm 上报；
     只在按下时由我们自己给 tmux 发一次 MouseDown3（弹出菜单），
     永远不发 MouseUp3 —— tmux 收不到“松开”，菜单就一直开着。
     菜单项用鼠标左键点，或按 h/v/x/r/m/z 快捷键。 */
  function termCell(ev) {
    var el = document.getElementById("terminal");
    var r = el.getBoundingClientRect();
    var cw = r.width / (term.cols || 1);
    var ch = r.height / (term.rows || 1);
    var col = Math.floor((ev.clientX - r.left) / cw) + 1;
    var row = Math.floor((ev.clientY - r.top) / ch) + 1;
    return {
      col: Math.min(term.cols || 1, Math.max(1, col)),
      row: Math.min(term.rows || 1, Math.max(1, row)),
    };
  }

  function sendRightPress(cell) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(encoder.encode("\x1b[<2;" + cell.col + ";" + cell.row + "M"));
  }

  function swallowRight(ev) {
    if (ev.button !== 2) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
  }

  window.addEventListener(
    "mousedown",
    function (ev) {
      if (ev.button !== 2) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      sendRightPress(termCell(ev));
    },
    true
  );

  // 松开/辅助点击一律吞掉，绝不把 MouseUp3 发给 tmux（发了菜单就会关）
  window.addEventListener("mouseup", swallowRight, true);
  window.addEventListener("pointerup", swallowRight, true);
  window.addEventListener("auxclick", swallowRight, true);
  window.addEventListener("contextmenu", swallowRight, true);

  /* ---------- WebSocket ---------- */
  var overlay = document.getElementById("overlay");
  var ws = null;
  var encoder = new TextEncoder();

  function wsURL() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    // 保留查询串：/?t=<SynoToken> 由 DSM 窗口带进来，服务端用它做 DSM API 鉴权
    return proto + "//" + location.host + location.pathname.replace(/\/+$/, "") + "/ws" + location.search;
  }

  function connect() {
    overlay.classList.remove("show");
    ws = new WebSocket(wsURL());
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      term.focus();
      sendResize();
      if (term.rows && term.cols) sendResize();
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data === "string") {
        try {
          var m = JSON.parse(ev.data);
          if (m.type === "error") toast(m.msg || "终端启动失败");
        } catch (e) {}
        return;
      }
      term.write(new Uint8Array(ev.data));
    };
    ws.onclose = function () {
      overlay.classList.add("show");
    };
    ws.onerror = function () {
      overlay.classList.add("show");
    };
  }

  function sendResize() {
    if (!ws || ws.readyState !== 1) return;
    fit.fit();
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }

  term.onData(function (d) {
    if (ws && ws.readyState === 1) ws.send(encoder.encode(d));
  });
  term.onResize(function () {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  });

  // 尺寸自适应：窗口/iframe 变化、字体度量延迟、ExtJS 动画结束后都重新 fit
  function fitNow() {
    try { fit.fit(); } catch (e) {}
  }
  window.addEventListener("resize", fitNow);
  if (window.ResizeObserver) {
    try { new ResizeObserver(fitNow).observe(document.getElementById("terminal")); } catch (e) {}
  }
  requestAnimationFrame(fitNow);
  setTimeout(fitNow, 60);
  setTimeout(fitNow, 250);
  setTimeout(fitNow, 800);
  overlay.addEventListener("click", function () { connect(); });
  document.getElementById("terminal").addEventListener("click", function () { term.focus(); });

  connect();
})();
