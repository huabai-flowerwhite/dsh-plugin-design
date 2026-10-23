import { InvariantRegistry } from '@deepseek-ai/dsh-invariants'
import { check } from '@deepseek-ai/dsh-session/invariant'

export function apply(ctx) {
  const registry = new InvariantRegistry(ctx)
  void registry
  void check
}
