// A 401/403 from the gateway is a credential failure, not an outage, and a
// 401 with `code: "workspace_deleted"` says so once per session
// (gatewaystack-connect#1693; mirrors codex-acp-plugin
// test/key-rejected.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decide } from '../hook.mjs'

async function withGateway(status, reply, fn) {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(reply === undefined ? '' : JSON.stringify(reply))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try { return await fn(`http://127.0.0.1:${server.address().port}`) } finally { server.close() }
}

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'acp-keyrej-'))
  mkdirSync(join(home, '.acp'), { recursive: true })
  writeFileSync(join(home, '.acp', 'credentials'), 'test-token')
  return home
}

function runPre(base, home, extra = {}) {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    permission_mode: 'default',
    ...extra,
  }
  return decide(payload, { HOME: home, ACP_GOVERN_BASE: base })
}

const decision = (r) => r.out.hookSpecificOutput?.permissionDecision ?? 'allow'
const reason = (r) => r.out.hookSpecificOutput?.permissionDecisionReason
const DELETED = { error: 'workspace deleted', code: 'workspace_deleted' }

test('interactive 401 proceeds with KEY REJECTED naming the key and the fix, and logs the lapse', async () => {
  const home = tmpHome()
  const r = await withGateway(401, { error: 'invalid key' }, (b) => runPre(b, home, { session_id: 's1' }))
  assert.equal(decision(r), 'allow')
  assert.match(r.out.systemMessage, /^\[ACP\] ⚠ KEY REJECTED \(HTTP 401\): the key in ~\/\.acp\/credentials is revoked or invalid/)
  assert.match(r.out.systemMessage, /install\.sh/)
  assert.match(r.out.systemMessage, /settings\/api-keys/)
  assert.doesNotMatch(r.out.systemMessage, /unreachable/i)
  assert.match(readFileSync(join(home, '.acp', 'lapse.log'), 'utf8'), /key rejected \(HTTP 401\)/)
})

test('interactive 401 with no body still reads as KEY REJECTED', async () => {
  const r = await withGateway(401, undefined, (b) => runPre(b, tmpHome()))
  assert.equal(decision(r), 'allow')
  assert.match(r.out.systemMessage, /KEY REJECTED \(HTTP 401\)/)
})

test('unattended 401 stays denied with the cause named', async () => {
  const r = await withGateway(401, { error: 'invalid key' }, (b) => runPre(b, tmpHome(), { permission_mode: 'never' }))
  assert.equal(decision(r), 'deny')
  assert.match(reason(r), /Key rejected \(HTTP 401\)/)
  assert.match(reason(r), /~\/\.acp\/credentials/)
  assert.doesNotMatch(reason(r), /unreachable/i)
})

test('403 is treated like 401', async () => {
  const i = await withGateway(403, { error: 'forbidden' }, (b) => runPre(b, tmpHome()))
  assert.equal(decision(i), 'allow')
  assert.match(i.out.systemMessage, /KEY REJECTED \(HTTP 403\)/)
  const u = await withGateway(403, { error: 'forbidden' }, (b) => runPre(b, tmpHome(), { permission_mode: 'never' }))
  assert.equal(decision(u), 'deny')
  assert.match(reason(u), /Key rejected \(HTTP 403\)/)
})

test('5xx keeps the outage posture', async () => {
  const i = await withGateway(503, { error: 'down' }, (b) => runPre(b, tmpHome()))
  assert.equal(decision(i), 'allow')
  assert.match(i.out.systemMessage, /UNGOVERNED: gateway unreachable \(HTTP 503/)
  const u = await withGateway(503, { error: 'down' }, (b) => runPre(b, tmpHome(), { permission_mode: 'never' }))
  assert.equal(decision(u), 'deny')
  assert.match(reason(u), /Gateway unreachable/)
})

test('interactive workspace_deleted: one notice per session, then silent; lapse logged every call', async () => {
  const home = tmpHome()
  await withGateway(401, DELETED, async (b) => {
    const first = await runPre(b, home, { session_id: 'sess-a' })
    assert.equal(decision(first), 'allow')
    assert.match(first.out.systemMessage, /workspace this machine was connected to has been deleted/)
    assert.match(first.out.systemMessage, /acp-uninstall/)
    assert.match(first.out.systemMessage, /uninstall\.sh/)
    assert.ok(existsSync(join(home, '.acp', 'notices', 'workspace-deleted.sess-a')))

    const second = await runPre(b, home, { session_id: 'sess-a' })
    assert.deepEqual(second.out, {})
    assert.equal(second.warn, undefined)

    const otherSession = await runPre(b, home, { session_id: 'sess-b' })
    assert.match(otherSession.out.systemMessage, /has been deleted/)
  })
  const lapses = readFileSync(join(home, '.acp', 'lapse.log'), 'utf8').trim().split('\n')
  assert.equal(lapses.length, 3)
})

test('interactive workspace_deleted with no session id: at most once per 24h', async () => {
  const home = tmpHome()
  await withGateway(401, DELETED, async (b) => {
    const first = await runPre(b, home)
    assert.match(first.out.systemMessage, /has been deleted/)
    const second = await runPre(b, home)
    assert.deepEqual(second.out, {})
  })
})

test('unattended workspace_deleted denies every call with the deleted message', async () => {
  const home = tmpHome()
  await withGateway(401, DELETED, async (b) => {
    for (let i = 0; i < 2; i++) {
      const r = await runPre(b, home, { permission_mode: 'never', session_id: 'sess-u' })
      assert.equal(decision(r), 'deny')
      assert.match(reason(r), /has been deleted/)
      assert.match(reason(r), /acp-uninstall/)
    }
  })
})
