window.__ModuleLoader__.load({
	id: "dsh-plugin-design",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const TOOLS = "dshpd_discover · dshpd_inspect · dshpd_analyze · dshpd_design · dshpd_approve · dshpd_backup · dshpd_apply · dshpd_rollback · dshpd_status · dshpd_report";

		function h(tag, props, kids) {
			return React.createElement(tag, props, ...(Array.isArray(kids) ? kids : [kids]));
		}

		const css = {
			panel: { fontFamily: "inherit", padding: "4px 0", lineHeight: "1.6" },
			h3: { margin: "0 0 6px", fontSize: 15, fontWeight: 600 },
			h4: { margin: "14px 0 4px", fontSize: 13, fontWeight: 600 },
			lead: { opacity: 0.75, fontSize: 13, marginBottom: 4 },
			cmd: { margin: "6px 0", padding: 10, border: "1px dashed #ccc", borderRadius: 8, background: "#f5f5f5", fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" },
			step: { fontSize: 13, margin: "2px 0" },
			tools: { fontSize: 12, opacity: 0.85, margin: "4px 0", lineHeight: 1.7 },
			note: { fontSize: 12, opacity: 0.7, marginTop: 10 },
			row: { display: "flex", alignItems: "center", gap: 10, padding: 10, border: "1px solid #ddd", borderRadius: 8, marginBottom: 8 },
			meta: { flex: "1 1 auto", minWidth: 0 },
			name: { fontWeight: 600 },
			path: { fontSize: 12, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			btn: { border: "1px solid #ccc", background: "#f5f5f5", borderRadius: 6, padding: "6px 10px", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" },
			btnPrimary: { border: "1px solid #2563eb", background: "#2563eb", color: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" },
			input: { flex: "1 1 auto", minWidth: 0, border: "1px solid #ccc", background: "#fff", color: "#222", borderRadius: 6, padding: "6px 10px", fontSize: 13 },
			empty: { opacity: 0.7, fontSize: 13, padding: "8px 0" },
			prompt: { marginTop: 12, padding: 10, border: "1px dashed #ccc", borderRadius: 8 },
			err: { color: "#c00", fontSize: 13, marginTop: 8 }
		};

		function Panel(props) {
			const [plugins, setPlugins] = React.useState([]);
			const [loading, setLoading] = React.useState(false);
			const [prompt, setPrompt] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [root, setRoot] = React.useState("");
			const pickDirectoryFn = props && props.pickDirectory;

			function pickDirectory() {
				if (pickDirectoryFn) {
					setError(null);
					pickDirectoryFn().then(function (path) {
						if (path) setRoot(path);
					}).catch(function (e) {
						setError("目录选择失败：" + String(e && e.message ? e.message : e) + "（可在输入框手动粘贴路径）");
					});
				} else {
					setError("当前环境未提供目录选择器，请手动输入路径");
				}
			}

			function scan() {
				const target = String(root || "").trim();
				if (!target) { setError("请先选择或输入第三方插件库文件夹路径"); return; }
				setLoading(true);
				setError(null);
				fetch("/dsh-plugin-design/discover", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ root: target })
				}).then(function (r) { return r.json(); }).then(function (data) {
					setPlugins((data && data.plugins) || []);
					setLoading(false);
				}).catch(function (e) {
					setError(String(e && e.message ? e.message : e));
					setLoading(false);
				});
			}

			function requestPrompt(p) {
				setPrompt("使用dsh plugin design插件，输出对 " + p.name + " 插件进行规范修改的design.md文件，然后询问我意见后进行规范修改");
			}

			function row(p) {
				return h("div", { style: css.row, key: p.path }, [
					h("div", { style: css.meta }, [
						h("div", { style: css.name }, p.name),
						h("div", { style: css.path }, p.path),
						h("div", { style: css.path }, (p.hasManifest ? "manifest " : "no-manifest ") + (p.hasPackageJson ? "package.json" : "no-package.json"))
					]),
					h("button", { style: css.btn, onClick: function () { requestPrompt(p); } }, "规范修改")
				]);
			}

			return h("div", { style: css.panel }, [
				h("h3", { style: css.h3 }, "dsh plugin design"),
				h("div", { style: css.lead }, "DH-TP-SDK 第三方插件规范适配与自动修改元插件：发现、分析、生成 design.md，经你确认后逐项修改并可回滚。"),

				h("h4", { style: css.h4 }, "使用方法（聊天框入口）"),
				h("div", { style: css.cmd }, "使用dsh plugin design插件，输出对 <插件名> 插件进行规范修改的design.md文件，然后询问我意见后进行规范修改"),

				h("h4", { style: css.h4 }, "两阶段工作流"),
				h("div", { style: css.step }, "阶段 1（只读分析）：discover → inspect → analyze → design（生成 design.md），此阶段绝不修改源码。"),
				h("div", { style: css.step }, "阶段 2（你确认后才修改）：approve（门控）→ backup（备份）→ apply（逐项原子替换）→ rollback / report。"),

				h("h4", { style: css.h4 }, "安全边界"),
				h("div", { style: css.step }, "分析先于修改、设计先于执行；未确认前不修改；修改前备份、失败可回滚；不修改 Core、不用 private API。"),

				h("h4", { style: css.h4 }, "发现第三方插件"),
				h("div", { style: css.row }, [
					h("input", {
						style: css.input,
						placeholder: "第三方插件库文件夹路径，如 E:\\creat\\DSH\\open",
						value: root,
						onChange: function (e) { setRoot(e.target.value); }
					}),
					h("button", { style: css.btn, onClick: pickDirectory }, "选择文件夹"),
					h("button", { style: css.btnPrimary, onClick: scan, disabled: loading }, loading ? "扫描中…" : "扫描")
				]),
				plugins.length === 0
					? h("div", { style: css.empty }, loading ? "正在扫描第三方插件…" : "尚未扫描，或该文件夹中未发现第三方插件项目（含 dsh.plugin.yaml 或 package.json 的目录）")
					: plugins.map(row),
				prompt !== null
					? h("div", { style: css.prompt }, [
							h("div", { style: css.name }, "复制到聊天框执行："),
							h("div", { style: css.cmd }, prompt)
						])
					: null,
				error !== null ? h("div", { style: css.err }, error) : null,

				h("h4", { style: css.h4 }, "工具清单（10 个）"),
				h("div", { style: css.tools }, TOOLS),

				h("div", { style: css.note }, "说明：DH-TP-SDK 的 Bronze/Silver/Gold、P0–P4、S0–S4 为工程化规范等级，非 DeepSeek 官方认证。")
			]);
		}

		function apply(ctx) {
			const slots = ctx.slots;
			const workspaces = ctx.get("workspaces");
			const pickDirectory = workspaces && typeof workspaces.pickDirectory === "function"
				? function () { return workspaces.pickDirectory(); }
				: null;
			slots.inject("settings.section", function () {
				return slots.register(
					{ name: "settings.section", id: "dsh-plugin-design", order: 100, label: "dsh plugin design" },
					function () { return React.createElement(Panel, { pickDirectory: pickDirectory }); }
				);
			});
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
