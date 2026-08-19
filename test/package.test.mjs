import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('P1: only schemastery is a runtime dependency; dsh runtime packages are peers', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(pkg.dependencies, { '@deepseek-ai/schemastery': '3.18.1' })
  assert.deepEqual(pkg.peerDependencies, {
    '@deepseek-ai/cordis': '4.0.1',
    '@deepseek-ai/dsh-llm': '0.1.0-rc.7',
    '@deepseek-ai/dsh-llm-pi-ai': '0.1.0-rc.7',
    '@deepseek-ai/dsh-settings': '0.1.0-rc.7',
  })
  for (const name of Object.keys(pkg.dependencies)) {
    assert.ok(name === '@deepseek-ai/schemastery', `runtime dependency ${name} must be a peer`)
  }
  assert.ok(pkg.dsh.bundle.patch === './cordis.patch.yml')
})
