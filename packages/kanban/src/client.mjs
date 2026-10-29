// dsh-kanban: the browser half.
//
// Registers a global sidebar panel entry (`sidebar.panellist` → id "kanban")
// and the matching `main` panel. The sidebar's panel button selects the main
// key, so this is an additive seat in an existing list — the shell is never
// replaced and the workspaces list is untouched.
//
// Board, Now groups, ticket detail, timeline/Gantt and analytics all read the
// same Host queries the tests exercise. This file is a classic script: no
// imports, React from the module loader.

window.__ModuleLoader__.load({
	id: "dsh-kanban",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var connection = null;
		var openSessionById = null;
		var autoOpenedSessions = new Set();
		var rpcSeq = 0;

		function rpc(method, payload) {
			if (!connection) return Promise.reject(new Error("dsh-kanban: connection service unavailable"));
			return connection.rpc.call("/api", "kanban/" + method, payload || {});
		}

		function fmtUsd(value) {
			if (value === null || value === undefined) return "unpriced";
			return "$" + Number(value).toFixed(value > 0 && value < 0.01 ? 4 : 2);
		}

		function fmtTokens(value) {
			var n = Number(value || 0);
			if (!isFinite(n)) return "0";
			if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, "") + "m";
			if (Math.abs(n) >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
			return String(Math.round(n));
		}

		function fmtCost(value, unpriced) {
			if (unpriced) return "$0.00";
			if (value === null || value === undefined) return "$0.00";
			return fmtUsd(value);
		}

		function fmtDur(ms) {
			if (ms === null || ms === undefined) return "—";
			var s = Math.round(ms / 1000);
			if (s < 60) return s + "s";
			var m = Math.floor(s / 60);
			if (m < 60) return m + "m " + (s % 60) + "s";
			return Math.floor(m / 60) + "h " + (m % 60) + "m";
		}

		function fmtTime(iso) {
			if (!iso) return "—";
			try {
				return new Date(iso).toLocaleString();
			} catch (e) {
				return iso;
			}
		}

		function ago(iso) {
			if (!iso) return "—";
			var ms = Date.now() - new Date(iso).getTime();
			if (!isFinite(ms) || ms < 0) return "—";
			return fmtDur(ms) + " ago";
		}

		function download(name, mime, text) {
			var blob = new Blob([text], { type: mime || "text/plain" });
			var url = URL.createObjectURL(blob);
			var a = document.createElement("a");
			a.href = url;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
		}

var CSS =
		".kb-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:400 14px/22px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif)}"
		+ ".kb-bar{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:.5px solid var(--dsw-alias-border-l1,#e4e4e4);flex:none;flex-wrap:wrap}"
		+ ".kb-title{font:500 16px/22px var(--dsw-font-family,sans-serif);margin:0 8px 0 0}"
		+ ".kb-sub{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:18px}"
		+ ".kb-spacer{flex:1}"
		+ ".kb-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:0.5px solid var(--dsw-alias-border-l3,#d0d0d0);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:500 14px/22px var(--dsw-font-family,sans-serif);cursor:pointer;white-space:nowrap}"
		+ ".kb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}"
		+ ".kb-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,#e8e8e8)}"
		+ ".kb-btn:disabled{opacity:.4;cursor:default}"
		+ ".kb-btn.sm{height:28px;padding:0 10px;font:500 12px/18px var(--dsw-font-family,sans-serif);border-radius:var(--dsw-radius-sm,8px)}"
		+ ".kb-btn.primary{background:var(--dsw-alias-button-primary-fill,#111);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}"
		+ ".kb-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#000)}"
		+ ".kb-btn.danger{color:#b42318}"
		+ ".kb-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#d8d8d8);font:500 11px/16px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-secondary,#555);white-space:nowrap}"
		+ ".kb-chip.on{background:var(--dsw-alias-bg-layer-2,#eef1f5);border-color:transparent;color:var(--dsw-alias-label-primary,#111)}"
		+ ".kb-chip.warn{background:#fff4e5;border-color:#f0c987;color:#8a5300}"
		+ ".kb-chip.err{background:#fdecea;border-color:#f3b3ac;color:#9b1c1c}"
		+ ".kb-chip.ok{background:#e8f6ec;border-color:#a8d8b5;color:#1d6b32}"
		+ ".kb-body{flex:1;min-height:0;overflow:auto;padding:14px 18px 28px}"
		+ ".kb-cols{display:grid;grid-template-columns:repeat(3,minmax(210px,1fr));gap:12px;align-items:start;min-width:700px}"
		+ ".kb-col{border:.5px solid var(--dsw-alias-border-l1,#e4e4e4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,#f7f8fa);min-height:120px;display:flex;flex-direction:column;max-height:calc(100vh - 190px)}"
		+ ".kb-colhead{display:flex;align-items:center;gap:8px;padding:9px 11px 7px;font:600 12px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-secondary,#555);position:sticky;top:0;z-index:1;background:inherit;border-radius:var(--dsw-radius-md,12px) var(--dsw-radius-md,12px) 0 0}"
		+ ".kb-count{margin-left:auto;font:500 11px/16px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888)}"
		+ ".kb-list{display:flex;flex-direction:column;gap:7px;padding:0 8px 9px;overflow:auto}"
		+ ".kb-card{border:.5px solid var(--dsw-alias-border-l1,#ddd);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-base,#fff);padding:8px 9px;cursor:pointer;display:flex;flex-direction:column;gap:5px}"
		+ ".kb-card:hover{border-color:var(--dsw-alias-label-tertiary,#999)}"
		+ ".kb-card.dragging{opacity:.4}"
		+ ".kb-card-ghost{opacity:.62;border-style:dashed;border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 45%,var(--dsw-alias-border-l2,#ddd));background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 5%,var(--dsw-alias-bg-base,#fff));box-shadow:0 5px 16px rgba(15,23,42,.10);pointer-events:none;transform:translateY(1px)}"
		+ ".kb-card-ghost .kb-next{color:var(--dsw-alias-state-business-primary,#2563eb)}"
		+ ".kb-col.drop-target{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 45%,var(--dsw-alias-border-l1,#ddd));background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 3%,var(--dsw-alias-bg-layer-2,#f7f8fa))}"
		+ ".kb-key{font:600 11px/15px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888)}"
		+ ".kb-cardtitle{font:600 13px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-primary,#111);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}"
		+ ".kb-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;font:500 11px/15px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}"
		+ ".kb-grouphead{margin:12px 0 6px;font:600 11px/16px var(--dsw-font-family,sans-serif);text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-tertiary,#777)}"
		+ ".kb-now{max-width:1100px}"
		+ ".kb-detail{max-width:1180px;display:flex;flex-direction:column;gap:14px}"
		+ ".kb-panel{border:.5px solid var(--dsw-alias-border-l1,#e4e4e4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-base,#fff);padding:12px 14px}"
		+ ".kb-panel h3{margin:0 0 8px;font:600 12px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-secondary,#555);text-transform:uppercase;letter-spacing:.04em}"
		+ ".kb-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}"
		+ ".kb-kv{display:grid;grid-template-columns:130px 1fr;gap:3px 10px;font-size:12px;line-height:18px}"
		+ ".kb-kv b{font-weight:500;color:var(--dsw-alias-label-tertiary,#888)}"
		+ ".kb-input,.kb-select{box-sizing:border-box;height:32px;border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font:400 14px/22px var(--dsw-font-family,sans-serif);padding:0 10px;outline:none}"
		+ ".kb-textarea{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font:400 14px/22px var(--dsw-font-family,sans-serif);padding:8px 10px;outline:none;min-height:80px;resize:vertical;width:100%}"
		+ ".kb-input::placeholder,.kb-select::placeholder,.kb-textarea::placeholder{color:var(--dsw-alias-label-dimmed,#999)}"
		+ ".kb-input:focus,.kb-select:focus,.kb-textarea:focus{border-color:var(--dsw-alias-state-business-primary,#3b82f6)}"
		+ ".kb-form{display:flex;flex-direction:column;gap:11px;max-width:640px}"
		+ ".kb-label{font:500 11px/16px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-secondary,#555)}"
		+ ".kb-hint{font:400 12px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}"
		+ ".kb-err{font:400 12px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-error,#9b1c1c)}"
		+ ".kb-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}"
		+ ".kb-table th{text-align:left;font:600 10px/14px var(--dsw-font-family,sans-serif);text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#888);padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,#e4e4e4)}"
		+ ".kb-table td{padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,#f0f0f0);vertical-align:top}"
		+ ".kb-tabs{display:flex;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l1,#e4e4e4);margin-bottom:10px;flex-wrap:wrap}"
		+ ".kb-tab{background:0 0;border:none;border-bottom:2px solid transparent;padding:6px 10px;font:500 12px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-tertiary,#888);cursor:pointer}"
		+ ".kb-tab.on{color:var(--dsw-alias-label-primary,#111);border-bottom-color:var(--dsw-alias-label-primary,#111)}"
		+ ".kb-gantt{overflow:auto;border:.5px solid var(--dsw-alias-border-l1,#eee);border-radius:var(--dsw-radius-md,12px)}"
		+ ".kb-grow{display:grid;grid-template-columns:260px 1fr;align-items:center;min-height:24px;border-bottom:.5px solid #f2f2f2}"
		+ ".kb-glabel{padding:2px 8px;font:400 11px/16px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-secondary,#555);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
		+ ".kb-gtrack{position:relative;height:22px;margin-right:8px;background:repeating-linear-gradient(90deg,#fafafa,#fafafa 24px,#f2f2f2 25px)}"
		+ ".kb-gbar{position:absolute;top:3px;height:16px;border-radius:var(--dsw-radius-xs,4px);background:#7c9cc4;min-width:2px}"
		+ ".kb-gbar.agent{background:#4f7fae}.kb-gbar.judge{background:#8a6fb0}.kb-gbar.tool{background:#6aa87b}.kb-gbar.wait{background:repeating-linear-gradient(45deg,#bbb,#bbb 3px,#e8e8e8 3px,#e8e8e8 6px)}"
		+ ".kb-gbar.failed{background:#c05b4d}.kb-gbar.abandoned{background:#999}"
		+ ".kb-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}"
		+ ".kb-notice{padding:7px 10px;border-radius:var(--dsw-radius-md,12px);background:#fff7e6;border:.5px solid #f0d39a;color:#7a5200;font-size:12px;line-height:18px;margin-bottom:10px}"
		+ ".kb-answers{display:flex;flex-direction:column;gap:6px}"
		+ ".kb-answerrow{display:flex;gap:8px;align-items:flex-start}"
		+ ".kb-q{flex:1;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#555)}"
		+ ".kb-spin{display:inline-block;width:12px;height:12px;border:2px solid #ccc;border-top-color:#555;border-radius:50%;animation:kb-spin .8s linear infinite}"
		+ "@keyframes kb-spin{to{transform:rotate(360deg)}}"
		+ ".kb-root{background:radial-gradient(900px 440px at 6% -8%,color-mix(in srgb,#3b82f6 6%,transparent),transparent 60%),radial-gradient(760px 380px at 100% 0%,color-mix(in srgb,#8b5cf6 5%,transparent),transparent 58%),var(--dsw-alias-bg-base,#fff)}"
		+ ".kb-pagehead{display:flex;align-items:flex-start;gap:16px;padding:28px clamp(20px,4vw,48px) 0;flex-wrap:wrap}"
		+ ".kb-pagehead-main{flex:1;min-width:0}"
		+ ".kb-title{margin:0;font:500 20px/28px var(--dsw-font-family,sans-serif);letter-spacing:-.01em}"
		+ ".kb-sub{margin-top:3px;color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:18px}"
		+ ".kb-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}"
		+ ".kb-kpi{position:relative;overflow:hidden;padding:10px 12px;border:1px solid color-mix(in srgb,var(--kb-accent) 22%,var(--dsw-alias-border-l2,#e5e7eb));border-radius:var(--dsw-radius-md,12px);background:linear-gradient(135deg,color-mix(in srgb,var(--kb-accent) 8%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff))}"
		+ ".kb-kpi::after{content:'';position:absolute;right:-16px;top:-22px;width:68px;height:68px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--kb-accent) 16%,transparent),transparent 70%)}"
		+ ".kb-kpi-value{font:600 22px/26px var(--dsw-font-family,sans-serif);font-variant-numeric:tabular-nums;color:var(--kb-accent)}"
		+ ".kb-kpi-label{margin-top:1px;font:600 11px/15px var(--dsw-font-family,sans-serif);letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#555)}"
		+ ".kb-tone-idle{--kb-accent:#64748b}.kb-tone-run{--kb-accent:#2563eb}.kb-tone-warn{--kb-accent:#b45309}.kb-tone-err{--kb-accent:#b91c1c}.kb-tone-ok{--kb-accent:#15803d}.kb-tone-violet{--kb-accent:#7c3aed}"
		+ ".kb-body{padding:0 clamp(20px,4vw,48px) 48px}"
		+ ".kb-cols{grid-template-columns:repeat(3,minmax(250px,1fr));gap:14px;min-width:780px}"
		+ ".kb-col{--kb-accent:#64748b;position:relative;overflow:hidden;border:1px solid color-mix(in srgb,var(--kb-accent) 18%,var(--dsw-alias-border-l2,#e5e7eb));border-radius:var(--dsw-radius-lg,16px);background:color-mix(in srgb,var(--kb-accent) 4%,var(--dsw-alias-bg-layer-2,#f7f8fa));padding-top:3px;max-height:calc(100vh - 280px)}"
		+ ".kb-col::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--kb-accent),color-mix(in srgb,var(--kb-accent) 35%,transparent))}"
		+ ".kb-colhead{padding:9px 12px 7px;color:var(--dsw-alias-label-secondary,#555);background:transparent;border-radius:var(--dsw-radius-md,12px) var(--dsw-radius-md,12px) 0 0}"
		+ ".kb-coldot{width:7px;height:7px;border-radius:50%;background:var(--kb-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--kb-accent) 14%,transparent);flex:none}"
		+ ".kb-collabel{font:600 11px/16px var(--dsw-font-family,sans-serif);letter-spacing:.06em;text-transform:uppercase}"
		+ ".kb-count{margin-left:auto;min-width:20px;height:18px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--kb-accent) 11%,transparent);color:var(--kb-accent);font:600 11px/18px ui-monospace,monospace;text-align:center}"
		+ ".kb-list{gap:8px;padding:0 9px 11px}"
		+ ".kb-card{border:1px solid var(--dsw-alias-border-l2,#e2e6ea);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#fff);padding:9px 10px;gap:6px;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease;position:relative}"
		+ ".kb-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--kb-accent,#3b82f6) 45%,var(--dsw-alias-border-l2,#e2e6ea));box-shadow:0 8px 22px color-mix(in srgb,var(--kb-accent,#3b82f6) 13%,transparent)}"
		+ ".kb-card.active{border-color:color-mix(in srgb,#2563eb 42%,var(--dsw-alias-border-l2,#e2e6ea));background:linear-gradient(135deg,color-mix(in srgb,#2563eb 5%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff));animation:kb-glow-blue 3.2s ease-in-out infinite}"
		+ ".kb-card.active::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,#2563eb,#06b6d4)}"
		+ ".kb-card.attention{border-color:color-mix(in srgb,#b91c1c 45%,var(--dsw-alias-border-l2,#e2e6ea));background:color-mix(in srgb,#b91c1c 6%,var(--dsw-alias-bg-layer-1,#fff));animation:kb-glow-red 1.6s ease-in-out infinite}"
		+ ".kb-card.attention::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:#b91c1c}"
		+ ".kb-cardtop{display:flex;align-items:center;gap:7px}"
		+ ".kb-key{font:600 11px/15px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888);letter-spacing:.02em}"
		+ ".kb-statusdot{width:8px;height:8px;border-radius:50%;background:#94a3b8;flex:none}"
		+ ".kb-statusdot.active{background:#2563eb;animation:kb-pulse 1.8s ease-out infinite}"
		+ ".kb-statusdot.attention{background:#b91c1c;box-shadow:0 0 0 3px rgba(185,28,28,.16)}"
		+ ".kb-phasechip{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;border:1px solid color-mix(in srgb,var(--kb-accent,#64748b) 30%,transparent);background:color-mix(in srgb,var(--kb-accent,#64748b) 9%,transparent);color:var(--kb-accent,#475569);font:600 11px/15px var(--dsw-font-family,sans-serif);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}"
		+ ".kb-phasechip.plan{--kb-accent:#2563eb}.kb-phasechip.build{--kb-accent:#0d9488}.kb-phasechip.review{--kb-accent:#db2777}.kb-phasechip.approval{--kb-accent:#7c3aed}.kb-phasechip.done{--kb-accent:#15803d}"
		+ ".kb-cardtitle{font:600 13px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-primary,#111);-webkit-line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}"
		+ ".kb-steps{display:flex;gap:3px;margin:1px 0 2px}"
		+ ".kb-step{--kb-step-color:#64748b;height:3px;flex:1;border-radius:3px;background:color-mix(in srgb,var(--kb-step-color) 20%,transparent)}"
		+ ".kb-step-intake{--kb-step-color:#64748b}.kb-step-grill{--kb-step-color:#d97706}.kb-step-plan{--kb-step-color:#2563eb}.kb-step-implement{--kb-step-color:#0d9488}.kb-step-verify{--kb-step-color:#7c3aed}.kb-step-review{--kb-step-color:#db2777}.kb-step-closed{--kb-step-color:#15803d}"
		+ ".kb-step.done{background:var(--kb-step-color);opacity:.72}"
		+ ".kb-step.current{background:var(--kb-step-color);box-shadow:0 0 0 1px color-mix(in srgb,var(--kb-step-color) 45%,transparent)}"
		+ ".kb-meta{gap:5px;font:500 11px/15px var(--dsw-font-family,sans-serif);align-items:center}"
		+ ".kb-next{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--kb-accent,#64748b) 9%,transparent);color:var(--kb-accent,#475569);font-weight:600;white-space:nowrap}"
		+ ".kb-next.run{--kb-accent:#2563eb}.kb-next.err{--kb-accent:#b91c1c}.kb-next.idle{--kb-accent:#64748b}"
		+ ".kb-total{color:var(--dsw-alias-label-secondary,#555);font-variant-numeric:tabular-nums;white-space:nowrap}"
		+ ".kb-age{margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#999)}"
		+ ".kb-empty{padding:20px 10px;border:1px dashed color-mix(in srgb,var(--kb-accent,#888) 22%,transparent);border-radius:var(--dsw-radius-md,12px);background:transparent;font-size:11px;line-height:16px}"
		+ ".kb-detail{gap:12px;max-width:1180px}"
		+ ".kb-hero{--kb-accent:#2563eb;position:relative;overflow:hidden;border:1px solid color-mix(in srgb,var(--kb-accent) 22%,var(--dsw-alias-border-l2,#e5e7eb));border-radius:var(--dsw-radius-lg,16px);background:linear-gradient(135deg,color-mix(in srgb,var(--kb-accent) 7%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff));padding:14px 16px;box-shadow:0 10px 30px rgba(15,23,42,.04)}"
		+ ".kb-hero::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--kb-accent),color-mix(in srgb,var(--kb-accent) 35%,transparent))}"
		+ ".kb-hero-backlog{--kb-accent:#64748b}.kb-hero-working{--kb-accent:#64748b}.kb-hero-discarded{--kb-accent:#64748b}.kb-hero-done{--kb-accent:#15803d}.kb-hero-attention{--kb-accent:#b91c1c}"
		+ ".kb-hero-top{display:flex;align-items:center;gap:9px;flex-wrap:wrap}"
		+ ".kb-hero-title{margin:8px 0 3px;font:500 18px/25px var(--dsw-font-family,sans-serif);letter-spacing:-.01em}"
		+ ".kb-hero-meta{display:flex;flex-wrap:wrap;gap:5px 14px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;line-height:16px}"
		+ ".kb-hero-meta b{font-weight:600;color:var(--dsw-alias-label-secondary,#555)}"
		+ ".kb-lifecycle{display:flex;align-items:center;gap:4px;margin-top:12px;flex-wrap:wrap}"
		+ ".kb-life{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary,#999);font:500 11px/16px var(--dsw-font-family,sans-serif)}"
		+ ".kb-life+.kb-life::before{content:'';width:14px;height:1px;background:var(--dsw-alias-border-l2,#ddd);margin-right:1px}"
		+ ".kb-life-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-bg-layer-2,#eef1f5);border:1px solid var(--dsw-alias-border-l3,#ccc)}"
		+ ".kb-life-intake{--kb-life-color:#64748b}.kb-life-grill{--kb-life-color:#d97706}.kb-life-plan{--kb-life-color:#2563eb}.kb-life-implement{--kb-life-color:#0d9488}.kb-life-verify{--kb-life-color:#7c3aed}.kb-life-review{--kb-life-color:#db2777}.kb-life-closed{--kb-life-color:#15803d}"
		+ ".kb-life.done{color:var(--dsw-alias-label-secondary,#555)}.kb-life.done .kb-life-dot{background:var(--kb-life-color);border-color:var(--kb-life-color)}"
		+ ".kb-life.active{color:var(--kb-life-color);font-weight:600}.kb-life.active .kb-life-dot{background:var(--kb-life-color);border-color:var(--kb-life-color);animation:kb-pulse 1.8s ease-out infinite}"
		+ ".kb-tabs{gap:6px;border-bottom:none;margin:2px 0 0}"
		+ ".kb-tab{padding:5px 11px;border-radius:999px;border:1px solid transparent;color:var(--dsw-alias-label-tertiary,#888);font:500 12px/18px var(--dsw-font-family,sans-serif)}"
		+ ".kb-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}"
		+ ".kb-tab.on{color:var(--dsw-alias-label-primary,#111);border-color:var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-bg-layer-1,#fff)}"
		+ ".kb-panel{border-color:var(--dsw-alias-border-l2,#e5e7eb);border-radius:var(--dsw-radius-md,12px);padding:13px 15px}"
		+ ".kb-timeline{display:flex;flex-direction:column;gap:7px}"
		+ ".kb-tl-legend{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px}"
		+ ".kb-tl-key{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#e2e6ea);color:var(--dsw-alias-label-secondary,#555);font:600 11px/15px var(--dsw-font-family,sans-serif);background:var(--dsw-alias-bg-layer-2,#f6f7f9)}"
		+ ".kb-tl-key::before{content:'';width:7px;height:7px;border-radius:2px;background:var(--kb-tl-color)}"
		+ ".kb-tl-griller{--kb-tl-color:#d97706}.kb-tl-planner{--kb-tl-color:#2563eb}.kb-tl-implementer{--kb-tl-color:#0d9488}.kb-tl-verifier{--kb-tl-color:#7c3aed}.kb-tl-reviewer{--kb-tl-color:#db2777}.kb-tl-judge{--kb-tl-color:#8b5cf6}.kb-tl-plugin{--kb-tl-color:#64748b}"
		+ ".kb-tl-row{display:grid;grid-template-columns:180px minmax(0,1fr);align-items:center;gap:10px;min-height:30px}"
		+ ".kb-tl-label{min-width:0;display:flex;flex-direction:column;line-height:1.25}"
		+ ".kb-tl-name{font:600 11px/15px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-primary,#111);text-transform:capitalize;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
		+ ".kb-tl-detail{font:400 11px/14px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-tertiary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
		+ ".kb-tl-track{position:relative;height:20px;background:repeating-linear-gradient(90deg,transparent,transparent 39px,color-mix(in srgb,var(--dsw-alias-border-l2,#e2e6ea) 55%,transparent) 40px);border-radius:6px;overflow:hidden}"
		+ ".kb-tl-bar{position:absolute;top:3px;height:14px;border-radius:var(--dsw-radius-xs,4px);background:var(--kb-tl-color);display:flex;align-items:center;justify-content:flex-end;padding-right:5px;box-shadow:0 1px 2px rgba(15,23,42,.12);opacity:.92;min-width:3px;transition:filter .15s ease}"
		+ ".kb-tl-bar:hover{filter:brightness(1.08);opacity:1}"
		+ ".kb-tl-griller{--kb-tl-color:#d97706}.kb-tl-planner{--kb-tl-color:#2563eb}.kb-tl-implementer{--kb-tl-color:#0d9488}.kb-tl-verifier{--kb-tl-color:#7c3aed}.kb-tl-reviewer{--kb-tl-color:#db2777}.kb-tl-judge{--kb-tl-color:#8b5cf6}"
		+ ".kb-tl-step-0{--kb-tl-color:#0891b2}.kb-tl-step-1{--kb-tl-color:#ca8a04}.kb-tl-step-2{--kb-tl-color:#c026d3}.kb-tl-step-3{--kb-tl-color:#65a30d}.kb-tl-step-4{--kb-tl-color:#e11d48}"
		+ ".kb-tl-dur{font:600 10px/12px ui-monospace,monospace;color:#fff;white-space:nowrap;text-shadow:0 1px 1px rgba(0,0,0,.2)}"
		+ "@media (max-width:700px){.kb-tl-row{grid-template-columns:120px minmax(0,1fr)}}"
		+ ".kb-analytics{display:flex;flex-direction:column;gap:14px}"
		+ ".kb-analytics-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px}"
		+ ".kb-analytics-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}"
		+ ".kb-analytics-card{border-color:color-mix(in srgb,var(--kb-accent,#3b82f6) 18%,var(--dsw-alias-border-l2,#e5e7eb));background:linear-gradient(150deg,color-mix(in srgb,var(--kb-accent,#3b82f6) 5%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff))}"
		+ ".kb-analytics-card h3{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary,#555);font:600 11px/16px var(--dsw-font-family,sans-serif);letter-spacing:.08em}"
		+ ".kb-carddot{width:7px;height:7px;border-radius:2px;background:var(--kb-accent,#3b82f6);box-shadow:0 0 0 3px color-mix(in srgb,var(--kb-accent,#3b82f6) 12%,transparent)}"
		+ ".kb-analytics .kb-table th{padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--kb-accent,#3b82f6) 16%,var(--dsw-alias-border-l1,#e8e8e8))}"
		+ ".kb-analytics .kb-table td{padding:7px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,#f0f0f0)}"
		+ ".kb-analytics .kb-table tr:hover td{background:color-mix(in srgb,var(--kb-accent,#3b82f6) 4%,transparent)}"
		+ ".kb-big-num{font:600 13px/16px ui-monospace,monospace;color:var(--kb-accent,#2563eb)}"
		+ ".kb-time{font:600 11px/15px ui-monospace,monospace;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap}"
		+ ".kb-rate{display:inline-flex;align-items:center;gap:7px;min-width:90px}"
		+ ".kb-rate-track{width:70px;height:6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary,#888) 14%,transparent);overflow:hidden}"
		+ ".kb-rate-fill{display:block;height:100%;border-radius:inherit;background:#64748b}.kb-rate-fill.good{background:#15803d}.kb-rate-fill.mid{background:#b45309}.kb-rate-fill.bad{background:#b91c1c}"
		+ "@media (max-width:800px){.kb-analytics-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kb-analytics-grid{grid-template-columns:1fr}}"
		+ ".kb-tl-entry{display:flex;flex-direction:column;gap:5px}"
		+ ".kb-tl-row{cursor:pointer;border-radius:var(--dsw-radius-sm,8px);padding:2px 4px;margin:0 -4px;transition:background-color .15s ease}"
		+ ".kb-tl-row:hover,.kb-tl-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover,#f4f6f8);outline:none}"
		+ ".kb-tl-expand{margin:2px 0 4px 190px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e6ea);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,#f7f8fa)}"
		+ ".kb-tl-meta{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--dsw-alias-label-tertiary,#888);font:400 11px/16px var(--dsw-font-family,sans-serif);margin-bottom:6px}"
		+ ".kb-tl-meta b{font-weight:600;color:var(--dsw-alias-label-secondary,#555)}"
		+ ".kb-tl-artifact+.kb-tl-artifact{margin-top:6px}"
		+ ".kb-tl-artifact-title{font:600 10px/14px ui-monospace,monospace;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#888);margin-bottom:3px}"
		+ ".kb-tl-events{margin-top:8px;border-top:.5px solid var(--dsw-alias-border-l1,#e8e8e8);padding-top:7px}"
		+ ".kb-tl-event{padding:5px 0;border-top:.5px dashed var(--dsw-alias-border-l1,#ececec)}"
		+ ".kb-tl-event:first-of-type{border-top:none}"
		+ ".kb-tl-event-head{display:flex;align-items:center;flex-wrap:wrap;gap:5px 9px;font:400 11px/15px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}"
		+ ".kb-tl-event-head b{font:600 11px/15px ui-monospace,monospace;color:var(--dsw-alias-label-secondary,#555)}"
		+ ".kb-tl-event-time,.kb-tl-event-phase{font:400 10px/14px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888)}"
		+ ".kb-tl-event-actor{margin-left:auto;font:400 11px/15px var(--dsw-font-family,sans-serif);text-transform:uppercase;letter-spacing:.04em}"
		+ ".kb-tl-event-payload{margin:3px 0 0;max-height:150px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l1,#ececec);border-radius:var(--dsw-radius-sm,8px);padding:5px 7px;font:400 11px/15px ui-monospace,monospace;color:var(--dsw-alias-label-secondary,#444)}"
		+ ".kb-tl-artifact-body{margin:0;max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l1,#e8e8e8);border-radius:var(--dsw-radius-sm,8px);padding:7px 9px;font:400 11px/16px ui-monospace,monospace;color:var(--dsw-alias-label-primary,#222)}"
		+ "@media (max-width:700px){.kb-tl-expand{margin-left:0}}"
		+ ".kb-nav-icon-wrap{position:relative;display:inline-flex;align-items:center;flex:none}"
		+ ".kb-nav-badges{position:absolute;left:calc(100% + 58px);top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:2px;white-space:nowrap;z-index:2}"
		+ ".kb-nav-badge{display:inline-flex;align-items:center;justify-content:center;height:14px;min-width:14px;padding:0 6px;border-radius:999px;border:1px solid;box-sizing:border-box;font:600 9px/12px ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;letter-spacing:-.02em}"
		+ ".kb-nav-badge.run{color:#1d4ed8;background:rgba(37,99,235,.12);border-color:rgba(37,99,235,.38)}"
		+ ".kb-nav-badge.attn{color:#b91c1c;background:rgba(185,28,28,.12);border-color:rgba(185,28,28,.35)}"
		+ "@media (prefers-color-scheme:dark){.kb-nav-badge.run{color:#93c5fd;background:rgba(37,99,235,.22);border-color:rgba(96,165,250,.45)}.kb-nav-badge.attn{color:#fca5a5;background:rgba(185,28,28,.22);border-color:rgba(248,113,113,.42)}}"
		+ ".kb-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid var(--dsw-alias-border-l3,#cbd2da);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,#f4f6f8);color:var(--dsw-alias-label-secondary,#555);cursor:pointer;padding:0;flex:none}"
		+ ".kb-iconbtn:hover{color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-interactive-bg-hover,#f2f4f7)}"
		+ ".kb-panelhead{display:flex;align-items:center;justify-content:space-between;gap:8px}"
		+ ".kb-modal-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;background:var(--dsw-alias-bg-mask-1,rgba(15,23,42,.34));backdrop-filter:var(--dsw-mask-blur,none)}"
		+ ".kb-modal{box-sizing:border-box;width:min(640px,100%);max-height:82vh;overflow:auto;background:var(--dsw-alias-bg-layer-2,#f7f8fa);border:0;border-radius:var(--dsw-radius-panel,28px);padding:24px;box-shadow:var(--dsw-elevation-prominent,0 24px 70px rgba(15,23,42,.28))}"
		+ ".kb-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:16px}"
		+ ".kb-modal-title{margin:0;font:500 16px/24px var(--dsw-font-family,sans-serif);letter-spacing:-.01em;color:var(--dsw-alias-label-primary,#111)}"
		+ ".kb-modal .kb-form{gap:12px}"
		+ ".kb-modal .kb-textarea{min-height:120px}"
		+ ".kb-modal .kb-row{margin-top:2px}"
		+ "@media (max-width:700px){.kb-modal-backdrop{padding:10px}.kb-modal{padding:14px}}"
		+ ".kb-routing{margin:0 clamp(20px,4vw,48px) 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e8ebef);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#fff)}"
		+ ".kb-routing-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}"
		+ ".kb-routing-title{font:600 11px/16px var(--dsw-font-family,sans-serif);letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#555)}"
		+ ".kb-routing-sub{margin:0 0 9px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;line-height:16px}"
		+ ".kb-routing-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px}"
		+ ".kb-route{--kb-route-color:#64748b;position:relative;overflow:hidden;border:1px solid color-mix(in srgb,var(--kb-route-color) 22%,var(--dsw-alias-border-l2,#e2e6ea));border-radius:var(--dsw-radius-md,12px);background:linear-gradient(150deg,color-mix(in srgb,var(--kb-route-color) 6%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff));padding:7px 8px;min-width:0}"
		+ ".kb-route::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--kb-route-color)}"
		+ ".kb-route-orchestrator{--kb-route-color:#8b5cf6}.kb-route-griller{--kb-route-color:#d97706}.kb-route-planner{--kb-route-color:#2563eb}.kb-route-implementer{--kb-route-color:#0d9488}.kb-route-verifier{--kb-route-color:#7c3aed}.kb-route-reviewer{--kb-route-color:#db2777}"
		+ ".kb-route-top{display:flex;align-items:baseline;justify-content:space-between;gap:4px}"
		+ ".kb-route-task{font:600 11px/15px var(--dsw-font-family,sans-serif);color:var(--kb-route-color)}"
		+ ".kb-route-role{font:400 10px/13px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#999);text-transform:lowercase}"
		+ ".kb-route-model{margin-top:3px;display:flex;flex-direction:column;line-height:1.2;min-width:0}"
		+ ".kb-route-model b{font:600 11px/14px ui-monospace,monospace;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
		+ ".kb-route-model span{font:400 11px/14px ui-monospace,monospace;color:var(--dsw-alias-label-primary,#222);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
		+ ".kb-route-meta{display:flex;flex-wrap:wrap;gap:3px 6px;margin-top:3px;font:400 10px/13px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}"
		+ ".kb-route-default{color:var(--kb-route-color);font-weight:600}"
		+ ".kb-modal-actions{display:flex;align-items:center;gap:6px}"
		+ ".kb-route-rows{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,#e8ebef);border-radius:var(--dsw-radius-md,12px);overflow:hidden}"
		+ ".kb-route-row{display:grid;grid-template-columns:minmax(120px,150px) minmax(0,1fr) minmax(120px,170px);align-items:center;gap:10px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1,#eef1f4);border-left:3px solid var(--kb-route-color);background:var(--dsw-alias-bg-layer-1,#fff)}"
		+ ".kb-route-row:first-child{border-top:0}"
		+ ".kb-route-edit{grid-template-columns:minmax(100px,135px) minmax(0,1fr);background:color-mix(in srgb,var(--kb-route-color) 3%,var(--dsw-alias-bg-layer-1,#fff))}"
		+ ".kb-route-picker{width:100%;min-width:0}"
		+ ".kb-route-label{display:flex;flex-direction:column;min-width:0}"
		+ ".kb-route-label b{font:600 11px/15px var(--dsw-font-family,sans-serif);color:var(--kb-route-color)}"
		+ ".kb-route-label span{font:400 10px/13px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#999)}"
		+ ".kb-route-value{display:flex;flex-direction:column;min-width:0;line-height:1.25}"
		+ ".kb-route-value b{font:600 11px/14px ui-monospace,monospace;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
		+ ".kb-route-value span{font:400 11px/14px ui-monospace,monospace;color:var(--dsw-alias-label-primary,#222);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
		+ ".kb-route-effort{display:flex;flex-direction:column;align-items:flex-end;gap:1px;font:400 10px/13px var(--dsw-font-family,sans-serif);text-align:right;color:var(--dsw-alias-label-tertiary,#888)}"
		+ ".kb-routing-editfoot{display:flex;align-items:center;gap:8px;margin-top:10px}"
		+ ".kb-routing-editfoot .kb-err{flex:1}"
		+ "@media (max-width:560px){.kb-route-row,.kb-route-edit{grid-template-columns:100px minmax(0,1fr);gap:6px}.kb-route-effort{align-items:flex-start;text-align:left}}"
		+ ".kb-modal .kb-routing{margin:0;padding:0;border:0;background:transparent}"
		+ ".kb-modal .kb-routing-grid{grid-template-columns:repeat(3,minmax(0,1fr))}"
		+ "@media (max-width:520px){.kb-modal .kb-routing-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}"
		+ "@media (max-width:1100px){.kb-routing-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}"
		+ "@media (max-width:650px){.kb-routing{margin-left:12px;margin-right:12px}.kb-routing-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}"
		+ ".kb-seg{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}"
		+ ".kb-seg-indicator{position:absolute;top:4px;left:4px;width:calc((100% - 8px - 2px * (var(--dsh-segment-count) - 1)) / var(--dsh-segment-count));height:calc(100% - 8px);border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-soft,0 4px 16px rgba(0,0,0,.05));transform:translateX(calc(var(--dsh-segment-index) * (100% + 2px)));transition:transform 160ms ease;pointer-events:none}"
		+ ".kb-seg-tab{box-sizing:border-box;position:relative;z-index:1;height:28px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,#555);font:500 13px/20px var(--dsw-font-family,sans-serif);white-space:nowrap;cursor:pointer;transition:color 120ms ease}"
		+ ".kb-seg-tab:hover:not(:disabled){color:var(--dsw-alias-label-primary,#111)}"
		+ ".kb-seg-tab[aria-selected='true']{color:var(--dsw-alias-label-primary,#111)}"
		+ ".kb-seg-tab:disabled{cursor:default;opacity:.4}"
		+ ".kb-seg-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6));outline-offset:-2px}"
		+ ".kb-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,#ccc);cursor:pointer}"
		+ ".kb-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary,#111)}"
		+ ".kb-switch:disabled{cursor:default;opacity:.5}"
		+ ".kb-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6));outline-offset:2px}"
		+ ".kb-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform 120ms ease}"
		+ ".kb-switch[aria-checked='true'] .kb-switch-thumb{background:var(--dsw-alias-label-primary-foreground,#fff);transform:translateX(16px)}"
		+ ".kb-switchrow{display:flex;align-items:center;gap:8px}"
		+ ".kb-worktree-path{font:400 11px/16px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px}"
		+ "@keyframes kb-pulse{0%{box-shadow:0 0 0 0 rgba(37,99,235,.5)}70%{box-shadow:0 0 0 6px rgba(37,99,235,0)}100%{box-shadow:0 0 0 0 rgba(37,99,235,0)}}"
		+ "@keyframes kb-glow-blue{0%,100%{box-shadow:0 0 0 1px rgba(37,99,235,.08),0 4px 16px rgba(37,99,235,.05)}50%{box-shadow:0 0 0 1.5px rgba(37,99,235,.32),0 8px 28px rgba(37,99,235,.15)}}"
		+ "@keyframes kb-glow-red{0%,100%{box-shadow:0 0 0 1px rgba(185,28,28,.16),0 4px 14px rgba(185,28,28,.08)}50%{box-shadow:0 0 0 2px rgba(185,28,28,.42),0 8px 26px rgba(185,28,28,.22)}}"
		+ "@media (prefers-reduced-motion:reduce){.kb-card.active,.kb-card.attention,.kb-statusdot.active,.kb-life.active .kb-life-dot,.kb-seg-indicator,.kb-seg-tab,.kb-switch-thumb{animation:none;transition:none}}"
		+ "@media (max-width:900px){.kb-analytics-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}"
		+ "";

		function ensureStyles() {
			var id = "kanban-styles";
			if (document.getElementById(id)) return;
			var tag = document.createElement("style");
			tag.id = id;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------------ icon

		function useKanbanBadges() {
			var s = React.useState({ inFlight: 0, attention: 0 });
			var badges = s[0], setBadges = s[1];
			React.useEffect(function () {
				var alive = true;
				function load() {
					if (!connection) return;
					rpc("board", {}).then(function (res) {
						if (!alive || !res || !res.ok || !res.value) return;
						var columns = res.value.columns || {};
						var inFlight = 0, attention = 0;
						["backlog", "working", "done", "discarded"].forEach(function (name) {
							(columns[name] || []).forEach(function (ticket) {
								if (ticket.status === "active") inFlight += 1;
								else if (ticket.status === "attention") attention += 1;
							});
						});
						setBadges({ inFlight: inFlight, attention: attention });
					}, function () {});
				}
				load();
				var timer = setInterval(load, 5000);
				return function () { alive = false; clearInterval(timer); };
			}, []);
			return badges;
		}

		function KanbanIcon(props) {
			var size = props && props.size ? props.size : 16;
			var badges = useKanbanBadges();
			return h("span", { className: "kb-nav-icon-wrap" },
				h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
					h("rect", { x: 1.5, y: 1.5, width: 3.4, height: 13, rx: 1, fill: "currentColor", opacity: 0.9 }),
					h("rect", { x: 6.3, y: 1.5, width: 3.4, height: 9, rx: 1, fill: "currentColor", opacity: 0.65 }),
					h("rect", { x: 11.1, y: 1.5, width: 3.4, height: 11, rx: 1, fill: "currentColor", opacity: 0.45 })
				),
				badges.inFlight > 0 || badges.attention > 0 ? h("span", { className: "kb-nav-badges" },
					badges.inFlight > 0 ? h("span", { className: "kb-nav-badge run", title: badges.inFlight + " in flight", children: badges.inFlight }) : null,
					badges.attention > 0 ? h("span", { className: "kb-nav-badge attn", title: badges.attention + " needs attention", children: badges.attention }) : null
				) : null
			);
		}

		// ------------------------------------------------------------------ board

		var PHASES = ["plan", "implement", "review", "verify", "closed"];
		function phaseIndex(phase) {
			var i = PHASES.indexOf(phase);
			return i < 0 ? 0 : i;
		}
		function phaseLabel(phase) {
			return phase === "implement" ? "Build" : phase === "verify" ? "Approval" : phase === "closed" ? "Done" : phase.charAt(0).toUpperCase() + phase.slice(1);
		}
		function phaseProgress(ticket) {
			return h("div", { className: "kb-steps", title: "Lifecycle: " + PHASES.map(phaseLabel).join(" → ") },
				PHASES.map(function (phase, i) {
					var done = phaseIndex(ticket.phase) > i || ticket.phase === "closed";
					var current = phaseIndex(ticket.phase) === i && ticket.phase !== "closed";
					return h("span", { key: phase, className: "kb-step" + (done ? " done" : "") + (current ? " current" : ""), title: phaseLabel(phase) });
				})
			);
		}
		// Badge tone follows the lifecycle stage, not the column: Plan blue,
		// Build teal, Review pink, Approval violet, Done green.
		function phaseTone(phase) {
			return phase === "plan" ? "plan" : phase === "implement" ? "build" : phase === "review" ? "review" : phase === "verify" ? "approval" : "done";
		}
		// The bottom-left badge mirrors the card status: grey idle, blue active,
		// red attention.
		function statusTone(status) {
			return status === "attention" ? "err" : status === "active" ? "run" : "idle";
		}
		function nextAction(t) {
			if (t.status === "attention") return t.phase === "verify" ? "Awaiting approval" : t.awaitingQuestion ? "Waiting on you" : "Needs your decision";
			if (t.status === "active") return t.phase === "plan" ? "Grilling / planning" : "Running";
			if (t.column === "done" || t.column === "discarded") return "Closed";
			if (t.column === "working") return "Queued";
			return "Ready";
		}

		function DropGhost(props) {
			var t = props.ticket;
			return h("div", { className: "kb-card kb-card-ghost", "aria-hidden": "true" },
				h("div", { className: "kb-cardtop" },
					h("span", { className: "kb-key", children: t.key }),
					h("span", { className: "kb-spacer" }),
					h("span", { className: "kb-statusdot " + (t.status || "idle"), "aria-hidden": "true" }),
					h("span", { className: "kb-phasechip " + phaseTone(t.phase), children: phaseLabel(t.phase) })
				),
				h("div", { className: "kb-cardtitle", children: t.title }),
				phaseProgress(t),
				h("div", { className: "kb-meta" },
					h("span", { className: "kb-next idle", children: "Drop here" })
				)
			);
		}

		function Card(props) {
			var t = props.ticket;
			var status = t.status || "idle";
			return h(
				"div",
				{
					className: "kb-card" + (status === "active" ? " active" : "") + (status === "attention" ? " attention" : "") + (props.dragging ? " dragging" : ""),
					draggable: true,
					onDragStart: function (ev) {
						ev.dataTransfer.setData("text/kanban", t.id);
						ev.dataTransfer.effectAllowed = "move";
						if (props.onDragStart) props.onDragStart(t.id);
					},
					onDragEnd: function () { if (props.onDragEnd) props.onDragEnd(); },
					onDragOver: function (ev) {
						ev.preventDefault();
						ev.stopPropagation();
						ev.dataTransfer.dropEffect = "move";
						if (props.onDragOverCard) props.onDragOverCard(props.column, t.id);
					},
					onDrop: function (ev) {
						ev.preventDefault();
						ev.stopPropagation();
						var id = ev.dataTransfer.getData("text/kanban");
						if (id) props.onDropCard(id, props.column, t.id);
					},
					onClick: function () { props.onOpen(t.id); },
					title: t.title
				},
				h("div", { className: "kb-cardtop" },
					h("span", { className: "kb-key", children: t.key }),
					h("span", { className: "kb-spacer" }),
					h("span", { className: "kb-statusdot " + status, title: status, "aria-label": "Status: " + status }),
					h("span", { className: "kb-phasechip " + phaseTone(t.phase), children: phaseLabel(t.phase) })
				),
				h("div", { className: "kb-cardtitle", children: t.title }),
				phaseProgress(t),
				h("div", { className: "kb-meta" },
					h("span", { className: "kb-next " + statusTone(status), children: nextAction(t) }),
					t.attemptCount > 0 ? h("span", { children: "try " + t.attemptCount }) : null,
					t.spentUsd > 0 ? h("span", { children: fmtUsd(t.spentUsd) }) : null,
					h("span", { className: "kb-total", title: "Total time on ticket", children: fmtDur(t.totalMs !== undefined ? t.totalMs : Date.now() - new Date(t.createdAt).getTime()) }),
					h("span", { className: "kb-spacer" }),
					h("span", { className: "kb-age", children: ago(t.updatedAt) })
				)
			);
		}

		function Column(props) {
			var items = props.items || [];
			var dragging = props.dragId !== null && props.dragId !== undefined;
			var active = dragging && props.dropTarget && props.dropTarget.column === props.column;
			var ghost = active && props.dragTicket ? h(DropGhost, { key: "drop-ghost", ticket: props.dragTicket, column: props.column }) : null;
			var rendered = items.map(function (t) { return h(Card, { key: t.id, ticket: t, column: props.column, dragging: props.dragId === t.id, onOpen: props.onOpen, onReorder: props.onReorder, onDragStart: props.onDragStart, onDragEnd: props.onDragEnd, onDragOverCard: props.onDragOverCard, onDropCard: props.onDropCard }); });
			if (ghost) {
				var beforeId = props.dropTarget.beforeId;
				var index = beforeId === null || beforeId === undefined ? -1 : items.findIndex(function (t) { return t.id === beforeId; });
				if (index < 0) rendered.push(ghost);
				else rendered.splice(index, 0, ghost);
			}
			return h(
				"div",
				{
					className: "kb-col" + (active ? " drop-target" : ""),
					onDragOver: function (ev) { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; if (props.onDragOverColumn) props.onDragOverColumn(props.column); },
					onDrop: function (ev) {
						ev.preventDefault();
						var id = ev.dataTransfer.getData("text/kanban");
						if (id) { props.onMove(id, props.column); if (props.onDragEnd) props.onDragEnd(); }
					}
				},
				h("div", { className: "kb-colhead" },
					h("span", { className: "kb-coldot" }),
					h("span", { className: "kb-collabel", children: props.label }),
					h("span", { className: "kb-count", children: items.length })
				),
				h("div", { className: "kb-list" },
					items.length === 0 && ghost === null
						? h("div", { className: "kb-empty", children: props.column === "backlog" ? "Nothing queued" : props.column === "working" ? "Nothing in progress" : props.column === "done" ? "Nothing shipped yet" : "Nothing here" })
						: rendered
				)
			);
		}

		// Native-style form controls, reproduced in plain CSS (see .kb-seg / .kb-switch).
		// No hooks here, so hook order in the slot entries is unaffected.

		function SegmentedControl(props) {
			var options = props.options || [];
			var index = 0;
			options.forEach(function (o, i) { if (o.value === props.value) index = i; });
			return h("div", {
				className: "kb-seg",
				role: "tablist",
				"aria-label": props.ariaLabel,
				style: { "--dsh-segment-count": options.length, "--dsh-segment-index": index }
			},
				h("span", { className: "kb-seg-indicator", "aria-hidden": "true" }),
				options.map(function (o, i) {
					return h("button", {
						key: o.value,
						type: "button",
						role: "tab",
						className: "kb-seg-tab",
						"aria-selected": i === index ? "true" : "false",
						disabled: !!props.disabled,
						onClick: function () { if (!props.disabled) props.onChange(o.value); },
						onKeyDown: function (ev) {
							if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
							ev.preventDefault();
							if (props.disabled || options.length === 0) return;
							var next = (i + (ev.key === "ArrowRight" ? 1 : options.length - 1)) % options.length;
							props.onChange(options[next].value);
						},
						children: o.label
					});
				})
			);
		}

		function Switch(props) {
			var on = !!props.checked;
			return h("button", {
				type: "button",
				role: "switch",
				className: "kb-switch",
				"aria-checked": on ? "true" : "false",
				"aria-label": props.ariaLabel,
				disabled: !!props.disabled,
				onClick: function () { if (!props.disabled) props.onToggle(!on); },
				children: h("span", { className: "kb-switch-thumb", "aria-hidden": "true" })
			});
		}

		function CreateForm(props) {
			var s = React.useState({ title: "", body: "", acceptance: "", timing: "at_pickup", questions: "interactive", priority: 0, allowPaid: false, budget: 0, workspace: "", status: "backlog", worktree: false, worktreeCreated: false, worktreePath: "" });
			var form = s[0], setForm = s[1];
			var e = React.useState(null);
			var err = e[0], setErr = e[1];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			var wc = React.useState(false);
			var worktreeConfirm = wc[0], setWorktreeConfirm = wc[1];
			var wb = React.useState(false);
			var worktreeBusy = wb[0], setWorktreeBusy = wb[1];
			var we = React.useState(null);
			var worktreeError = we[0], setWorktreeError = we[1];
			var ws = React.useState(null);
			var extraWorkspace = ws[0], setExtraWorkspace = ws[1];
			var invalid = false;
			function field(key, value) {
				var next = Object.assign({}, form);
				next[key] = value;
				setForm(next);
			}
			function createWorktree() {
				setWorktreeBusy(true);
				setWorktreeError(null);
				rpc("worktree", { workspaceCwd: form.workspace || null, title: form.title }).then(function (res) {
					setWorktreeBusy(false);
					if (!res || !res.ok) { setWorktreeError(res && res.error ? res.error.message : "The worktree could not be created."); return; }
					var path = res.value.worktree.managedRoot;
					setForm(Object.assign({}, form, { workspace: path, worktree: true, worktreeCreated: true, worktreePath: path }));
					setExtraWorkspace({ path: path, title: "worktree" });
					setWorktreeConfirm(false);
				}, function () { setWorktreeBusy(false); setWorktreeError("Could not reach the Host."); });
			}

			function submit() {
				if (invalid || form.title.trim() === "") return;
				setBusy(true);
				setErr(null);
				rpc("create", {
					title: form.title,
					body: form.body,
					acceptance: form.acceptance.split("\n").map(function (x) { return x.trim(); }).filter(Boolean),
					planTiming: form.timing,
					planQuestions: form.questions,
					priority: Number(form.priority) || 0,
					allowPaid: !!form.allowPaid,
					budgetUsd: Number(form.budget) || 0,
					workspaceCwd: form.workspace || null,
					column: form.status
				}).then(function (res) {
					setBusy(false);
					if (res && res.ok) {
						setForm({ title: "", body: "", acceptance: "", timing: "at_pickup", questions: "interactive", priority: 0, allowPaid: false, budget: 0, workspace: "", status: "backlog", worktree: false, worktreeCreated: false, worktreePath: "" });
						props.onCreated(res.value.ticket);
					} else {
						setErr(res && res.error ? res.error.message : "Could not create the ticket.");
					}
				}, function () { setBusy(false); setErr("Could not reach the Host."); });
			}
			return h("div", { className: "kb-form" },
				h("div", { className: "kb-label", children: "Title" }),
				h("input", { className: "kb-input", "aria-label": "Ticket title", value: form.title, placeholder: "What needs to happen?", onChange: function (ev) { field("title", ev.target.value); } }),
				h("div", { className: "kb-label", children: "Body / context" }),
				h("textarea", { className: "kb-textarea", "aria-label": "Ticket body", value: form.body, placeholder: "Anything the roles should know. Untrusted data, never instructions.", onChange: function (ev) { field("body", ev.target.value); } }),
				h("div", { className: "kb-label", children: "Acceptance (one per line, stored verbatim; may be aspirational)" }),
				h("textarea", { className: "kb-textarea", "aria-label": "Acceptance statements", value: form.acceptance, onChange: function (ev) { field("acceptance", ev.target.value); } }),
				h("div", { className: "kb-row" },
					h("div", { style: { flex: 1, minWidth: 220 } },
						h("div", { className: "kb-label", children: "Workspace" }),
						h("select", { className: "kb-select", style: { width: "100%" }, value: form.workspace, disabled: form.worktreeCreated, onChange: function (ev) { field("workspace", ev.target.value); } },
							h("option", { value: "", children: "Engine default" }),
							((props.workspaces || []).concat(extraWorkspace ? [extraWorkspace] : [])).map(function (workspace) { return h("option", { key: workspace.id || workspace.path, value: workspace.path, children: workspace.title + " — " + workspace.path }); })
						)
					),
					h("div", null,
						h("div", { className: "kb-label", children: "Initial status" }),
						h(SegmentedControl, {
							ariaLabel: "Initial status",
							value: form.status,
							onChange: function (value) { field("status", value); },
							options: [
								{ value: "backlog", label: "Backlog" },
								{ value: "working", label: "Working (start immediately)" }
							]
						})
					)
				),
				h("div", { className: "kb-row" },
					h("div", null, h("div", { className: "kb-label", children: "Planning" }),
						h(SegmentedControl, {
							ariaLabel: "Planning",
							value: form.timing,
							onChange: function (value) { field("timing", value); },
							options: [
								{ value: "at_pickup", label: "When started" },
								{ value: "now", label: "Now" }
							]
						})),
					h("div", null, h("div", { className: "kb-label", children: "Questions" }),
						h(SegmentedControl, {
							ariaLabel: "Questions",
							value: form.questions,
							onChange: function (value) { field("questions", value); },
							options: [
								{ value: "interactive", label: "Ask me" },
								{ value: "autonomous", label: "Decide autonomously" }
							]
						})),
					h("div", null, h("div", { className: "kb-label", children: "Priority" }),
						h("input", { className: "kb-input", type: "number", value: form.priority, style: { width: 80 }, onChange: function (ev) { field("priority", ev.target.value); } })),
					h("div", { className: "kb-switchrow" },
						h(Switch, {
							ariaLabel: "Allow paid models",
							checked: form.allowPaid,
							onToggle: function (value) { field("allowPaid", value); }
						}),
						h("span", { className: "kb-label", children: "Allow paid" })),
					h("div", null, h("div", { className: "kb-label", children: "Budget USD" }),
						h("input", { className: "kb-input", type: "number", value: form.budget, style: { width: 100 }, onChange: function (ev) { field("budget", ev.target.value); } }))
				),
				props.worktreeAvailable ? h("div", { className: "kb-row" },
					h("div", { className: "kb-switchrow" },
						h(Switch, {
							ariaLabel: "Create a git worktree for this ticket",
							checked: form.worktree,
							disabled: worktreeBusy || form.worktreeCreated,
							onToggle: function (value) { if (value) { setWorktreeError(null); setWorktreeConfirm(true); } }
						}),
						h("span", { className: "kb-label", children: "Worktree" })),
					form.worktreeCreated ? h("span", { className: "kb-worktree-path", children: form.worktreePath }) : h("span", { className: "kb-hint", children: "Create an isolated working copy for this ticket." })) : null,
				err ? h("div", { className: "kb-err", children: err }) : null,
				h("div", { className: "kb-row" },
					h("button", { className: "kb-btn primary", disabled: busy || invalid || form.title.trim() === "", onClick: submit, children: busy ? "Creating…" : "Create ticket" }),
					h("button", { className: "kb-btn", onClick: props.onClose, children: "Cancel" })),
				h(Modal, { open: worktreeConfirm, title: "Start in a git worktree", onClose: function () { if (!worktreeBusy) setWorktreeConfirm(false); } },
					h("div", { className: "kb-form" },
						h("p", { className: "kb-hint", children: "A new branch and worktree are created for this repository. The ticket will use that working copy, and the original checkout is left untouched." }),
						worktreeError ? h("div", { className: "kb-err", children: worktreeError }) : null,
						h("div", { className: "kb-row" },
							h("button", { className: "kb-btn", disabled: worktreeBusy, onClick: function () { setWorktreeConfirm(false); }, children: "Cancel" }),
							h("button", { className: "kb-btn primary", disabled: worktreeBusy, onClick: createWorktree, children: worktreeBusy ? "Creating…" : "Create worktree and use it" }))))
			);
		}

		// ---------------------------------------------------------------- detail

		function PencilIcon() {
			return h("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M3 11.8V13h1.2l6.9-6.9-1.2-1.2L3 11.8Z", stroke: "currentColor", strokeWidth: 1.8, strokeLinejoin: "round", strokeLinecap: "round" }),
				h("path", { d: "m10.3 4.3 1.4-1.4a1 1 0 0 1 1.4 0l.5.5a1 1 0 0 1 0 1.4l-1.4 1.4", stroke: "currentColor", strokeWidth: 1.8, strokeLinejoin: "round", strokeLinecap: "round" })
			);
		}

		var modalSeq = 0;
		var modalStack = [];

		function Modal(props) {
			// Only the topmost open dialog answers Escape, so a nested
			// confirm (worktree) closes alone and leaves the form open.
			// The close callback is read through a ref and the stack entry
			// is registered only on open, because onClose is re-created on
			// every render and a dep on it would reshuffle the stack order.
			var closeRef = React.useRef(props.onClose);
			React.useEffect(function () { closeRef.current = props.onClose; });
			React.useEffect(function () {
				if (!props.open) return undefined;
				var id = ++modalSeq;
				modalStack.push(id);
				function onKey(event) {
					if (event.key === "Escape" && modalStack[modalStack.length - 1] === id) closeRef.current();
				}
				window.addEventListener("keydown", onKey);
				return function () {
					modalStack.splice(modalStack.indexOf(id), 1);
					window.removeEventListener("keydown", onKey);
				};
			}, [props.open]);
			if (!props.open) return null;
			return h("div", { className: "kb-modal-backdrop", onClick: function (event) { if (event.target === event.currentTarget) props.onClose(); } },
				h("div", { className: "kb-modal", role: "dialog", "aria-modal": "true", "aria-label": props.title },
					h("div", { className: "kb-modal-head" },
						h("h2", { className: "kb-modal-title", children: props.title }),
						h("div", { className: "kb-modal-actions" },
							props.actions || null,
							h("button", { className: "kb-iconbtn", "aria-label": "Close dialog", title: "Close", onClick: props.onClose, children: "×" })
						)
					),
					props.children
				)
			);
		}

		function AcceptanceEditor(props) {
			var s = React.useState("");
			var text = s[0], setText = s[1];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			function submit() {
				var lines = text.split("\n").map(function (line) { return line.trim(); }).filter(Boolean);
				if (lines.length === 0) return;
				setBusy(true);
				Promise.all(lines.map(function (line) { return props.onAcceptance(props.ticketId, line); })).finally(function () { setBusy(false); props.onClose(); });
			}
			return h("div", { className: "kb-form" },
				h("div", { className: "kb-hint", children: "Stored verbatim as human-authored acceptance. One statement per line." }),
				h("textarea", { className: "kb-textarea", autoFocus: true, value: text, placeholder: "One acceptance statement per line…", onChange: function (event) { setText(event.target.value); } }),
				h("div", { className: "kb-row" },
					h("button", { className: "kb-btn primary", disabled: busy || text.trim() === "", onClick: submit, children: busy ? "Adding…" : "Add acceptance" }),
					h("button", { className: "kb-btn", onClick: props.onClose, children: "Cancel" })
				)
			);
		}

		function ModeEditor(props) {
			var ticket = props.ticket;
			var s = React.useState({ timing: ticket.planTiming, questions: ticket.planQuestions, priority: ticket.priority, allowPaid: ticket.allowPaid, budgetUsd: ticket.budgetUsd, workspaceCwd: ticket.workspaceCwd || "" });
			var form = s[0], setForm = s[1];
			var invalid = false;
			function save() {
				if (invalid) return;
				props.onSave({ planTiming: form.timing, planQuestions: form.questions, priority: Number(form.priority) || 0, allowPaid: !!form.allowPaid, budgetUsd: Number(form.budgetUsd) || 0, workspaceCwd: form.workspaceCwd || null });
			}
			return h("div", { className: "kb-form" },
				h("div", { className: "kb-row" },
					h("div", null, h("div", { className: "kb-label", children: "Planning" }),
						h("select", { className: "kb-select", value: form.timing, onChange: function (ev) { setForm(Object.assign({}, form, { timing: ev.target.value })); } },
							h("option", { value: "at_pickup", children: "When started" }), h("option", { value: "now", children: "Now" }))),
					h("div", null, h("div", { className: "kb-label", children: "Questions" }),
						h("select", { className: "kb-select", value: form.questions, onChange: function (ev) { setForm(Object.assign({}, form, { questions: ev.target.value })); } },
							h("option", { value: "interactive", children: "Ask me" }), h("option", { value: "autonomous", children: "Decide autonomously" }))),
					h("div", null, h("div", { className: "kb-label", children: "Priority" }),
						h("input", { className: "kb-input", type: "number", style: { width: 80 }, value: form.priority, onChange: function (ev) { setForm(Object.assign({}, form, { priority: ev.target.value })); } })),
					h("label", { className: "kb-row", style: { gap: 6, marginTop: 18 } },
						h("input", { type: "checkbox", checked: form.allowPaid, onChange: function (ev) { setForm(Object.assign({}, form, { allowPaid: ev.target.checked })); } }),
						h("span", { className: "kb-label", children: "allow paid" })),
					h("div", null, h("div", { className: "kb-label", children: "Budget USD" }),
						h("input", { className: "kb-input", type: "number", style: { width: 100 }, value: form.budgetUsd, onChange: function (ev) { setForm(Object.assign({}, form, { budgetUsd: ev.target.value })); } }))
				),
				h("div", null, h("div", { className: "kb-label", children: "Workspace cwd" }),
					h("input", { className: "kb-input", style: { width: "100%" }, value: form.workspaceCwd, onChange: function (ev) { setForm(Object.assign({}, form, { workspaceCwd: ev.target.value })); } })),
								h("div", { className: "kb-row" },
					h("button", { className: "kb-btn primary", disabled: invalid, onClick: function () { save(); if (props.onClose) props.onClose(); }, children: "Save modes" }),
					h("button", { className: "kb-btn", onClick: props.onClose || function () {}, children: "Cancel" }))
			);
		}

		function Timeline(props) {
			var items = props.items || [];
			var expandedState = React.useState(null);
			var expanded = expandedState[0], setExpanded = expandedState[1];
			if (items.length === 0) return h("div", { className: "kb-empty", children: "No workflow steps recorded yet." });
			var min = Infinity, max = -Infinity;
			items.forEach(function (item) {
				var a = new Date(item.startedAt).getTime();
				var b = new Date(item.endedAt).getTime();
				if (isFinite(a)) min = Math.min(min, a);
				if (isFinite(b)) max = Math.max(max, b);
			});
			if (!isFinite(min) || !isFinite(max) || max <= min) max = min + 1000;
			var stepIndex = 0;
			function tone(item) {
				if (item.kind === "phase") return "kb-tl-" + item.role;
				if (item.kind === "judge") return "kb-tl-judge";
				var cls = "kb-tl-step-" + (stepIndex % 5);
				stepIndex += 1;
				return cls;
			}
			return h("div", { className: "kb-timeline" },
				h("div", { className: "kb-tl-legend" },
					h("span", { className: "kb-tl-key kb-tl-planner", children: "Plan" }),
					h("span", { className: "kb-tl-key kb-tl-implementer", children: "Build" }),
					h("span", { className: "kb-tl-key kb-tl-reviewer", children: "Review" }),
					h("span", { className: "kb-tl-key kb-tl-verifier", children: "Approval" }),
					h("span", { className: "kb-tl-key kb-tl-plugin", children: "Plugin step" })
				),
				items.map(function (item, index) {
					var a = new Date(item.startedAt).getTime();
					var b = new Date(item.endedAt).getTime();
					var left = ((a - min) / (max - min)) * 100;
					var width = Math.max(0.5, ((b - a) / (max - min)) * 100);
					var cls = tone(item);
					var label = item.kind === "phase" ? item.name : item.kind === "judge" ? "judge · " + item.name : item.name;
					var detail = (item.kind === "phase" ? "attempt " + item.attempt + " · " : "") + (item.includesWait ? "includes human wait · " : "") + fmtDur(item.durationMs);
					return h("div", { className: "kb-tl-entry", key: index },
						h("div", { className: "kb-tl-row", role: "button", tabIndex: 0, title: "Show details for " + label,
							onClick: function () { setExpanded(expanded === index ? null : index); },
							onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setExpanded(expanded === index ? null : index); } } },
							h("div", { className: "kb-tl-label" },
								h("span", { className: "kb-tl-name", children: label }),
								h("span", { className: "kb-tl-detail", children: detail })
							),
							h("div", { className: "kb-tl-track" },
								h("div", { className: "kb-tl-bar " + cls, style: { left: Math.min(99, Math.max(0, left)) + "%", width: Math.min(100, width) + "%" } },
									width > 12 ? h("span", { className: "kb-tl-dur", children: fmtDur(item.durationMs) }) : null
								)
							)
						),
						expanded === index ? h("div", { className: "kb-tl-expand" },
							h("div", { className: "kb-tl-meta" },
								h("span", null, "kind ", h("b", { children: item.kind })),
								item.role ? h("span", null, "role ", h("b", { children: item.role })) : null,
								item.attempt ? h("span", null, "attempt ", h("b", { children: item.attempt })) : null,
								item.provider ? h("span", null, h("b", { children: item.provider + "/" + (item.model || "?") })) : null,
								h("span", null, "status ", h("b", { children: item.status || "unknown" })),
								h("span", null, "spans ", h("b", { children: item.spans || 1 }))
							),
							(item.artifacts || []).map(function (artifact, artifactIndex) {
								return h("div", { className: "kb-tl-artifact", key: "artifact-" + artifactIndex },
									h("div", { className: "kb-tl-artifact-title", children: artifact.kind.replace(/^judge_/, "judge · ").replace(/^plugin_/, "plugin · ") }),
									h("pre", { className: "kb-tl-artifact-body", children: artifact.content })
								);
							}),
							(item.events || []).length > 0 ? h("div", { className: "kb-tl-events" },
								h("div", { className: "kb-tl-artifact-title", children: "Lifecycle events" }),
								(item.events || []).map(function (event, eventIndex) {
									return h("div", { className: "kb-tl-event", key: "event-" + eventIndex },
										h("div", { className: "kb-tl-event-head" },
											h("b", { children: event.kind }),
											h("span", { className: "kb-tl-event-time", children: fmtTime(event.at) }),
											event.phaseFrom || event.phaseTo ? h("span", { className: "kb-tl-event-phase", children: (event.phaseFrom || "—") + " → " + (event.phaseTo || "—") }) : null,
											h("span", { className: "kb-tl-event-actor", children: event.actor || "engine" })
										),
										h("pre", { className: "kb-tl-event-payload", children: JSON.stringify(event.payload || {}, null, 2) })
									);
								})
							) : null,
							(item.artifacts || []).length === 0 && (item.events || []).length === 0 ? h("div", { className: "kb-hint", children: item.kind === "judge" ? "No artifact was stored for this older judge call." : "No payload or lifecycle event stored for this step." }) : null
						) : null
					);
				})
			);
		}

		function Accordion(props) {
			var o = React.useState(!!props.open);
			var open = o[0], setOpen = o[1];
			return h("div", { className: "kb-panel" },
				h("h3", { style: { cursor: "pointer", margin: 0 }, onClick: function () { setOpen(!open); }, children: (open ? "▾ " : "▸ ") + props.title }),
				open ? h("div", { style: { marginTop: 8 } }, props.children) : null
			);
		}

		function Lifecycle(props) {
			var t = props.ticket;
			var current = phaseIndex(t.phase);
			var closed = t.phase === "closed" || t.column === "done";
			return h("div", { className: "kb-lifecycle" },
				PHASES.map(function (phase, i) {
					var done = closed || i < current;
					var active = !closed && i === current;
					return h("div", { key: phase, className: "kb-life kb-life-" + phase + (done ? " done" : "") + (active ? " active" : "") },
						h("span", { className: "kb-life-dot" }),
						h("span", { className: "kb-life-label", children: phaseLabel(phase) })
					);
				})
			);
		}

		function TicketAnalytics(props) {
			var d = props.detail;
			var t = d.ticket;
			var u = d.usage || {};
			var models = Object.keys(u.byModel || {}).map(function (key) { return Object.assign({ key: key }, u.byModel[key]); });
			var phases = (d.timeline || []).filter(function (item) { return item.kind === "phase"; });
			var verified = (d.review && Array.isArray(d.review.done_when)) ? d.review.done_when : [];
			var met = verified.filter(function (x) { return x.met === true; }).length;
			var statuses = {};
			(d.spans || []).forEach(function (span) { statuses[span.status] = (statuses[span.status] || 0) + 1; });
			function card(title, body, tone) {
				return h("div", { className: "kb-panel kb-analytics-card " + (tone || "kb-tone-run") },
					h("h3", { children: [h("span", { className: "kb-carddot" }), title] }), body);
			}
			function table(headers, rows) {
				if (rows.length === 0) return h("div", { className: "kb-hint", children: "No data yet." });
				return h("table", { className: "kb-table" },
					h("thead", null, h("tr", null, headers.map(function (hdr) { return h("th", { key: hdr, children: hdr }); }))),
					h("tbody", null, rows.map(function (row, i) { return h("tr", { key: i }, row.map(function (cell, j) { return h("td", { key: j, children: cell }); })); }))
				);
			}
			return h("div", { className: "kb-analytics" },
				h("div", { className: "kb-analytics-kpis" },
					h(Kpi, { tone: "kb-tone-run", value: t.attemptCount, label: "Attempts" }),
					h(Kpi, { tone: "kb-tone-violet", value: fmtTokens((u.inputTokens || 0) + (u.outputTokens || 0)), label: "Tokens" }),
					h(Kpi, { tone: "kb-tone-idle", value: fmtCost(u.costUsd, u.unpriced), label: "Cost" }),
					h(Kpi, { tone: "kb-tone-ok", value: met + "/" + verified.length, label: "Conditions met" }),
					h(Kpi, { tone: "kb-tone-warn", value: d.spans.length, label: "Steps" })
				),
				h("div", { className: "kb-analytics-grid" },
					card("Model usage", table(["provider", "model", "in", "out", "cost"], models.map(function (m) {
						return [m.provider, m.model, fmtTokens(m.inputTokens), fmtTokens(m.outputTokens), fmtCost(m.costUsd, m.unpriced)];
					})), "kb-tone-violet"),
					card("Time by phase", table(["phase", "attempt", "duration"], phases.map(function (item) {
						return [item.name, item.attempt, fmtDur(item.durationMs) + (item.includesWait ? " · incl. wait" : "")];
					})), "kb-tone-run"),
					card("Review claims", table(["condition", "met", "confidence"], verified.map(function (x) {
						return [x.id, x.met === true ? "met" : "not met", x.confidence === undefined ? "—" : x.confidence];
					})), "kb-tone-ok"),
					card("Span outcomes", table(["status", "spans"], Object.keys(statuses).sort().map(function (key) { return [key, statuses[key]]; })), "kb-tone-warn")
				)
			);
		}

		function TicketDetail(props) {
			var d = props.detail;
			var tabState = React.useState("overview");
			var tab = tabState[0], setTab = tabState[1];
			var modalState = React.useState(null);
			var modal = modalState[0], setModal = modalState[1];
			React.useEffect(function () {
				if (!d) return;
				var ticket = d.ticket;
				var planSessions = (d.sessions || []).filter(function (session) { return session.purpose === "plan" || session.role === "plan"; });
				var planSession = planSessions.length > 0 ? planSessions[planSessions.length - 1] : null;
				if (ticket.phase === "plan" && planSession && !autoOpenedSessions.has(ticket.id)) {
					autoOpenedSessions.add(ticket.id);
					if (openSessionById) openSessionById(planSession.sessionId);
				}
			}, [d]);
			if (!d) return h("div", { className: "kb-empty", children: "Loading ticket…" });
			var t = d.ticket;
			var detailStatus = d.status || t.status || "idle";
			var tabs = ["overview", "timeline", "sessions", "events", "ticket analytics"];
			return h("div", { className: "kb-detail" },
				h("div", { className: "kb-hero " + (detailStatus === "attention" ? "kb-hero-attention" : "kb-hero-" + t.column) },
					h("div", { className: "kb-hero-top" },
						h("button", { className: "kb-btn", onClick: props.onBack, children: "← Board" }),
						h("span", { className: "kb-key", children: t.key }),
						h("span", { className: "kb-statusdot " + detailStatus, title: detailStatus, "aria-label": "Status: " + detailStatus }),
						h("span", { className: "kb-phasechip " + phaseTone(t.phase), children: phaseLabel(t.phase) }),
						h("span", { className: "kb-chip", children: t.column }),
						t.needsAttentionReason ? h("span", { className: "kb-chip err", children: d.awaitingQuestion ? "waiting on your answer" : "needs attention" }) : null,
						h("button", { className: "kb-iconbtn", title: "Edit modes and budget", "aria-label": "Edit modes and budget", onClick: function () { setModal("modes"); } }, h(PencilIcon))
					),
					h("h2", { className: "kb-hero-title", children: t.title }),
					h("div", { className: "kb-hero-meta" },
						h("span", null, "workspace ", h("b", { children: t.workspaceCwd || "engine default" })),
						h("span", null, "attempts ", h("b", { children: t.attemptCount })),
						h("span", null, "spend ", h("b", { children: fmtUsd(t.spentUsd) })),
						h("span", null, "updated ", h("b", { children: ago(t.updatedAt) }))
					),
					h(Lifecycle, { ticket: t })
				),
				t.needsAttentionReason && !d.awaitingQuestion ? (t.phase === "verify" ? h(ApprovalPanel, { ticket: t, detail: d, onApprove: props.onApprove, onDiscard: function () { props.onAction(t.id, "discard", {}); }, onOpenSession: function (sessionId) { if (openSessionById) openSessionById(sessionId); }, onStartSession: function () { props.onApprovalSession(t.id); } }) : h(NeedsAttention, { ticket: t, onResolve: props.onResolve })) : null,
				h("div", { className: "kb-tabs" }, tabs.map(function (name) {
					return h("button", { key: name, className: "kb-tab" + (tab === name ? " on" : ""), onClick: function () { setTab(name); }, children: name });
				})),
				tab === "overview" ? h(Overview, { detail: d, onSave: props.onSave, onAction: props.onAction, onAcceptance: props.onAcceptance, onEditAcceptance: function () { setModal("acceptance"); } }) : null,
				tab === "timeline" ? h("div", { className: "kb-panel" },
					h("h3", { children: "Workflow timeline" }),
					h("div", { className: "kb-row", style: { marginBottom: 8 } },
						h("button", { className: "kb-btn sm", onClick: function () { rpc("export", { id: t.id, kind: "spans", format: "csv" }).then(function (res) { if (res && res.ok) download(t.key + "-spans.csv", res.value.mime, res.value.body); }); }, children: "Spans CSV" }),
						h("button", { className: "kb-btn sm", onClick: function () { rpc("export", { id: t.id, kind: "spans", format: "jsonl" }).then(function (res) { if (res && res.ok) download(t.key + "-spans.jsonl", res.value.mime, res.value.body); }); }, children: "Spans JSONL" }),
						h("button", { className: "kb-btn sm", onClick: function () { rpc("export", { id: t.id, kind: "usage", format: "csv" }).then(function (res) { if (res && res.ok) download(t.key + "-usage.csv", res.value.mime, res.value.body); }); }, children: "Usage CSV" })),
					h(Timeline, { items: d.timeline || [] })) : null,
				tab === "sessions" ? h(SessionsPanel, { detail: d, onAction: props.onAction, onRecover: props.onRecover }) : null,
				tab === "events" ? h(EventsPanel, { detail: d }) : null,
				tab === "ticket analytics" ? h(TicketAnalytics, { detail: d }) : null,
				h(Modal, { open: modal === "modes", title: "Modes and budget", onClose: function () { setModal(null); } },
					h(ModeEditor, { ticket: t, onSave: function (patch) { props.onSave(t.id, patch); }, onClose: function () { setModal(null); } })),
				h(Modal, { open: modal === "acceptance", title: "Add acceptance criteria", onClose: function () { setModal(null); } },
					h(AcceptanceEditor, { ticketId: t.id, onAcceptance: props.onAcceptance, onClose: function () { setModal(null); } }))
			);
		}


		function ApprovalPanel(props) {
			var d = props.detail;
			var sessionId = d.approvalSessionId;
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			function start() {
				setBusy(true);
				props.onStartSession().finally(function () { setBusy(false); });
			}
			return h("div", { className: "kb-panel", style: { borderColor: "#f3b3ac", background: "#fffafa" } },
				h("h3", { children: "Approval" }),
				h("div", { className: "kb-hint", style: { marginBottom: 8 }, children: "The review is complete and every planned condition is accounted for. Approve to close, discard the work, or open an interactive approval session to merge, deploy, or iterate." }),
				h("div", { className: "kb-row" },
					h("button", { className: "kb-btn primary sm", disabled: busy, onClick: function () { setBusy(true); props.onApprove(props.ticket.id).finally(function () { setBusy(false); }); }, children: "Approve and close" }),
					h("button", { className: "kb-btn danger sm", disabled: busy, onClick: props.onDiscard, children: "Discard" }),
					sessionId
						? h("button", { className: "kb-btn sm", onClick: function () { props.onOpenSession(sessionId); }, children: "Open approval session" })
						: h("button", { className: "kb-btn sm", disabled: busy, onClick: start, children: busy ? "Starting…" : "Launch approval session" }))
			);
		}

		function NeedsAttention(props) {
			var s = React.useState("");
			var instruction = s[0], setInstruction = s[1];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			return h("div", { className: "kb-panel", style: { borderColor: "#f3b3ac", background: "#fffafa" } },
				h("h3", { children: "Needs attention" }),
				h("div", { className: "kb-hint", style: { marginBottom: 8 }, children: props.ticket.needsAttentionReason || "The engine ran out of options." }),
				h("textarea", { className: "kb-textarea", placeholder: "Optional instruction for the next attempt", value: instruction, onChange: function (ev) { setInstruction(ev.target.value); } }),
				h("div", { className: "kb-row", style: { marginTop: 8 } },
					h("button", {
						className: "kb-btn primary sm", disabled: busy,
						onClick: function () { setBusy(true); props.onResolve(props.ticket.id, "retry", instruction).finally(function () { setBusy(false); }); },
						children: "Retry with instruction"
					}),
					h("button", {
						className: "kb-btn danger sm", disabled: busy,
						onClick: function () { setBusy(true); props.onResolve(props.ticket.id, "discard", instruction).finally(function () { setBusy(false); }); },
						children: "Discard"
					}))
			);
		}

		function Overview(props) {
			var d = props.detail;
			var t = d.ticket;
			var usage = d.usage || {};
			var models = Object.keys(usage.byModel || {});
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
				h("div", { className: "kb-panel" },
					h("h3", { children: "Ticket" }),
					h("div", { className: "kb-kv" },
						h("b", { children: "Workspace" }), h("span", { children: t.workspaceCwd || "(engine default)" }),
						h("b", { children: "Planning" }), h("span", { children: t.planTiming === "now" ? "now" : "when started" }),
						h("b", { children: "Questions" }), h("span", { children: t.planQuestions === "autonomous" ? "decide autonomously" : "ask me" }),
						h("b", { children: "Attempts" }), h("span", { children: t.attemptCount + " / " + (props.maxAttempts || 3) }),
						h("b", { children: "Spend" }), h("span", { children: fmtUsd(t.spentUsd) + (t.budgetUsd > 0 ? " / " + fmtUsd(t.budgetUsd) : " (no budget)") }),
						h("b", { children: "Allow paid" }), h("span", { children: t.allowPaid ? "yes" : "no" }),
						h("b", { children: "Created" }), h("span", { children: fmtTime(t.createdAt) }),
						h("b", { children: "Updated" }), h("span", { children: ago(t.updatedAt) }))
				),
				h("div", { className: "kb-panel" },
					h("div", { className: "kb-panelhead" },
						h("h3", { children: "Acceptance — the human's words, verbatim" }),
						h("button", { className: "kb-iconbtn", title: "Add acceptance criteria", "aria-label": "Add acceptance criteria", onClick: props.onEditAcceptance }, h(PencilIcon))
					),
					d.acceptance.length === 0 ? h("div", { className: "kb-hint", children: "None stored." }) :
						h("ul", { style: { margin: 0, paddingLeft: 18 } }, d.acceptance.map(function (a, i) {
							return h("li", { key: i }, h("span", { className: "kb-chip", style: { marginRight: 6 }, children: a.source }), a.statement);
						}))
				),
				h("div", { className: "kb-panel" },
					h("h3", { children: "done_when — what the review proves" }),
					d.conditions.length === 0 ? h("div", { className: "kb-hint", children: "No conditions yet; the plan session produces them." }) :
						h("table", { className: "kb-table" },
							h("thead", null, h("tr", null, h("th", { children: "id" }), h("th", { children: "statement" }), h("th", { children: "how verified" }), h("th", { children: "source" }))),
							h("tbody", null, d.conditions.map(function (c) {
								return h("tr", { key: c.id }, h("td", null, h("code", { children: c.id })), h("td", { children: c.statement }), h("td", { children: c.howVerified }), h("td", { children: c.source }));
							})))
				),
				d.review ? h("div", { className: "kb-panel" },
					h("h3", { children: "Review" }),
					h("div", { className: "kb-row" }, h("span", { className: "kb-chip" + (d.review.verdict === "pass" ? " ok" : " err"), children: d.review.verdict }), h("span", { className: "kb-hint", children: "scope: " + (d.review.scope_drift || "—") })),
					(d.review.reasons || []).length > 0 ? h("ul", { style: { margin: "6px 0 0", paddingLeft: 18 } }, d.review.reasons.map(function (r, i) { return h("li", { key: i, children: r }); })) : null,
					(d.review.acceptance_coverage || []).length > 0 ? h("table", { className: "kb-table", style: { marginTop: 8 } },
						h("thead", null, h("tr", null, h("th", { children: "condition" }), h("th", { children: "acceptance phrase it serves" }))),
						h("tbody", null, d.review.acceptance_coverage.map(function (row, i) { return h("tr", { key: i }, h("td", null, h("code", { children: row.condition })), h("td", { children: row.acceptance })); }))) : null
				) : null,
				h("div", { className: "kb-panel" },
					h("h3", { children: "Token and cost rollup" }),
					h("div", { className: "kb-row", style: { gap: 18, marginBottom: 8 } },
						h("span", { children: "input " + fmtTokens(usage.inputTokens) }),
						h("span", { children: "output " + fmtTokens(usage.outputTokens) }),
						h("span", { children: "cache read " + fmtTokens(usage.cacheReadTokens) }),
						h("span", { children: "cache write " + (usage.cacheWriteTokens || 0) }),
						h("span", { children: fmtCost(usage.costUsd, usage.unpriced) })),
					models.length === 0 ? h("div", { className: "kb-hint", children: "No usage recorded." }) :
						h("table", { className: "kb-table" },
							h("thead", null, h("tr", null, h("th", { children: "provider" }), h("th", { children: "model" }), h("th", { children: "in" }), h("th", { children: "out" }), h("th", { children: "cost" }))),
							h("tbody", null, models.map(function (key) {
								var m = usage.byModel[key];
								return h("tr", { key: key }, h("td", { children: m.provider }), h("td", { children: m.model }), h("td", { children: fmtTokens(m.inputTokens) }), h("td", { children: fmtTokens(m.outputTokens) }), h("td", { children: fmtCost(m.costUsd, m.unpriced) }));
							})))
				),
				h("div", { className: "kb-panel" },
					h("h3", { children: "Actions" }),
					h("div", { className: "kb-row" },
						h("button", { className: "kb-btn danger sm", onClick: function () { props.onAction(t.id, "discard"); }, children: "Discard" }),
						h("button", { className: "kb-btn sm", onClick: function () { rpc("export", { id: t.id, format: "jsonl" }).then(function (res) { if (res && res.ok) download(t.key + ".jsonl", res.value.mime, res.value.body); }); }, children: "Export JSONL" }),
						h("button", { className: "kb-btn sm", onClick: function () { rpc("export", { id: t.id, format: "csv" }).then(function (res) { if (res && res.ok) download(t.key + ".csv", res.value.mime, res.value.body); }); }, children: "Export CSV" }))
				)
			);
		}

		function SessionsPanel(props) {
			var d = props.detail;
			var s = React.useState("");
			var sessionId = s[0], setSessionId = s[1];
			return h("div", { className: "kb-panel" },
				h("h3", { children: "Workflow sessions" }),
				d.sessions.length === 0 ? h("div", { className: "kb-hint", children: "No sessions attached." }) :
					h("table", { className: "kb-table" },
						h("thead", null, h("tr", null, h("th", { children: "purpose" }), h("th", { children: "session" }), h("th", { children: "provider/model" }), h("th", { children: "created" }), h("th", { children: "" }))),
						h("tbody", null, d.sessions.map(function (session) {
							return h("tr", { key: session.id },
								h("td", { children: session.purpose || session.role }),
								h("td", null, h("code", { style: { fontSize: 10 }, children: session.sessionId }),
									h("button", { className: "kb-btn sm", style: { marginLeft: 8 }, onClick: function () { if (openSessionById) openSessionById(session.sessionId); }, children: "Open" }),
										props.onRecover ? h("button", { className: "kb-btn sm", style: { marginLeft: 4 }, onClick: function () { props.onRecover(session.sessionId); }, children: "Recover tools" }) : null),
								h("td", { children: (session.provider || "?") + "/" + (session.model || "?") }),
								h("td", { children: fmtTime(session.createdAt) }),
								h("td", null, h("button", { className: "kb-btn sm", onClick: function () { props.onAction(d.ticket.id, "detachSession", { sessionId: session.sessionId }); }, children: "Detach" })));
						}))),
				h("div", { className: "kb-row", style: { marginTop: 10 } },
					h("input", { className: "kb-input", style: { flex: 1 }, placeholder: "Existing DSH session id", value: sessionId, onChange: function (ev) { setSessionId(ev.target.value); } }),
					h("button", { className: "kb-btn sm", disabled: sessionId.trim() === "", onClick: function () { props.onAction(d.ticket.id, "attachSession", { sessionId: sessionId.trim(), role: "implementer" }); setSessionId(""); }, children: "Attach" }))
			);
		}

		function EventsPanel(props) {
			return h("div", { className: "kb-panel" },
				h("h3", { children: "Event log" }),
				props.detail.events.length === 0 ? h("div", { className: "kb-hint", children: "No events." }) :
					h("table", { className: "kb-table" },
						h("thead", null, h("tr", null, h("th", { children: "at" }), h("th", { children: "kind" }), h("th", { children: "actor" }), h("th", { children: "phase" }), h("th", { children: "detail" }))),
						h("tbody", null, props.detail.events.slice().reverse().map(function (e) {
							return h("tr", { key: e.id },
								h("td", { style: { whiteSpace: "nowrap" }, children: fmtTime(e.at) }),
								h("td", null, h("code", { children: e.kind })),
								h("td", { children: e.actor }),
								h("td", { children: (e.phaseFrom || "—") + " → " + (e.phaseTo || "—") }),
								h("td", { style: { maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis" }, title: JSON.stringify(e.payload), children: JSON.stringify(e.payload) }));
						})))
			);
		}

		function AnalyticsPanel(props) {
			if (!props.data) return h("div", { className: "kb-empty", children: "Loading analytics…" });
			var a = props.data;
			var done = a.counts ? a.counts.done || 0 : 0;
			var totalCost = (a.costPerTicket || []).reduce(function (sum, row) { return sum + (Number(row.costUsd) || 0); }, 0);
			var totalAttempts = 0, totalTickets = 0;
			(a.attemptsToDone || []).forEach(function (row) { totalAttempts += Number(row.attempts) * Number(row.tickets); totalTickets += Number(row.tickets); });
			var avgAttempts = totalTickets === 0 ? "—" : (totalAttempts / totalTickets).toFixed(1);
			var modelCount = (a.modelSuccessRate || []).length;
			function pctBar(rate) {
				if (rate === null || rate === undefined) return h("span", { className: "kb-dim", children: "—" });
				var pct = Math.round(rate * 100);
				return h("span", { className: "kb-rate" }, h("span", { className: "kb-rate-track" }, h("span", { className: "kb-rate-fill " + (pct >= 80 ? "good" : pct >= 50 ? "mid" : "bad"), style: { width: pct + "%" } })), h("span", { children: pct + "%" }));
			}
			function table(title, rows, cols, tone) {
				return h("div", { className: "kb-panel kb-analytics-card " + tone },
					h("h3", { children: [h("span", { className: "kb-carddot" }), title] }),
					rows.length === 0 ? h("div", { className: "kb-hint", children: "No data yet." }) :
						h("table", { className: "kb-table" },
							h("thead", null, h("tr", null, cols.map(function (c) { return h("th", { key: c[0], children: c[1] }); }))),
							h("tbody", null, rows.map(function (row, i) {
								return h("tr", { key: i }, cols.map(function (c) { return h("td", { key: c[0], children: typeof c[2] === "function" ? c[2](row) : row[c[0]] }); }));
							}))));
			}
			return h("div", { className: "kb-analytics" },
				h("div", { className: "kb-analytics-kpis" },
					h(Kpi, { tone: "kb-tone-ok", value: done, label: "Tickets done" }),
					h(Kpi, { tone: "kb-tone-run", value: avgAttempts, label: "Avg attempts" }),
					h(Kpi, { tone: "kb-tone-violet", value: modelCount, label: "Models tracked" }),
					h(Kpi, { tone: "kb-tone-idle", value: fmtCost(totalCost, false), label: "Recorded spend" })
				),
				h("div", { className: "kb-analytics-grid" },
					table("Attempts to done", a.attemptsToDone, [["attempts", "attempts"], ["tickets", "tickets", function (r) { return h("span", { className: "kb-big-num", children: r.tickets }); }]], "kb-tone-run"),
					table("Model success rate", a.modelSuccessRate, [["provider", "provider"], ["model", "model"], ["tickets", "tickets"], ["rate", "success", function (r) { return pctBar(r.rate); }]], "kb-tone-violet"),
					table("Confidence calibration", a.calibration, [["verdict", "verdict"], ["confidence", "bucket"], ["n", "n"], ["done", "done", function (r) { return h("span", { className: "kb-big-num", children: r.done }); }]], "kb-tone-ok"),
					table("Time in phase", a.timeInPhase, [["phase", "phase"], ["transitions", "runs"], ["avgMs", "avg time", function (r) { return h("span", { className: "kb-time", children: fmtDur(r.avgMs) }); }]], "kb-tone-warn"),
					table("Cost per ticket", a.costPerTicket, [["key", "ticket"], ["inputTokens", "in", function (r) { return fmtTokens(r.inputTokens); }], ["outputTokens", "out", function (r) { return fmtTokens(r.outputTokens); }], ["costUsd", "cost", function (r) { return fmtCost(r.costUsd, r.unpricedRows > 0); }]], "kb-tone-idle"),
					table("Stall rate by role", a.stallRate, [["role", "role"], ["spans", "runs"], ["abandoned", "abandoned"], ["rate", "stalled", function (r) { return pctBar(r.rate); }]], "kb-tone-err")
				)
			);
		}

		// ------------------------------------------------------------------ page

		function Kpi(props) {
			return h("div", { className: "kb-kpi " + props.tone },
				h("div", { className: "kb-kpi-value", children: props.value }),
				h("div", { className: "kb-kpi-label", children: props.label })
			);
		}

		function RoleRouting(props) {
			var routes = props.routes || {};
			var roles = props.roles || {};
			var labels = { planner: "Plan", implementer: "Build", reviewer: "Review", approver: "Approval" };
			var order = ["planner", "implementer", "reviewer", "approver"];
			return h("div", { className: "kb-routing" },
				h("div", { className: "kb-routing-sub", children: props.editing ? "Choose a model for each role. Models are grouped by provider; saving writes the kanban row in the profile config." : "Base route per role. The escalation ladder can override this for later attempts." }),
				h("div", { className: "kb-route-rows" }, order.map(function (role) {
					var route = routes[role] || {};
					var config = roles[role] || {};
					var isFallback = config.provider === null || config.provider === undefined || config.model === null || config.model === undefined;
					if (props.editing) {
						var entry = props.draft[role] || { provider: route.provider || "", model: route.model || "" };
						var groups = props.groups || [];
						var current = entry.provider + "\u0000" + entry.model;
						var known = groups.some(function (group) { return group.id === entry.provider && group.models.some(function (model) { return model.id === entry.model; }); });
						return h("div", { className: "kb-route-row kb-route-edit kb-route-" + role, key: role },
							h("div", { className: "kb-route-label" }, h("b", { children: labels[role] }), h("span", { children: role })),
							h("select", { className: "kb-select kb-route-picker", value: current, onChange: function (event) {
								var parts = event.target.value.split("\u0000");
								props.onDraft(role, { provider: parts[0] || "", model: parts[1] || "" });
							} },
								known ? null : h("option", { value: current, children: (entry.provider || "?") + " / " + (entry.model || "?") + " (not in catalog)" }),
								groups.map(function (group) {
									return h("optgroup", { key: group.id, label: group.id },
										group.models.map(function (model) { return h("option", { key: model.id, value: group.id + "\u0000" + model.id, children: model.name || model.id }); }));
								})
							)
						);
					}
					return h("div", { className: "kb-route-row kb-route-" + role, key: role },
						h("div", { className: "kb-route-label" }, h("b", { children: labels[role] }), h("span", { children: role })),
						h("div", { className: "kb-route-value" }, h("b", { children: route.provider || "?" }), h("span", { children: "/" + (route.model || "?") })),
						h("div", { className: "kb-route-effort" },
							h("span", { children: route.reasoningEffort || "default effort" }),
							isFallback ? h("span", { className: "kb-route-default", children: "deployment default" }) : null)
					);
				})),
				props.editing ? h("div", { className: "kb-routing-editfoot" },
					props.error ? h("div", { className: "kb-err", children: props.error }) : null,
					h("button", { className: "kb-btn primary", disabled: props.saving, onClick: props.onSave, children: props.saving ? "Saving…" : "Save routing" }),
					h("button", { className: "kb-btn", onClick: props.onCancel, children: "Cancel" })) : null
			);
		}

		function KanbanPage() {
			var b = React.useState(null);
			var board = b[0], setBoard = b[1];
			var sel = React.useState(null);
			var selectedId = sel[0], setSelectedId = sel[1];
			var det = React.useState(null);
			var detail = det[0], setDetail = det[1];
			var n = React.useState(null);
			var notice = n[0], setNotice = n[1];
			var c = React.useState(false);
			var creating = c[0], setCreating = c[1];
			var v = React.useState("board");
			var view = v[0], setView = v[1];
			var analytics = React.useState(null);
			var analyticsData = analytics[0], setAnalyticsData = analytics[1];
			var ws = React.useState([]);
			var workspaces = ws[0], setWorkspaces = ws[1];
			var cap = React.useState({ worktree: false });
			var capabilities = cap[0], setCapabilities = cap[1];
			var rc = React.useState(null);
			var routing = rc[0], setRouting = rc[1];
			var ro = React.useState(false);
			var routingOpen = ro[0], setRoutingOpen = ro[1];
			var re = React.useState(false);
			var routingEditing = re[0], setRoutingEditing = re[1];
			var rd = React.useState({});
			var routingDraft = rd[0], setRoutingDraft = rd[1];
			var rsv = React.useState(false);
			var routingSaving = rsv[0], setRoutingSaving = rsv[1];
			var rerr = React.useState(null);
			var routingError = rerr[0], setRoutingError = rerr[1];
			var dr = React.useState(null);
			var dragId = dr[0], setDragId = dr[1];
			var dp = React.useState(null);
			var dropTarget = dp[0], setDropTarget = dp[1];
			var poll = React.useRef(0);
			var knownPlanSessions = React.useRef(new Set());
			var planSeen = React.useRef(false);

			function loadBoard() {
				rpc("board", {}).then(function (res) {
					if (res && res.ok) setBoard(res.value);
					else if (res && res.error) setNotice(res.error.message);
				}, function () { setNotice("Could not reach the Host."); });
			}
			function loadDetail(id) {
				rpc("ticket", { id: id }).then(function (res) {
					if (res && res.ok) setDetail(res.value);
					else if (res && res.error) { setNotice(res.error.message); }
				});
			}
			React.useEffect(function () {
				rpc("workspaces", {}).then(function (res) { if (res && res.ok && res.value) setWorkspaces(res.value.items || []); });
				rpc("capabilities", {}).then(function (res) { if (res && res.ok && res.value) setCapabilities(res.value); });
				function loadRouting() { rpc("config", {}).then(function (res) { if (res && res.ok && res.value) setRouting(res.value); }); }
				loadRouting();
				var routingTimer = setInterval(loadRouting, 15000);
				loadBoard();
				var timer = setInterval(function () {
					poll.current += 1;
					loadBoard();
					if (selectedId) loadDetail(selectedId);
				}, 3000);
				return function () { clearInterval(timer); clearInterval(routingTimer); };
			}, [selectedId]);
			React.useEffect(function () {
				if (!board) return;
				var columns = board.columns || {};
				var tickets = [].concat(columns.working || [], columns.backlog || []);
				var initial = !planSeen.current;
				planSeen.current = true;
				for (var i = 0; i < tickets.length; i += 1) {
					var ticket = tickets[i];
					if (ticket.phase !== "plan" || !ticket.planSessionId) continue;
					var key = ticket.id + ":" + ticket.planSessionId;
					if (initial) { knownPlanSessions.current.add(key); continue; }
					if (knownPlanSessions.current.has(key)) continue;
					knownPlanSessions.current.add(key);
					if (!autoOpenedSessions.has(ticket.id)) {
						autoOpenedSessions.add(ticket.id);
						if (openSessionById) openSessionById(ticket.planSessionId);
						break;
					}
				}
			}, [board]);
			React.useEffect(function () {
				if (view === "analytics" && analyticsData === null) {
					rpc("analytics", {}).then(function (res) { if (res && res.ok) setAnalyticsData(res.value); });
				}
			}, [view, analyticsData]);

			function act(method, payload) {
				return rpc(method, payload).then(function (res) {
					if (res && res.ok) {
						setNotice(null);
						loadBoard();
						if (selectedId) loadDetail(selectedId);
					} else {
						setNotice(res && res.error ? res.error.message : "That did not work.");
					}
					return res;
				}, function () { setNotice("Could not reach the Host."); });
			}

			var columns = board ? board.columns : { backlog: [], working: [], done: [], discarded: [] };
			var allTickets = Object.keys(columns).reduce(function (list, column) { return list.concat(columns[column] || []); }, []);
			var dragTicket = dragId === null ? null : allTickets.find(function (ticket) { return ticket.id === dragId; }) || null;
			return h("div", { className: "kb-root" },
				h("div", { className: "kb-pagehead" },
					h("div", { className: "kb-pagehead-main" },
						h("h1", { className: "kb-title", children: "Work" }),
						h("div", { className: "kb-sub", children: board ? "Ticket flow from plan to approval · sequential workflow sessions" : "Loading the board…" })
					),
					h("div", { className: "kb-actions" },
						h("button", { className: "kb-btn" + (view === "board" ? " primary" : ""), onClick: function () { setView("board"); setSelectedId(null); }, children: "Board" }),
						h("button", { className: "kb-btn" + (view === "analytics" ? " primary" : ""), onClick: function () { setView("analytics"); }, children: "Analytics" }),
						h("button", { className: "kb-btn", onClick: function () { setRoutingOpen(true); }, children: "Model routing" }),
						h("button", { className: "kb-btn", onClick: function () { loadBoard(); }, children: "Refresh" }),
						h("button", { className: "kb-btn primary", onClick: function () { setCreating(true); setSelectedId(null); setView("board"); }, children: "+ New ticket" })
					)
				),
				h("div", { className: "kb-body" },
					notice ? h("div", { className: "kb-notice" }, notice) : null,
					h(Modal, { open: creating, title: "New ticket", onClose: function () { setCreating(false); } }, h(CreateForm, { workspaces: workspaces, worktreeAvailable: Boolean(capabilities.worktree), onClose: function () { setCreating(false); }, onCreated: function (ticket) { setCreating(false); setSelectedId(ticket.id); loadBoard(); loadDetail(ticket.id); } })),
					selectedId ? h(TicketDetail, {
						detail: detail,
						onBack: function () { setSelectedId(null); setDetail(null); },
						onSave: function (id, patch) { act("update", { id: id, patch: patch }); },
						onResolve: function (id, action, instruction) { return act("resolve", { id: id, action: action, instruction: instruction }); },
						onAcceptance: function (id, statement) { return act("action", { id: id, action: "addAcceptance", statement: statement }); },
						onAction: function (id, action, extra) { return act("action", Object.assign({ id: id, action: action }, extra || {})); },
						onApprove: function (id) { return act("action", { id: id, action: "approve" }); },
						onApprovalSession: function (id) { return act("action", { id: id, action: "approvalSession" }).then(function (res) { if (res && res.ok && res.value && res.value.sessionId && openSessionById) openSessionById(res.value.sessionId); }); },
						onRecover: function (sessionId) { return act("action", { id: selectedId, action: "recoverSession", sessionId: sessionId }); }
					}) : view === "analytics" ? h("div", { style: { maxWidth: 900 } }, h(AnalyticsPanel, { data: analyticsData })) : h("div", null,
						h("div", { className: "kb-cols" },
							h(Column, { column: "backlog", label: "Backlog", items: columns.backlog, onOpen: open, onMove: move, onReorder: reorder, dragId: dragId, dragTicket: dragTicket, dropTarget: dropTarget, onDragStart: startDrag, onDragEnd: finishDrag, onDragOverColumn: dragOverColumn, onDragOverCard: dragOverCard, onDropCard: dropCard }),
							h(Column, { column: "working", label: "Working", items: columns.working, onOpen: open, onMove: move, onReorder: reorder, dragId: dragId, dragTicket: dragTicket, dropTarget: dropTarget, onDragStart: startDrag, onDragEnd: finishDrag, onDragOverColumn: dragOverColumn, onDragOverCard: dragOverCard, onDropCard: dropCard }),
							h(Column, { column: "done", label: "Done / Discarded", items: columns.done.concat(columns.discarded), onOpen: open, onMove: move, onReorder: reorder, dragId: dragId, dragTicket: dragTicket, dropTarget: dropTarget, onDragStart: startDrag, onDragEnd: finishDrag, onDragOverColumn: dragOverColumn, onDragOverCard: dragOverCard, onDropCard: dropCard })
						)
					)
				),
				h(Modal, { open: routingOpen, title: "Model routing", onClose: function () { setRoutingOpen(false); setRoutingEditing(false); setRoutingError(null); },
					actions: routing && routing.writable !== false && !routingEditing ? h("button", { className: "kb-iconbtn", title: "Edit routing", "aria-label": "Edit routing", onClick: startRoutingEdit }, h(PencilIcon)) : null },
					routing ? h(RoleRouting, {
						routes: routing.routes,
						roles: routing.roles,
						groups: routing.groups,
						editing: routingEditing,
						draft: routingDraft,
						saving: routingSaving,
						error: routingError,
						onDraft: updateRoutingDraft,
						onSave: saveRouting,
						onCancel: cancelRoutingEdit
					}) : h("div", { className: "kb-hint", children: "Loading routing…" }))
			);

			function startRoutingEdit() {
				if (!routing || routing.writable === false) return;
				var draft = {};
				["planner", "implementer", "reviewer", "approver"].forEach(function (role) {
					var route = (routing.routes || {})[role] || {};
					draft[role] = { provider: route.provider || "", model: route.model || "" };
				});
				setRoutingDraft(draft);
				setRoutingError(null);
				setRoutingEditing(true);
			}
			function updateRoutingDraft(role, patch) {
				var next = Object.assign({}, routingDraft);
				next[role] = Object.assign({}, next[role], patch);
				setRoutingDraft(next);
			}
			function cancelRoutingEdit() {
				setRoutingEditing(false);
				setRoutingError(null);
			}
			function saveRouting() {
				if (!routing) return;
				var roles = ["planner", "implementer", "reviewer", "approver"];
				var routes = roles.map(function (role) { return { role: role, provider: routingDraft[role].provider, model: routingDraft[role].model }; });
				setRoutingSaving(true);
				setRoutingError(null);
				rpc("setRoutes", { routes: routes, revision: routing.revision }).then(function (res) {
					if (res && res.ok) {
						var nextRoutes = Object.assign({}, routing.routes);
						routes.forEach(function (route) { nextRoutes[route.role] = Object.assign({}, nextRoutes[route.role] || {}, { provider: route.provider, model: route.model }); });
						setRouting(Object.assign({}, routing, { routes: nextRoutes }));
						setRoutingEditing(false);
						setTimeout(function () { rpc("config", {}).then(function (next) { if (next && next.ok) setRouting(next.value); }); }, 6000);
					} else {
						setRoutingError(res && res.error ? res.error.message : "Could not save routing.");
					}
				}, function () { setRoutingError("Could not reach the Host."); }).finally(function () { setRoutingSaving(false); });
			}
			function open(id) { setSelectedId(id); loadDetail(id); }
			function move(id, column) {
				if (column === "done") return;
				act("move", { id: id, column: column });
			}
			function reorder(id, beforeId) {
				if (id === beforeId) return;
				act("reorder", { id: id, beforeId: beforeId });
			}
			function startDrag(id) {
				setDragId(id);
				setDropTarget(null);
			}
			function finishDrag() {
				setDragId(null);
				setDropTarget(null);
			}
			function dragOverColumn(column) {
				if (dragId === null || column === "done") return;
				setDropTarget({ column: column, beforeId: null });
			}
			function dragOverCard(column, beforeId) {
				if (dragId === null || column === "done") return;
				setDropTarget({ column: column, beforeId: beforeId });
			}
			function dropCard(id, column, beforeId) {
				if (column === "done") { finishDrag(); return; }
				var source = allTickets.find(function (ticket) { return ticket.id === id; });
				finishDrag();
				if (source === undefined) return;
				if (source.column === column) {
					reorder(id, beforeId);
					return;
				}
				act("move", { id: id, column: column }).then(function (res) {
					if (res && res.ok && beforeId) reorder(id, beforeId);
				});
			}
		}

		// ------------------------------------------------------------------ apply

		function apply(ctx) {
			connection = ctx.connection !== undefined ? ctx.connection : ctx.get ? ctx.get("connection") : null;
			openSessionById = function (sessionId) {
				try {
					var uiWorkspace = ctx.get("uiWorkspace");
					if (uiWorkspace && typeof uiWorkspace.openSession === "function") { uiWorkspace.openSession(sessionId); return true; }
				} catch (error) { /* best-effort navigation */ }
				return false;
			};
			var slots = ctx.slots !== undefined ? ctx.slots : ctx.get ? ctx.get("slots") : undefined;
			if (!slots) {
				console.error("dsh-kanban: slots service missing - the board stays off");
				return;
			}
			ensureStyles();
			ctx.effect(function () {
				return slots.inject("sidebar.panellist", function () {
					return slots.register(
						{ name: "sidebar.panellist", id: "kanban", order: 20, label: function () { return "Kanban"; } },
						KanbanIcon
					);
				});
			}, "dsh-kanban: sidebar panel");
			ctx.effect(function () {
				return slots.inject("main", function () {
					return slots.register({ name: "main", key: "kanban" }, KanbanPage);
				});
			}, "dsh-kanban: board page");
		}

		exports.apply = apply;
		exports.inject = ["connection", "slots"];
		return module.exports;
	}
});
