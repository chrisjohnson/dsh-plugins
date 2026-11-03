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
		// kanban-goBoardRequest: set by the mounted KanbanPage to its own "back to
		// the Board" reset — exactly what the top Board button does. The sidebar
		// panel row lives outside this component, so the click bridge in apply()
		// reaches the live state through this module-scope callback, not a prop.
		var goBoardRequest = null;
		var rpcSeq = 0;

		function rpc(method, payload) {
			if (!connection) return Promise.reject(new Error("dsh-kanban: connection service unavailable"));
			return connection.rpc.call("/api", "kanban/" + method, payload || {});
		}

		// For controls with no room to print a message (the card's jump icon, the
		// progress steps): a failed open is still said out loud, never swallowed.
		function openOrComplain(sessionId) {
			var opening = openSessionById ? openSessionById(sessionId) : Promise.resolve({ ok: false, error: "The session view is not available in this window." });
			opening.then(function (result) { if (!result || !result.ok) window.alert((result && result.error) || "The session could not be opened."); });
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
			var hours = Math.floor(m / 60);
				if (hours < 24) return hours + "h " + (m % 60) + "m";
				// A day or more: hours stay for the first day ("1d2h"), then only
				// whole days ("3d") - minutes stop being information at that scale.
				var days = Math.floor(hours / 24);
				if (days >= 2) return days + "d";
				return hours % 24 === 0 ? days + "d" : days + "d" + (hours % 24) + "h";
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
		+ ".kb-list{display:flex;flex-direction:column;gap:7px;padding:0 8px 9px}"
		+ ".kb-card{border:.5px solid var(--dsw-alias-border-l1,#ddd);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-base,#fff);padding:8px 9px;cursor:pointer;display:flex;flex-direction:column;gap:5px}"
		+ ".kb-card:hover{border-color:var(--dsw-alias-label-tertiary,#999)}"
		+ ".kb-card.dragging{opacity:.4}.kb-drop-line{position:relative;height:0;margin-top:-8px;pointer-events:none;z-index:3}.kb-drop-line::before{content:'';position:absolute;left:2px;right:2px;top:-2px;height:4px;border-radius:2px;background:var(--dsw-alias-state-business-primary,#2563eb);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 22%,transparent)}"
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
		+ ".kb-open-error{margin-left:8px;color:#9b1c1c;font:500 12px/18px var(--dsw-font-family,sans-serif)}"
		+ ".kb-banner-line{padding:8px 12px;border-radius:var(--dsw-radius-md,12px);font-size:13px;line-height:20px;margin-bottom:10px;border:.5px solid transparent}"
		+ ".kb-banner-line.err{background:#fdecea;border-color:#f3b3ac;color:#9b1c1c}.kb-banner-line.run{background:#eaf2ff;border-color:#b9d0f5;color:#1d4f9b}.kb-banner-line.ok{background:#e8f6ec;border-color:#a8d8b5;color:#1d6b32}"
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
		+ ".kb-col{--kb-accent:#64748b;position:relative;overflow:hidden;border:1px solid color-mix(in srgb,var(--kb-accent) 18%,var(--dsw-alias-border-l2,#e5e7eb));border-radius:var(--dsw-radius-lg,16px);background:color-mix(in srgb,var(--kb-accent) 4%,var(--dsw-alias-bg-layer-2,#f7f8fa));padding-top:3px;max-height:none}"
		+ ".kb-col::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--kb-accent),color-mix(in srgb,var(--kb-accent) 35%,transparent))}"
		+ ".kb-colhead{padding:9px 12px 7px;color:var(--dsw-alias-label-secondary,#555);background:transparent;border-radius:var(--dsw-radius-md,12px) var(--dsw-radius-md,12px) 0 0}"
		+ ".kb-coldot{width:7px;height:7px;border-radius:50%;background:var(--kb-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--kb-accent) 14%,transparent);flex:none}"
		+ ".kb-collabel{font:600 11px/16px var(--dsw-font-family,sans-serif);letter-spacing:.06em;text-transform:uppercase}"
		+ ".kb-col-pinned{position:sticky;top:0;height:var(--kb-pin-h,calc(100vh - 220px));max-height:none}.kb-col-pinned .kb-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}.kb-count{margin-left:auto;min-width:20px;height:18px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--kb-accent) 11%,transparent);color:var(--kb-accent);font:600 11px/18px ui-monospace,monospace;text-align:center}"
		+ ".kb-list{gap:8px;padding:0 9px 11px}"
		+ ".kb-card{border:1px solid var(--dsw-alias-border-l2,#e2e6ea);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#fff);padding:9px 10px;gap:6px;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease;position:relative;overflow:hidden;flex:none}"
		+ ".kb-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--kb-accent,#3b82f6) 45%,var(--dsw-alias-border-l2,#e2e6ea));box-shadow:0 8px 22px color-mix(in srgb,var(--kb-accent,#3b82f6) 13%,transparent)}"
		+ ".kb-card.active{border-color:color-mix(in srgb,#2563eb 42%,var(--dsw-alias-border-l2,#e2e6ea));background:linear-gradient(135deg,color-mix(in srgb,#2563eb 5%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff));animation:kb-glow-blue 3.2s ease-in-out infinite}"
		+ ".kb-card.active::before{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:linear-gradient(180deg,#2563eb,#06b6d4);pointer-events:none}"
		+ ".kb-card.attention{border-color:color-mix(in srgb,#b91c1c 45%,var(--dsw-alias-border-l2,#e2e6ea));background:color-mix(in srgb,#b91c1c 6%,var(--dsw-alias-bg-layer-1,#fff))}"
		+ ".kb-card.attention::before{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:#b91c1c;pointer-events:none}.kb-card.active,.kb-card.attention{padding-left:15px}"
		+ ".kb-cardtop{display:flex;align-items:center;gap:7px}"
		+ ".kb-key{font:600 11px/15px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888);letter-spacing:.02em}"
		+ ".kb-statusdot{width:8px;height:8px;border-radius:50%;background:#94a3b8;flex:none}"
		+ ".kb-statusdot.active{background:#2563eb;animation:kb-pulse 1.8s ease-out infinite}"
		+ ".kb-statusdot.attention{background:#b91c1c}"
		+ ".kb-phasechip{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;border:1px solid color-mix(in srgb,var(--kb-accent,#64748b) 30%,transparent);background:color-mix(in srgb,var(--kb-accent,#64748b) 9%,transparent);color:var(--kb-accent,#475569);font:600 11px/15px var(--dsw-font-family,sans-serif);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}"
		+ ".kb-phasechip.plan{--kb-accent:#2563eb}.kb-phasechip.build{--kb-accent:#0d9488}.kb-phasechip.review{--kb-accent:#db2777}.kb-phasechip.approval{--kb-accent:#7c3aed}.kb-phasechip.done{--kb-accent:#15803d}.kb-phasechip.discarded{--kb-accent:#64748b}"
		+ ".kb-cardtitle{font:600 13px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-primary,#111);-webkit-line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}"
		+ ".kb-steps{display:flex;gap:3px;margin:1px 0 2px}"
		+ ".kb-step{--kb-step-color:#64748b;height:4px;flex:1;border-radius:3px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#94a3b8) 24%,transparent)}"
		+ ".kb-step-intake{--kb-step-color:#64748b}.kb-step-grill{--kb-step-color:#d97706}.kb-step-plan{--kb-step-color:#2563eb}.kb-step-implement{--kb-step-color:#0d9488}.kb-step-verify{--kb-step-color:#7c3aed}.kb-step-review{--kb-step-color:#db2777}.kb-step-closed{--kb-step-color:#15803d}"
		+ ".kb-step.done{background:var(--kb-step-color);opacity:.72}.kb-step.todo{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#94a3b8) 24%,transparent)}"
		+ ".kb-step.current{background:var(--kb-step-color);box-shadow:0 0 0 1px color-mix(in srgb,var(--kb-step-color) 45%,transparent)}"
		+ ".kb-meta{gap:5px;font:500 11px/15px var(--dsw-font-family,sans-serif);align-items:center}"
		+ ".kb-next{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--kb-accent,#64748b) 9%,transparent);color:var(--kb-accent,#475569);font-weight:600;white-space:nowrap}"
		+ ".kb-next.run{--kb-accent:#2563eb}.kb-next.err{--kb-accent:#b91c1c}.kb-next.idle{--kb-accent:#64748b}"
		+ ".kb-cardfoot{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-top:1px;min-height:20px}.kb-worktime{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary,#555);font:600 11px/15px var(--dsw-font-family,sans-serif);font-variant-numeric:tabular-nums;white-space:nowrap}.kb-created{color:var(--dsw-alias-label-tertiary,#999);font:500 11px/15px var(--dsw-font-family,sans-serif);font-variant-numeric:tabular-nums;white-space:nowrap}.kb-attempt{color:var(--dsw-alias-label-secondary,#555);font-style:italic;white-space:nowrap}.kb-iconbtn.sm{width:22px;height:22px;border-radius:6px}.kb-jump{border-color:transparent;background:transparent}.kb-jump:hover{border-color:var(--dsw-alias-border-l3,#cbd2da)}"
		+ ".kb-planbtn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border:.5px solid color-mix(in srgb,#2563eb 38%,transparent);border-radius:999px;background:color-mix(in srgb,#2563eb 8%,var(--dsw-alias-bg-base,#fff));color:#2563eb;font:600 11px/16px var(--dsw-font-family,sans-serif);cursor:pointer;white-space:nowrap}"
		+ ".kb-buildbtn{--kb-build:#0d9488;border-color:color-mix(in srgb,#0d9488 38%,transparent);background:color-mix(in srgb,#0d9488 8%,var(--dsw-alias-bg-base,#fff));color:#0d9488}.kb-buildbtn:hover{background:color-mix(in srgb,#0d9488 16%,var(--dsw-alias-bg-base,#fff))!important;border-color:#0d9488!important}.kb-planbtn:hover{background:color-mix(in srgb,#2563eb 16%,var(--dsw-alias-bg-base,#fff));border-color:#2563eb}"
		+ ".kb-empty{padding:20px 10px;border:1px dashed color-mix(in srgb,var(--kb-accent,#888) 22%,transparent);border-radius:var(--dsw-radius-md,12px);background:transparent;font-size:11px;line-height:16px}"
		+ ".kb-detail{display:grid;gap:12px 20px;max-width:1680px;grid-template-columns:minmax(0,4fr) minmax(220px,1fr);grid-template-areas:'head side' 'main side';align-items:start}.kb-detail-head{grid-area:head;display:flex;flex-direction:column;gap:12px;min-width:0}.kb-detail-main{grid-area:main;display:flex;flex-direction:column;gap:12px;min-width:0}.kb-detail-side{grid-area:side;min-width:0;position:sticky;top:0;align-self:start}.kb-side-panel{padding:12px 14px}.kb-side-list{margin:0;display:flex;flex-direction:column;gap:9px}.kb-side-row{min-width:0}.kb-side-row dt{font:600 10px/14px var(--dsw-font-family,sans-serif);letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#888)}.kb-side-row dd{margin:1px 0 0;font:400 13px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-primary,#111);overflow-wrap:anywhere}@media (max-width:900px){.kb-detail{grid-template-columns:minmax(0,1fr);grid-template-areas:'head' 'side' 'main'}.kb-detail-side{position:static}.kb-side-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:9px 14px}}"
		+ ".kb-hero{--kb-accent:#2563eb;position:relative;overflow:hidden;border:1px solid color-mix(in srgb,var(--kb-accent) 22%,var(--dsw-alias-border-l2,#e5e7eb));border-radius:var(--dsw-radius-lg,16px);background:linear-gradient(135deg,color-mix(in srgb,var(--kb-accent) 7%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff));padding:14px 16px;box-shadow:0 10px 30px rgba(15,23,42,.04)}"
		+ ".kb-hero::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--kb-accent),color-mix(in srgb,var(--kb-accent) 35%,transparent))}"
		+ ".kb-hero-backlog{--kb-accent:#64748b}.kb-hero-working{--kb-accent:#64748b}.kb-hero-discarded{--kb-accent:#64748b}.kb-hero-done{--kb-accent:#15803d}.kb-hero-attention{--kb-accent:#b91c1c}"
		+ ".kb-hero-top{display:flex;align-items:center;gap:9px;flex-wrap:wrap}"
		+ ".kb-hero-title{margin:8px 0 3px;font:500 18px/25px var(--dsw-font-family,sans-serif);letter-spacing:-.01em}"
		+ ".kb-lifecycle{display:flex;align-items:center;gap:4px;margin-top:12px;flex-wrap:wrap}"
		+ ".kb-life{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary,#999);font:500 11px/16px var(--dsw-font-family,sans-serif)}"
		+ ".kb-life.link{appearance:none;background:none;border:0;padding:2px 8px;margin:0 -4px;border-radius:999px;cursor:pointer}.kb-life.link:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}.kb-life.link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#3b82f6)}.kb-life.link .kb-life-label{text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:3px}.kb-life+.kb-life::before{content:'';width:14px;height:1px;background:var(--dsw-alias-border-l2,#ddd);margin-right:1px}"
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
		+ ".kb-edit-lock{display:inline-flex}"
		+ ".kb-iconbtn:disabled{opacity:.45;cursor:not-allowed}"
		+ ".kb-iconbtn:disabled:hover{color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-bg-layer-2,#f4f6f8)}"
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
		+ ".kb-route-edit{grid-template-columns:minmax(100px,135px) minmax(0,1fr) minmax(110px,150px);background:color-mix(in srgb,var(--kb-route-color) 3%,var(--dsw-alias-bg-layer-1,#fff))}"
		+ ".kb-route-picker{width:100%;min-width:0}"
		+ ".kb-route-effort-picker{width:100%;min-width:0;font:400 12px/18px var(--dsw-font-family,sans-serif)}"
		+ ".kb-route-label{display:flex;flex-direction:column;min-width:0}"
		+ ".kb-route-label b{font:600 11px/15px var(--dsw-font-family,sans-serif);color:var(--kb-route-color)}"
		+ ".kb-route-label span{font:400 10px/13px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#999)}"
		+ ".kb-route-value{display:flex;flex-direction:column;min-width:0;line-height:1.25}"
		+ ".kb-route-value b{font:600 11px/14px ui-monospace,monospace;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
		+ ".kb-route-value span{font:400 11px/14px ui-monospace,monospace;color:var(--dsw-alias-label-primary,#222);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
		+ ".kb-route-effort{display:flex;flex-direction:column;align-items:flex-end;gap:1px;font:400 10px/13px var(--dsw-font-family,sans-serif);text-align:right;color:var(--dsw-alias-label-tertiary,#888)}"
		+ ".kb-routing-editfoot{display:flex;align-items:center;gap:8px;margin-top:10px}"
		+ ".kb-routing-editfoot .kb-err{flex:1}"
		+ "@media (max-width:560px){.kb-route-row,.kb-route-edit{grid-template-columns:100px minmax(0,1fr);gap:6px}.kb-route-edit{grid-template-columns:88px minmax(0,1fr) minmax(84px,104px)}.kb-route-effort{align-items:flex-start;text-align:left}.kb-route-effort-picker{height:28px;font:400 11px/16px var(--dsw-font-family,sans-serif)}}"
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
		+ ".kb-banner{display:flex;align-items:center;gap:7px;box-sizing:border-box;min-width:0;max-width:640px;margin:2px 0 0;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#e2e6ea);background:var(--dsw-alias-bg-layer-2,#f7f8fa);font:500 12px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-secondary,#555)}"
		+ ".kb-banner::before{content:'';flex:none;width:6px;height:6px;border-radius:50%;background:#94a3b8}"
		+ ".kb-banner-text{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
		+ ".kb-banner.plan{border-color:color-mix(in srgb,#2563eb 30%,var(--dsw-alias-border-l2,#e2e6ea));background:color-mix(in srgb,#2563eb 5%,var(--dsw-alias-bg-layer-1,#fff))}"
		+ ".kb-banner.plan::before{background:#2563eb}"
		+ ".kb-banner.build{border-color:color-mix(in srgb,#0d9488 30%,var(--dsw-alias-border-l2,#e2e6ea));background:color-mix(in srgb,#0d9488 5%,var(--dsw-alias-bg-layer-1,#fff))}"
		+ ".kb-banner.build::before{background:#0d9488}"
		+ ".kb-banner.ok{border-color:color-mix(in srgb,#15803d 30%,var(--dsw-alias-border-l2,#e2e6ea));background:color-mix(in srgb,#15803d 5%,var(--dsw-alias-bg-layer-1,#fff))}"
		+ ".kb-banner.ok::before{background:#15803d}"
		+ ".kb-banner.warn{border-color:color-mix(in srgb,#b91c1c 30%,var(--dsw-alias-border-l2,#e2e6ea));background:color-mix(in srgb,#b91c1c 5%,var(--dsw-alias-bg-layer-1,#fff))}"
		+ ".kb-banner.warn::before{background:#b91c1c}"
		+ "@keyframes kb-pulse{0%{box-shadow:0 0 0 0 rgba(37,99,235,.5)}70%{box-shadow:0 0 0 6px rgba(37,99,235,0)}100%{box-shadow:0 0 0 0 rgba(37,99,235,0)}}"
		+ "@keyframes kb-glow-blue{0%,100%{box-shadow:0 0 0 1px rgba(37,99,235,.08),0 4px 16px rgba(37,99,235,.05)}50%{box-shadow:0 0 0 1.5px rgba(37,99,235,.32),0 8px 28px rgba(37,99,235,.15)}}"
		+ "@media (prefers-reduced-motion:reduce){.kb-card.active,.kb-statusdot.active,.kb-life.active .kb-life-dot,.kb-seg-indicator,.kb-seg-tab,.kb-switch-thumb{animation:none;transition:none}}"
		+ "@media (max-width:900px){.kb-analytics-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}"
		+ ".kb-img-row{display:flex;align-items:center;gap:8px;margin:4px 0 2px}"
		+ ".kb-img-rail{display:flex;flex-wrap:wrap;gap:8px;margin:8px 2px 6px;padding:0 6px}"
		+ ".kb-img-tile{position:relative;width:56px;height:56px;border:.5px solid var(--dsw-alias-border-l2,#d8d8d8);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,#f2f2f2)}"
		+ ".kb-img-tile img{width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit}"
		+ ".kb-img-x{position:absolute;top:-7px;right:-7px;z-index:1;width:18px;height:18px;padding:0;border:1.5px solid var(--dsw-alias-bg-base,#fff);border-radius:999px;background:rgba(17,17,17,.78);color:#fff;font:600 11px/15px var(--dsw-font-family,sans-serif);text-align:center;cursor:pointer;opacity:0;transition:opacity .12s ease}"
		+ ".kb-img-tile:hover .kb-img-x,.kb-img-tile:focus-within .kb-img-x{opacity:1}"
		+ ".kb-md{font:400 13px/20px var(--dsw-font-family,sans-serif);overflow-wrap:anywhere}"
		+ ".kb-md h1,.kb-md h2,.kb-md h3{font-size:15px;margin:10px 0 4px}"
		+ ".kb-md h4,.kb-md h5,.kb-md h6{font-size:13px;margin:8px 0 4px}"
		+ ".kb-md p{margin:0 0 8px}"
		+ ".kb-md ul,.kb-md ol{margin:0 0 8px;padding-left:20px}"
		+ ".kb-md code{font:400 12px/18px ui-monospace,SFMono-Regular,monospace;background:var(--dsw-alias-bg-layer-2,#f2f2f2);border-radius:4px;padding:0 4px}"
		+ ".kb-md pre{margin:0 0 8px;background:var(--dsw-alias-bg-layer-2,#f2f2f2);border:.5px solid var(--dsw-alias-border-l1,#e4e4e4);border-radius:var(--dsw-radius-sm,8px);padding:8px 10px;overflow:auto}"
		+ ".kb-md pre code{background:none;padding:0}"
		+ ".kb-md img{max-width:100%;max-height:360px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l1,#e4e4e4);display:block;margin:4px 0}"
		+ ".kb-img-broken{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#d8d8d8);background:var(--dsw-alias-bg-layer-2,#eee);color:var(--dsw-alias-label-tertiary,#888);font:500 11px/16px var(--dsw-font-family,sans-serif)}"
		+ "";

		function ensureStyles() {
			var id = "kanban-styles";
			var existing = document.getElementById(id);
			if (existing) {
				// A client half re-applied inside a live tab (reconnect after a
				// service restart, slot remount) must bring its own stylesheet up
				// to date. Returning early on an existing tag left the previous
				// release's CSS styling the new markup — the image tiles rendered
				// unstyled, at natural size, with the × below the image.
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return;
			}
			var tag = document.createElement("style");
			tag.id = id;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------------ icon

		// ---------------------------------------------------------------------
		// Live board.
		//
		// One shared store serves everything that shows the board (the sidebar
		// icon's badges and the page). It holds a single long-lived streaming
		// request to the Host while anything is subscribed and the tab is
		// visible, and nothing at all while the tab is hidden. The Host pushes a
		// frame only when the board changed; a frame that carries only a newer
		// token tells a page showing a ticket's detail to look again. If the
		// stream cannot be held (a proxy that buffers, an old Host) the store
		// falls back to asking `board` with the last token, which the Host
		// answers with a one-line "unchanged" when nothing moved, backing off
		// while that stays true, and retries the stream with back-off.
		// ---------------------------------------------------------------------

		var STREAM_URL = "/api/kanban/stream";
		var STALL_MS = 20000;
		var POLL_BASE_MS = 3000;
		var POLL_MAX_MS = 30000;
		var POLL_FAST_POLLS = 3;
		var RETRY_BASE_MS = 2000;
		var RETRY_MAX_MS = 30000;
		var CLOCK_MS = 3000;
		var BOARD_COLUMNS = ["backlog", "working", "done", "discarded"];

		// What a card says, with only the clock's contribution left out: a time
		// that is still growing is carried forward by the browser, not re-sent.
		function cardSignature(card) {
			return JSON.stringify(card, function (key, value) {
				if (key === "totalMs" || key === "readAt") return undefined;
				if (key === "workingMs" && this.accruing === true) return undefined;
				return value;
			});
		}

		var cardSignatures = new WeakMap();
		function signatureOf(card) {
			var known = cardSignatures.get(card);
			if (known === undefined) {
				known = cardSignature(card);
				cardSignatures.set(card, known);
			}
			return known;
		}

		// A compact board carries Done and Discarded once, in `closed`; the page
		// reads them per column as well.
		function expandBoard(raw) {
			if (!raw || raw.compact !== true) return raw;
			var closed = raw.closed || [];
			var columns = Object.assign({}, raw.columns);
			columns.done = closed.filter(function (card) { return card.column === "done"; });
			columns.discarded = closed.filter(function (card) { return card.column === "discarded"; });
			return Object.assign({}, raw, { columns: columns });
		}

		// Cards that say exactly what they said before keep their identity, and
		// so does a list of such cards: what did not change does not re-render.
		function reuseCards(previous, next, readAt) {
			var before = {};
			if (previous) {
				BOARD_COLUMNS.forEach(function (name) {
					((previous.columns || {})[name] || []).forEach(function (card) { before[card.id] = card; });
				});
			}
			function share(list, old) {
				var out = (list || []).map(function (card) {
					var prior = before[card.id];
					if (prior !== undefined && signatureOf(prior) === cardSignature(card)) return prior;
					card.readAt = readAt;
					return card;
				});
				if (old && old.length === out.length && out.every(function (card, i) { return card === old[i]; })) return old;
				return out;
			}
			var columns = {};
			BOARD_COLUMNS.forEach(function (name) {
				columns[name] = share(next.columns[name], previous && previous.columns ? previous.columns[name] : null);
			});
			return Object.assign({}, next, { columns: columns, closed: share(next.closed, previous ? previous.closed : null) });
		}

		function countBadges(board) {
			var inFlight = 0, attention = 0;
			if (board && board.columns) {
				BOARD_COLUMNS.forEach(function (name) {
					(board.columns[name] || []).forEach(function (ticket) {
						if (ticket.status === "active") inFlight += 1;
						else if (ticket.status === "attention") attention += 1;
					});
				});
			}
			return { inFlight: inFlight, attention: attention };
		}

		// How long to wait before the next fallback ask: the base for the first
		// few answers that said "unchanged", then doubling up to a ceiling. Any
		// change starts the count again.
		function pollDelay(unchangedRun) {
			if (unchangedRun <= POLL_FAST_POLLS) return POLL_BASE_MS;
			return Math.min(POLL_MAX_MS, POLL_BASE_MS * Math.pow(2, unchangedRun - POLL_FAST_POLLS));
		}

		function createBoardStore(env) {
			var listeners = new Set();
			var state = { board: null, token: null, seq: 0, boot: null, error: null, mode: "idle" };
			var controller = null;
			var pollTimer = null;
			var retryTimer = null;
			var stallTimer = null;
			var failures = 0;
			var unchangedRun = 0;
			var generation = 0;
			var held = 0;

			function emit() {
				Array.from(listeners).forEach(function (listener) { listener(); });
			}
			function set(patch) {
				state = Object.assign({}, state, patch);
				emit();
			}
			function hidden() {
				return !!(env.document && env.document.hidden);
			}
			function clearTimers() {
				if (pollTimer !== null) { env.clearTimeout(pollTimer); pollTimer = null; }
				if (retryTimer !== null) { env.clearTimeout(retryTimer); retryTimer = null; }
				if (stallTimer !== null) { env.clearTimeout(stallTimer); stallTimer = null; }
			}
			function abortStream() {
				if (controller !== null) { try { controller.abort(); } catch (e) { /* already closed */ } controller = null; }
			}
			function stopAll() {
				generation += 1;
				clearTimers();
				abortStream();
				state = Object.assign({}, state, { mode: "idle" });
			}
			// One board in. An answer older than what is shown (a frame built before
			// a write the page has already seen) is dropped, and nothing is applied
			// while a drop is still being written: the page asks again afterwards.
			function ingest(value) {
				if (!value) return false;
				var patch = {};
				if (typeof value.token === "string" && value.token !== state.token) patch.token = value.token;
				var fresh = value.boot !== state.boot || (typeof value.seq === "number" && value.seq > state.seq);
				if (value.columns && held === 0 && fresh) {
					var full = expandBoard(value);
					patch.board = reuseCards(state.board, full, env.now());
					patch.seq = value.seq;
					patch.boot = value.boot;
					patch.error = null;
				}
				if (Object.keys(patch).length === 0) return false;
				set(patch);
				return true;
			}
			function pollOnce() {
				pollTimer = null;
				var mine = generation;
				env.rpc("board", { compact: true, since: state.token || undefined }).then(function (res) {
					if (mine !== generation || state.mode !== "poll") return;
					var changed = false;
					if (res && res.ok && res.value) {
						if (!res.value.unchanged) changed = ingest(res.value);
						unchangedRun = changed ? 0 : unchangedRun + 1;
						if (state.error !== null) set({ error: null });
					} else if (res && res.error) {
						set({ error: res.error.message });
					}
					schedulePoll();
				}, function () {
					if (mine !== generation || state.mode !== "poll") return;
					set({ error: "Could not reach the Host." });
					unchangedRun += 1;
					schedulePoll();
				});
			}
			function schedulePoll() {
				if (state.mode !== "poll" || pollTimer !== null) return;
				pollTimer = env.setTimeout(pollOnce, pollDelay(unchangedRun));
			}
			function fallBack() {
				abortStream();
				if (stallTimer !== null) { env.clearTimeout(stallTimer); stallTimer = null; }
				failures += 1;
				if (state.mode !== "poll") {
					state = Object.assign({}, state, { mode: "poll" });
					unchangedRun = 0;
					pollOnce();
					emit();
				}
				if (retryTimer !== null) env.clearTimeout(retryTimer);
				var mine = generation;
				var delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.min(failures, 5)));
				retryTimer = env.setTimeout(function () {
					retryTimer = null;
					if (mine === generation && listeners.size > 0 && !hidden()) openStream();
				}, delay);
			}
			function armStall() {
				if (stallTimer !== null) env.clearTimeout(stallTimer);
				var mine = generation;
				stallTimer = env.setTimeout(function () {
					stallTimer = null;
					if (mine === generation) fallBack();
				}, STALL_MS);
			}
			function openStream() {
				if (typeof env.fetch !== "function" || typeof env.AbortController !== "function") { fallBack(); return; }
				var mine = generation;
				controller = new env.AbortController();
				var signal = controller.signal;
				armStall();
				env.fetch(STREAM_URL, {
					method: "POST", headers: { "content-type": "application/json" },
					credentials: "same-origin", body: "{}", signal: signal
				}).then(function (response) {
					if (!response.ok || !response.body || typeof response.body.getReader !== "function") throw new Error("stream unavailable");
					var reader = response.body.getReader();
					var decoder = new env.TextDecoder();
					var buffer = "";
					function pump() {
						return reader.read().then(function (chunk) {
							if (mine !== generation) return undefined;
							if (chunk.done) throw new Error("stream closed");
							armStall();
							buffer += decoder.decode(chunk.value, { stream: true });
							var cut;
							while ((cut = buffer.indexOf("\n")) >= 0) {
								var line = buffer.slice(0, cut);
								buffer = buffer.slice(cut + 1);
								if (line === "") continue;
								var frame;
								try { frame = JSON.parse(line); } catch (e) { continue; }
								if (pollTimer !== null) { env.clearTimeout(pollTimer); pollTimer = null; }
								if (retryTimer !== null) { env.clearTimeout(retryTimer); retryTimer = null; }
								failures = 0;
								if (state.mode !== "stream") set({ mode: "stream" });
								ingest(frame);
							}
							return pump();
						});
					}
					return pump();
				}).catch(function () {
					if (mine !== generation || signal.aborted) return;
					fallBack();
				});
			}
			function start() {
				if (listeners.size === 0 || hidden() || state.mode !== "idle") return;
				state = Object.assign({}, state, { mode: "stream" });
				failures = 0;
				openStream();
			}
			function onVisibility() {
				if (hidden()) stopAll();
				else start();
			}
			if (env.document && env.document.addEventListener) env.document.addEventListener("visibilitychange", onVisibility);
			return {
				subscribe: function (listener) {
					listeners.add(listener);
					start();
					return function () {
						listeners.delete(listener);
						if (listeners.size === 0) stopAll();
					};
				},
				get: function () { return state; },
				// Ask for the board now (after the page changed something, or on
				// request). The answer goes through the same stale-answer rule.
				refresh: function () {
					return env.rpc("board", { compact: true }).then(function (res) {
						if (res && res.ok && res.value) { ingest(res.value); return null; }
						return res && res.error ? res.error.message : "That did not work.";
					}, function () { return "Could not reach the Host."; });
				},
				// The page shows a change it has made before the Host has confirmed it.
				update: function (change) {
					if (!state.board) return;
					set({ board: change(state.board) });
				},
				// While a drop is being written, boards from the Host are not applied.
				hold: function () { held += 1; },
				release: function () { held = Math.max(0, held - 1); },
				dispose: function () {
					stopAll();
					if (env.document && env.document.removeEventListener) env.document.removeEventListener("visibilitychange", onVisibility);
				}
			};
		}

		// One shared tick for every time that is shown as "N ago" or as a growing
		// working time: it runs only while one is on screen and the tab is
		// visible, and only those small text leaves re-render on it.
		function createClock(env) {
			var listeners = new Set();
			var timer = null;
			var value = env.now();
			function hidden() { return !!(env.document && env.document.hidden); }
			function stop() { if (timer !== null) { env.clearInterval(timer); timer = null; } }
			function start() {
				if (timer !== null || listeners.size === 0 || hidden()) return;
				timer = env.setInterval(function () {
					value = env.now();
					Array.from(listeners).forEach(function (listener) { listener(); });
				}, CLOCK_MS);
			}
			function onVisibility() {
				if (hidden()) { stop(); return; }
				value = env.now();
				Array.from(listeners).forEach(function (listener) { listener(); });
				start();
			}
			if (env.document && env.document.addEventListener) env.document.addEventListener("visibilitychange", onVisibility);
			return {
				subscribe: function (listener) {
					listeners.add(listener);
					start();
					return function () {
						listeners.delete(listener);
						if (listeners.size === 0) stop();
					};
				},
				get: function () { return value; }
			};
		}

		var liveEnv = {
			document: typeof document !== "undefined" ? document : null,
			fetch: typeof window !== "undefined" && window.fetch ? window.fetch.bind(window) : undefined,
			AbortController: typeof AbortController !== "undefined" ? AbortController : undefined,
			TextDecoder: typeof TextDecoder !== "undefined" ? TextDecoder : undefined,
			setTimeout: function (fn, ms) { return window.setTimeout(fn, ms); },
			clearTimeout: function (id) { window.clearTimeout(id); },
			setInterval: function (fn, ms) { return window.setInterval(fn, ms); },
			clearInterval: function (id) { window.clearInterval(id); },
			now: function () { return Date.now(); },
			rpc: rpc
		};
		var boardStore = createBoardStore(liveEnv);
		var liveClock = createClock(liveEnv);

		function useBoardStore() {
			return React.useSyncExternalStore(boardStore.subscribe, boardStore.get);
		}

		function useClock() {
			return React.useSyncExternalStore(liveClock.subscribe, liveClock.get);
		}

		// The working time on a card: the figure the Host read, plus the time
		// since it was read while the ticket is still being worked on.
		function LiveDur(props) {
			var now = useClock();
			var t = props.ticket;
			var ms = (t.workingMs || 0) + (t.accruing && t.readAt ? Math.max(0, now - t.readAt) : 0);
			return fmtDur(ms);
		}

		function LiveAgo(props) {
			useClock();
			return ago(props.iso);
		}

		function useKanbanBadges() {
			var live = useBoardStore();
			return React.useMemo(function () { return countBadges(live.board); }, [live.board]);
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
			var segments = Array.isArray(ticket.segments) && ticket.segments.length > 0 ? ticket.segments : straightSegments(ticket);
			return h("div", { className: "kb-steps", title: "Lifecycle: " + segments.map(function (seg) { return phaseLabel(seg.phase); }).join(" → ") },
				segments.map(function (seg, i) {
					return h("span", {
						key: i,
						className: "kb-step kb-step-" + seg.phase + " " + seg.state,
						title: phaseLabel(seg.phase) + (seg.round > 1 ? " (round " + seg.round + ")" : "") + (seg.state === "todo" ? " — still to come" : "")
					});
				})
			);
		}
		// The host sends the real path (a second implement/review round adds
		// segments). This is only the straight line for a payload that lacks it.
		function straightSegments(ticket) {
			var closed = ticket.phase === "closed" || ticket.column === "done";
			var at = phaseIndex(ticket.phase);
			return PHASES.map(function (phase, i) {
				return { phase: phase, round: 1, state: closed || i < at ? "done" : i === at ? "current" : "todo" };
			});
		}
		// Badge tone follows the lifecycle stage, not the column: Plan blue,
		// Build teal, Review pink, Approval violet, Done green.
		function phaseTone(phase) {
			return phase === "plan" ? "plan" : phase === "implement" ? "build" : phase === "review" ? "review" : phase === "verify" ? "approval" : "done";
		}
		// Discarded is its own badge stage, derived from the column: a discard
		// can land from any phase and the row's phase may stay where it was
		// (only the approval-stage discard closes the phase). The lifecycle dot
		// strip deliberately has no Discarded dot - the stage lives in the
		// badge, and the Done / Discarded column holds both stages.
		function stageTone(t) {
			return t.column === "discarded" ? "discarded" : phaseTone(t.phase);
		}
		function stageLabel(t) {
			return t.column === "discarded" ? "Discarded" : phaseLabel(t.phase);
		}
		// The bottom-left badge mirrors the card status: grey idle, blue active,
		// red attention.
		function statusTone(status) {
			return status === "attention" ? "err" : status === "active" ? "run" : "idle";
		}
		function nextAction(t) {
			// KAN-17: awaitingApproval / awaitingQuestion mean a session is paused
			// mid-turn on a human — the red card says which ask is pending, in any
			// phase. The verify-phase rule below is the engine-parked approval: no
			// turn in flight, the human still holds the decision.
			if (t.status === "attention") return t.awaitingApproval ? "Awaiting approval" : (t.awaitingQuestion || t.parkedOnQuestion) ? "Waiting on you" : t.phase === "verify" ? "Awaiting approval" : "Needs your decision";
			if (t.status === "active") return t.phase === "plan" ? "Grilling / planning" : "Running";
			if (t.column === "done" || t.column === "discarded") return "Closed";
			if (t.column === "working") return "Queued";
			return "Ready";
		}
		// KAN-16: offer "Start planning" exactly where the host would accept it.
		// This mirrors the host rule in src/planning.mjs — this half is a classic
		// browser script and cannot import it, so the rule is written twice on
		// purpose and host-contract.test.mjs checks the two agree.
		// A parked ticket keeps its button: pressing it again is the retry.
		function canStartPlanning(t) {
			if (!t) return false;
			if (t.column !== "backlog" || t.phase !== "plan") return false;
			if (t.planTiming === "now") return false;
			if ((t.status || "idle") === "active" || t.awaitingQuestion) return false;
			return true;
		}

		// Offer "Start build" exactly where the host would accept it: a planned
		// ticket (build phase) still sitting in Backlog. Mirrors src/build.mjs for the
		// same reason canStartPlanning mirrors src/planning.mjs; host-contract and
		// board-ui tests check the two agree. A parked ticket keeps its button - the
		// move into Working lifts the park.
		function canStartBuild(t) {
			if (!t) return false;
			if (t.column !== "backlog" || t.phase !== "implement") return false;
			if ((t.status || "idle") === "active" || t.awaitingQuestion) return false;
			return true;
		}

		// Where the pointer sits among a column's cards: the id of the first card
		// whose midpoint is below it, or null for "after the last card". `rects` are
		// the column's cards in order with the dragged one left out.
		function dropBefore(rects, pointerY) {
			for (var i = 0; i < rects.length; i++) {
				if (pointerY < rects[i].top + rects[i].height / 2) return rects[i].id;
			}
			return null;
		}
		// The id of the card a pointer at clientY would drop before, read from the
		// live card boxes inside `container` and skipping the dragged card (it stays
		// in place, dimmed, and is not a target).
		function beforeIdFor(container, clientY, dragId) {
			var nodes = container.querySelectorAll("[data-card-id]");
			var rects = [];
			Array.prototype.forEach.call(nodes, function (node) {
				var id = node.getAttribute("data-card-id");
				if (id === dragId) return;
				var box = node.getBoundingClientRect();
				rects.push({ id: id, top: box.top, height: box.height });
			});
			return dropBefore(rects, clientY);
		}
		// At most one pointer measurement per animation frame, whichever column
		// the pointer is over.
		var overFrame = { pending: false, latest: null };
		function nextFrame(fn) {
			if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(fn);
			else setTimeout(fn, 16);
		}
		// True when dropping dragId before beforeId would leave the column as it is
		// (right back where it was), so no indicator is drawn and nothing is sent.
		function dropIsNoop(ids, dragId, beforeId) {
			var at = ids.indexOf(dragId);
			if (at < 0) return false;
			var next = at + 1 < ids.length ? ids[at + 1] : null;
			return (beforeId === undefined ? null : beforeId) === next;
		}
		// The board after a drop, so the card lands before the request returns. Only
		// the two draggable columns are touched; the input is never mutated.
		function moveInColumns(columns, id, column, beforeId) {
			var next = {};
			var moved = null;
			Object.keys(columns).forEach(function (name) {
				next[name] = (columns[name] || []).filter(function (t) {
					if (t.id === id) { moved = t; return false; }
					return true;
				});
			});
			if (moved === null || !next[column]) return columns;
			var list = next[column];
			var at = beforeId === null || beforeId === undefined ? -1 : list.findIndex(function (t) { return t.id === beforeId; });
			var item = Object.assign({}, moved, { column: column });
			if (at < 0) list.push(item);
			else list.splice(at, 0, item);
			return next;
		}

		function JumpIcon() {
			return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("path", { d: "M9.5 2.5h4v4" }),
				h("path", { d: "M13.5 2.5 7.5 8.5" }),
				h("path", { d: "M12 9.5v2.5a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3 12V6a1.5 1.5 0 0 1 1.5-1.5H7" })
			);
		}

		function ClockIcon() {
			return h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("circle", { cx: 8, cy: 8, r: 6 }),
				h("path", { d: "M8 4.8V8l2.2 1.4" })
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
					"data-card-id": t.id,
					onDragStart: function (ev) {
						ev.dataTransfer.setData("text/kanban", t.id);
						ev.dataTransfer.effectAllowed = "move";
						if (props.onDragStart) props.onDragStart(t.id);
					},
					onDragEnd: function () { if (props.onDragEnd) props.onDragEnd(); },
					// No drag-over or drop handler here: the column owns the whole drop,
					// computed from the pointer's position among its cards, so a card moving
					// under the pointer can never change where the drop lands.
					onClick: function () { props.onOpen(t.id); },
					title: t.title
				},
				h("div", { className: "kb-cardtop" },
					h("span", { className: "kb-key", children: t.key }),
					h("span", { className: "kb-spacer" }),
					// A conditional element, never a conditional hook: Card calls no hooks.
					// stopPropagation keeps the click off the card's own onClick, which
					// would open the detail instead of the session.
					t.sessionId ? h("button", {
						type: "button",
						className: "kb-iconbtn sm kb-jump",
						title: "Open this ticket's session (the active one, else the latest)",
						"aria-label": "Open the session for " + t.key,
						draggable: false,
						onClick: function (ev) { ev.stopPropagation(); openOrComplain(t.sessionId); }
					}, h(JumpIcon)) : null,
					h("span", { className: "kb-statusdot " + status, title: status, "aria-label": "Status: " + status }),
					h("span", { className: "kb-phasechip " + stageTone(t), children: stageLabel(t) })
				),
				h("div", { className: "kb-cardtitle", children: t.title }),
				phaseProgress(t),
				h("div", { className: "kb-meta" },
					h("span", { className: "kb-next " + statusTone(status), children: nextAction(t) }),
					t.attemptLabel ? h("span", { className: "kb-attempt", children: t.attemptLabel }) : null,
					t.spentUsd > 0 ? h("span", { children: fmtUsd(t.spentUsd) }) : null
				),
				h("div", { className: "kb-cardfoot" },
					// stopPropagation: the button must not also open the detail.
					canStartPlanning(t) ? h("button", {
						type: "button",
						className: "kb-planbtn",
						title: "Plan this ticket now, in Backlog, without moving it to Working",
						onClick: function (ev) {
							ev.stopPropagation();
							if (props.onStartPlanning) props.onStartPlanning(t.id);
						}
					}, "Start planning") : null,
					canStartBuild(t) ? h("button", {
						type: "button",
						className: "kb-planbtn kb-buildbtn",
						title: "Move this planned ticket to Working and start the build",
						onClick: function (ev) {
							ev.stopPropagation();
							if (props.onStartBuild) props.onStartBuild(t.id);
						}
					}, "Start build") : null,
					h("span", { className: "kb-spacer" }),
					h("span", { className: "kb-worktime", title: "Time spent actively working on this ticket (not while it waits on you)" },
						h(ClockIcon), h(LiveDur, { ticket: t })),
					h("span", { className: "kb-created", title: "Created " + fmtTime(t.createdAt) }, "created ", h(LiveAgo, { iso: t.createdAt }))
				)
			);
		}

		// A card is redrawn when its own ticket object changed (the store keeps
		// the identity of a card that said the same thing again) or when it starts
		// or stops being dragged. Its callbacks are not compared: every one of them
		// reaches current state through refs and setters, never through values
		// captured at the render that created it.
		function sameCard(prev, next) {
			return prev.ticket === next.ticket && prev.dragging === next.dragging && prev.column === next.column;
		}
		var BoardCard = React.memo(Card, sameCard);

		function Column(props) {
			var items = props.items || [];
			var dragging = props.dragId !== null && props.dragId !== undefined;
			var target = dragging && props.dropTarget && props.dropTarget.column === props.column ? props.dropTarget : null;
			var ids = items.map(function (t) { return t.id; });
			var showLine = target !== null && !dropIsNoop(ids, props.dragId, target.beforeId);
			var droppable = props.column !== "done";
			// The indicator takes no room (see .kb-drop-line), so showing it, moving it
			// or hiding it never shifts a card under the pointer.
			var line = h("div", { key: "drop-line", className: "kb-drop-line", "aria-hidden": "true" });
			var rendered = [];
			items.forEach(function (t) {
				if (showLine && target.beforeId === t.id) rendered.push(line);
				rendered.push(h(BoardCard, { key: t.id, ticket: t, column: props.column, dragging: props.dragId === t.id, onOpen: props.onOpen, onStartPlanning: props.onStartPlanning, onStartBuild: props.onStartBuild, onDragStart: props.onDragStart, onDragEnd: props.onDragEnd }));
			});
			if (showLine && (target.beforeId === null || target.beforeId === undefined)) rendered.push(line);
			// Where a pointer at ev.clientY would drop: read from the live card boxes,
			// skipping the dragged card (it stays in place, dimmed, and is not a target).
			function beforeIdAt(ev) {
				return beforeIdFor(ev.currentTarget, ev.clientY, props.dragId);
			}
			return h(
				"div",
				{
					className: "kb-col" + (props.column === "done" ? " kb-col-pinned" : "") + (target !== null ? " drop-target" : ""),
					onDragOver: function (ev) {
						if (!droppable || !dragging) return;
						ev.preventDefault();
						ev.dataTransfer.dropEffect = "move";
						if (!props.onDragOverColumn) return;
						// The pointer moves far faster than the screen redraws; the cards
						// are measured once per frame, for the latest position only.
						var container = ev.currentTarget;
						var pointerY = ev.clientY;
						var dragged = props.dragId;
						var column = props.column;
						var report = props.onDragOverColumn;
						overFrame.latest = function () { report(column, beforeIdFor(container, pointerY, dragged)); };
						if (!overFrame.pending) {
							overFrame.pending = true;
							nextFrame(function () {
								overFrame.pending = false;
								var run = overFrame.latest;
								overFrame.latest = null;
								if (run) run();
							});
						}
					},
					onDrop: function (ev) {
						if (!droppable) return;
						ev.preventDefault();
						var id = ev.dataTransfer.getData("text/kanban");
						if (id && props.onDropAt) props.onDropAt(id, props.column, beforeIdAt(ev));
					}
				},
				h("div", { className: "kb-colhead" },
					h("span", { className: "kb-coldot" }),
					h("span", { className: "kb-collabel", children: props.label }),
					h("span", { className: "kb-count", children: items.length })
				),
				h("div", { className: "kb-list" },
					items.length === 0 && !showLine
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

		// KAN-15: the two new ticket options shared by the create form and the
		// editor. No hooks here either — plain data over the controls.
		// A null preset means "harness default" (the empty option), so the
		// ticket keeps tracking the deployment's default even if it changes.
		// A null write mode means "purpose default", which for a build session
		// is workspace-write — the segmented control's default position.

		var WRITE_MODE_OPTIONS = [
			{ value: "read-only", label: "Read-only" },
			{ value: "workspace-write", label: "Workspace write" },
			{ value: "danger-full-access", label: "Full access" }
		];

		function presetOptions(presets) {
			var def = presets && presets.default ? presets.default : "standard";
			var out = [{ value: "", label: "Harness default (" + def + ")" }];
			var items = presets && Array.isArray(presets.items) ? presets.items : [];
			items.forEach(function (p) {
				out.push({ value: p.id, label: (p.name || p.id) + (p.broken ? " (unavailable)" : "") });
			});
			return out;
		}

		function PresetPicker(props) {
			return h("select", {
				className: "kb-select",
				style: { width: "100%" },
				"aria-label": props.ariaLabel,
				value: props.value,
				onChange: function (ev) { props.onChange(ev.target.value); }
			}, presetOptions(props.presets).map(function (o) {
				return h("option", { key: o.value, value: o.value, children: o.label });
			}));
		}

		// ---------------------------------------------------------------- images
		//
		// A ticket body carries image refs as markdown: ![name](kanban-image:<id>).
		// While a draft is open the id is a client token — pending-<token> — and
		// the Host stores the bytes in DSH's content-addressed attachment store
		// and rewrites the refs before the body is persisted (src/images.mjs).
		// The browser half cannot import that module, so the small rules below
		// mirror it; the Host re-checks everything on save regardless.

		var IMG_PREFIX = "kanban-image:";
		var IMG_MAX = 10;
		var IMG_MAX_BYTES = 20 * 1024 * 1024;
		var IMG_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
		var IMG_REF_RE = /!\[([^\]\n]*)\]\(\s*kanban-image:([^\s)]+)\s*\)/g;

		function imgRefText(name, target) {
			var clean = String(name || "").replace(/[\]\n\r]/g, " ").trim().slice(0, 120);
			return "![" + (clean === "" ? "image" : clean) + "](" + IMG_PREFIX + target + ")";
		}
		function imgCountRefs(body) {
			var seen = {};
			var text = String(body || "");
			var m;
			IMG_REF_RE.lastIndex = 0;
			while ((m = IMG_REF_RE.exec(text)) !== null) {
				if (!Object.prototype.hasOwnProperty.call(seen, m[2])) seen[m[2]] = true;
			}
			return Object.keys(seen).length;
		}
		function imgInsertRef(body, cursor, token, name) {
			var text = String(body || "");
			var at = Math.max(0, Math.min(Number.isFinite(cursor) ? Math.trunc(cursor) : text.length, text.length));
			var before = text.slice(0, at);
			var after = text.slice(at);
			var lead = before === "" ? "" : before.slice(-2) === "\n\n" ? "" : before.slice(-1) === "\n" ? "\n" : "\n\n";
			var tail = after === "" ? "\n" : after.charAt(0) === "\n" ? "\n" : "\n\n";
			return before + lead + imgRefText(name, "pending-" + token) + tail + after;
		}
		function imgRemoveRef(body, token) {
			var text = String(body || "");
			var target = String(token || "");
			if (target === "") return text;
			if (target.indexOf("pending-") !== 0 && target.indexOf("sha256:") !== 0) target = "pending-" + target;
			var esc = function (v) { return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
			var one = new RegExp("(?:\\n\\n|\\n)?!\\[[^\\]\\n]*\\]\\(\\s*" + esc(IMG_PREFIX) + esc(target) + "\\s*\\)(?:\\n\\n|\\n)?", "g");
			return text.replace(one, "\n\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
		}
		function imgToken() {
			return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
		}
		function fileToBase64(file) {
			return new Promise(function (resolve, reject) {
				var reader = new FileReader();
				reader.onload = function () { resolve(String(reader.result).split(",")[1] || ""); };
				reader.onerror = function () { reject(new Error("could not read " + (file && file.name ? file.name : "image"))); };
				reader.readAsDataURL(file);
			});
		}

		// One draft-image manager shared by CreateForm and TicketEditor: it owns
		// the pending tiles and keeps the body text and the tiles in step — an
		// ingest inserts the ref at the cursor, an X removes tile and ref alike.
		// Every hook it calls is unconditional, and both callers call it
		// unconditionally, so the hook order of either form never varies.
		function imageDrafts(getBody, setBody, bodyRef) {
			var st = React.useState([]);
			var drafts = st[0], setDrafts = st[1];
			var er = React.useState(null);
			var error = er[0], setError = er[1];
			var keep = React.useRef([]);
			keep.current = drafts;
			React.useEffect(function () {
				return function () {
					keep.current.forEach(function (d) { try { URL.revokeObjectURL(d.url); } catch (e) { /* gone already */ } });
				};
			}, []);
			function ingest(fileList) {
				var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
					return f && IMG_TYPES.indexOf(f.type) !== -1;
				});
				if (files.length === 0) return false;
				var body = String(getBody() || "");
				var cursor = bodyRef && bodyRef.current ? bodyRef.current.selectionStart : body.length;
				var added = [];
				var problem = null;
				files.forEach(function (file) {
					// imgCountRefs sees the refs already inserted this loop, so the
					// cap is just the live count — no added.length on top.
					if (imgCountRefs(body) >= IMG_MAX) { problem = "A ticket carries at most " + IMG_MAX + " images."; return; }
					if (file.size > IMG_MAX_BYTES) { problem = (file.name || "That image") + " is over the 20 MB limit."; return; }
					var token = imgToken();
					body = imgInsertRef(body, added.length === 0 ? cursor : body.length, token, file.name || "image");
					added.push({ token: token, name: file.name || "image", mediaType: file.type, file: file, url: URL.createObjectURL(file) });
				});
				setBody(body);
				if (added.length > 0) setDrafts(function (prev) { return prev.concat(added); });
				setError(problem);
				return true;
			}
			function remove(token) {
				setDrafts(function (prev) {
					var hit = null;
					prev.forEach(function (d) { if (d.token === token) hit = d; });
					if (hit !== null) { try { URL.revokeObjectURL(hit.url); } catch (e) { /* gone already */ } }
					return prev.filter(function (d) { return d.token !== token; });
				});
				setBody(imgRemoveRef(String(getBody() || ""), "pending-" + token));
			}
			function collect() {
				return Promise.all(drafts.map(function (d) {
					return fileToBase64(d.file).then(function (data) {
						return { token: d.token, data: data, mediaType: d.mediaType, name: d.name };
					});
				}));
			}
			return { drafts: drafts, error: error, ingest: ingest, remove: remove, collect: collect };
		}

		function ImageRail(props) {
			if (!props.drafts || props.drafts.length === 0) return null;
			return h("div", { className: "kb-img-rail" },
				props.drafts.map(function (d) {
					return h("div", { className: "kb-img-tile", key: d.token, title: d.name },
						h("img", { src: d.url, alt: d.name }),
						h("button", { type: "button", className: "kb-img-x", "aria-label": "Remove " + d.name, title: "Remove " + d.name, onClick: function () { props.onRemove(d.token); }, children: "×" }));
				}));
		}

		function ImageControls(props) {
			// The one ingest surface: the textarea wires onPaste/onDrop to the
			// same ingest, and this bar adds the file picker and the tiles.
			return h("div", null,
				h("div", { className: "kb-img-row" },
					h("button", { type: "button", className: "kb-btn sm", onClick: function () { if (props.fileRef.current) props.fileRef.current.click(); }, children: "Add image" }),
					h("input", { ref: props.fileRef, type: "file", accept: IMG_TYPES.join(","), multiple: true, style: { display: "none" }, "aria-hidden": "true", tabIndex: -1, onChange: function (ev) { props.ingest(ev.target.files); ev.target.value = ""; } }),
					h("span", { className: "kb-hint", children: "Paste, drop or add up to " + IMG_MAX + " images (png, jpeg, webp, gif · 20 MB each)." })),
				h(ImageRail, { drafts: props.drafts, onRemove: props.onRemove }),
				props.error ? h("div", { className: "kb-err", children: props.error }) : null);
		}

		// The body ref handlers, spread onto the body textarea by both forms.
		function imageTextareaProps(imgs, bodyRef) {
			return {
				ref: bodyRef,
				onPaste: function (ev) {
					var files = ev.clipboardData ? ev.clipboardData.files : null;
					if (files && files.length > 0 && imgs.ingest(files)) ev.preventDefault();
				},
				onDragOver: function (ev) { ev.preventDefault(); },
				onDrop: function (ev) {
					ev.preventDefault();
					if (ev.dataTransfer && ev.dataTransfer.files) imgs.ingest(ev.dataTransfer.files);
				},
			};
		}

		// ------------------------------------------------- read-only body view

		var imgDataCache = {};
		function loadImageDataUrl(attachmentId) {
			if (imgDataCache[attachmentId] !== undefined) return imgDataCache[attachmentId];
			imgDataCache[attachmentId] = rpc("readImage", { attachmentId: attachmentId }).then(function (res) {
				if (!res || !res.ok || !res.value || !res.value.base64) throw new Error(res && res.error ? res.error.message : "image unavailable");
				return "data:" + (res.value.mediaType || "image/png") + ";base64," + res.value.base64;
			}).catch(function (error) {
				delete imgDataCache[attachmentId];
				throw error;
			});
			return imgDataCache[attachmentId];
		}

		function BodyImage(props) {
			var st = React.useState(null);
			var state = st[0], setState = st[1];
			React.useEffect(function () {
				var alive = true;
				setState(null);
				loadImageDataUrl(props.attachmentId).then(function (url) {
					if (alive) setState({ ok: true, url: url });
				}, function () { if (alive) setState({ ok: false }); });
				return function () { alive = false; };
			}, [props.attachmentId]);
			if (state === null) return h("span", { className: "kb-img-broken", children: "loading image…" });
			if (!state.ok) return h("span", { className: "kb-img-broken", children: "image unavailable" + (props.name ? " · " + props.name : "") });
			return h("img", { src: state.url, alt: props.name || "ticket image", title: props.name || "" });
		}

		/**
		 * Light markdown inline pass: image refs, http(s) links, code, bold,
		 * italic — every piece built as a React element with text children. The
		 * body is untrusted data and is never interpreted as HTML.
		 */
		function mdInline(text, key) {
			var nodes = [];
			var re = /!\[([^\]\n]*)\]\(\s*kanban-image:([^\s)]+)\s*\)|\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
			var last = 0;
			var m;
			var i = 0;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) nodes.push(text.slice(last, m.index));
				if (m[1] !== undefined) nodes.push(h(BodyImage, { key: key + "-" + i, attachmentId: m[2], name: m[1] }));
				else if (m[3] !== undefined) nodes.push(h("a", { key: key + "-" + i, href: m[4], target: "_blank", rel: "noreferrer", children: m[3] === "" ? m[4] : m[3] }));
				else if (m[5] !== undefined) nodes.push(h("code", { key: key + "-" + i, children: m[5] }));
				else if (m[6] !== undefined) nodes.push(h("b", { key: key + "-" + i, children: m[6] }));
				else if (m[7] !== undefined) nodes.push(h("i", { key: key + "-" + i, children: m[7] }));
				last = re.lastIndex;
				i += 1;
			}
			if (last < text.length) nodes.push(text.slice(last));
			return nodes;
		}

		/**
		 * The read-only Body panel renderer: fenced code, headings, lists,
		 * blockquotes and paragraphs, each line run through mdInline. Deliberate
		 * subset — the body is context, not a document.
		 */
		function renderMarkdown(text) {
			var lines = String(text || "").split(/\r?\n/);
			var out = [];
			var i = 0;
			var key = 0;
			var BLOCK_START = /^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|\s*>|```)/;
			while (i < lines.length) {
				var line = lines[i];
				if (/^\s*$/.test(line)) { i += 1; continue; }
				if (line.trim().indexOf("```") === 0) {
					var code = [];
					i += 1;
					while (i < lines.length && lines[i].trim().indexOf("```") !== 0) { code.push(lines[i]); i += 1; }
					i += 1;
					out.push(h("pre", { key: "k" + key, className: "kb-md-code" }, h("code", { children: code.join("\n") })));
					key += 1;
					continue;
				}
				var hm = line.match(/^(#{1,6})\s+(.*)$/);
				if (hm) {
					var Tag = "h" + Math.min(hm[1].length + 2, 6);
					out.push(h(Tag, { key: "k" + key }, mdInline(hm[2], "h" + key)));
					key += 1;
					i += 1;
					continue;
				}
				if (/^\s*[-*]\s+/.test(line)) {
					var items = [];
					while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i += 1; }
					out.push(h("ul", { key: "k" + key }, items.map(function (it, n) { return h("li", { key: n }, mdInline(it, "ul" + key + "-" + n)); })));
					key += 1;
					continue;
				}
				if (/^\s*\d+\.\s+/.test(line)) {
					var oitems = [];
					while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { oitems.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i += 1; }
					out.push(h("ol", { key: "k" + key }, oitems.map(function (it, n) { return h("li", { key: n }, mdInline(it, "ol" + key + "-" + n)); })));
					key += 1;
					continue;
				}
				if (/^\s*>\s?/.test(line)) {
					var quote = [];
					while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
					out.push(h("blockquote", { key: "k" + key }, quote.map(function (l, n) { return h("div", { key: n }, mdInline(l, "q" + key + "-" + n)); })));
					key += 1;
					continue;
				}
				var para = [];
				while (i < lines.length && !/^\s*$/.test(lines[i]) && !BLOCK_START.test(lines[i])) { para.push(lines[i]); i += 1; }
				out.push(h("p", { key: "k" + key }, para.map(function (l, n) {
					return h(React.Fragment, { key: n }, n > 0 ? h("br") : null, mdInline(l, "p" + key + "-" + n));
				})));
				key += 1;
			}
			return out;
		}

		function CreateForm(props) {
			var s = React.useState({ title: "", body: "", acceptance: "", timing: "at_pickup", questions: "interactive", priority: 0, allowPaid: false, budget: 0, workspace: "", status: "backlog", worktree: false, preset: "", writeMode: "workspace-write" });
			var form = s[0], setForm = s[1];
			var e = React.useState(null);
			var err = e[0], setErr = e[1];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			var br = React.useRef(null);
			var bodyRef = br;
			var fr = React.useRef(null);
			var fileRef = fr;
			var imgs = imageDrafts(
				function () { return form.body; },
				function (next) { setForm(function (prev) { var o = Object.assign({}, prev); o.body = next; return o; }); },
				bodyRef
			);
			var invalid = false;
			function field(key, value) {
				var next = Object.assign({}, form);
				next[key] = value;
				setForm(next);
			}

			function submit() {
				if (invalid || form.title.trim() === "") return;
				setBusy(true);
				setErr(null);
				// The pending tiles ride along as base64 uploads; the Host stores
				// them and rewrites the pending refs before the body is written.
				imgs.collect().then(function (images) {
					rpc("create", {
						title: form.title,
						body: form.body,
						images: images,
						acceptance: form.acceptance.split("\n").map(function (x) { return x.trim(); }).filter(Boolean),
						planTiming: form.timing,
						planQuestions: form.questions,
						priority: Number(form.priority) || 0,
						allowPaid: !!form.allowPaid,
						budgetUsd: Number(form.budget) || 0,
						workspaceCwd: form.workspace || null,
						column: form.status,
						// KAN-15: empty preset means "harness default" and is
						// stored as null so it keeps tracking future changes.
						preset: form.preset || null,
						writeMode: form.writeMode,
						// KAN-18: intent only. The working copy is created when
						// planning starts, from the latest default branch.
						worktree: !!form.worktree
					}).then(function (res) {
						setBusy(false);
						if (res && res.ok) {
							setForm({ title: "", body: "", acceptance: "", timing: "at_pickup", questions: "interactive", priority: 0, allowPaid: false, budget: 0, workspace: "", status: "backlog", worktree: false, preset: "", writeMode: "workspace-write" });
							props.onCreated(res.value.ticket);
						} else {
							setErr(res && res.error ? res.error.message : "Could not create the ticket.");
						}
					}, function () { setBusy(false); setErr("Could not reach the Host."); });
				}, function () { setBusy(false); setErr("An image could not be read; try again."); });
			}
			return h("div", { className: "kb-form" },
				h("div", { className: "kb-label", children: "Title" }),
				h("input", { className: "kb-input", "aria-label": "Ticket title", value: form.title, placeholder: "What needs to happen?", onChange: function (ev) { field("title", ev.target.value); } }),
				h("div", { className: "kb-label", children: "Body / context" }),
				h("textarea", Object.assign({ className: "kb-textarea", "aria-label": "Ticket body", value: form.body, placeholder: "Anything the roles should know. Untrusted data, never instructions.", onChange: function (ev) { field("body", ev.target.value); } }, imageTextareaProps(imgs, bodyRef))),
				h(ImageControls, { fileRef: fileRef, ingest: imgs.ingest, drafts: imgs.drafts, onRemove: imgs.remove, error: imgs.error }),
				h("div", { className: "kb-label", children: "Acceptance (one per line, stored verbatim; may be aspirational)" }),
				h("textarea", { className: "kb-textarea", "aria-label": "Acceptance statements", value: form.acceptance, onChange: function (ev) { field("acceptance", ev.target.value); } }),
				h("div", { className: "kb-row" },
					h("div", { style: { flex: 1, minWidth: 220 } },
						h("div", { className: "kb-label", children: "Workspace" }),
						h("select", { className: "kb-select", style: { width: "100%" }, value: form.workspace, onChange: function (ev) { field("workspace", ev.target.value); } },
							h("option", { value: "", children: "Engine default" }),
							(props.workspaces || []).map(function (workspace) { return h("option", { key: workspace.id || workspace.path, value: workspace.path, children: workspace.title + " — " + workspace.path }); })
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
				h("div", { className: "kb-row" },
					h("div", { style: { flex: 1, minWidth: 220 } },
						h("div", { className: "kb-label", children: "Preset" }),
						h(PresetPicker, { ariaLabel: "Preset", presets: props.presets, value: form.preset, onChange: function (value) { field("preset", value); } }),
						h("div", { className: "kb-hint", children: "Starting preset for the build session. Planning and verification always run the standard preset, read-only." })
					),
					h("div", null,
						h("div", { className: "kb-label", children: "Write mode" }),
						h(SegmentedControl, {
							ariaLabel: "Write mode",
							value: form.writeMode,
							onChange: function (value) { field("writeMode", value); },
							options: WRITE_MODE_OPTIONS
						}),
						h("div", { className: "kb-hint", children: "File policy of the build session." })
					)
				),
				props.worktreeAvailable ? h("div", { className: "kb-row" },
					h("div", { className: "kb-switchrow" },
						h(Switch, {
							ariaLabel: "Worktree for this ticket",
							checked: form.worktree,
							onToggle: function (value) { field("worktree", value); }
						}),
						h("span", { className: "kb-label", children: "Worktree" })),
					h("span", { className: "kb-hint", children: "A worktree from the latest main is created when planning starts." })) : null,
				err ? h("div", { className: "kb-err", children: err }) : null,
				h("div", { className: "kb-row" },
					h("button", { className: "kb-btn primary", disabled: busy || invalid || form.title.trim() === "", onClick: submit, children: busy ? "Creating…" : "Create ticket" }),
					h("button", { className: "kb-btn", onClick: props.onClose, children: "Cancel" }))
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

		// The one ticket editor. It replaces the old "modes and budget" pencil and
		// the add-only acceptance dialog: a pristine ticket is edited as a whole,
		// in one save. A started ticket never reaches it — the hero pencil is
		// disabled from `detail.ticket.editable` and the host refuses the write
		// again with `ticket_started`.
		function TicketEditor(props) {
			var t = props.ticket;
			var prior = (props.acceptance || []).map(function (a) { return a.statement; });
			var s = React.useState({
				title: t.title,
				body: t.body || "",
				acceptance: prior.join("\n"),
				timing: t.planTiming,
				questions: t.planQuestions,
				priority: t.priority,
				allowPaid: t.allowPaid,
				budgetUsd: t.budgetUsd,
				workspaceCwd: t.workspaceCwd || "",
				preset: t.preset || "",
				writeMode: t.writeMode || "workspace-write"
			});
			var form = s[0], setForm = s[1];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			var e = React.useState(null);
			var err = e[0], setErr = e[1];
			var br = React.useRef(null);
			var bodyRef = br;
			var fr = React.useRef(null);
			var fileRef = fr;
			var imgs = imageDrafts(
				function () { return form.body; },
				function (next) { setForm(function (prev) { var o = Object.assign({}, prev); o.body = next; return o; }); },
				bodyRef
			);
			function field(key, value) {
				var next = Object.assign({}, form);
				next[key] = value;
				setForm(next);
			}
			function save() {
				if (busy) return;
				var title = form.title.trim();
				if (title === "") { setErr("A ticket needs a title."); return; }
				// Only what actually changed goes on the wire; acceptance is
				// compared line by line so an untouched list is not rewritten.
				var patch = {};
				if (title !== t.title) patch.title = title;
				if (form.body !== (t.body || "")) patch.body = form.body;
				if (form.timing !== t.planTiming) patch.planTiming = form.timing;
				if (form.questions !== t.planQuestions) patch.planQuestions = form.questions;
				if (Number(form.priority) !== Number(t.priority)) patch.priority = Number(form.priority) || 0;
				if (!!form.allowPaid !== !!t.allowPaid) patch.allowPaid = !!form.allowPaid;
				if (Number(form.budgetUsd) !== Number(t.budgetUsd)) patch.budgetUsd = Number(form.budgetUsd) || 0;
				if ((form.workspaceCwd || "") !== (t.workspaceCwd || "")) patch.workspaceCwd = form.workspaceCwd || null;
				// KAN-15: same rules as create — empty preset stores null, and
				// the write mode is always an explicit choice once edited.
				var nextPreset = form.preset || null;
				if (nextPreset !== (t.preset === undefined ? null : t.preset)) patch.preset = nextPreset;
				if (form.writeMode !== (t.writeMode || "workspace-write")) patch.writeMode = form.writeMode;
				var lines = form.acceptance.split("\n").map(function (line) { return line.trim(); }).filter(Boolean);
				var acceptanceChanged = lines.length !== prior.length || lines.some(function (line, i) { return line !== prior[i]; });
				if (acceptanceChanged) patch.acceptance = lines;
				// Pending tiles ride as base64 uploads beside the patch; the
				// Host stores them and rewrites the refs before anything is
				// written, so a failed image save applies no patch at all.
				imgs.collect().then(function (images) {
					if (images.length > 0) {
						patch.images = images;
						if (patch.body === undefined) patch.body = form.body;
					}
					var realChange = Object.keys(patch).some(function (k) { return k !== "images"; });
					if (!realChange) { props.onClose(); return; }
					setBusy(true);
					setErr(null);
					Promise.resolve(props.onSave(patch)).then(function (res) {
						setBusy(false);
						if (res && res.ok) props.onClose();
						else setErr(res && res.error ? res.error.message : "The ticket could not be saved.");
					}, function () { setBusy(false); setErr("Could not reach the Host."); });
				}, function () { setErr("An image could not be read; try again."); });
			}
			return h("div", { className: "kb-form" },
				h("div", { className: "kb-label", children: "Title" }),
				h("input", { className: "kb-input", "aria-label": "Ticket title", value: form.title, onChange: function (ev) { field("title", ev.target.value); } }),
				h("div", { className: "kb-label", children: "Body / context" }),
				h("textarea", Object.assign({ className: "kb-textarea", "aria-label": "Ticket body", value: form.body, placeholder: "Anything the roles should know. Untrusted data, never instructions.", onChange: function (ev) { field("body", ev.target.value); } }, imageTextareaProps(imgs, bodyRef))),
				h(ImageControls, { fileRef: fileRef, ingest: imgs.ingest, drafts: imgs.drafts, onRemove: imgs.remove, error: imgs.error }),
				h("div", { className: "kb-label", children: "Acceptance (one per line, stored verbatim; may be aspirational)" }),
				h("textarea", { className: "kb-textarea", "aria-label": "Acceptance statements", value: form.acceptance, placeholder: "One acceptance statement per line…", onChange: function (ev) { field("acceptance", ev.target.value); } }),
				h("div", { className: "kb-hint", children: "This list replaces the whole acceptance: edit a line to change it, delete a line to remove it." }),
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
						h("input", { className: "kb-input", type: "number", "aria-label": "Ticket priority", style: { width: 80 }, value: form.priority, onChange: function (ev) { field("priority", ev.target.value); } })),
					h("div", { className: "kb-switchrow" },
						h(Switch, {
							ariaLabel: "Allow paid models",
							checked: form.allowPaid,
							onToggle: function (value) { field("allowPaid", value); }
						}),
						h("span", { className: "kb-label", children: "Allow paid" })),
					h("div", null, h("div", { className: "kb-label", children: "Budget USD" }),
						h("input", { className: "kb-input", type: "number", "aria-label": "Budget USD", style: { width: 100 }, value: form.budgetUsd, onChange: function (ev) { field("budgetUsd", ev.target.value); } }))),
				h("div", null, h("div", { className: "kb-label", children: "Workspace cwd" }),
					h("input", { className: "kb-input", style: { width: "100%" }, value: form.workspaceCwd, placeholder: "(engine default)", onChange: function (ev) { field("workspaceCwd", ev.target.value); } })),
				h("div", { className: "kb-row" },
					h("div", { style: { flex: 1, minWidth: 220 } },
						h("div", { className: "kb-label", children: "Preset" }),
						h(PresetPicker, { ariaLabel: "Preset", presets: props.presets, value: form.preset, onChange: function (value) { field("preset", value); } })),
					h("div", null,
						h("div", { className: "kb-label", children: "Write mode" }),
						h(SegmentedControl, {
							ariaLabel: "Write mode",
							value: form.writeMode,
							onChange: function (value) { field("writeMode", value); },
							options: WRITE_MODE_OPTIONS
						}))),
				err ? h("div", { className: "kb-err", children: err }) : null,
				h("div", { className: "kb-row" },
					h("button", { className: "kb-btn primary", disabled: busy, onClick: save, children: busy ? "Saving…" : "Save ticket" }),
					h("button", { className: "kb-btn", onClick: props.onClose, children: "Cancel" }))
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
			var targets = props.sessions || {};
			var current = phaseIndex(t.phase);
			var closed = t.phase === "closed" || t.column === "done";
			return h("div", { className: "kb-lifecycle" },
				PHASES.map(function (phase, i) {
					var done = closed || i < current;
					var active = !closed && i === current;
					var target = targets[phase] || null;
					var className = "kb-life kb-life-" + phase + (done ? " done" : "") + (active ? " active" : "") + (target ? " link" : "");
					var dot = h("span", { className: "kb-life-dot" });
					var label = h("span", { className: "kb-life-label", children: phaseLabel(phase) });
					// A step with a session is a link to it: plan opens the latest plan
					// session, build / review / approval open the build session.
					if (!target) return h("div", { key: phase, className: className }, dot, label);
					return h("button", {
						key: phase,
						type: "button",
						className: className,
						title: "Open the " + (phase === "plan" ? "plan" : "build") + " session for " + phaseLabel(phase),
						onClick: function () { if (props.onOpenSession) props.onOpenSession(target); }
					}, dot, label);
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

		function TicketMeta(props) {
			var d = props.detail;
			var t = d.ticket;
			var rows = [
				["Workspace", t.workspaceCwd || "(engine default)"],
				["Planning", t.planTiming === "now" ? "now" : "when started"],
				["Questions", t.planQuestions === "autonomous" ? "decide autonomously" : "ask me"],
				["Preset", t.preset || "harness default"],
				["Write mode", t.writeMode || "workspace write"],
				["Attempts", t.attemptCount + " / " + (d.maxAttempts || 3)],
				["Spend", fmtUsd(t.spentUsd) + (t.budgetUsd > 0 ? " / " + fmtUsd(t.budgetUsd) : " (no budget)")],
				["Allow paid", t.allowPaid ? "yes" : "no"],
				["Working time", h(LiveDur, { ticket: t })],
				["Created", fmtTime(t.createdAt)],
				["Updated", h(LiveAgo, { iso: t.updatedAt })]
			];
			if (t.closedAt) rows.push(["Closed", fmtTime(t.closedAt)]);
			return h("div", { className: "kb-panel kb-side-panel" },
				h("h3", { children: "Details" }),
				h("dl", { className: "kb-side-list" }, rows.map(function (row) {
					return h("div", { key: row[0], className: "kb-side-row" },
						h("dt", { children: row[0] }),
						h("dd", { children: row[1] }));
				}))
			);
		}

		function TicketDetail(props) {
			var d = props.detail;
			var tabState = React.useState("overview");
			var tab = tabState[0], setTab = tabState[1];
			var modalState = React.useState(null);
			var modal = modalState[0], setModal = modalState[1];
			if (!d) return h("div", { className: "kb-empty", children: "Loading ticket…" });
			var t = d.ticket;
			var detailStatus = d.status || t.status || "idle";
			var tabs = ["overview", "timeline", "sessions", "events", "ticket analytics"];
			return h("div", { className: "kb-detail" },
				h("div", { className: "kb-detail-head" },
				h("div", { className: "kb-hero " + (detailStatus === "attention" ? "kb-hero-attention" : "kb-hero-" + t.column) },
					h("div", { className: "kb-hero-top" },
						h("button", { className: "kb-btn", onClick: props.onBack, children: "← Board" }),
						h("span", { className: "kb-key", children: t.key }),
						h("span", { className: "kb-statusdot " + detailStatus, title: detailStatus, "aria-label": "Status: " + detailStatus }),
						h("span", { className: "kb-phasechip " + stageTone(t), children: stageLabel(t) }),
						h("span", { className: "kb-chip", children: t.column }),
						(t.needsAttentionReason || d.awaitingApproval) ? h("span", { className: "kb-chip err", children: d.awaitingApproval ? "awaiting approval" : (d.awaitingQuestion || d.parkedOnQuestion) ? "waiting on your answer" : "needs attention" }) : null,
						// One pencil for the whole ticket. The lock is the host's
						// answer, not a guess: `editable` is false the moment any
						// engine has touched this ticket, and the update endpoint
						// refuses it again. The title sits on a wrapper span so a
						// disabled button still explains itself on hover.
						h("span", { className: "kb-edit-lock", title: t.editable === false ? "Locked — the ticket has already started" : "Edit ticket" },
							h("button", {
								className: "kb-iconbtn",
								title: t.editable === false ? "Locked — the ticket has already started" : "Edit ticket",
								"aria-label": t.editable === false ? "Edit ticket, locked because the ticket has already started" : "Edit ticket",
								disabled: t.editable === false,
								onClick: function () { setModal("ticket"); }
							}, h(PencilIcon))),
						// KAN-16: the same button as on the card, same rule. The
						// detail keeps status and awaitingQuestion on `d` rather
						// than on the ticket, so the rule is handed a merged view
						// instead of a second copy of the condition.
						canStartPlanning({ column: t.column, phase: t.phase, planTiming: t.planTiming, status: detailStatus, awaitingQuestion: d.awaitingQuestion }) ? h("button", {
							type: "button",
							className: "kb-btn sm",
							title: "Plan this ticket now, in Backlog, without moving it to Working",
							onClick: function () { props.onAction(t.id, "startPlanning", {}); }
						}, "Start planning") : null,
						// The same move as dragging a planned ticket into Working, for a
						// ticket that is waiting at the build phase in Backlog.
						canStartBuild({ column: t.column, phase: t.phase, status: detailStatus, awaitingQuestion: d.awaitingQuestion }) ? h("button", {
							type: "button",
							className: "kb-btn sm",
							title: "Move this planned ticket to Working and start the build",
							onClick: function () { props.onAction(t.id, "startBuild", {}); }
						}, "Start build") : null,
						// KAN-17: a mid-turn human wait has no park panel to open
						// the session from — the engine is still inside the turn —
						// so the hero itself offers the way to the prompt. A
						// conditional element, never a conditional hook: the two
						// useState calls at the top of TicketDetail are the only
						// hooks this component has, and nothing here adds one.
						(d.awaitingApproval || d.awaitingQuestion || d.parkedOnQuestion) && d.approvalSessionId ? h(OpenSessionButton, {
							sessionId: d.approvalSessionId,
							label: "Open session",
							title: "Open the session that is waiting on you"
						}) : null,
						// Recovery actions. The host decides which apply (d.actions);
						// these are conditional elements, never conditional hooks.
						d.actions && d.actions.revisePlan ? h("button", {
							type: "button",
							className: "kb-btn sm",
							title: "Ask the plan session for a revised plan before the build starts",
							onClick: function () { setModal("revisePlan"); }
						}, "Revise plan") : null,
						d.actions && d.actions.markDone ? h("button", {
							type: "button",
							className: "kb-btn sm",
							title: "Close this ticket as done because the work was finished outside the engine",
							onClick: function () { setModal("markDone"); }
						}, "Mark done") : null,
						// KAN-30: a plan that declared sandbox grants parks for
						// one decision — this button. Approving the plan is the
						// one-time grant: the build starts with exactly these
						// escalations pre-approved, and everything else still
						// asks. A conditional element only, never a hook.
						t.phase === "plan" && String(t.needsAttentionReason || "").indexOf("Plan ready:") === 0 ? h("button", {
							type: "button",
							className: "kb-btn primary sm",
							title: "Approve the plan and its sandbox grants, and start the build",
							onClick: function () { props.onResolve(t.id, "approvePlan"); }
						}, "Approve plan") : null
					),
					h("h2", { className: "kb-hero-title", children: t.title }),
					h(Lifecycle, { ticket: t, sessions: d.phaseSessions, onOpenSession: function (sessionId) { openOrComplain(sessionId); } })
				),
				t.needsAttentionReason && !d.awaitingQuestion ? (t.phase === "verify" ? h(ApprovalPanel, { ticket: t, detail: d, onApprove: props.onApprove, onDiscard: function () { props.onAction(t.id, "discard", {}); } }) : h(NeedsAttention, { ticket: t, actions: d.actions, onResolve: props.onResolve, onMarkDone: function () { setModal("markDone"); } })) : null,
				d.planRevision && d.planRevision.status === "rejected" ? h("div", { className: "kb-banner-line err", role: "alert", children: "Plan revision rejected: " + d.planRevision.reason }) : null,
				d.planRevision && d.planRevision.status === "pending" ? h("div", { className: "kb-banner-line run", children: "The plan session is revising the plan…" }) : null),
				h("aside", { className: "kb-detail-side" }, h(TicketMeta, { detail: d })),
				h("div", { className: "kb-detail-main" },
				h("div", { className: "kb-tabs" }, tabs.map(function (name) {
					return h("button", { key: name, className: "kb-tab" + (tab === name ? " on" : ""), onClick: function () { setTab(name); }, children: name });
				})),
				tab === "overview" ? h(Overview, { detail: d, onSave: props.onSave, onAction: props.onAction, onEditAcceptance: function () { setModal("ticket"); } }) : null,
				tab === "timeline" ? h("div", { className: "kb-panel" },
					h("h3", { children: "Workflow timeline" }),
					h("div", { className: "kb-row", style: { marginBottom: 8 } },
						h("button", { className: "kb-btn sm", onClick: function () { rpc("export", { id: t.id, kind: "spans", format: "csv" }).then(function (res) { if (res && res.ok) download(t.key + "-spans.csv", res.value.mime, res.value.body); }); }, children: "Spans CSV" }),
						h("button", { className: "kb-btn sm", onClick: function () { rpc("export", { id: t.id, kind: "spans", format: "jsonl" }).then(function (res) { if (res && res.ok) download(t.key + "-spans.jsonl", res.value.mime, res.value.body); }); }, children: "Spans JSONL" }),
						h("button", { className: "kb-btn sm", onClick: function () { rpc("export", { id: t.id, kind: "usage", format: "csv" }).then(function (res) { if (res && res.ok) download(t.key + "-usage.csv", res.value.mime, res.value.body); }); }, children: "Usage CSV" })),
					h(Timeline, { items: d.timeline || [] })) : null,
				tab === "sessions" ? h(SessionsPanel, { detail: d, onAction: props.onAction, onRecover: props.onRecover }) : null,
				tab === "events" ? h(EventsPanel, { detail: d, liveToken: props.liveToken }) : null,
				tab === "ticket analytics" ? h(TicketAnalytics, { detail: d }) : null,
				h(Modal, { open: modal === "markDone", title: "Mark done", onClose: function () { setModal(null); } },
					h(TextActionForm, {
						hint: "Closes " + t.key + " as done and closes its sessions. Use it when the work was completed outside the engine; the reason is recorded on the ticket.",
						placeholder: "Why is this done? (required)",
						submitLabel: "Mark done",
						onSubmit: function (reason) { return props.onAction(t.id, "markDone", { reason: reason }); },
						onClose: function () { setModal(null); }
					})),
				h(Modal, { open: modal === "revisePlan", title: "Revise plan", onClose: function () { setModal(null); } },
					h(TextActionForm, {
						hint: "Sends your instruction to the plan session, which resubmits the plan. The new plan and its conditions replace the current ones as a new version.",
						placeholder: "What should change in the plan? (required)",
						submitLabel: "Send to plan session",
						onSubmit: function (instruction) { return props.onAction(t.id, "revisePlan", { instruction: instruction }); },
						onClose: function () { setModal(null); }
					})),
				h(Modal, { open: modal === "ticket", title: "Edit ticket", onClose: function () { setModal(null); } },
					h(TicketEditor, {
						ticket: t,
						acceptance: d.acceptance,
						presets: props.presets || null,
						onClose: function () { setModal(null); },
						onSave: function (patch) {
							// images is a sibling of patch on the wire: the Host
							// stores the uploads, then applies the patch whose
							// body carries the resolved refs.
							var images = patch.images;
							var clean = Object.assign({}, patch);
							delete clean.images;
							return props.onSave(t.id, clean, images || []);
						}
					})))
			);
		}


		// A button that opens a workflow session and says what happened: a
		// loading label while it works, the failure message when it cannot.
		function OpenSessionButton(props) {
			var st = React.useState({ phase: "idle", error: "" });
			var state = st[0], setState = st[1];
			var mounted = React.useRef(true);
			React.useEffect(function () { mounted.current = true; return function () { mounted.current = false; }; }, []);
			function click() {
				if (state.phase === "loading") return;
				setState({ phase: "loading", error: "" });
				var opening = openSessionById ? openSessionById(props.sessionId) : Promise.resolve({ ok: false, error: "The session view is not available in this window." });
				opening.then(function (result) {
					if (!mounted.current) return;
					setState(result && result.ok ? { phase: "idle", error: "" } : { phase: "error", error: (result && result.error) || "The session could not be opened." });
				});
			}
			return h(React.Fragment, null,
				h("button", { type: "button", className: props.className || "kb-btn sm", style: props.style, title: props.title, disabled: state.phase === "loading", onClick: click, children: state.phase === "loading" ? "Opening…" : props.label }),
				state.phase === "error" ? h("span", { className: "kb-open-error", role: "alert", children: state.error }) : null);
		}

		// One required line of text and a submit: the shape of Mark done (a
		// reason) and Revise plan (an instruction). The server's refusal is shown
		// in the form, not lost to the page notice.
		function TextActionForm(props) {
			var st = React.useState("");
			var text = st[0], setText = st[1];
			var bs = React.useState(false);
			var busy = bs[0], setBusy = bs[1];
			var es = React.useState("");
			var error = es[0], setError = es[1];
			function submit() {
				setBusy(true);
				setError("");
				props.onSubmit(text.trim()).then(function (res) {
					setBusy(false);
					if (res && res.ok) props.onClose();
					else setError(res && res.error ? res.error.message : "That did not work.");
				}, function () { setBusy(false); setError("Could not reach the Host."); });
			}
			return h("div", { className: "kb-form" },
				h("div", { className: "kb-hint", style: { marginBottom: 8 }, children: props.hint }),
				h("textarea", { className: "kb-textarea", autoFocus: true, placeholder: props.placeholder, value: text, onChange: function (ev) { setText(ev.target.value); } }),
				error ? h("div", { className: "kb-open-error", role: "alert", style: { marginLeft: 0, marginTop: 6 }, children: error }) : null,
				h("div", { className: "kb-row", style: { marginTop: 8 } },
					h("button", { type: "button", className: "kb-btn primary sm", disabled: busy || text.trim() === "", onClick: submit, children: busy ? "Working…" : props.submitLabel }),
					h("button", { type: "button", className: "kb-btn sm", disabled: busy, onClick: props.onClose, children: "Cancel" })));
		}

		function ApprovalPanel(props) {
			var d = props.detail;
			var sessionId = d.approvalSessionId;
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			return h("div", { className: "kb-panel", style: { borderColor: "#f3b3ac", background: "#fffafa" } },
				h("h3", { children: "Approval" }),
				h("div", { className: "kb-hint", style: { marginBottom: 8 }, children: "The review is complete and every planned condition is accounted for. Approval happens in the build session: the agent wraps up, tells you what it did, and asks what to do next. Approve or discard here, or answer it in that session." }),
				h("div", { className: "kb-row" },
					h("button", { className: "kb-btn primary sm", disabled: busy, onClick: function () { setBusy(true); props.onApprove(props.ticket.id).finally(function () { setBusy(false); }); }, children: "Approve and close" }),
					h("button", { className: "kb-btn danger sm", disabled: busy, onClick: props.onDiscard, children: "Discard" }),
					sessionId
						? h(OpenSessionButton, { sessionId: sessionId, label: "Open build session" })
						: null)
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
					props.actions && props.actions.rerunReview ? h("button", {
						className: "kb-btn sm", disabled: busy,
						title: "The work exists and nothing is left to implement: go straight to review",
						onClick: function () { setBusy(true); props.onResolve(props.ticket.id, "rerunReview", instruction).finally(function () { setBusy(false); }); },
						children: "Re-run review"
					}) : null,
					props.actions && props.actions.markDone ? h("button", {
						className: "kb-btn sm", disabled: busy,
						title: "Close this ticket as done: the work was finished outside the engine",
						onClick: props.onMarkDone,
						children: "Mark done"
					}) : null,
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
				h("div", { className: "kb-panel kb-md" },
					h("h3", { children: "Body" }),
					t.body && String(t.body).trim() !== "" ? renderMarkdown(t.body) : h("div", { className: "kb-hint", children: "Nothing written yet." })
				),
				h("div", { className: "kb-panel" },
					h("div", { className: "kb-panelhead" },
						h("h3", { children: "Acceptance — the human's words, verbatim" }),
						h("button", { className: "kb-iconbtn", title: "Edit acceptance criteria", "aria-label": "Edit acceptance criteria", onClick: props.onEditAcceptance }, h(PencilIcon))
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
								return h("tr", { key: c.id }, h("td", null, h("code", { children: c.id })), h("td", null, c.statement, c.deferred ? h("span", { className: "kb-hint", children: " (deferred to approval)" }) : null), h("td", { children: c.howVerified }), h("td", { children: c.source }));
							})))
				),
				// KAN-30: what the plan asked to be allowed outside the sandbox,
				// and the read-only evidence the planner gathered for it. The
				// grants ride in the plan artifact, so this is exactly the set
				// the Approve-plan action makes live — and a plan without any
				// renders nothing, the way it did before grants existed.
				d.plan && d.plan.sandbox ? h("div", { className: "kb-panel" },
					h("h3", { children: "Sandbox grants — what the build may do without asking" }),
					d.plan.sandbox.grants && (d.plan.sandbox.grants.paths || []).length > 0 ? h("div", { style: { marginBottom: 6 } },
						h("div", { className: "kb-hint", children: "write paths" }),
						h("ul", { style: { margin: "2px 0 0", paddingLeft: 18 } }, d.plan.sandbox.grants.paths.map(function (p, i) {
							return h("li", { key: i }, h("code", { children: p }));
						}))) : null,
					d.plan.sandbox.grants && (d.plan.sandbox.grants.commands || []).length > 0 ? h("div", { style: { marginBottom: 6 } },
						h("div", { className: "kb-hint", children: "command prefixes" }),
						h("ul", { style: { margin: "2px 0 0", paddingLeft: 18 } }, d.plan.sandbox.grants.commands.map(function (c, i) {
							return h("li", { key: i }, h("code", { children: c }));
						}))) : null,
					(d.plan.sandbox.checks || []).length > 0 ? h("table", { className: "kb-table", style: { marginTop: 8 } },
						h("thead", null, h("tr", null, h("th", { children: "path" }), h("th", { children: "check" }), h("th", { children: "observed" }))),
						h("tbody", null, d.plan.sandbox.checks.map(function (row, i) {
							return h("tr", { key: i }, h("td", null, h("code", { children: row.path })), h("td", null, h("code", { children: row.check })), h("td", { children: row.observed }));
						}))) : null
				) : null,
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
									h(OpenSessionButton, { sessionId: session.sessionId, label: "Open", style: { marginLeft: 8 } }),
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

		// The lifecycle log is read when its tab is open, not carried with every
		// refresh of the ticket: it is looked at again whenever the Host says
		// something changed.
		function EventsPanel(props) {
			var st = React.useState(props.detail.events || null);
			var events = st[0], setEvents = st[1];
			var ticketId = props.detail.ticket.id;
			var liveToken = props.liveToken;
			React.useEffect(function () {
				var alive = true;
				rpc("events", { id: ticketId, limit: 300 }).then(function (res) {
					if (alive && res && res.ok && Array.isArray(res.value)) setEvents(res.value);
				});
				return function () { alive = false; };
			}, [ticketId, liveToken]);
			if (events === null) return h("div", { className: "kb-panel" }, h("h3", { children: "Event log" }), h("div", { className: "kb-hint", children: "Loading events…" }));
			return h("div", { className: "kb-panel" },
				h("h3", { children: "Event log" }),
				events.length === 0 ? h("div", { className: "kb-hint", children: "No events." }) :
					h("table", { className: "kb-table" },
						h("thead", null, h("tr", null, h("th", { children: "at" }), h("th", { children: "kind" }), h("th", { children: "actor" }), h("th", { children: "phase" }), h("th", { children: "detail" }))),
						h("tbody", null, events.slice().reverse().map(function (e) {
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

		// The reasoning levels the catalog offers for one exact model, in catalog
		// order. Empty means "not a reasoning model" (or not in the catalog yet),
		// and the row then shows no effort control at all.
		function effortsForModel(groups, provider, model) {
			var list = groups || [];
			for (var i = 0; i < list.length; i += 1) {
				var group = list[i];
				if (!group || group.id !== provider) continue;
				var models = group.models || [];
				for (var j = 0; j < models.length; j += 1) {
					var candidate = models[j];
					if (!candidate || candidate.id !== model) continue;
					var reasoning = candidate.reasoning;
					return reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
				}
			}
			return [];
		}

		// The effort a role row is allowed to send. A level survives only if the
		// model on that row actually offers it: a stale one — a hand-edited row,
		// or a provider-config swap that dropped the model's reasoning metadata —
		// has no control on screen to clear it (the picker is hidden), and the
		// host rejects the whole payload for one bad row, so nothing could be
		// saved at all. Such a level goes out as Default instead. When the model
		// is not in the catalog at all the value is left alone and the host, which
		// reads the live registry, decides.
		function sendableEffort(groups, provider, model, effort) {
			if (effort === "" || effort === undefined || effort === null) return null;
			var known = false;
			(groups || []).forEach(function (group) {
				if (!group || group.id !== provider) return;
				(group.models || []).forEach(function (candidate) {
					if (candidate && candidate.id === model) known = true;
				});
			});
			if (!known) return effort;
			var offered = effortsForModel(groups, provider, model);
			for (var i = 0; i < offered.length; i += 1) {
				if (offered[i].id === effort) return effort;
			}
			return null;
		}

		function RoleRouting(props) {
			var routes = props.routes || {};
			var roles = props.roles || {};
			var labels = { planner: "Plan", implementer: "Build", reviewer: "Review", approver: "Approval" };
			var order = ["planner", "implementer", "reviewer", "approver"];
			return h("div", { className: "kb-routing" },
				h("div", { className: "kb-routing-sub", children: props.editing ? "Choose a model and reasoning effort for each role. Models are grouped by provider; \"Default\" leaves the effort to the model. Saving writes the kanban row in the profile config." : "Base route per role. The escalation ladder can override this for later attempts." }),
				h("div", { className: "kb-route-rows" }, order.map(function (role) {
					var route = routes[role] || {};
					var config = roles[role] || {};
					var isFallback = config.provider === null || config.provider === undefined || config.model === null || config.model === undefined;
					if (props.editing) {
						var entry = props.draft[role] || { provider: route.provider || "", model: route.model || "", reasoningEffort: route.reasoningEffort || "" };
						var groups = props.groups || [];
						var current = entry.provider + "\u0000" + entry.model;
						var effort = entry.reasoningEffort || "";
						var known = groups.some(function (group) { return group.id === entry.provider && group.models.some(function (model) { return model.id === entry.model; }); });
						var efforts = effortsForModel(groups, entry.provider, entry.model);
						return h("div", { className: "kb-route-row kb-route-edit kb-route-" + role, key: role },
							h("div", { className: "kb-route-label" }, h("b", { children: labels[role] }), h("span", { children: role })),
							h("select", { className: "kb-select kb-route-picker", value: current, onChange: function (event) {
								var parts = event.target.value.split("\u0000");
								var nextProvider = parts[0] || "";
								var nextModel = parts[1] || "";
								var patch = { provider: nextProvider, model: nextModel };
								// A level the new model does not offer would only be
								// rejected on save, so drop it back to Default here.
								if (effort !== "" && !effortsForModel(groups, nextProvider, nextModel).some(function (candidate) { return candidate.id === effort; })) {
									patch.reasoningEffort = "";
								}
								props.onDraft(role, patch);
							} },
								known ? null : h("option", { value: current, children: (entry.provider || "?") + " / " + (entry.model || "?") + " (not in catalog)" }),
								groups.map(function (group) {
									return h("optgroup", { key: group.id, label: group.id },
										group.models.map(function (model) { return h("option", { key: model.id, value: group.id + "\u0000" + model.id, children: model.name || model.id }); }));
								})
							),
							efforts.length > 0 ? h("select", {
								className: "kb-select kb-route-effort-picker",
								"aria-label": labels[role] + " reasoning effort",
								title: "Reasoning effort (" + entry.provider + "/" + entry.model + ")",
								value: effort,
								onChange: function (event) { props.onDraft(role, { reasoningEffort: event.target.value }); },
							},
								h("option", { value: "", children: "Default" }),
								efforts.map(function (candidate) { return h("option", { key: candidate.id, value: candidate.id, children: candidate.name || candidate.id }); })
							) : null
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
			var live = useBoardStore();
			var board = live.board;
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
			// What the long-lived callbacks need to read: the current selection and
			// the detail on screen. Callbacks that outlive a render (the cards keep
			// theirs) read these instead of values captured when they were made.
			var selectedRef = React.useRef(null);
			selectedRef.current = selectedId;
			var detailRef = React.useRef(null);
			detailRef.current = detail;
			var bodyRef = React.useRef(null);

			// The Done / Discarded column is pinned at the height of the visible
			// board, so scrolling the page never moves it. The height is the body's
			// own scrollport, measured, because the board does not own the viewport.
			React.useEffect(function () {
				var el = bodyRef.current;
				if (!el) return undefined;
				function measure() { el.style.setProperty("--kb-pin-h", Math.max(240, el.clientHeight - 12) + "px"); }
				measure();
				var observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
				if (observer) observer.observe(el);
				window.addEventListener("resize", measure);
				return function () { if (observer) observer.disconnect(); window.removeEventListener("resize", measure); };
			}, []);

			// kanban-goBoardRequest: the sidebar panel row's bridge to this page's
			// state. Clicking the row while the kanban panel is already active
			// re-selects the same main key, so the store writes nothing and this
			// component stays mounted with whatever view/detail it had. The row's
			// click handler (registered in apply()) calls this to do exactly what
			// the top Board button does: show the board, close the detail.
			goBoardRequest = function () {
				setView("board");
				setSelectedId(null);
				setDetail(null);
			};

			// The board arrives by itself (see the live board store); this asks for
			// it right now, after something this page did or on request.
			function loadBoard() {
				boardStore.refresh().then(function (problem) { if (problem) setNotice(problem); });
			}
			// The ticket on screen. The Host is told which version this page holds
			// and answers "unchanged" in a line when nothing moved. The event log is
			// not part of it: its tab asks for it itself.
			function loadDetail(id) {
				var held = detailRef.current;
				var since = held && held.ticket && held.ticket.id === id ? held.token : undefined;
				rpc("ticket", { id: id, since: since, events: false }).then(function (res) {
					if (selectedRef.current !== id) return;
					if (res && res.ok) {
						if (res.value && res.value.unchanged) return;
						if (res.value && res.value.ticket) res.value.ticket.readAt = Date.now();
						setDetail(res.value);
					} else if (res && res.error) { setNotice(res.error.message); }
				});
			}
			// The workspace and preset lists are read when the page opens and again
			// each time the new-ticket form does; they are not worth a poll.
			React.useEffect(function () {
				rpc("workspaces", {}).then(function (res) { if (res && res.ok && res.value) setWorkspaces(res.value.items || []); });
				rpc("capabilities", {}).then(function (res) { if (res && res.ok && res.value) setCapabilities(res.value); });
			}, [creating]);
			// The routing rules are read when the dialog opens.
			React.useEffect(function () {
				if (!routingOpen) return;
				rpc("config", {}).then(function (res) { if (res && res.ok && res.value) setRouting(res.value); });
			}, [routingOpen]);
			// The open ticket is fetched when it is selected, then again whenever the
			// Host says something changed (at most a few times a second). A ticket
			// whose working time is still growing is also looked at every ten seconds
			// while the tab is visible, so its live bars keep moving.
			var liveToken = live.token;
			var previousSelected = React.useRef(null);
			React.useEffect(function () {
				if (!selectedId) { previousSelected.current = null; return undefined; }
				var fresh = previousSelected.current !== selectedId;
				previousSelected.current = selectedId;
				var timer = setTimeout(function () { loadDetail(selectedId); }, fresh ? 0 : 300);
				return function () { clearTimeout(timer); };
			}, [selectedId, liveToken]);
			var detailRunning = Boolean(detail && detail.ticket && (detail.ticket.accruing || (detail.timeline || []).some(function (item) { return item.status === "running"; })));
			React.useEffect(function () {
				if (!selectedId || !detailRunning) return undefined;
				var timer = setInterval(function () { if (!document.hidden) loadDetail(selectedId); }, 10000);
				return function () { clearInterval(timer); };
			}, [selectedId, detailRunning]);
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
						if (selectedRef.current) loadDetail(selectedRef.current);
					} else {
						setNotice(res && res.error ? res.error.message : "That did not work.");
					}
					return res;
				}, function () { setNotice("Could not reach the Host."); });
			}

			var columns = board ? board.columns : { backlog: [], working: [], done: [], discarded: [] };
			var allTickets = Object.keys(columns).reduce(function (list, column) { return list.concat(columns[column] || []); }, []);
			// Done and Discarded share one column, newest closed first (the host
			// sends it ordered; the concat covers a payload without `closed`).
			var closedItems = columns.closed || (board && board.closed) || (columns.done || []).concat(columns.discarded || []);
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
				h("div", { className: "kb-body", ref: bodyRef },
					notice || live.error ? h("div", { className: "kb-notice" }, notice || live.error) : null,
					h(Modal, { open: creating, title: "New ticket", onClose: function () { setCreating(false); } }, h(CreateForm, { workspaces: workspaces, worktreeAvailable: Boolean(capabilities.worktree), presets: capabilities.presets || null, onClose: function () { setCreating(false); }, onCreated: function (ticket) { setCreating(false); setSelectedId(ticket.id); loadBoard(); } })),
					selectedId ? h(TicketDetail, {
						detail: detail,
						liveToken: liveToken,
						presets: capabilities.presets || null,
						onBack: function () { setSelectedId(null); setDetail(null); },
						onSave: function (id, patch, images) { return act("update", { id: id, patch: patch, images: images || [] }); },
						onResolve: function (id, action, instruction) { return act("resolve", { id: id, action: action, instruction: instruction }); },
						onAction: function (id, action, extra) { return act("action", Object.assign({ id: id, action: action }, extra || {})); },
						onApprove: function (id) { return act("action", { id: id, action: "approve" }); },
						onRecover: function (sessionId) { return act("action", { id: selectedId, action: "recoverSession", sessionId: sessionId }); }
					}) : view === "analytics" ? h("div", { style: { maxWidth: 900 } }, h(AnalyticsPanel, { data: analyticsData })) : h("div", null,
						h("div", { className: "kb-cols" },
							h(Column, { column: "backlog", label: "Backlog", items: columns.backlog, onOpen: open, dragId: dragId, dropTarget: dropTarget, onDragStart: startDrag, onDragEnd: finishDrag, onDragOverColumn: dragOverColumn, onDropAt: dropAt, onStartPlanning: startPlanningNow, onStartBuild: startBuildNow }),
							h(Column, { column: "working", label: "Working", items: columns.working, onOpen: open, dragId: dragId, dropTarget: dropTarget, onDragStart: startDrag, onDragEnd: finishDrag, onDragOverColumn: dragOverColumn, onDropAt: dropAt, onStartPlanning: startPlanningNow, onStartBuild: startBuildNow }),
							h(Column, { column: "done", label: "Done / Discarded", items: closedItems, onOpen: open, dragId: dragId, dropTarget: dropTarget, onDragStart: startDrag, onDragEnd: finishDrag, onDragOverColumn: dragOverColumn, onDropAt: dropAt })
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
					// A level the row's model does not offer is dropped here, not
					// just hidden, so the draft can never carry an unsendable value.
					draft[role] = { provider: route.provider || "", model: route.model || "", reasoningEffort: sendableEffort(routing.groups, route.provider, route.model, route.reasoningEffort) || "" };
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
				var routes = roles.map(function (role) {
					var entry = routingDraft[role] || {};
					// Same rule as the seed, applied at the boundary: "" is the
					// dialog's Default, and a level the row's model does not offer
					// goes out as null so the host clears it instead of rejecting
					// the whole save.
					return {
						role: role,
						provider: entry.provider,
						model: entry.model,
						reasoningEffort: sendableEffort(routing.groups, entry.provider, entry.model, entry.reasoningEffort),
					};
				});
				setRoutingSaving(true);
				setRoutingError(null);
				rpc("setRoutes", { routes: routes, revision: routing.revision }).then(function (res) {
					if (res && res.ok) {
						var nextRoutes = Object.assign({}, routing.routes);
						routes.forEach(function (route) { nextRoutes[route.role] = Object.assign({}, nextRoutes[route.role] || {}, { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }); });
						setRouting(Object.assign({}, routing, { routes: nextRoutes }));
						setRoutingEditing(false);
						setTimeout(function () { rpc("config", {}).then(function (next) { if (next && next.ok) setRouting(next.value); }); }, 6000);
					} else {
						setRoutingError(res && res.error ? res.error.message : "Could not save routing.");
					}
				}, function () { setRoutingError("Could not reach the Host."); }).finally(function () { setRoutingSaving(false); });
			}
			function open(id) { setSelectedId(id); }
			function reorder(id, beforeId) {
				if (id === beforeId) return Promise.resolve(null);
				var payload = { id: id };
				if (beforeId) payload.beforeId = beforeId;
				return rpc("reorder", payload);
			}
			// Through `act` so a failure lands in the page notice and a success
			// refreshes the board (and the detail, if one is open).
			function startPlanningNow(id) {
				return act("action", { id: id, action: "startPlanning" });
			}
			function startBuildNow(id) {
				return act("action", { id: id, action: "startBuild" });
			}
			function startDrag(id) {
				setDragId(id);
				setDropTarget(null);
			}
			function finishDrag() {
				setDragId(null);
				setDropTarget(null);
			}
			// Called continuously while the pointer moves: only a changed target
			// is state, so a still pointer re-renders nothing.
			function dragOverColumn(column, beforeId) {
				if (dragId === null || column === "done") return;
				setDropTarget(function (prev) {
					return prev && prev.column === column && prev.beforeId === beforeId ? prev : { column: column, beforeId: beforeId };
				});
			}
			function dropAt(id, column, beforeId) {
				finishDrag();
				if (column === "done") return;
				var source = allTickets.find(function (ticket) { return ticket.id === id; });
				if (source === undefined) return;
				var ids = (columns[column] || []).map(function (ticket) { return ticket.id; });
				var sameColumn = source.column === column;
				if (sameColumn && dropIsNoop(ids, id, beforeId)) return;
				// Show the card where it was dropped before the requests return,
				// and hold back boards from the Host until they have: an older one
				// would put the card back where it was for a moment.
				boardStore.hold();
				boardStore.update(function (prev) { return Object.assign({}, prev, { columns: moveInColumns(prev.columns, id, column, beforeId) }); });
				var work = sameColumn ? reorder(id, beforeId) : rpc("move", { id: id, column: column }).then(function (res) {
					if (res && res.ok && ids.length > 0) return reorder(id, beforeId);
					return res;
				});
				work.then(function (res) {
					if (res && res.ok === false) setNotice(res.error ? res.error.message : "That did not work.");
					else setNotice(null);
				}, function () { setNotice("Could not reach the Host."); }).then(function () {
					boardStore.release();
					loadBoard();
					if (selectedRef.current) loadDetail(selectedRef.current);
				});
			}
		}

		// ------------------------------------------------- phase-change banner
		//
		// A turn that ends on a kanban_* tool call moved the ticket, but the
		// chat view only showed the call. This entry renders one line at the
		// turn tail — below the "Completed in …" disclosure, never folded into
		// it — naming the transition the turn caused.
		//
		// The call itself is not proof: a phase-gated call can be refused and a
		// submission can be rejected by validation, and both look identical in
		// the transcript. So the banner is validated against the ticket's real
		// phase through the host's sessionInfo endpoint, and renders nothing
		// until that phase confirms the transition. The engine settles the
		// phase a beat after the turn concludes, so an unconfirmed banner
		// retries on a short backoff and then gives up quietly.

		var PHASE_ORDER = { plan: 0, implement: 1, review: 2, verify: 3, closed: 4 };
		var BANNER_RETRIES = 5;
		// Confirmed banners only: a turn that has not been validated yet must
		// refetch, so failures are deliberately never cached.
		var bannerCache = new Map();
		// One entry per kanban turn ever rendered, in one browser tab that may stay
		// open for weeks, so the cache needs a ceiling. A Map keeps insertion order,
		// so the first key is the oldest entry and eviction is one delete.
		var BANNER_CACHE_MAX = 200;

		function rememberBanner(key, value) {
			if (bannerCache.has(key)) bannerCache.delete(key);
			bannerCache.set(key, value);
			while (bannerCache.size > BANNER_CACHE_MAX) {
				var oldest = bannerCache.keys().next();
				if (oldest.done) break;
				bannerCache.delete(oldest.value);
			}
		}

		function parseToolArgs(raw) {
			if (typeof raw !== "string" || raw === "") return {};
			try {
				var value = JSON.parse(raw);
				return value !== null && typeof value === "object" ? value : {};
			} catch (error) {
				return {};
			}
		}

		function kanbanCallsInTurn(turn) {
			var out = [];
			var steps = turn && Array.isArray(turn.steps) ? turn.steps : [];
			for (var i = 0; i < steps.length; i += 1) {
				var reader = steps[i] ? steps[i].data : null;
				if (!reader || typeof reader.get !== "function") continue;
				var assistant = null;
				try {
					assistant = reader.get("assistant-step");
				} catch (error) {
					assistant = null;
				}
				var blocks = assistant && Array.isArray(assistant.blocks) ? assistant.blocks : [];
				for (var j = 0; j < blocks.length; j += 1) {
					var block = blocks[j];
					if (!block || block.kind !== "tool-call") continue;
					if (typeof block.name !== "string" || block.name.indexOf("kanban_") !== 0) continue;
					out.push({ name: block.name, args: parseToolArgs(block.argsRaw) });
				}
			}
			return out;
		}

		// One line, always: the CSS ellipsis does the truncating and the element's
		// title carries the whole thing, so a long plan summary or review
		// instruction is shortened for the eye and never for the reader who wants
		// the rest.
		function oneLine(value) {
			return String(value === null || value === undefined ? "" : value).replace(/\s+/g, " ").trim();
		}

		/** What a review call said for itself: its instruction, else its reasons. */
		function callFeedback(args) {
			if (!args || typeof args !== "object") return "";
			var instruction = typeof args.instruction === "string" ? args.instruction : "";
			var reasons = Array.isArray(args.reasons)
				? args.reasons.filter(function (r) { return typeof r === "string"; }).join("; ")
				: "";
			return oneLine(instruction !== "" ? instruction : reasons);
		}

		/**
		 * Is the ticket's latest review artifact the one this call submitted? The
		 * engine stores the submitted object verbatim, so verdict, reasons and
		 * condition ids together identify it. Absent or unreadable args cannot be
		 * matched, and are treated as latest so an old transcript still renders.
		 */
		function sameReview(args, review) {
			if (!review || typeof review !== "object") return false;
			if (!args || typeof args !== "object" || Object.keys(args).length === 0) return true;
			var parts = (value) => [
				String(value.verdict || "").toLowerCase(),
				Array.isArray(value.reasons) ? value.reasons.join("|") : "",
				Array.isArray(value.done_when) ? value.done_when.map((row) => String(row && row.id)).join("|") : "",
				String(value.instruction || ""),
			];
			var mine = parts(args);
			var theirs = parts(review);
			// Nothing to identify by — a truncated argsRaw. The verdict alone is all
			// there is, so compare that rather than silence a real transition.
			if (mine.slice(1).every((part) => part === "")) return mine[0] === theirs[0];
			return mine.join("::") === theirs.join("::");
		}

		function conditionIds(info) {
			var plan = info && info.plan;
			var list = plan && Array.isArray(plan.conditions) ? plan.conditions : (plan && Array.isArray(plan.done_when) ? plan.done_when : []);
			var ids = list.map(function (item) { return item && item.id ? String(item.id) : ""; }).filter(Boolean);
			return ids.join(", ");
		}

		/**
		 * Decide the one banner line for a turn, or null when nothing about this
		 * turn is confirmed yet. Two sources, and each answers a different question:
		 * the call's own arguments say what this turn tried to do, and the ticket's
		 * real phase says whether it actually happened. A banner needs both — the
		 * phase alone cannot tell a failed review from a later passed one in the
		 * same session, and the call alone cannot tell an accepted submission from
		 * one a phase gate refused.
		 */
		function bannerFor(calls, info) {
			if (!info || !info.ticket) return null;
			var ticket = info.ticket;
			var phase = String(ticket.phase || "");
			var order = Object.prototype.hasOwnProperty.call(PHASE_ORDER, phase) ? PHASE_ORDER[phase] : -1;
			var summary = info.plan && typeof info.plan.summary === "string" ? oneLine(info.plan.summary) : "";
			var ids = conditionIds(info);
			for (var i = calls.length - 1; i >= 0; i -= 1) {
				var name = calls[i].name;
				if (name === "kanban_submit_plan" && info.plan && order >= PHASE_ORDER.implement) {
					return {
						tone: "plan",
						text: "Plan submitted" + (summary ? " — " + summary : "") + (ids ? " · Done when: " + ids : "") + ". Now proceeding to build.",
					};
				}
				if (name === "kanban_submit_implementation" && order >= PHASE_ORDER.review) {
					return {
						tone: "build",
						text: "Implementation submitted — here's the plan: " + (summary || "see the plan") + (ids ? " · done when: " + ids : "") + ". Now proceeding to self-review.",
					};
				}
				if (name === "kanban_submit_review") {
					// Which transition to look for is decided by the verdict THIS call
					// carried, not by where the ticket happens to sit now. A session
					// with one rework round holds a failed review and a later passed
					// one, and reading only the current phase would label both of
					// them "Review passed" — the opposite of what the first turn did.
					var verdict = typeof calls[i].args.verdict === "string" ? calls[i].args.verdict.toLowerCase() : "";
					// And an outcome belongs to this turn only if the ticket's latest
					// review is the one this call submitted. The engine stores the
					// submitted object verbatim, so a mismatch means a later round has
					// already replaced it and nothing can be claimed here.
					var isLatest = sameReview(calls[i].args, info.review);
					// The text is the call's own too: info.reviewFeedback is the
					// ticket's latest artifact, so every earlier round would else
					// display the newest round's feedback.
					var own = callFeedback(calls[i].args);
					if (verdict === "fail" && phase === "implement") {
						// The call's own instruction is truthful about this turn
						// whatever round the ticket is in now, so no identity check is
						// needed here — only the phase, which confirms a fail actually
						// sent the work back.
						var failText = own !== "" ? own : oneLine(info.reviewFeedback || "");
						return { tone: "warn", text: "Review status: not finished" + (failText ? " — " + failText : "") + ". Back to implementation." };
					}
					if (verdict === "pass" && order >= PHASE_ORDER.verify && isLatest) {
						return { tone: "ok", text: "Review passed — all conditions met. Now proceeding to approval." };
					}
					if (verdict === "pass" && phase === "implement" && isLatest && info.reviewRejected === true) {
						// The reviewer claimed a complete pass and the code check sent
						// it back: the gaps are the engine's, so the ticket's feedback
						// is the honest text here and the call's own is the fallback.
						// `reviewRejected` is what proves that reading. Without it a
						// pass that landed and was later returned to implement by an
						// approval follow-up plan would be called "not finished" — the
						// opposite of its own turn, which is the whole bug this banner
						// exists to avoid.
						var gaps = oneLine(info.reviewFeedback || "");
						if (gaps === "") gaps = own;
						return { tone: "warn", text: "Review status: not finished" + (gaps ? " — " + gaps : "") + ". Back to implementation." };
					}
					// No verdict to read means the call's args never parsed — a turn
					// interrupted mid-call, or a tool-call block still streaming
					// (argsRaw is documented as "original argument JSON or incomplete
					// raw text"). A schema-valid review always carries a verdict, so
					// there is nothing to infer here: rendering a phase-only reading
					// would claim an outcome for a call that may never have run, which
					// is the exact mistake the last two releases removed. Silence.
				}
				if (name === "kanban_approve" && ticket.column === "done") {
					return { tone: "ok", text: "Ticket approved and closed." };
				}
				if (name === "kanban_discard" && ticket.column === "discarded") {
					return { tone: "warn", text: "Ticket discarded." };
				}
			}
			return null;
		}

		function fetchSessionInfo(sessionId) {
			return rpc("sessionInfo", { sessionId: sessionId }).then(function (res) {
				return res && res.ok && res.value ? res.value : null;
			}, function () {
				return null;
			});
		}

		function PhaseBanner(props) {
			var turn = props.turn;
			var sessionId = props.kanbanSessionId;
			var calls = React.useMemo(function () { return turn ? kanbanCallsInTurn(turn) : []; }, [turn]);
			var state = React.useState(null);
			var banner = state[0], setBanner = state[1];
			var turnKey = turn && typeof turn.turn === "number" ? turn.turn : -1;
			React.useEffect(function () {
				if (!sessionId || calls.length === 0) return undefined;
				var cacheKey = sessionId + ":" + turnKey;
				if (bannerCache.has(cacheKey)) {
					setBanner(bannerCache.get(cacheKey));
					return undefined;
				}
				var alive = true;
				var timer = 0;
				var tries = 0;
				function attempt() {
					tries += 1;
					fetchSessionInfo(sessionId).then(function (info) {
						if (!alive) return;
						var next = bannerFor(calls, info);
						if (next) {
							rememberBanner(cacheKey, next);
							setBanner(next);
							return;
						}
						if (tries < BANNER_RETRIES) timer = setTimeout(attempt, tries * 1500);
					});
				}
				attempt();
				return function () {
					alive = false;
					if (timer) clearTimeout(timer);
				};
			}, [sessionId, turnKey, calls]);
			if (!banner) return null;
			return h("div", { className: "kb-banner " + banner.tone, title: banner.text, children: h("span", { className: "kb-banner-text", children: banner.text }) });
		}

		// ------------------------------------------------------------------ apply

		function apply(ctx) {
			connection = ctx.connection !== undefined ? ctx.connection : ctx.get ? ctx.get("connection") : null;
			openSessionById = function (sessionId) {
				return new Promise(function (resolveOpen) {
					function failed(text) { resolveOpen({ ok: false, error: text }); }
					try {
						var uiWorkspace = ctx.get("uiWorkspace");
						if (!uiWorkspace || typeof uiWorkspace.openSession !== "function") { failed("The session view is not available in this window."); return; }
						// A session the list has finished loading and does not
						// contain is gone (deleted, or never reached the list):
						// say so instead of navigating to nothing.
						var snapshot = uiWorkspace.sessions && uiWorkspace.sessions.list && typeof uiWorkspace.sessions.list.getSnapshot === "function" ? uiWorkspace.sessions.list.getSnapshot() : null;
						if (snapshot && snapshot.phase === "ready" && snapshot.byId && !snapshot.byId[sessionId]) { failed("Session " + sessionId + " is not in the session list; it may have been deleted."); return; }
						var opened = uiWorkspace.openSession(sessionId);
						Promise.resolve(opened).then(function () {
							// Hold the loading state until the session is the current one
							// (bounded), so the click visibly does something.
							var waited = 0;
							(function settle() {
								var now = uiWorkspace.sessions && uiWorkspace.sessions.list && typeof uiWorkspace.sessions.list.getSnapshot === "function" ? uiWorkspace.sessions.list.getSnapshot() : null;
								if (!now || now.current === sessionId || waited >= 1500) { resolveOpen({ ok: true }); return; }
								waited += 100;
								setTimeout(settle, 100);
							})();
						}, function (error) { failed("Could not open the session: " + (error && error.message ? error.message : String(error))); });
					} catch (error) {
						failed("Could not open the session: " + (error && error.message ? error.message : String(error)));
					}
				});
			};
			var slots = ctx.slots !== undefined ? ctx.slots : ctx.get ? ctx.get("slots") : undefined;
			if (!slots) {
				console.error("dsh-kanban: slots service missing - the board stays off");
				return;
			}
			ensureStyles();
			// Clicking this plugin's own sidebar row while the kanban panel is
			// already active would otherwise do nothing: the row's selectPanel
			// writes the same store value, no subscriber notification fires, and
			// KanbanPage stays mounted on whatever view or ticket detail it had.
			// Capture the click before React's own handler and reset the page to
			// the Board, exactly what the top Board button does. The row is
			// identified by the plugin-unique icon wrapper it renders — present in
			// both the wide sidebar and the collapsed rail — and the layout guard
			// means the reset only happens when kanban is already the active
			// panel; a click that first opens the panel needs no reset, the page
			// mounts on the board. If the layout service is unavailable the guard
			// degrades to always resetting: harmless, since goBoardRequest only
			// exists while KanbanPage is mounted.
			var layout = null;
			try {
				layout = ctx.layout !== undefined ? ctx.layout : ctx.get ? ctx.get("layout") : null;
			} catch (error) { layout = null; }
			ctx.effect(function () {
				function onDocumentClick(event) {
					if (event.button) return;
					var target = event.target;
					if (!target || typeof target.closest !== "function") return;
					var row = target.closest("button");
					if (!row || !row.querySelector(".kb-nav-icon-wrap")) return;
					if (layout && layout.panelInfo && typeof layout.panelInfo.getSnapshot === "function") {
						var info = layout.panelInfo.getSnapshot();
						if (!info || info.activePanelId !== "kanban") return;
					}
					if (goBoardRequest) goBoardRequest();
				}
				document.addEventListener("click", onDocumentClick, true);
				return function () { document.removeEventListener("click", onDocumentClick, true); };
			}, "dsh-kanban: sidebar row click resets to board");
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
			ctx.effect(function () {
				return slots.inject("conversation.chat.turnTail", function () {
					return slots.register(
						{
							name: "conversation.chat.turnTail",
							id: "kanban-phase-banner",
							order: 30,
							inject: function (sessionId) { return { kanbanSessionId: sessionId }; },
						},
						PhaseBanner
					);
				});
			}, "dsh-kanban: turn phase banner");
		}

		exports.apply = apply;
		exports.inject = ["connection", "slots", "layout"];
		return module.exports;
	}
});
