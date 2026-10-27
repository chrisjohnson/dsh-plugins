// dsh-model-capacity: browser half.
//
// 1. `conversation.input.dock` — a session-scoped banner that appears the moment
//    this session's model call is queued, with its position and a cancel action.
// 2. `sidebar.panellist` + `main` — a global Capacity panel showing active
//    leases, FIFO waiters and subagent reservations, with controls.
//
// Classic script, React from the module loader, same slot rules as every other
// client half: seats are called unconditionally over a module-scope fallback.

window.__ModuleLoader__.load({
	id: "dsh-model-capacity",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var connection = null;
		var openSessionById = null;

		function rpc(method, payload) {
			if (!connection) return Promise.reject(new Error("dsh-model-capacity: connection unavailable"));
			return connection.rpc.call("/api", "modelCapacity/" + method, payload || {});
		}

		function fmtMs(ms) {
			if (ms === null || ms === undefined) return "—";
			var s = Math.round(ms / 1000);
			if (s < 60) return s + "s";
			var m = Math.floor(s / 60);
			if (m < 60) return m + "m " + (s % 60) + "s";
			return Math.floor(m / 60) + "h " + (m % 60) + "m";
		}

		function shortId(id) {
			return typeof id === "string" && id.length > 14 ? id.slice(-8) : (id || "no session");
		}

		function sessionLabel(entry) {
			return (entry && entry.sessionTitle) || shortId(entry && entry.sessionId);
		}

		function fmtTime(ms) {
			if (!ms) return "—";
			try { return new Date(ms).toLocaleTimeString(); } catch (e) { return "—"; }
		}

		var CSS =
			".mc-root{height:100%;min-height:0;overflow-y:auto;background:radial-gradient(900px 420px at 8% -8%,color-mix(in srgb,#3b82f6 7%,transparent),transparent 62%),radial-gradient(760px 380px at 100% 0%,color-mix(in srgb,#8b5cf6 6%,transparent),transparent 58%),var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:13px/1.45 Inter,system-ui,sans-serif;scrollbar-gutter:stable}"
			+ ".mc-page{box-sizing:border-box;max-width:1180px;margin:0 auto;padding:28px clamp(20px,4vw,48px) 56px}"
			+ ".mc-pagehead{display:flex;align-items:flex-start;gap:16px;margin-bottom:20px;flex-wrap:wrap}"
			+ ".mc-pagehead-main{flex:1;min-width:0}"
			+ ".mc-title{margin:0;font:500 20px/28px Inter,sans-serif;letter-spacing:-.01em}"
			+ ".mc-page-sub{margin-top:4px;color:var(--dsw-alias-label-tertiary,#888);font-size:12px}"
			+ ".mc-status{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;border:1px solid color-mix(in srgb,#22c55e 35%,var(--dsw-alias-border-l2,#ddd));background:color-mix(in srgb,#22c55e 10%,transparent);color:#15803d;font:600 10px/16px Inter,sans-serif;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}"
			+ ".mc-status i{width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.5);animation:mc-pulse 1.9s ease-out infinite}"
			+ ".mc-status.off{color:#6b7280;border-color:var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-bg-layer-2,#f3f4f6)}.mc-status.off i{background:#9ca3af;animation:none;box-shadow:none}"
			+ ".mc-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:18px}"
			+ ".mc-kpi{position:relative;overflow:hidden;padding:12px 14px;border-radius:12px;border:1px solid color-mix(in srgb,var(--mc-accent) 22%,var(--dsw-alias-border-l2,#e5e7eb));background:linear-gradient(135deg,color-mix(in srgb,var(--mc-accent) 9%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff))}"
			+ ".mc-kpi::after{content:'';position:absolute;right:-18px;top:-24px;width:76px;height:76px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--mc-accent) 18%,transparent),transparent 68%)}"
			+ ".mc-kpi-value{font:650 24px/28px Inter,sans-serif;font-variant-numeric:tabular-nums;color:var(--mc-accent)}"
			+ ".mc-kpi-label{margin-top:2px;font-weight:600;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#555)}"
			+ ".mc-kpi-hint{margin-top:2px;font-size:10px;color:var(--dsw-alias-label-tertiary,#999)}"
			+ ".mc-tone-blue{--mc-accent:#3b82f6;--mc-accent-2:#06b6d4}"
			+ ".mc-tone-violet{--mc-accent:#8b5cf6;--mc-accent-2:#d946ef}"
			+ ".mc-tone-teal{--mc-accent:#0d9488;--mc-accent-2:#22c55e}"
			+ ".mc-tone-amber{--mc-accent:#d97706;--mc-accent-2:#f59e0b}"
			+ ".mc-provider-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;align-items:start}"
			+ ".mc-provider{--mc-accent:#3b82f6;--mc-accent-2:#06b6d4;position:relative;overflow:hidden;box-sizing:border-box;border:1px solid color-mix(in srgb,var(--mc-accent) 20%,var(--dsw-alias-border-l2,#e5e7eb));border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);padding:14px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 10px 30px rgba(15,23,42,.04)}"
			+ ".mc-provider::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--mc-accent),var(--mc-accent-2))}"
			+ ".mc-provider.mc-tone-0{--mc-accent:#3b82f6;--mc-accent-2:#06b6d4}"
			+ ".mc-provider.mc-tone-1{--mc-accent:#8b5cf6;--mc-accent-2:#d946ef}"
			+ ".mc-provider.mc-tone-2{--mc-accent:#0d9488;--mc-accent-2:#22c55e}"
			+ ".mc-provider::after{content:'';position:absolute;right:-40px;top:-50px;width:150px;height:150px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--mc-accent) 10%,transparent),transparent 70%);pointer-events:none}"
			+ ".mc-provider.is-waiting{border-color:color-mix(in srgb,var(--mc-accent) 34%,var(--dsw-alias-border-l2,#e5e7eb));box-shadow:0 1px 2px rgba(15,23,42,.04),0 12px 34px color-mix(in srgb,var(--mc-accent) 10%,transparent)}"
			+ ".mc-provider-head{display:flex;align-items:flex-start;gap:12px;position:relative;z-index:1}"
			+ ".mc-provider-name{font:600 14px/20px Inter,sans-serif;color:var(--dsw-alias-label-primary,#111);overflow-wrap:anywhere}"
			+ ".mc-provider-sub{margin-top:2px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}"
			+ ".mc-util{text-align:right;flex:none;margin-left:auto}"
			+ ".mc-util strong{font:650 21px/24px Inter,sans-serif;font-variant-numeric:tabular-nums;color:var(--mc-accent)}"
			+ ".mc-util span{color:var(--dsw-alias-label-tertiary,#999);font-size:12px}"
			+ ".mc-util small{display:block;margin-top:1px;color:var(--dsw-alias-label-tertiary,#999);font-size:9px;letter-spacing:.05em;text-transform:uppercase}"
			+ ".mc-capbar{height:6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary,#888) 14%,transparent);overflow:hidden;margin:11px 0 14px;position:relative;z-index:1}"
			+ ".mc-capbar>span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--mc-accent),var(--mc-accent-2));transition:width .55s cubic-bezier(.2,.8,.2,1)}"
			+ ".mc-capbar.is-waiting>span{background:linear-gradient(90deg,#f59e0b,#ef4444)}"
			+ ".mc-section+.mc-section{margin-top:14px}"
			+ ".mc-section-head{display:flex;align-items:center;gap:7px;margin:0 0 7px;color:var(--dsw-alias-label-secondary,#666);font:600 10px/14px Inter,sans-serif;letter-spacing:.08em;text-transform:uppercase}"
			+ ".mc-count{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:15px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f1f3f6);color:var(--dsw-alias-label-secondary,#555);font:600 10px/14px ui-monospace,monospace;letter-spacing:0}"
			+ ".mc-empty-card{padding:12px;border:1px dashed var(--dsw-alias-border-l2,#dfe3e8);border-radius:10px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;text-align:center;background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 60%,transparent)}"
			+ ".mc-session-card{position:relative;display:flex;flex-direction:column;gap:6px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2,#e2e6ea);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;outline:none;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease;overflow:hidden}"
			+ ".mc-session-card+.mc-session-card{margin-top:7px}"
			+ ".mc-session-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--mc-accent) 48%,var(--dsw-alias-border-l2,#e2e6ea));box-shadow:0 8px 22px color-mix(in srgb,var(--mc-accent) 14%,transparent)}"
			+ ".mc-session-card:focus-visible{outline:2px solid var(--mc-accent);outline-offset:2px}"
			+ ".mc-session-card.mc-live{border-color:color-mix(in srgb,#22c55e 42%,var(--dsw-alias-border-l2,#e2e6ea));background:linear-gradient(135deg,color-mix(in srgb,#22c55e 5%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff));animation:mc-glow 3.2s ease-in-out infinite}"
			+ ".mc-session-card.mc-live::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,#22c55e,#06b6d4)}"
			+ ".mc-sc-top{display:flex;align-items:center;justify-content:space-between;gap:8px}"
			+ ".mc-sc-state{display:inline-flex;align-items:center;gap:5px;padding:1px 6px;border-radius:999px;font:600 9px/14px Inter,sans-serif;letter-spacing:.04em;text-transform:uppercase}"
			+ ".mc-sc-state i{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none}"
			+ ".mc-sc-state.live{color:#15803d;background:color-mix(in srgb,#22c55e 13%,transparent)}.mc-sc-state.live i{background:#22c55e;animation:mc-pulse 1.8s ease-out infinite}"
			+ ".mc-sc-state.queued{color:#b45309;background:color-mix(in srgb,#f59e0b 14%,transparent)}.mc-sc-state.queued i{background:#f59e0b}"
			+ ".mc-sc-time{font:600 10px/14px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums;white-space:nowrap}"
			+ ".mc-sc-title{font:600 12.5px/17px Inter,sans-serif;color:var(--dsw-alias-label-primary,#111);overflow-wrap:anywhere}"
			+ ".mc-sc-meta{display:flex;flex-wrap:wrap;gap:4px;min-width:0}"
			+ ".mc-tag{display:inline-flex;align-items:center;max-width:100%;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#e8e8e8);background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-tertiary,#777);font:500 9px/15px ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
			+ ".mc-tag.model{color:color-mix(in srgb,var(--mc-accent) 78%,var(--dsw-alias-label-primary,#111));border-color:color-mix(in srgb,var(--mc-accent) 25%,transparent);background:color-mix(in srgb,var(--mc-accent) 8%,transparent)}"
			+ ".mc-sc-actions{display:flex;align-items:center;gap:6px;margin-top:2px}"
			+ ".mc-sc-open{margin-left:auto;font:600 9px/14px Inter,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--mc-accent);opacity:0;transition:opacity .15s ease;white-space:nowrap}"
			+ ".mc-session-card:hover .mc-sc-open,.mc-session-card:focus-visible .mc-sc-open{opacity:1}"
			+ ".mc-res-card{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e6ea);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f8f9fb);font-size:11px}"
			+ ".mc-res-card+.mc-res-card{margin-top:6px}"
			+ ".mc-res-tool{font:600 10px/14px ui-monospace,monospace;color:#7c3aed;white-space:nowrap}"
			+ ".mc-res-route{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#555)}"
			+ ".mc-res-age{font:600 10px/14px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}"
			+ ".mc-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-top:.5px solid var(--dsw-alias-border-l1,#f0f0f0);font-size:12px}"
			+ ".mc-row:first-of-type{border-top:none}"
			+ ".mc-key{font:600 11px/16px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888);min-width:64px}"
			+ ".mc-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
			+ ".mc-dim{color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".mc-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#d8d8d8);font:500 10px/16px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap}"
			+ ".mc-chip.on{background:var(--dsw-alias-bg-layer-2,#eef1f5);border-color:transparent;color:var(--dsw-alias-label-primary,#111)}"
			+ ".mc-chip.warn{background:#fff4e5;border-color:#f0c987;color:#8a5300}"
			+ ".mc-chip.err{background:#fdecea;border-color:#f3b3ac;color:#9b1c1c}"
			+ ".mc-chip.ok{background:#e8f6ec;border-color:#a8d8b5;color:#1d6b32}"
			+ ".mc-btn{height:24px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3,#d0d0d0);border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:500 10px/14px Inter,sans-serif;cursor:pointer;flex:none;transition:background-color .15s ease,border-color .15s ease}"
			+ ".mc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}"
			+ ".mc-btn.danger{color:#b42318;border-color:#e7b4ae}"
			+ ".mc-btn:disabled{opacity:.4;cursor:default}"
			+ ".mc-empty{padding:10px 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}"
			+ ".mc-page-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}"
			+ ".mc-btn.primary{background:var(--dsw-alias-button-primary-fill,#2563eb);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}"
			+ ".mc-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#1d4ed8)}"
			+ ".mc-input{box-sizing:border-box;width:100%;height:30px;border:1px solid var(--dsw-alias-border-l3,#cbd2da);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);padding:0 8px;font:12px/18px Inter,sans-serif}"
			+ ".mc-input:disabled{opacity:.5}"
			+ ".mc-modal-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(15,23,42,.34);backdrop-filter:blur(2px)}"
			+ ".mc-modal{box-sizing:border-box;width:min(560px,100%);max-height:82vh;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e2e6ea);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);padding:18px;box-shadow:0 24px 70px rgba(15,23,42,.28)}"
			+ ".mc-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}"
			+ ".mc-modal-title{margin:0;font:600 17px/23px Inter,sans-serif;letter-spacing:-.01em}"
			+ ".mc-modal-sub{margin-top:3px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}"
			+ ".mc-modal-section{display:flex;flex-direction:column;gap:7px;margin-bottom:14px}"
			+ ".mc-limit-row{display:grid;grid-template-columns:minmax(0,1fr) auto 72px auto;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1,#e8ebef);border-radius:9px;padding:8px 9px;background:var(--dsw-alias-bg-layer-2,#f7f8fa)}"
			+ ".mc-limit-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 11px/16px Inter,sans-serif;color:var(--dsw-alias-label-primary,#111)}"
			+ ".mc-limit-unlimited{display:inline-flex;align-items:center;gap:4px;font:10px/14px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap}"
			+ ".mc-limit-number{padding:0 6px;text-align:right}"
			+ ".mc-limit-label{font:10px/14px Inter,sans-serif;color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".mc-modal-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:10px}"
			+ ".mc-modal-grid label{display:flex;flex-direction:column;gap:4px}"
			+ ".mc-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,#e8ebef)}"
			+ "@media (max-width:560px){.mc-limit-row{grid-template-columns:minmax(0,1fr) 72px}.mc-limit-unlimited{grid-column:1}.mc-limit-row .mc-limit-label{display:none}.mc-modal-grid{grid-template-columns:1fr}}"

			+ ".mc-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,760px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));margin:0 auto 8px;border:.5px solid #e9c47e;border-radius:10px;background:#fffaf0;padding:7px 10px;display:flex;align-items:center;gap:10px;font:12px/18px Inter,sans-serif;color:#6d4a00}"
			+ ".mc-dock .mc-grow{white-space:normal}"
			+ ".mc-waits{margin:6px 0;border:.5px solid var(--dsw-alias-border-l1,#e4e4e4);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);overflow:hidden;max-width:var(--dsh-chat-content-width,760px)}"
			+ ".mc-waits-head{display:flex;align-items:center;gap:7px;width:100%;padding:5px 9px;border:none;background:0 0;cursor:pointer;text-align:left;color:var(--dsw-alias-label-secondary,#555);font:500 11px/16px Inter,sans-serif}"
			+ ".mc-waits-head:hover{background:var(--dsw-alias-interactive-bg-hover,#f0f0f0)}"
			+ ".mc-waits-clock{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".mc-waits-total{color:var(--dsw-alias-label-primary,#111);font-weight:600}"
			+ ".mc-waits-count{display:inline-flex;align-items:center;border:1px solid rgba(180,83,9,.35);background:rgba(234,179,8,.14);color:#854d0e;border-radius:999px;padding:0 6px;font:600 9px/14px ui-monospace,monospace}"
			+ ".mc-waits-list{border-top:.5px solid var(--dsw-alias-border-l1,#e4e4e4);max-height:180px;overflow:auto;padding:3px 9px 5px}"
			+ ".mc-wait-row{display:flex;align-items:center;gap:8px;padding:2px 0;font:11px/16px Inter,sans-serif;color:var(--dsw-alias-label-tertiary,#777)}"
			+ ".mc-wait-route{font:11px/16px ui-monospace,monospace;color:var(--dsw-alias-label-secondary,#555);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
			+ ".mc-wait-ms{margin-left:auto;font:600 10px/14px ui-monospace,monospace;color:#b45309;white-space:nowrap}"
			+ ".mc-notice{padding:7px 10px;border-radius:8px;background:#fff7e6;border:.5px solid #f0d39a;color:#7a5200;font-size:12px;margin-bottom:10px}"
			+ ".mc-mono{font:11px/16px ui-monospace,monospace}"
			+ ".mc-session{font-weight:600;color:var(--dsw-alias-label-primary,#111)}"
			+ ".mc-nav-icon-wrap{position:relative;display:inline-flex;align-items:center;flex:none}"
			+ ".mc-nav-badges{position:absolute;left:calc(100% + 58px);top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:2px;white-space:nowrap;z-index:2}"
			+ ".mc-badge{display:inline-flex;align-items:center;justify-content:center;height:14px;padding:0 6px;border-radius:999px;border:1px solid;box-sizing:border-box;font:600 9px/12px ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;letter-spacing:-.02em}"
			+ ".mc-badge.ok{color:#15803d;background:rgba(34,160,74,.12);border-color:rgba(34,160,74,.35)}"
			+ ".mc-badge.full{color:#854d0e;background:rgba(234,179,8,.14);border-color:rgba(161,98,7,.38)}"
			+ ".mc-badge.waiting{color:#b91c1c;background:rgba(185,28,28,.12);border-color:rgba(185,28,28,.35)}"
			+ ".mc-dot.ok{background:#15803d}.mc-dot.full{background:#a16207}.mc-dot.waiting{background:#b91c1c}"
			+ ".mc-dot{display:inline-block;width:6px;height:6px;border-radius:50%;flex:none}"
			+ "@keyframes mc-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}70%{box-shadow:0 0 0 6px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}"
			+ "@keyframes mc-glow{0%,100%{box-shadow:0 0 0 1px rgba(34,197,94,.08),0 4px 16px rgba(34,197,94,.05)}50%{box-shadow:0 0 0 1.5px rgba(34,197,94,.32),0 8px 28px rgba(34,197,94,.15)}}"
			+ "@media (prefers-color-scheme:dark){.mc-provider,.mc-session-card,.mc-kpi{background:var(--dsw-alias-bg-layer-1,#16181d)}.mc-session-card.mc-live{background:linear-gradient(135deg,rgba(34,197,94,.08),var(--dsw-alias-bg-layer-1,#16181d))}.mc-tag{background:rgba(255,255,255,.06)}.mc-empty-card{background:rgba(255,255,255,.02)}}"
			+ "@media (prefers-reduced-motion:reduce){.mc-session-card.mc-live,.mc-sc-state.live i,.mc-status i{animation:none}.mc-capbar>span{transition:none}}"
			+ "@media (max-width:720px){.mc-kpis{grid-template-columns:1fr}.mc-provider-grid{grid-template-columns:1fr}}";


		function ensureStyles() {
			if (document.getElementById("model-capacity-styles")) return;
			var tag = document.createElement("style");
			tag.id = "model-capacity-styles";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		function badgeDemand(provider) {
			// The left number is demand: calls that hold a slot plus calls queued
			// behind them. It can exceed the limit while work is waiting, which is
			// exactly the state the orange/red pill is meant to make obvious.
			return provider.active.length + provider.waiters.length;
		}

		function badgeState(provider) {
			if (provider.waiters.length > 0) return "waiting";
			if (!provider.unlimited && badgeDemand(provider) >= provider.limit) return "full";
			return "ok";
		}

		function badgeCount(provider) {
			return badgeDemand(provider) + "/" + (provider.unlimited ? "\u221e" : provider.limit);
		}

		function badgeTitle(provider) {
			return provider.name + ": " + badgeDemand(provider) + "/" + (provider.unlimited ? "unlimited" : provider.limit) +
				" \u00b7 " + provider.active.length + " active \u00b7 " + provider.waiters.length + " queued";
		}

		function CapacityIcon(props) {
			var size = props && props.size ? props.size : 16;
			var pair = useSnapshot(1500);
			var snapshot = pair[0];
			var providers = snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : [];
			var compact = size === 18;
			return h("span", { className: "mc-nav-icon-wrap" },
				h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
					h("rect", { x: 1.5, y: 9, width: 3, height: 5.5, rx: 1, fill: "currentColor", opacity: 0.5 }),
					h("rect", { x: 6.5, y: 5.5, width: 3, height: 9, rx: 1, fill: "currentColor", opacity: 0.7 }),
					h("rect", { x: 11.5, y: 2, width: 3, height: 12.5, rx: 1, fill: "currentColor", opacity: 0.9 })
				),
				!compact && providers.length > 0 ? h("span", { className: "mc-nav-badges" }, providers.map(function (provider) {
					var state = provider.waiters.length > 0 ? "waiting" : (!provider.unlimited && badgeDemand(provider) >= provider.limit ? "full" : "ok");
					return h("span", {
						key: provider.name,
						className: "mc-badge " + state,
						title: provider.name + ": " + badgeDemand(provider) + "/" + (provider.unlimited ? "unlimited" : provider.limit) +
							" \u00b7 " + provider.active.length + " active \u00b7 " + provider.waiters.length + " queued",
						children: badgeDemand(provider) + "/" + (provider.unlimited ? "\u221e" : provider.limit),
					});
				})) : null
			);
		}

		function useSnapshot(intervalMs) {
			var s = React.useState(null);
			var snapshot = s[0], setSnapshot = s[1];
			var e = React.useState(null);
			var error = e[0], setError = e[1];
			React.useEffect(function () {
				var alive = true;
				function load() {
					rpc("snapshot", {}).then(function (res) {
						if (!alive) return;
						if (res && res.ok) { setSnapshot(res.value); setError(null); }
						else if (res && res.error) setError(res.error.message);
					}, function () { if (alive) setError("Could not reach the Host."); });
				}
				load();
				var timer = setInterval(load, intervalMs || 1500);
				return function () { alive = false; clearInterval(timer); };
			}, []);
			return [snapshot, error];
		}

		function act(method, payload) {
			return rpc(method, payload).then(function (res) {
				return res && res.ok ? null : (res && res.error ? res.error.message : "That did not work.");
			}, function () { return "Could not reach the Host."; });
		}

		function SessionWaitDock(props) {
			var sessionId = props && props.sessionId;
			var pair = useSnapshot(1200);
			var snapshot = pair[0], error = pair[1];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			var n = React.useState(null);
			var notice = n[0], setNotice = n[1];
			if (!sessionId || !snapshot) return null;
			var mine = [];
			(snapshot.providers || []).forEach(function (provider) {
				(provider.waiters || []).forEach(function (waiter) {
					// Only a main request is "your work waiting"; title/compaction calls
					// can queue while the main call is happily streaming.
					if (waiter.sessionId === sessionId && waiter.kind === "call") mine.push(Object.assign({ provider: provider.name, limit: provider.limit, total: (provider.waiters || []).length }, waiter));
				});
			});
			if (mine.length === 0) return null;
			var first = mine[0];
			return h("div", { className: "mc-dock", role: "status" },
				h("span", { className: "mc-dock-title", children: "Waiting for model capacity" }),
				h("span", { className: "mc-grow" },
					h("span", { className: "mc-mono", children: first.provider + "/" + (first.model || "?") }),
					" · position " + first.position + " of " + first.total +
					" · waiting " + fmtMs(first.waitedMs) + ". Inference has not started."),
				notice ? h("span", { className: "mc-dim", children: notice }) : null,
				h("button", {
					className: "mc-btn danger", disabled: busy,
					onClick: function () {
						setBusy(true);
						act("cancelSession", { sessionId: sessionId }).then(function (message) {
							setNotice(message || "Cancel requested.");
							setBusy(false);
						});
					},
					children: busy ? "Cancelling…" : "Cancel turn"
				}),
				error ? h("span", { className: "mc-dim", children: error }) : null
			);
		}

		function CapacityKpi(props) {
			return h("div", { className: "mc-kpi " + props.tone },
				h("div", { className: "mc-kpi-value", children: props.value }),
				h("div", { className: "mc-kpi-label", children: props.label }),
				h("div", { className: "mc-kpi-hint", children: props.hint })
			);
		}

		function SessionCard(props) {
			var e = props.entry;
			var active = props.state === "active";
			var busy = props.busy === (active ? e.leaseId : e.waiterId) || props.busy === e.sessionId;
			function open() {
				if (props.onOpen) props.onOpen(e.sessionId);
			}
			function stop(event) { event.stopPropagation(); }
			return h("div", {
				className: "mc-session-card " + (active ? "mc-live" : "mc-queued"),
				role: "button",
				tabIndex: 0,
				"aria-label": "Open session " + sessionLabel(e),
				title: "Open session " + (e.sessionId || ""),
				onClick: function (event) { if (!event.target.closest("button")) open(); },
				onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } },
			},
				h("div", { className: "mc-sc-top" },
					h("span", { className: "mc-sc-state " + (active ? "live" : "queued") },
						h("i"), active ? "live" : ("queued #" + props.position)),
					h("span", { className: "mc-sc-time", children: active ? fmtMs(e.elapsedMs) : fmtMs(e.waitedMs) })
				),
				h("div", { className: "mc-sc-title", children: sessionLabel(e) }),
				h("div", { className: "mc-sc-meta" },
					h("span", { className: "mc-tag", children: e.workspace || "no workspace" }),
					h("span", { className: "mc-tag model", children: e.model || "?" }),
					h("span", { className: "mc-tag", children: e.kind || "call" })
				),
				h("div", { className: "mc-sc-actions" },
					h("button", {
						className: "mc-btn", disabled: busy,
						onClick: function (event) { stop(event); props.onCancel(e.sessionId); },
						children: active ? "Cancel turn" : "Cancel"
					}),
					active ? h("button", {
						className: "mc-btn danger", disabled: busy,
						onClick: function (event) {
							stop(event);
							if (!window.confirm("Force-release this lease? The underlying model call may still be running; this can exceed the provider limit.")) return;
							props.onForce(e.leaseId);
						},
						children: "Force release"
					}) : null,
					h("span", { className: "mc-sc-open", children: "Open ↗" })
				)
			);
		}

		function ProviderCard(props) {
			var p = props.provider;
			var busy = props.busyId;
			var demand = p.active.length + p.waiters.length;
			var pct = p.unlimited ? 100 : Math.min(100, Math.round((demand / Math.max(1, p.limit)) * 100));
			return h("section", { className: "mc-provider mc-tone-" + props.tone + (p.waiters.length > 0 ? " is-waiting" : "") },
				h("div", { className: "mc-provider-head" },
					h("div", { style: { minWidth: 0 } },
						h("div", { className: "mc-provider-name", children: p.name }),
						h("div", { className: "mc-provider-sub", children: p.unlimited ? "unlimited concurrency · never queues" : p.limit + " concurrent model calls" })
					),
					h("div", { className: "mc-util" },
						h("strong", { children: demand }),
						h("span", { children: "/" + (p.unlimited ? "∞" : p.limit) }),
						h("small", { children: "active + queued" })
					)
				),
				h("div", { className: "mc-capbar" + (p.waiters.length > 0 ? " is-waiting" : "") },
					h("span", { style: { width: pct + "%" } })
				),
				h("div", { className: "mc-section" },
					h("div", { className: "mc-section-head", children: ["Active", h("span", { className: "mc-count", children: p.active.length })] }),
					p.active.length === 0 ? h("div", { className: "mc-empty-card", children: "No active calls" }) :
						p.active.map(function (lease) {
							return h(SessionCard, {
								key: lease.leaseId, entry: lease, state: "active", busy: busy,
								onCancel: props.onCancelSession, onForce: props.onForceRelease, onOpen: props.onOpen
							});
						})
				),
				h("div", { className: "mc-section" },
					h("div", { className: "mc-section-head", children: ["Queue", h("span", { className: "mc-count", children: p.waiters.length })] }),
					p.waiters.length === 0 ? h("div", { className: "mc-empty-card", children: "Queue empty" }) :
						p.waiters.map(function (waiter) {
							return h(SessionCard, {
								key: waiter.waiterId, entry: waiter, state: "queued", position: waiter.position, busy: busy,
								onCancel: props.onCancelSession, onForce: props.onForceRelease, onOpen: props.onOpen
							});
						})
				),
				p.reservations.length > 0 ? h("div", { className: "mc-section" },
					h("div", { className: "mc-section-head", children: ["Reservations", h("span", { className: "mc-count", children: p.reservations.length })] }),
					p.reservations.map(function (reservation) {
						var parentTitle = (reservation.parent && reservation.parent.sessionTitle) || shortId(reservation.parentSession);
						var childTitle = reservation.childSession ? ((reservation.child && reservation.child.sessionTitle) || shortId(reservation.childSession)) : null;
						return h("div", { className: "mc-res-card", key: reservation.reservationId },
							h("span", { className: "mc-res-tool", children: reservation.tool || "reservation" }),
							h("span", { className: "mc-res-route", title: reservation.parentSession || "", children: parentTitle + (childTitle ? " → " + childTitle : "") + " · " + (reservation.state || "pending") }),
							h("span", { className: "mc-res-age", children: fmtMs(reservation.ageMs) }),
							h("button", { className: "mc-btn danger", disabled: busy === reservation.reservationId, onClick: function () { props.onDismissReservation(reservation.reservationId); }, children: "Dismiss" })
						);
					})
				) : null
			);
		}

		function limitsDraft(snapshot) {
			var rows = [];
			var seen = new Set();
			(snapshot.limits || []).forEach(function (limit) {
				seen.add(limit.provider);
				rows.push({ provider: limit.provider, unlimited: limit.unlimited === true, maxConcurrent: limit.maxConcurrent || 1 });
			});
			(snapshot.providers || []).forEach(function (provider) {
				if (seen.has(provider.name)) return;
				rows.push({ provider: provider.name, unlimited: provider.unlimited === true, maxConcurrent: provider.unlimited ? 1 : (provider.limit || 1) });
			});
			return {
				rows: rows,
				defaultMaxConcurrent: snapshot.defaultMaxConcurrent || 1,
				queueLimitPerProvider: snapshot.queueLimitPerProvider || 1000
			};
		}

		function LimitsDialog(props) {
			var initial = limitsDraft(props.snapshot);
			var s = React.useState(initial);
			var draft = s[0], setDraft = s[1];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			var e = React.useState(null);
			var error = e[0], setError = e[1];
			function row(index, patch) {
				var next = Object.assign({}, draft);
				var rows = next.rows.slice();
				rows[index] = Object.assign({}, rows[index], patch);
				next.rows = rows;
				setDraft(next);
			}
			function save() {
				var limits = draft.rows.map(function (entry) {
					return entry.unlimited ? { provider: entry.provider, unlimited: true } : { provider: entry.provider, maxConcurrent: Number(entry.maxConcurrent) };
				});
				setBusy(true);
				setError(null);
				rpc("setLimits", { limits: limits, defaultMaxConcurrent: Number(draft.defaultMaxConcurrent), queueLimitPerProvider: Number(draft.queueLimitPerProvider) }).then(function (res) {
					if (res && res.ok) props.onSaved();
					else setError(res && res.error ? res.error.message : "Could not save limits.");
				}, function () { setError("Could not reach the Host."); }).finally(function () { setBusy(false); });
			}
			return h("div", { className: "mc-modal-backdrop", onClick: function (event) { if (event.target === event.currentTarget) props.onClose(); } },
				h("div", { className: "mc-modal", role: "dialog", "aria-modal": "true", "aria-label": "Adjust capacity limits" },
					h("div", { className: "mc-modal-head" },
						h("div", null,
							h("h2", { className: "mc-modal-title", children: "Adjust capacity limits" }),
							h("div", { className: "mc-modal-sub", children: "Saving writes the model-capacity row in the profile config." })
						),
						h("button", { className: "mc-btn", onClick: props.onClose, children: "×" })
					),
					h("div", { className: "mc-modal-section" },
						draft.rows.length === 0 ? h("div", { className: "mc-empty", children: "No providers discovered yet." }) :
							draft.rows.map(function (entry, index) {
								return h("div", { className: "mc-limit-row", key: entry.provider },
									h("div", { className: "mc-limit-name", title: entry.provider, children: entry.provider }),
									h("label", { className: "mc-limit-unlimited" },
										h("input", { type: "checkbox", checked: entry.unlimited, onChange: function (event) { row(index, { unlimited: event.target.checked }); } }),
										"unlimited"
									),
									h("input", { className: "mc-input mc-limit-number", type: "number", min: 1, step: 1, value: entry.maxConcurrent, disabled: entry.unlimited, onChange: function (event) { row(index, { maxConcurrent: event.target.value }); } }),
									h("span", { className: "mc-limit-label", children: "concurrent calls" })
								);
							})
					),
					h("div", { className: "mc-modal-grid" },
						h("label", null, h("span", { className: "mc-limit-label", children: "Default per-provider limit" }), h("input", { className: "mc-input", type: "number", min: 1, step: 1, value: draft.defaultMaxConcurrent, onChange: function (event) { setDraft(Object.assign({}, draft, { defaultMaxConcurrent: event.target.value })); } })),
						h("label", null, h("span", { className: "mc-limit-label", children: "Queue limit per provider" }), h("input", { className: "mc-input", type: "number", min: 1, step: 1, value: draft.queueLimitPerProvider, onChange: function (event) { setDraft(Object.assign({}, draft, { queueLimitPerProvider: event.target.value })); } }))
					),
					error ? h("div", { className: "mc-notice", children: error }) : null,
					h("div", { className: "mc-modal-foot" },
						h("button", { className: "mc-btn", onClick: props.onClose, children: "Cancel" }),
						h("button", { className: "mc-btn primary", disabled: busy, onClick: save, children: busy ? "Saving…" : "Save limits" })
					)
				)
			);
		}

		function CapacityPanel() {
			var pair = useSnapshot(1500);
			var snapshot = pair[0], error = pair[1];
			var n = React.useState(null);
			var notice = n[0], setNotice = n[1];
			var b = React.useState(null);
			var busy = b[0], setBusy = b[1];
			var o = React.useState(false);
			var limitsOpen = o[0], setLimitsOpen = o[1];
			var totals = snapshot ? snapshot.totals : { active: 0, waiting: 0, reservations: 0 };
			function run(method, payload, key) {
				setBusy(key);
				act(method, payload).then(function (message) {
					setNotice(message);
					setBusy(null);
				});
			}
			return h("div", { className: "mc-root" },
				h("div", { className: "mc-page" },
					h("div", { className: "mc-pagehead" },
						h("div", { className: "mc-pagehead-main" },
							h("h1", { className: "mc-title", children: "Activity" }),
							h("div", { className: "mc-page-sub", children: "Live model activity · per-provider admission control · FIFO · click any session card to open it" })
						),
						h("div", { className: "mc-page-actions" },
							h("button", { className: "mc-btn", disabled: snapshot === null || snapshot.writable === false, onClick: function () { setLimitsOpen(true); }, children: "Adjust limits" }),
							h("span", { className: "mc-status" + (snapshot && snapshot.enabled === false ? " off" : ""), children: [h("i"), snapshot === null ? "loading" : snapshot.enabled === false ? "disabled" : "enforcing"] })
						)
					),
					notice ? h("div", { className: "mc-notice", children: notice }) : null,
					error ? h("div", { className: "mc-notice", children: error }) : null,
					snapshot === null ? h("div", { className: "mc-empty", children: "Loading capacity state…" }) :
						snapshot.providers.length === 0 ? h("div", { className: "mc-empty", children: "No provider has been used yet." }) :
							h(React.Fragment, null,
								h("div", { className: "mc-kpis" },
									h(CapacityKpi, { tone: "mc-tone-blue", value: totals.active, label: "Active leases", hint: "model calls holding a slot" }),
									h(CapacityKpi, { tone: "mc-tone-amber", value: totals.waiting, label: "Queued calls", hint: "FIFO waiting for capacity" }),
									h(CapacityKpi, { tone: "mc-tone-violet", value: totals.reservations, label: "Reservations", hint: "subagent dispatches held" })
								),
								h("div", { className: "mc-provider-grid" }, snapshot.providers.map(function (provider, index) {
									return h(ProviderCard, {
										key: provider.name, provider: provider, tone: index % 3, busyId: busy,
										onOpen: function (sessionId) {
											if (openSessionById !== null && sessionId) openSessionById(sessionId);
										},
										onCancelSession: function (sessionId) { if (sessionId) run("cancelSession", { sessionId: sessionId }, sessionId); },
										onDismissReservation: function (id) { run("dismissReservation", { reservationId: id }, id); },
										onForceRelease: function (id) { run("forceRelease", { leaseId: id }, id); }
									});
								}))
							)
				),
				limitsOpen && snapshot ? h(LimitsDialog, { snapshot: snapshot, onClose: function () { setLimitsOpen(false); }, onSaved: function () { setLimitsOpen(false); setNotice("Limits updated."); } }) : null
			);
		}

		function useSessionWaits(sessionId) {
			var s = React.useState([]);
			var waits = s[0], setWaits = s[1];
			React.useEffect(function () {
				if (!sessionId) return undefined;
				var alive = true;
				function load() {
					rpc("sessionWaits", { sessionId: sessionId }).then(function (res) {
						if (!alive) return;
						if (res && res.ok && res.value && Array.isArray(res.value.waits)) setWaits(res.value.waits);
					}, function () {});
				}
				load();
				var timer = setInterval(load, 2000);
				return function () { alive = false; clearInterval(timer); };
			}, [sessionId]);
			return waits;
		}

		function CapacityWaitCard(props) {
			var waits = useSessionWaits(props.sessionId);
			var openState = React.useState(true);
			var open = openState[0], setOpen = openState[1];
			var turn = props.turn && typeof props.turn.turn === "number" ? props.turn.turn : props.turn;
			var mine = (waits || []).filter(function (w) { return w.turn === turn; });
			if (mine.length === 0) return null;
			var total = mine.reduce(function (sum, w) { return sum + (Number(w.waitedMs) || 0); }, 0);
			return h("div", { className: "mc-waits", "data-turn": turn },
				h("button", { type: "button", className: "mc-waits-head", title: "Capacity waits recorded for this turn. Client-side only; not part of model context.", onClick: function () { setOpen(!open); } },
					h("span", { className: "mc-waits-clock", children: h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
						h("circle", { cx: 8, cy: 8, r: 6.2, stroke: "currentColor", strokeWidth: 1.2 }),
						h("path", { d: "M8 4.4V8l2.6 1.6", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" })) }),
					h("span", { children: "Waited for capacity" }),
					h("span", { className: "mc-waits-total", children: fmtMs(total) }),
					h("span", { className: "mc-waits-count", children: mine.length === 1 ? "1 wait" : mine.length + " waits" }),
					h("span", { className: "mc-dim", style: { marginLeft: "auto" }, children: open ? "hide" : "show" })
				),
				open ? h("div", { className: "mc-waits-list" }, mine.map(function (w) {
					return h("div", { className: "mc-wait-row", key: w.id },
						h("span", { className: "mc-wait-route", children: (w.provider || "?") + "/" + (w.model || "?") }),
						h("span", { className: "mc-wait-ms", children: fmtMs(w.waitedMs) }));
				})) : null
			);
		}

		function apply(ctx) {
			connection = ctx.connection !== undefined ? ctx.connection : ctx.get ? ctx.get("connection") : null;
			openSessionById = function (sessionId) {
				try {
					var uiWorkspace = ctx.get("uiWorkspace");
					if (uiWorkspace && typeof uiWorkspace.openSession === "function") { uiWorkspace.openSession(sessionId); return true; }
				} catch (error) { /* session navigation is best-effort */ }
				return false;
			};
			var slots = ctx.slots !== undefined ? ctx.slots : ctx.get ? ctx.get("slots") : undefined;
			if (!slots) {
				console.error("dsh-model-capacity: slots service missing");
				return;
			}
			ensureStyles();
			ctx.effect(function () {
				return slots.inject("sidebar.panellist", function () {
					return slots.register(
						{ name: "sidebar.panellist", id: "model-capacity", order: 21, label: function () { return "Activity"; } },
						CapacityIcon
					);
				});
			}, "dsh-model-capacity: sidebar panel");
			ctx.effect(function () {
				return slots.inject("main", function () {
					return slots.register({ name: "main", key: "model-capacity" }, CapacityPanel);
				});
			}, "dsh-model-capacity: panel page");
			ctx.effect(function () {
				return slots.inject("conversation.chat.turnTail", function () {
					return slots.register(
						{ name: "conversation.chat.turnTail", id: "model-capacity-waits", order: 8, inject: function (sessionId) { return { sessionId: sessionId }; } },
						CapacityWaitCard
					);
				});
			}, "dsh-model-capacity: turn wait history");
			ctx.effect(function () {
				return slots.inject("conversation.input.dock", function () {
					return slots.register(
						{ name: "conversation.input.dock", id: "model-capacity-wait", order: 12 },
						SessionWaitDock
					);
				});
			}, "dsh-model-capacity: session wait dock");
		}

		exports.apply = apply;
		exports.inject = ["connection", "slots"];
		return module.exports;
	}
});
