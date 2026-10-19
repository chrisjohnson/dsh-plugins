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
		var rpcSeq = 0;

		function rpc(method, payload) {
			if (!connection) return Promise.reject(new Error("dsh-kanban: connection service unavailable"));
			return connection.rpc.call("/api", "kanban/" + method, payload || {});
		}

		function fmtUsd(value) {
			if (value === null || value === undefined) return "unpriced";
			return "$" + Number(value).toFixed(value > 0 && value < 0.01 ? 4 : 2);
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
			".kb-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:13px/1.45 Inter,system-ui,sans-serif}"
			+ ".kb-bar{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:.5px solid var(--dsw-alias-border-l1,#e4e4e4);flex:none;flex-wrap:wrap}"
			+ ".kb-title{font:600 16px/22px Inter,sans-serif;margin:0 8px 0 0}"
			+ ".kb-sub{color:var(--dsw-alias-label-tertiary,#888);font-size:12px}"
			+ ".kb-spacer{flex:1}"
			+ ".kb-btn{height:30px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3,#d0d0d0);border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:500 12px/18px Inter,sans-serif;cursor:pointer;white-space:nowrap}"
			+ ".kb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}"
			+ ".kb-btn:disabled{opacity:.45;cursor:default}"
			+ ".kb-btn.primary{background:var(--dsw-interactive-text-on-base,#111);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}"
			+ ".kb-btn.danger{color:#b42318}"
			+ ".kb-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#d8d8d8);font:500 10px/16px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap}"
			+ ".kb-chip.on{background:var(--dsw-alias-bg-layer-2,#eef1f5);border-color:transparent;color:var(--dsw-alias-label-primary,#111)}"
			+ ".kb-chip.warn{background:#fff4e5;border-color:#f0c987;color:#8a5300}"
			+ ".kb-chip.err{background:#fdecea;border-color:#f3b3ac;color:#9b1c1c}"
			+ ".kb-chip.ok{background:#e8f6ec;border-color:#a8d8b5;color:#1d6b32}"
			+ ".kb-body{flex:1;min-height:0;overflow:auto;padding:14px 18px 28px}"
			+ ".kb-cols{display:grid;grid-template-columns:repeat(5,minmax(210px,1fr));gap:12px;align-items:start;min-width:1050px}"
			+ ".kb-col{border:.5px solid var(--dsw-alias-border-l1,#e4e4e4);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);min-height:120px;display:flex;flex-direction:column;max-height:calc(100vh - 190px)}"
			+ ".kb-col.attn{border-color:#f0b4ad;background:#fef6f5}"
			+ ".kb-colhead{display:flex;align-items:center;gap:8px;padding:9px 11px 7px;font:600 12px/18px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#555);position:sticky;top:0;z-index:1;background:inherit;border-radius:12px 12px 0 0}"
			+ ".kb-count{margin-left:auto;font:500 11px/16px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".kb-list{display:flex;flex-direction:column;gap:7px;padding:0 8px 9px;overflow:auto}"
			+ ".kb-card{border:.5px solid var(--dsw-alias-border-l1,#ddd);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);padding:8px 9px;cursor:pointer;display:flex;flex-direction:column;gap:5px}"
			+ ".kb-card:hover{border-color:var(--dsw-alias-label-tertiary,#999)}"
			+ ".kb-card.dragging{opacity:.4}"
			+ ".kb-card.attn{border-left:3px solid #c0392b}"
			+ ".kb-key{font:600 10px/14px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".kb-cardtitle{font:500 12.5px/17px Inter,sans-serif;color:var(--dsw-alias-label-primary,#111);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}"
			+ ".kb-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;font:500 10px/14px Inter,sans-serif;color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".kb-grouphead{margin:12px 0 6px;font:600 11px/16px Inter,sans-serif;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-tertiary,#777)}"
			+ ".kb-now{max-width:1100px}"
			+ ".kb-detail{max-width:1180px;display:flex;flex-direction:column;gap:14px}"
			+ ".kb-panel{border:.5px solid var(--dsw-alias-border-l1,#e4e4e4);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);padding:12px 14px}"
			+ ".kb-panel h3{margin:0 0 8px;font:600 12px/18px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#555);text-transform:uppercase;letter-spacing:.04em}"
			+ ".kb-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}"
			+ ".kb-kv{display:grid;grid-template-columns:130px 1fr;gap:3px 10px;font-size:12px}"
			+ ".kb-kv b{font-weight:500;color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".kb-input,.kb-select,.kb-textarea{border:.5px solid var(--dsw-alias-border-l3,#cfcfcf);border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:13px/18px Inter,sans-serif;padding:5px 8px;outline:none}"
			+ ".kb-input:focus,.kb-select:focus,.kb-textarea:focus{border-color:var(--dsw-alias-label-secondary,#555)}"
			+ ".kb-textarea{min-height:80px;resize:vertical;width:100%;box-sizing:border-box}"
			+ ".kb-form{display:flex;flex-direction:column;gap:9px;max-width:640px}"
			+ ".kb-label{font:500 11px/16px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#555)}"
			+ ".kb-hint{font:11px/16px Inter,sans-serif;color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".kb-err{font:11px/16px Inter,sans-serif;color:#9b1c1c}"
			+ ".kb-table{width:100%;border-collapse:collapse;font-size:12px}"
			+ ".kb-table th{text-align:left;font:600 10px/14px Inter,sans-serif;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#888);padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,#e4e4e4)}"
			+ ".kb-table td{padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,#f0f0f0);vertical-align:top}"
			+ ".kb-tabs{display:flex;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l1,#e4e4e4);margin-bottom:10px;flex-wrap:wrap}"
			+ ".kb-tab{background:0 0;border:none;border-bottom:2px solid transparent;padding:6px 10px;font:500 12px/18px Inter,sans-serif;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer}"
			+ ".kb-tab.on{color:var(--dsw-alias-label-primary,#111);border-bottom-color:var(--dsw-alias-label-primary,#111)}"
			+ ".kb-gantt{overflow:auto;border:.5px solid var(--dsw-alias-border-l1,#eee);border-radius:8px}"
			+ ".kb-grow{display:grid;grid-template-columns:260px 1fr;align-items:center;min-height:24px;border-bottom:.5px solid #f2f2f2}"
			+ ".kb-glabel{padding:2px 8px;font:11px/16px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#555);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
			+ ".kb-gtrack{position:relative;height:22px;margin-right:8px;background:repeating-linear-gradient(90deg,#fafafa,#fafafa 24px,#f2f2f2 25px)}"
			+ ".kb-gbar{position:absolute;top:3px;height:16px;border-radius:4px;background:#7c9cc4;min-width:2px}"
			+ ".kb-gbar.agent{background:#4f7fae}.kb-gbar.judge{background:#8a6fb0}.kb-gbar.tool{background:#6aa87b}.kb-gbar.wait{background:repeating-linear-gradient(45deg,#bbb,#bbb 3px,#e8e8e8 3px,#e8e8e8 6px)}"
			+ ".kb-gbar.failed{background:#c05b4d}.kb-gbar.abandoned{background:#999}"
			+ ".kb-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}"
			+ ".kb-notice{padding:7px 10px;border-radius:8px;background:#fff7e6;border:.5px solid #f0d39a;color:#7a5200;font-size:12px;margin-bottom:10px}"
			+ ".kb-answers{display:flex;flex-direction:column;gap:6px}"
			+ ".kb-answerrow{display:flex;gap:8px;align-items:flex-start}"
			+ ".kb-q{flex:1;font-size:12px;color:var(--dsw-alias-label-secondary,#555)}"
			+ ".kb-spin{display:inline-block;width:12px;height:12px;border:2px solid #ccc;border-top-color:#555;border-radius:50%;animation:kb-spin .8s linear infinite}"
			+ "@keyframes kb-spin{to{transform:rotate(360deg)}}";

		function ensureStyles() {
			var id = "kanban-styles";
			if (document.getElementById(id)) return;
			var tag = document.createElement("style");
			tag.id = id;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------------ icon

		function KanbanIcon(props) {
			var size = props && props.size ? props.size : 16;
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("rect", { x: 1.5, y: 1.5, width: 3.4, height: 13, rx: 1, fill: "currentColor", opacity: 0.9 }),
				h("rect", { x: 6.3, y: 1.5, width: 3.4, height: 9, rx: 1, fill: "currentColor", opacity: 0.65 }),
				h("rect", { x: 11.1, y: 1.5, width: 3.4, height: 11, rx: 1, fill: "currentColor", opacity: 0.45 })
			);
		}

		// ------------------------------------------------------------------ board

		function Card(props) {
			var t = props.ticket;
			return h(
				"div",
				{
					className: "kb-card" + (t.column === "needs_attention" ? " attn" : ""),
					draggable: true,
					onDragStart: function (ev) {
						ev.dataTransfer.setData("text/kanban", t.id);
						ev.dataTransfer.effectAllowed = "move";
					},
					onDragOver: function (ev) {
						ev.preventDefault();
						ev.dataTransfer.dropEffect = "move";
					},
					onDrop: function (ev) {
						ev.preventDefault();
						ev.stopPropagation();
						var id = ev.dataTransfer.getData("text/kanban");
						if (id) props.onReorder(id, t.id);
					},
					onClick: function () { props.onOpen(t.id); },
					title: t.title
				},
				h("div", { className: "kb-row" }, h("span", { className: "kb-key", children: t.key }), h("span", { className: "kb-spacer" }),
					t.attemptCount > 0 ? h("span", { className: "kb-chip", children: "try " + t.attemptCount }) : null),
				h("div", { className: "kb-cardtitle", children: t.title }),
				h("div", { className: "kb-meta" },
					h("span", { className: "kb-chip", children: t.phase }),
					t.phase === "grill" ? h("span", { className: "kb-chip warn", children: "waiting on you" }) : null,
					t.column === "now" && t.group ? h("span", { className: "kb-chip" + (t.group === "waiting" ? " warn" : t.group === "active" ? " ok" : "") , children: t.group.replace("_", " ") }) : null,
					t.column !== "done" && t.column !== "discarded" ? h("span", { children: fmtUsd(t.spentUsd) }) : null,
					t.needsAttentionReason ? h("span", { className: "kb-chip err", children: "needs attention" }) : null
				)
			);
		}

		function Column(props) {
			var items = props.items || [];
			return h(
				"div",
				{
					className: "kb-col" + (props.attention ? " attn" : ""),
					onDragOver: function (ev) { ev.preventDefault(); },
					onDrop: function (ev) {
						ev.preventDefault();
						var id = ev.dataTransfer.getData("text/kanban");
						if (id) props.onMove(id, props.column);
					}
				},
				h("div", { className: "kb-colhead" }, h("span", { children: props.label }), h("span", { className: "kb-count", children: items.length })),
				h("div", { className: "kb-list" },
					items.length === 0
						? h("div", { className: "kb-empty", children: "empty" })
						: items.map(function (t) { return h(Card, { key: t.id, ticket: t, onOpen: props.onOpen, onReorder: props.onReorder }); })
				)
			);
		}

		function CreateForm(props) {
			var s = React.useState({ title: "", body: "", acceptance: "", grill: "judgement", plan: "at_pickup", priority: 0, allowPaid: false, budget: 0 });
			var form = s[0], setForm = s[1];
			var e = React.useState(null);
			var err = e[0], setErr = e[1];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			var invalid = form.grill === "at_pickup" && form.plan === "now";
			function field(key, value) {
				var next = Object.assign({}, form);
				next[key] = value;
				setForm(next);
			}
			function submit() {
				if (invalid || form.title.trim() === "") return;
				setBusy(true);
				setErr(null);
				rpc("create", {
					title: form.title,
					body: form.body,
					acceptance: form.acceptance.split("\n").map(function (x) { return x.trim(); }).filter(Boolean),
					grillMode: form.grill,
					planMode: form.plan,
					priority: Number(form.priority) || 0,
					allowPaid: !!form.allowPaid,
					budgetUsd: Number(form.budget) || 0
				}).then(function (res) {
					setBusy(false);
					if (res && res.ok) {
						setForm({ title: "", body: "", acceptance: "", grill: "judgement", plan: "at_pickup", priority: 0, allowPaid: false, budget: 0 });
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
					h("div", null, h("div", { className: "kb-label", children: "Grill" }),
						h("select", { className: "kb-select", value: form.grill, onChange: function (ev) { field("grill", ev.target.value); } },
							h("option", { value: "now", children: "now" }), h("option", { value: "at_pickup", children: "at pickup" }), h("option", { value: "judgement", children: "judgement" }))),
					h("div", null, h("div", { className: "kb-label", children: "Plan" }),
						h("select", { className: "kb-select", value: form.plan, onChange: function (ev) { field("plan", ev.target.value); } },
							h("option", { value: "now", disabled: form.grill === "at_pickup", children: "now" }), h("option", { value: "at_pickup", children: "at pickup" }), h("option", { value: "one_shot", children: "one shot" }))),
					h("div", null, h("div", { className: "kb-label", children: "Priority" }),
						h("input", { className: "kb-input", type: "number", value: form.priority, style: { width: 80 }, onChange: function (ev) { field("priority", ev.target.value); } })),
					h("label", { className: "kb-row", style: { gap: 6, marginTop: 18 } },
						h("input", { type: "checkbox", checked: form.allowPaid, onChange: function (ev) { field("allowPaid", ev.target.checked); } }),
						h("span", { className: "kb-label", children: "allow paid" })),
					h("div", null, h("div", { className: "kb-label", children: "Budget USD" }),
						h("input", { className: "kb-input", type: "number", value: form.budget, style: { width: 100 }, onChange: function (ev) { field("budget", ev.target.value); } }))
				),
				invalid ? h("div", { className: "kb-err", children: "plan=now cannot fire after an at-pickup grill. Choose plan=at_pickup, or grill=now." }) : null,
				err ? h("div", { className: "kb-err", children: err }) : null,
				h("div", { className: "kb-row" },
					h("button", { className: "kb-btn primary", disabled: busy || invalid || form.title.trim() === "", onClick: submit, children: busy ? "Creating…" : "Create ticket" }),
					h("button", { className: "kb-btn", onClick: props.onClose, children: "Cancel" })
				)
			);
		}

		// ---------------------------------------------------------------- detail

		function ModeEditor(props) {
			var ticket = props.ticket;
			var s = React.useState({ grill: ticket.grillMode, plan: ticket.planMode, priority: ticket.priority, allowPaid: ticket.allowPaid, budgetUsd: ticket.budgetUsd, workspaceCwd: ticket.workspaceCwd || "" });
			var form = s[0], setForm = s[1];
			var invalid = form.grill === "at_pickup" && form.plan === "now";
			function save() {
				if (invalid) return;
				props.onSave({ grillMode: form.grill, planMode: form.plan, priority: Number(form.priority) || 0, allowPaid: !!form.allowPaid, budgetUsd: Number(form.budgetUsd) || 0, workspaceCwd: form.workspaceCwd || null });
			}
			return h("div", { className: "kb-form" },
				h("div", { className: "kb-row" },
					h("div", null, h("div", { className: "kb-label", children: "Grill" }),
						h("select", { className: "kb-select", value: form.grill, onChange: function (ev) { setForm(Object.assign({}, form, { grill: ev.target.value })); } },
							h("option", { value: "now", children: "now" }), h("option", { value: "at_pickup", children: "at pickup" }), h("option", { value: "judgement", children: "judgement" }))),
					h("div", null, h("div", { className: "kb-label", children: "Plan" }),
						h("select", { className: "kb-select", value: form.plan, onChange: function (ev) { setForm(Object.assign({}, form, { plan: ev.target.value })); } },
							h("option", { value: "now", disabled: form.grill === "at_pickup", children: "now" }), h("option", { value: "at_pickup", children: "at pickup" }), h("option", { value: "one_shot", children: "one shot" }))),
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
				invalid ? h("div", { className: "kb-err", children: "plan=now cannot fire after an at-pickup grill. Choose plan=at_pickup, or grill=now." }) : null,
				h("div", null, h("button", { className: "kb-btn primary", disabled: invalid, onClick: save, children: "Save modes" }))
			);
		}

		function Gantt(props) {
			var spans = props.spans || [];
			if (spans.length === 0) return h("div", { className: "kb-empty", children: "No spans yet." });
			var min = Infinity, max = -Infinity;
			spans.forEach(function (s) {
				var a = new Date(s.startedAt).getTime();
				var b = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
				if (isFinite(a)) min = Math.min(min, a);
				if (isFinite(b)) max = Math.max(max, b);
			});
			if (!isFinite(min) || !isFinite(max) || max <= min) max = min + 1000;
			var depth = {};
			function depthOf(s, guard) {
				if (depth[s.id] !== undefined) return depth[s.id];
				var d = 0;
				if (s.parentSpanId && props.byId[s.parentSpanId]) d = 1 + depthOf(props.byId[s.parentSpanId], (guard || 0) + 1);
				depth[s.id] = d;
				return d;
			}
			var rows = spans.slice().sort(function (a, b) { return new Date(a.startedAt) - new Date(b.startedAt); });
			return h("div", { className: "kb-gantt" },
				rows.map(function (s) {
					var a = new Date(s.startedAt).getTime();
					var b = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
					var left = ((a - min) / (max - min)) * 100;
					var width = Math.max(0.4, ((b - a) / (max - min)) * 100);
					var cls = "kb-gbar " + (s.kind === "wait" ? "wait" : s.kind) + (s.status === "failed" ? " failed" : s.status === "abandoned" ? " abandoned" : "");
					var title = (s.role || s.kind) + " · " + (s.provider || "?") + "/" + (s.model || "?") + " · attempt " + s.attempt + " · " + fmtDur(s.durationMs);
					return h("div", { className: "kb-grow", key: s.id },
						h("div", { className: "kb-glabel", style: { paddingLeft: 8 + depthOf(s, 0) * 14 }, title: title, children: (s.kind === "tool" ? "· " : "") + s.name + (s.role ? " (" + s.role + ")" : "") }),
						h("div", { className: "kb-gtrack" }, h("div", { className: cls, style: { left: Math.min(99, Math.max(0, left)) + "%", width: Math.min(100, width) + "%" }, title: title }))
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

		function TicketDetail(props) {
			var d = props.detail;
			var tabState = React.useState("overview");
			var tab = tabState[0], setTab = tabState[1];
			var analyticsState = React.useState(null);
			var analytics = analyticsState[0], setAnalytics = analyticsState[1];
			React.useEffect(function () {
				if (tab === "analytics" && analytics === null) {
					rpc("analytics", {}).then(function (res) { if (res && res.ok) setAnalytics(res.value); });
				}
			}, [tab, analytics]);
			if (!d) return h("div", { className: "kb-empty", children: "Loading ticket…" });
			var t = d.ticket;
			var spanById = {};
			d.spans.forEach(function (s) { spanById[s.id] = s; });
			var questionArtifact = d.grill;
			var awaiting = t.phase === "grill" && questionArtifact && questionArtifact.questions && questionArtifact.questions.length > 0;
			var tabs = ["overview", "timeline", "sessions", "events", "analytics"];
			return h("div", { className: "kb-detail" },
				h("div", { className: "kb-row" },
					h("button", { className: "kb-btn", onClick: props.onBack, children: "← Board" }),
					h("span", { className: "kb-key", children: t.key }),
					h("h2", { className: "kb-title", style: { margin: 0, fontSize: 15 }, children: t.title }),
					h("span", { className: "kb-chip", children: t.column }),
					h("span", { className: "kb-chip", children: t.phase }),
					t.needsAttentionReason ? h("span", { className: "kb-chip err", children: "needs attention" }) : null
				),
				awaiting ? h(GrillAnswerForm, { ticket: t, questions: questionArtifact.questions, onSubmit: props.onAnswer }) : null,
				t.column === "needs_attention" ? h(NeedsAttention, { ticket: t, onResolve: props.onResolve }) : null,
				h("div", { className: "kb-tabs" }, tabs.map(function (name) {
					return h("button", { key: name, className: "kb-tab" + (tab === name ? " on" : ""), onClick: function () { setTab(name); }, children: name });
				})),
				tab === "overview" ? h(Overview, { detail: d, onSave: props.onSave, onAction: props.onAction, onAcceptance: props.onAcceptance }) : null,
				tab === "timeline" ? h("div", { className: "kb-panel" },
					h("h3", { children: "Span timeline (from spans, not aggregates)" }),
					h("div", { className: "kb-row", style: { marginBottom: 8 } },
						h("button", { className: "kb-btn", onClick: function () { rpc("export", { id: t.id, kind: "spans", format: "csv" }).then(function (res) { if (res && res.ok) download(t.key + "-spans.csv", res.value.mime, res.value.body); }); }, children: "Spans CSV" }),
						h("button", { className: "kb-btn", onClick: function () { rpc("export", { id: t.id, kind: "spans", format: "jsonl" }).then(function (res) { if (res && res.ok) download(t.key + "-spans.jsonl", res.value.mime, res.value.body); }); }, children: "Spans JSONL" }),
						h("button", { className: "kb-btn", onClick: function () { rpc("export", { id: t.id, kind: "usage", format: "csv" }).then(function (res) { if (res && res.ok) download(t.key + "-usage.csv", res.value.mime, res.value.body); }); }, children: "Usage CSV" })),
					h(Gantt, { spans: d.spans, byId: spanById })) : null,
				tab === "sessions" ? h(SessionsPanel, { detail: d, onAction: props.onAction }) : null,
				tab === "events" ? h(EventsPanel, { detail: d }) : null,
				tab === "analytics" ? h(AnalyticsPanel, { data: analytics }) : null
			);
		}

		function GrillAnswerForm(props) {
			var s = React.useState({});
			var answers = s[0], setAnswers = s[1];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			return h("div", { className: "kb-panel", style: { borderColor: "#f0c987", background: "#fffdf7" } },
				h("h3", { children: "Waiting on you — grill answers" }),
				h("div", { className: "kb-answers" },
					props.questions.map(function (q, i) {
						return h("div", { className: "kb-answerrow", key: i },
							h("div", { className: "kb-q", children: (i + 1) + ". " + q }),
							h("input", { className: "kb-input", style: { flex: 1 }, value: answers[i] || "", onChange: function (ev) { var n = Object.assign({}, answers); n[i] = ev.target.value; setAnswers(n); } }));
					})),
				h("div", { style: { marginTop: 8 } },
					h("button", {
						className: "kb-btn primary", disabled: busy,
						onClick: function () {
							setBusy(true);
							var list = props.questions.map(function (_, i) { return (answers[i] || "").trim(); });
							props.onSubmit(props.ticket.id, list).finally(function () { setBusy(false); });
						},
						children: busy ? "Sending…" : "Answer and continue"
					}))
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
						className: "kb-btn primary", disabled: busy,
						onClick: function () { setBusy(true); props.onResolve(props.ticket.id, "retry", instruction).finally(function () { setBusy(false); }); },
						children: "Retry with instruction"
					}),
					h("button", {
						className: "kb-btn danger", disabled: busy,
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
			var addState = React.useState("");
			var addText = addState[0], setAddText = addState[1];
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
				h("div", { className: "kb-panel" },
					h("h3", { children: "Ticket" }),
					h("div", { className: "kb-kv" },
						h("b", { children: "Workspace" }), h("span", { children: t.workspaceCwd || "(engine default)" }),
						h("b", { children: "Attempts" }), h("span", { children: t.attemptCount + " / " + (props.maxAttempts || 3) }),
						h("b", { children: "Spend" }), h("span", { children: fmtUsd(t.spentUsd) + (t.budgetUsd > 0 ? " / " + fmtUsd(t.budgetUsd) : " (no budget)") }),
						h("b", { children: "Allow paid" }), h("span", { children: t.allowPaid ? "yes" : "no" }),
						h("b", { children: "Created" }), h("span", { children: fmtTime(t.createdAt) }),
						h("b", { children: "Updated" }), h("span", { children: ago(t.updatedAt) }))
				),
				h("div", { className: "kb-panel" },
					h("h3", { children: "Modes and budget" }),
					h(ModeEditor, { ticket: t, onSave: function (patch) { props.onSave(t.id, patch); } })
				),
				h("div", { className: "kb-panel" },
					h("h3", { children: "Acceptance — the human's words, verbatim" }),
					d.acceptance.length === 0 ? h("div", { className: "kb-hint", children: "None stored." }) :
						h("ul", { style: { margin: 0, paddingLeft: 18 } }, d.acceptance.map(function (a, i) {
							return h("li", { key: i }, h("span", { className: "kb-chip", style: { marginRight: 6 }, children: a.source }), a.statement);
						})),
					h("div", { className: "kb-row", style: { marginTop: 8 } },
						h("input", { className: "kb-input", style: { flex: 1 }, placeholder: "Add a human acceptance statement (stored verbatim)", value: addText, onChange: function (ev) { setAddText(ev.target.value); } }),
						h("button", { className: "kb-btn", disabled: addText.trim() === "", onClick: function () { props.onAcceptance(t.id, addText.trim()); setAddText(""); }, children: "Add" }))
				),
				h("div", { className: "kb-panel" },
					h("h3", { children: "done_when — what verification judges" }),
					d.conditions.length === 0 ? h("div", { className: "kb-hint", children: "No conditions yet (plan or triage will produce them)." }) :
						h("table", { className: "kb-table" },
							h("thead", null, h("tr", null, h("th", { children: "id" }), h("th", { children: "statement" }), h("th", { children: "how verified" }), h("th", { children: "source" }))),
							h("tbody", null, d.conditions.map(function (c) {
								return h("tr", { key: c.id }, h("td", null, h("code", { children: c.id })), h("td", { children: c.statement }), h("td", { children: c.howVerified }), h("td", { children: c.source }));
							})))
				),
				h("div", { className: "kb-panel" },
					h("h3", { children: "Token and cost rollup" }),
					h("div", { className: "kb-row", style: { gap: 18, marginBottom: 8 } },
						h("span", { children: "input " + (usage.inputTokens || 0) }),
						h("span", { children: "output " + (usage.outputTokens || 0) }),
						h("span", { children: "cache read " + (usage.cacheReadTokens || 0) }),
						h("span", { children: "cache write " + (usage.cacheWriteTokens || 0) }),
						h("span", { children: usage.unpriced ? "unpriced" : fmtUsd(usage.costUsd || 0) })),
					models.length === 0 ? h("div", { className: "kb-hint", children: "No usage recorded." }) :
						h("table", { className: "kb-table" },
							h("thead", null, h("tr", null, h("th", { children: "provider" }), h("th", { children: "model" }), h("th", { children: "in" }), h("th", { children: "out" }), h("th", { children: "cost" }))),
							h("tbody", null, models.map(function (key) {
								var m = usage.byModel[key];
								return h("tr", { key: key }, h("td", { children: m.provider }), h("td", { children: m.model }), h("td", { children: m.inputTokens }), h("td", { children: m.outputTokens }), h("td", { children: m.unpriced ? "unpriced" : fmtUsd(m.costUsd) }));
							})))
				),
				h("div", { className: "kb-panel" },
					h("h3", { children: "Actions" }),
					h("div", { className: "kb-row" },
						h("button", { className: "kb-btn", onClick: function () { props.onAction(t.id, "block"); }, children: "Block…" }),
						h("button", { className: "kb-btn danger", onClick: function () { props.onAction(t.id, "discard"); }, children: "Discard" }),
						h("button", { className: "kb-btn", onClick: function () { rpc("export", { id: t.id, format: "jsonl" }).then(function (res) { if (res && res.ok) download(t.key + ".jsonl", res.value.mime, res.value.body); }); }, children: "Export JSONL" }),
						h("button", { className: "kb-btn", onClick: function () { rpc("export", { id: t.id, format: "csv" }).then(function (res) { if (res && res.ok) download(t.key + ".csv", res.value.mime, res.value.body); }); }, children: "Export CSV" }))
				)
			);
		}

		function SessionsPanel(props) {
			var d = props.detail;
			var s = React.useState("");
			var sessionId = s[0], setSessionId = s[1];
			return h("div", { className: "kb-panel" },
				h("h3", { children: "Sessions (retro-attach supported)" }),
				d.sessions.length === 0 ? h("div", { className: "kb-hint", children: "No sessions attached." }) :
					h("table", { className: "kb-table" },
						h("thead", null, h("tr", null, h("th", { children: "role" }), h("th", { children: "session" }), h("th", { children: "provider/model" }), h("th", { children: "created" }), h("th", { children: "" }))),
						h("tbody", null, d.sessions.map(function (session) {
							return h("tr", { key: session.id },
								h("td", { children: session.role }),
								h("td", null, h("code", { style: { fontSize: 10 }, children: session.sessionId })),
								h("td", { children: (session.provider || "?") + "/" + (session.model || "?") }),
								h("td", { children: fmtTime(session.createdAt) }),
								h("td", null, h("button", { className: "kb-btn", onClick: function () { props.onAction(d.ticket.id, "detachSession", { sessionId: session.sessionId }); }, children: "Detach" })));
						}))),
				h("div", { className: "kb-row", style: { marginTop: 10 } },
					h("input", { className: "kb-input", style: { flex: 1 }, placeholder: "Existing DSH session id", value: sessionId, onChange: function (ev) { setSessionId(ev.target.value); } }),
					h("button", { className: "kb-btn", disabled: sessionId.trim() === "", onClick: function () { props.onAction(d.ticket.id, "attachSession", { sessionId: sessionId.trim(), role: "implementer" }); setSessionId(""); }, children: "Attach" }))
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
			function table(title, rows, cols) {
				return h("div", { className: "kb-panel", style: { marginBottom: 12 } },
					h("h3", { children: title }),
					rows.length === 0 ? h("div", { className: "kb-hint", children: "No data yet." }) :
						h("table", { className: "kb-table" },
							h("thead", null, h("tr", null, cols.map(function (c) { return h("th", { key: c[0], children: c[1] }); }))),
							h("tbody", null, rows.map(function (row, i) {
								return h("tr", { key: i }, cols.map(function (c) { return h("td", { key: c[0], children: typeof c[2] === "function" ? c[2](row) : row[c[0]] }); }));
							}))));
			}
			return h("div", null,
				table("Attempts to done", a.attemptsToDone, [["attempts", "attempts"], ["tickets", "tickets"]]),
				table("Model success rate", a.modelSuccessRate, [["provider", "provider"], ["model", "model"], ["tickets", "tickets"], ["done", "done"], ["rate", "rate", function (r) { return r.rate === null ? "—" : Math.round(r.rate * 100) + "%"; }]]),
				table("Confidence calibration", a.calibration, [["verdict", "verdict"], ["bucket", "confidence"], ["n", "n"], ["done", "done"]]),
				table("Cost per ticket", a.costPerTicket, [["key", "ticket"], ["inputTokens", "in"], ["outputTokens", "out"], ["costUsd", "cost", function (r) { return r.unpricedRows > 0 ? "unpriced" : fmtUsd(r.costUsd); }]]),
				table("Stall rate by role", a.stallRate, [["role", "role"], ["spans", "spans"], ["abandoned", "abandoned"], ["rate", "rate", function (r) { return r.rate === null ? "—" : Math.round(r.rate * 100) + "%"; }]])
			);
		}

		// ------------------------------------------------------------------ page

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
			var poll = React.useRef(0);

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
				loadBoard();
				var timer = setInterval(function () {
					poll.current += 1;
					loadBoard();
					if (selectedId) loadDetail(selectedId);
				}, 3000);
				return function () { clearInterval(timer); };
			}, [selectedId]);
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

			var columns = board ? board.columns : { backlog: [], now: [], blocked: [], needs_attention: [], done: [], discarded: [] };
			var nowGroups = board ? board.now : { active: [], waiting: [], pending_capacity: [], blocked: [] };
			var counts = board ? board.counts : {};
			return h("div", { className: "kb-root" },
				h("div", { className: "kb-bar" },
					h("h1", { className: "kb-title", children: "Kanban" }),
					h("span", { className: "kb-sub", children: board ? [
						counts.backlog + " backlog",
						counts.now + " now",
						counts.blocked + " blocked",
						counts.needs_attention + " attention",
						counts.done + " done"
					].join(" · ") : "loading" }),
					h("span", { className: "kb-spacer" }),
					h("button", { className: "kb-btn" + (view === "board" ? " primary" : ""), onClick: function () { setView("board"); setSelectedId(null); }, children: "Board" }),
					h("button", { className: "kb-btn" + (view === "analytics" ? " primary" : ""), onClick: function () { setView("analytics"); }, children: "Analytics" }),
					h("button", { className: "kb-btn", onClick: function () { loadBoard(); }, children: "Refresh" }),
					h("button", { className: "kb-btn primary", onClick: function () { setCreating(true); setSelectedId(null); setView("board"); }, children: "+ New ticket" })
				),
				h("div", { className: "kb-body" },
					notice ? h("div", { className: "kb-notice" }, notice) : null,
					creating ? h("div", { className: "kb-panel" }, h("h3", { children: "New ticket" }), h(CreateForm, { onClose: function () { setCreating(false); }, onCreated: function (ticket) { setCreating(false); setSelectedId(ticket.id); loadBoard(); loadDetail(ticket.id); } })) : null,
					selectedId ? h(TicketDetail, {
						detail: detail,
						onBack: function () { setSelectedId(null); setDetail(null); },
						onSave: function (id, patch) { act("update", { id: id, patch: patch }); },
						onAnswer: function (id, answers) { return act("answer", { id: id, answers: answers }); },
						onResolve: function (id, action, instruction) { return act("resolve", { id: id, action: action, instruction: instruction }); },
						onAction: function (id, action, extra) { return act("action", Object.assign({ id: id, action: action }, extra || {})); }
					}) : view === "analytics" ? h("div", { style: { maxWidth: 900 } }, h(AnalyticsPanel, { data: analyticsData })) : h("div", null,
						h("div", { className: "kb-cols" },
							h(Column, { column: "backlog", label: "Backlog", items: columns.backlog, onOpen: open, onMove: move, onReorder: reorder }),
							h(Column, { column: "now", label: "Now", items: columns.now, onOpen: open, onMove: move, onReorder: reorder }),
							h(Column, { column: "blocked", label: "Blocked", items: columns.blocked, onOpen: open, onMove: move, onReorder: reorder }),
							h(Column, { column: "needs_attention", label: "Needs attention", items: columns.needs_attention, attention: true, onOpen: open, onMove: move, onReorder: reorder }),
							h(Column, { column: "done", label: "Done / Discarded", items: columns.done.concat(columns.discarded), onOpen: open, onMove: move, onReorder: reorder })
						),
						board ? h("div", { className: "kb-now" },
							h("div", { className: "kb-grouphead", children: "Now · active" }),
							nowGroups.active.length === 0 ? h("div", { className: "kb-hint", children: "Nothing running." }) : h("div", { className: "kb-list" }, nowGroups.active.map(function (t) { return h(Card, { key: t.id, ticket: t, onOpen: open, onReorder: reorder }); })),
							h("div", { className: "kb-grouphead", children: "Now · waiting on you" }),
							nowGroups.waiting.length === 0 ? h("div", { className: "kb-hint", children: "Nothing waiting." }) : h("div", { className: "kb-list" }, nowGroups.waiting.map(function (t) { return h(Card, { key: t.id, ticket: t, onOpen: open, onReorder: reorder }); })),
							h("div", { className: "kb-grouphead", children: "Now · pending capacity" }),
							nowGroups.pending_capacity.length === 0 ? h("div", { className: "kb-hint", children: "No queued tickets." }) : h("div", { className: "kb-list" }, nowGroups.pending_capacity.map(function (t) { return h(Card, { key: t.id, ticket: t, onOpen: open, onReorder: reorder }); })),
							h("div", { className: "kb-grouphead", children: "Capacity" }),
							h("div", { className: "kb-row" }, (board.capacity || []).map(function (c) {
								return h("span", { key: c.name, className: "kb-chip" + (c.used >= c.maxConcurrent ? " warn" : ""), children: c.name + " " + c.used + "/" + c.maxConcurrent });
							}))
						) : null
					)
				)
			);

			function open(id) { setSelectedId(id); loadDetail(id); }
			function move(id, column) {
				if (column === "done") return;
				act("move", { id: id, column: column });
			}
			function reorder(id, beforeId) {
				if (id === beforeId) return;
				act("reorder", { id: id, beforeId: beforeId });
			}
		}

		// ------------------------------------------------------------------ apply

		function apply(ctx) {
			connection = ctx.connection !== undefined ? ctx.connection : ctx.get ? ctx.get("connection") : null;
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
