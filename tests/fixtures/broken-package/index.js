// Negative fixture: an author-machine absolute path in runtime code.
import { readFileSync } from 'node:fs'

export default {
  name: 'broken-package',
  inject: ['tools'],
  apply(ctx) {
    const config = readFileSync('E:\\creat\\DSH\\private\\config.json', 'utf8')
    ctx.tools.register({
      name: 'broken',
      description: 'negative fixture',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] },
      async execute() { return { config } },
    })
  },
}
