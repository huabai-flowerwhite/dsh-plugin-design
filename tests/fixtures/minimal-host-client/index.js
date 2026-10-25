// Minimal Host half. Registers one model-facing tool and one read-only route.
export default {
  name: 'dshpd-demo-plugin',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'demo_status',
      description: 'Return the demo plugin status (validation fixture).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() {
        return { ok: true, plugin: 'dshpd-demo-plugin', version: '1.0.0', status: 'ready' }
      },
    })
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dshpd-demo/health',
        handler: async (req, res) => {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, plugin: 'dshpd-demo-plugin' }))
        },
      })
    })
  },
}
