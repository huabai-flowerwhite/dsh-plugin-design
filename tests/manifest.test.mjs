// dsh-plugin-design — manifest / package.json / bundle / 源码安全 冒烟测试
//
// 运行：node --test tests/  （package.json 的 npm test 会走到这里）
//
// 依据 DH-TP-SDK（DeepSeek-Harness-Third-Party-Plugin-SDK-Specification.md）
// 校验本插件自身的规范合规性：manifest 必填字段、最小权限、三处导出、
// cordis.patch.yml 仅 insert 不替换 Core row、源码无高危模式。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function read(rel) {
  return readFileSync(join(root, rel), 'utf8')
}

test('dsh.plugin.yaml 存在且含 DH-TP-SDK 必填字段', () => {
  const raw = read('dsh.plugin.yaml')
  assert.match(raw, /^manifestVersion:\s*1\s*$/m, 'manifestVersion 应为 1')
  assert.match(raw, /^plugin:/m, '应有 plugin 块')
  assert.match(raw, /^\s+id:\s*com\.example\.dsh\.plugin-design\s*$/m, 'plugin.id 应为全局唯一 ID')
  assert.match(raw, /^runtime:/m, '应有 runtime 块')
  assert.match(raw, /^\s+harness:/m, '应有 runtime.harness 兼容范围')
  assert.match(raw, /^cordis:/m, '应有 cordis 块')
  assert.match(raw, /^\s+apiLevel:\s*1\s*$/m, 'cordis.apiLevel 应为 1')
  assert.match(raw, /^capabilities:/m, '应有 capabilities')
  assert.match(raw, /^permissions:/m, '应有 permissions（权限 Manifest 化）')
  assert.match(raw, /^resources:/m, '应有 resources 资源上限')
  assert.match(raw, /^lifecycle:/m, '应有 lifecycle')
  assert.match(raw, /^security:/m, '应有 security')
  assert.match(raw, /^\s+level:\s*S2\s*$/m, 'security.level 应为 S2（需读写 workspace 文件）')
  assert.match(raw, /^compatibility:/m, '应有 compatibility')
})

test('dsh.plugin.yaml 权限声明：网络/子进程/shell/密钥默认关闭', () => {
  const raw = read('dsh.plugin.yaml')
  assert.match(raw, /outbound:\s*false/m, 'network.outbound 应为 false')
  assert.match(raw, /^\s+enabled:\s*false\s*$/m, 'subprocess/shell 应为 false')
  assert.match(raw, /access:\s*false/m, 'credentials.access 应为 false')
  assert.doesNotMatch(raw, /(api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i, '不应含硬编码密钥')
})

test('package.json 声明三处导出 + dsh 兼容信息', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.name, 'dsh-plugin-design')
  assert.ok(pkg.version, '应有 version')
  assert.ok(pkg.engines && pkg.engines.node, '应有 engines.node')
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', 'dsh.client.platform 应为 web')
  assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, 'dsh.bundle.patch 应指向 cordis.patch.yml')
  assert.ok(pkg.dsh && pkg.dsh.compatibility && pkg.dsh.compatibility.apiLevel, '应声明 compatibility.apiLevel')
})

test('cordis.patch.yml 仅 insert 自己的 row，不替换 Core row', () => {
  const raw = read('cordis.patch.yml')
  assert.match(raw, /- insert:/m, '应为 insert 形态')
  assert.match(raw, /id:\s*dsh-plugin-design/m, '应包含本插件 id')
  assert.doesNotMatch(raw, /replace|replacement/i, '不应替换 Core row')
})

test('源码不含高危模式（globalThis/window 赋值、prototype patch、类型断言绕过、危险命令、命令注入）', () => {
  for (const rel of ['src/host.js', 'src/client.js', 'lib/client.js']) {
    const raw = read(rel)
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const loc = `${rel}:${i + 1}`
      assert.doesNotMatch(line, /globalThis\s*\.\s*\w+\s*=/, `globalThis 赋值（${loc}）`)
      assert.doesNotMatch(line, /window\s*\.\s*\w+\s*=/, `window 赋值（${loc}）`)
      assert.doesNotMatch(line, /\b\w+\.prototype\.\w+\s*=/, `prototype patch（${loc}）`)
      assert.doesNotMatch(line, /\bas\s+any\b|\bas\s+unknown\b/, `类型断言绕过（${loc}）`)
      assert.doesNotMatch(line, /(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-fd|git\s+push\s+--force|rmdir\s+\/s)/i, `危险命令（${loc}）`)
      assert.doesNotMatch(line, /exec\s*\(\s*["'][^"']*\+|exec\s*\(\s*`[^`]*\$\{/, `命令注入（${loc}）`)
    }
  }
})
