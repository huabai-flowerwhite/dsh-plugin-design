// dsh-plugin-design — Client half (Settings UI)
//
// 在「设置 → dsh plugin design」页展示本插件的使用方法。
// 持久化包版本为纯静态说明（不含 Client→Host 发现列表，那需要 Remote 传输接入）。

export default {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    styles.insert(
      '.dshpd-panel { font-family: inherit; padding: 4px 0; line-height: 1.6; }' +
      '.dshpd-panel h3 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }' +
      '.dshpd-panel h4 { margin: 14px 0 4px; font-size: 13px; font-weight: 600; }' +
      '.dshpd-lead { opacity: 0.75; font-size: 13px; margin-bottom: 4px; }' +
      '.dshpd-cmd { margin: 6px 0; padding: 10px; border: 1px dashed var(--color-border, #ccc); border-radius: 8px; background: var(--color-bg-secondary, #f5f5f5); font-size: 13px; white-space: pre-wrap; word-break: break-word; }' +
      '.dshpd-step { font-size: 13px; margin: 2px 0; }' +
      '.dshpd-step b { font-weight: 600; }' +
      '.dshpd-tools { font-size: 12px; opacity: 0.85; margin: 4px 0; line-height: 1.7; }' +
      '.dshpd-note { font-size: 12px; opacity: 0.7; margin-top: 10px; }'
    )

    const TOOLS = 'dshpd_discover · dshpd_inspect · dshpd_analyze · dshpd_design · dshpd_approve · dshpd_backup · dshpd_apply · dshpd_rollback · dshpd_status · dshpd_report'

    function h(tag, props, children) {
      return React.createElement(tag, props, ...(Array.isArray(children) ? children : [children]))
    }

    function Panel() {
      return h('div', { className: 'dshpd-panel' }, [
        h('h3', null, 'dsh plugin design'),
        h('div', { className: 'dshpd-lead' }, 'DH-TP-SDK 第三方插件规范适配与自动修改元插件：发现、分析、生成 design.md，经你确认后逐项修改并可回滚。'),

        h('h4', null, '使用方法（聊天框入口）'),
        h('div', { className: 'dshpd-cmd' }, '使用dsh plugin design插件，输出对 <插件名> 插件进行规范修改的design.md文件，然后询问我意见后进行规范修改'),

        h('h4', null, '两阶段工作流'),
        h('div', { className: 'dshpd-step' }, [h('b', null, '阶段 1（只读分析）：'), 'discover → inspect → analyze → design（生成 design.md），此阶段绝不修改源码。']),
        h('div', { className: 'dshpd-step' }, [h('b', null, '阶段 2（你确认后才修改）：'), 'approve（门控）→ backup（备份）→ apply（逐项原子替换）→ rollback / report。']),

        h('h4', null, '安全边界'),
        h('div', { className: 'dshpd-step' }, '分析先于修改、设计先于执行；未确认前不修改；修改前备份、失败可回滚；不修改 Core、不用 private API。'),

        h('h4', null, '工具清单（10 个）'),
        h('div', { className: 'dshpd-tools' }, TOOLS),

        h('h4', null, '安装（持久化 preset）'),
        h('div', { className: 'dshpd-step' }, '把整个 dsh-plugin-design/ 目录放到 $DSH_HOME/.agent-presets/dsh-plugin-design/，新建会话选择「dsh plugin design」preset 即拥有上述工具。'),

        h('div', { className: 'dshpd-note' }, '说明：DH-TP-SDK 的 Bronze/Silver/Gold、P0–P4、S0–S4 为工程化规范等级，非 DeepSeek 官方认证。')
      ])
    }

    slots.inject('settings.section', function () {
      return slots.register(
        { name: 'settings.section', id: 'dsh-plugin-design', order: 100, label: 'dsh plugin design' },
        function () { return React.createElement(Panel, null) }
      )
    })
  },
}
