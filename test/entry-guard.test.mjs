import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMainEntry } from '../hook.mjs'

const hookPath = fileURLToPath(new URL('../hook.mjs', import.meta.url))
const hookUrl = pathToFileURL(realpathSync(hookPath)).href

test('isMainEntry: true when argv[1] is the real file path', () => {
  assert.equal(isMainEntry(hookPath, hookUrl), true)
})

test('isMainEntry: true when argv[1] is a symlink to the file (npm .bin shim)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-acp-bin-'))
  const shim = join(dir, 'muse-acp-hook')
  symlinkSync(hookPath, shim)
  assert.equal(isMainEntry(shim, hookUrl), true)
})

test('isMainEntry: false when argv[1] is a different file (imported as a module)', () => {
  const wrapper = fileURLToPath(new URL('../hooks/pre.mjs', import.meta.url))
  assert.equal(isMainEntry(wrapper, hookUrl), false)
})

test('isMainEntry: false and never throws for a missing or empty argv[1]', () => {
  assert.equal(isMainEntry(join(tmpdir(), 'does-not-exist-' + Date.now()), hookUrl), false)
  assert.equal(isMainEntry(undefined, hookUrl), false)
  assert.equal(isMainEntry('', hookUrl), false)
})
