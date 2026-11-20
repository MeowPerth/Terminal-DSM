// Terminal-DSM 1.0.0 —— DSM 桌面应用窗口
Ext.ns("MeowPerth.Terminal");

Ext.define("MeowPerth.Terminal.AppInstance", {
  extend: "SYNO.SDS.AppInstance",
  appWindowName: "MeowPerth.Terminal.AppWindow",
  defaultWinSize: { width: 1160, height: 620 },
  constructor: function () {
    this.callParent(arguments);
  },
});

Ext.define("MeowPerth.Terminal.AppWindow", {
  extend: "SYNO.SDS.AppWindow",
  layout: "fit",
  width: "100%",
  height: "100%",
  // 工具栏 + 终端需要的最小可用尺寸，避免窗口被拖得太小
  minWidth: 640,
  minHeight: 420,
  initComponent: function () {
    try {
      // DSM 的浏览器会话默认启用 SynoToken，API 鉴权需要它；
      // 这里从 DSM 会话里取出随 iframe URL 传给终端服务。
      var tok = "";
      try {
        tok =
          (window.SYNO && SYNO.SDS && SYNO.SDS.Session && SYNO.SDS.Session.SynoToken) || "";
      } catch (e) {
        tok = "";
      }
      var src = "/terminal/" + (tok ? "?t=" + encodeURIComponent(tok) : "");
      this.items = [
        {
          xtype: "panel",
          border: false,
          // 认证由 terminal-server 负责：未登录 DSM 时这里会跳到登录页
          html: '<iframe src="' + src + '" style="width:100%;height:100%;border:none;"></iframe>',
        },
      ];
      this.callParent(arguments);

      // DSM 会记住上次的窗口尺寸；如果恢复出来的尺寸太小，打开时拉回最小值
      var self = this;
      var MIN_W = 640, MIN_H = 420;
      this.on("show", function () {
        try {
          var w = self.getWidth() || 0;
          var h = self.getHeight() || 0;
          if (w < MIN_W || h < MIN_H) {
            self.setSize(Math.max(w, MIN_W), Math.max(h, MIN_H));
          }
        } catch (e) {}
      });
    } catch (e) {
      // 万一初始化失败，别留一个白窗口：直接把原因显示出来，便于排查
      this.items = [
        {
          xtype: "panel",
          border: false,
          padding: 12,
          html:
            '<div style="color:#c00;font:13px/1.6 monospace">Terminal 窗口初始化失败：<br>' +
            String(e && (e.stack || e.message || e)) +
            "</div>",
        },
      ];
      this.callParent(arguments);
    }
  },
  defaultWinSize: { width: 1160, height: 620 },
  constructor: function (config) {
    this.callParent([this.fillConfig(config)]);
  },
  fillConfig: function (e) {
    var i = {};
    return Ext.apply(i, e), i;
  },
});
