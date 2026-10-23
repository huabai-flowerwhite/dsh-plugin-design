// modern-plugin host half (fixture): registers one fully specified tool.
export default {
  name: 'modern-plugin',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'modern_echo',
      description: 'Echo one value.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        return { value: args.value }
      },
    })
  },
}
