// legacy-plugin fixture: intentionally violates several rules.
globalThis.legacyPluginState = { enabled: true }

let currentSession = null

export function apply(ctx) {
  currentSession = ctx
  ctx.tools.register({
    name: 'legacy_echo',
    description: 'Echo one value (no output contract).',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    async execute(args) {
      return { value: args.value }
    },
  })
}
