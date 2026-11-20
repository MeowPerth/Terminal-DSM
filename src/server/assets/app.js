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

  // xterm 默认会给滚动条预留约 15px（scrollBarWidth），即使滚动条已被 CSS 隐藏，
  // 这会让终端右侧空出一条。把它置 0，列数就能铺满容器宽度。
  function dropScrollbarReserve() {
    try {
      var vp = term._core && term._core.viewport;
      if (vp) vp.scrollBarWidth = 0;
    } catch (e) {}
  }
  dropScrollbarReserve();
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

  /* 右键：交还给浏览器（使用浏览器自带的右键菜单：复制/粘贴/检查元素等）。
     只做一件事：把右键事件挡在 xterm 之前，避免 tmux 也弹出它自己的菜单。
     粘贴仍可用 Ctrl+Shift+V。 */
  window.addEventListener(
    "mousedown",
    function (ev) {
      if (ev.button !== 2) return;
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    },
    true
  );
  window.addEventListener(
    "mouseup",
    function (ev) {
      if (ev.button !== 2) return;
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    },
    true
  );

  /* ---------- 工具栏 ---------- */
  var PREFIX = "\x02"; // Ctrl+B

  function sendKeys(str) {
    if (!ws || ws.readyState !== 1) {
      toast("未连接");
      return;
    }
    ws.send(encoder.encode(str));
  }

  function keepFocus() {
    try { term.focus(); } catch (e) {}
  }

  function applyFontSize(n) {
    n = Math.max(9, Math.min(28, parseInt(n, 10) || 14));
    term.options.fontSize = n;
    try { fit.fit(); } catch (e) {}
    var el = document.getElementById("fontsize");
    if (el) el.value = String(n);
    try { localStorage.setItem("term.fontSize", String(n)); } catch (e) {}
  }

  /* ---------- 弹层（帮助 / 确认） ---------- */
  function showModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add("show");
  }
  function hideModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove("show");
  }
  function hideAllModals() {
    ["help", "confirm"].forEach(hideModal);
  }

  var confirmResolver = null;
  function askConfirm(title, text) {
    var box = document.getElementById("confirm");
    if (!box) return Promise.resolve(true);
    box.querySelector("h3").textContent = title || "确认";
    document.getElementById("confirm-text").textContent = text || "";
    showModal("confirm");
    return new Promise(function (resolve) {
      confirmResolver = resolve;
    });
  }

  (function initModals() {
    var confirmBox = document.getElementById("confirm");
    if (confirmBox) {
      confirmBox.addEventListener("click", function (ev) {
        if (ev.target === confirmBox) { hideModal("confirm"); if (confirmResolver) { confirmResolver(false); confirmResolver = null; } }
      });
      var ok = document.getElementById("confirm-ok");
      var cancel = document.getElementById("confirm-cancel");
      if (ok) ok.addEventListener("click", function () { hideModal("confirm"); if (confirmResolver) { confirmResolver(true); confirmResolver = null; } });
      if (cancel) cancel.addEventListener("click", function () { hideModal("confirm"); if (confirmResolver) { confirmResolver(false); confirmResolver = null; } });
    }
    var help = document.getElementById("help");
    if (help) {
      help.addEventListener("click", function (ev) { if (ev.target === help) hideModal("help"); });
    }
    window.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      if (help && help.classList.contains("show")) { hideModal("help"); ev.stopPropagation(); }
      if (confirmBox && confirmBox.classList.contains("show")) { hideModal("confirm"); if (confirmResolver) { confirmResolver(false); confirmResolver = null; } ev.stopPropagation(); }
    }, true);
  })();

  (function initToolbar() {
    var bar = document.getElementById("bar");
    if (!bar) return;

    var saved = parseInt(localStorage.getItem("term.fontSize") || "", 10);
    if (saved >= 9 && saved <= 28) applyFontSize(saved);

    bar.addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest("button") : null;
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      var f = btn.getAttribute("data-font");

      if (f === "-") { applyFontSize((term.options.fontSize || 14) - 1); return; }
      if (f === "+") { applyFontSize((term.options.fontSize || 14) + 1); return; }

      switch (act) {
        case "split-h":
          sendKeys(PREFIX + "%");
          keepFocus();
          return;
        case "split-v":
          sendKeys(PREFIX + '"');
          keepFocus();
          return;
        case "kill-pane":
          askConfirm("关闭当前窗格？", "如果是最后一个窗格，会话会结束，需要重新打开窗口。").then(function (ok) {
            if (!ok) return;
            // tmux 侧 bind x 直接 kill-pane（不再弹它自己的确认），所以只发一次
            sendKeys(PREFIX + "x");
            keepFocus();
          });
          return;
        case "help":
          showModal("help");
          return;
      }
    });

    // Ctrl + 滚轮 缩放字号
    var termEl = document.getElementById("terminal");
    if (termEl) {
      termEl.addEventListener("wheel", function (ev) {
        if (!ev.ctrlKey) return;
        ev.preventDefault();
        applyFontSize((term.options.fontSize || 14) + (ev.deltaY < 0 ? 1 : -1));
      }, { passive: false });
    }
  })();

  /* 关闭窗口/离开页面时先把内容隐藏，避免 tmux 的最后一条消息闪一下 */
  window.addEventListener("pagehide", function () {
    try { document.body.style.visibility = "hidden"; } catch (e) {}
  });
  window.addEventListener("beforeunload", function () {
    try { document.body.style.visibility = "hidden"; } catch (e) {}
  });

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
    dropScrollbarReserve();
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
