import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { decide, buildReceiptMessage } from '../hook.mjs'

// Mock govern gateway: each test sets `nextResponse` (or `failMode`) and the
// server answers accordingly. Requests are recorded for payload assertions.
let server, base
let nextResponse = {}
let failMode = null // 'refuse' closes the socket; a number answers that HTTP status
const requests = []

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(body) })
      if (failMode === 'refuse') return req.socket.destroy()
      if (typeof failMode === 'number') {
        res.writeHead(failMode).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(nextResponse))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // Node 18 runs a file's root after() only once the event loop drains, which
  // a listening server prevents: unref it so the file can finish.
  server.unref()
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

const env = overrides => ({
  ACP_BEARER_TOKEN: 'test-token',
  ACP_GOVERN_BASE: base,
  ACP_CHECK_TIMEOUT_MS: '1500',
  ...overrides,
})

const preCall = {
  hook_event_name: 'PreToolUse',
  tool_name: 'shell',
  tool_input: { command: 'rm -rf /tmp/x' },
  session_id: 'sess-1',
  cwd: '/work',
}

test('allow returns an empty decision object', async () => {
  failMode = null
  nextResponse = { decision: 'allow' }
  const { out } = await decide(preCall, env())
  assert.deepEqual(out, {})
})

test('deny is a hookSpecificOutput permissionDecision with the policy reason', async () => {
  nextResponse = { decision: 'deny', reason: 'dangerous delete' }
  const { out } = await decide(preCall, env())
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /dangerous delete/)
})

test('ask maps to the ask decision', async () => {
  nextResponse = { decision: 'ask', reason: 'needs a human' }
  const { out } = await decide(preCall, env())
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /needs a human/)
})

test('gateway payload carries tool, session, event, and tier', async () => {
  nextResponse = { decision: 'allow' }
  requests.length = 0
  await decide(preCall, env({ ACP_AGENT_TIER: 'subagent' }))
  assert.equal(requests[0].path, '/govern/tool-use')
  assert.equal(requests[0].body.tool_name, 'shell')
  assert.equal(requests[0].body.session_id, 'sess-1')
  assert.equal(requests[0].body.hook_event_name, 'PreToolUse')
  assert.equal(requests[0].body.agent_tier, 'subagent')
})

test('PermissionRequest: policy deny settles the approval, ask stays out of the way', async () => {
  nextResponse = { decision: 'deny', reason: 'not in this workspace' }
  requests.length = 0
  const denied = await decide({ ...preCall, hook_event_name: 'PermissionRequest' }, env())
  assert.equal(requests[0].path, '/govern/tool-use')
  assert.equal(denied.out.hookSpecificOutput.decision.behavior, 'deny')
  assert.match(denied.out.hookSpecificOutput.decision.message, /not in this workspace/)

  nextResponse = { decision: 'ask', reason: 'hold' }
  const asked = await decide({ ...preCall, hook_event_name: 'PermissionRequest' }, env())
  assert.deepEqual(asked.out, {})
})

test('unreachable gateway fails OPEN on interactive tier with a loud warning', async () => {
  failMode = 'refuse'
  const { out, warn } = await decide(preCall, env({ ACP_AGENT_TIER: 'interactive' }))
  assert.match(out.systemMessage, /UNGOVERNED/)
  assert.equal(out.hookSpecificOutput, undefined)
  assert.match(warn, /UNGOVERNED/)
  failMode = null
})

test('permission_mode never resolves to the unattended tier', async () => {
  failMode = 'refuse'
  const { out } = await decide({ ...preCall, permission_mode: 'never' }, env())
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /fail-closed/)
  failMode = null
})

test('unreachable gateway fails CLOSED on background tier', async () => {
  failMode = 'refuse'
  const { out } = await decide(preCall, env({ ACP_AGENT_TIER: 'background' }))
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /fail-closed/)
  failMode = null
})

test('an HTTP error status is not retried', async () => {
  failMode = 429
  requests.length = 0
  const { out } = await decide(preCall, env({ ACP_AGENT_TIER: 'background' }))
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(requests.length, 1)
  failMode = null
})

test('a transport failure is retried once', async () => {
  // First request refused, second answered: flip failMode from inside the
  // handler by counting requests.
  let n = 0
  const orig = server.listeners('request')[0]
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    n += 1
    if (n === 1) return req.socket.destroy()
    orig(req, res)
  })
  nextResponse = { decision: 'allow' }
  const { out } = await decide(preCall, env({ ACP_AGENT_TIER: 'background' }))
  assert.deepEqual(out, {})
  server.removeAllListeners('request')
  server.on('request', orig)
})

test('missing credential is UNGOVERNED-open with a warning, never a crash', async () => {
  const { out, warn } = await decide(preCall, {
    ACP_GOVERN_BASE: base,
    HOME: '/nonexistent-home-for-test',
  })
  assert.match(out.systemMessage, /UNGOVERNED: no credential/)
  assert.match(warn, /UNGOVERNED: no credential/)
})

test('PostToolUse block turns into a deny decision', async () => {
  nextResponse = { action: 'block', reason: 'leaked credential in output' }
  requests.length = 0
  const { out } = await decide(
    { ...preCall, hook_event_name: 'PostToolUse', tool_output: 'AKIA...' },
    env(),
  )
  assert.equal(requests[0].path, '/govern/tool-output')
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /leaked credential/)
  assert.equal(out.hookSpecificOutput, undefined)
})

test('PostToolUse gateway failure is a silent pass-through', async () => {
  failMode = 'refuse'
  const { out, warn } = await decide(
    { ...preCall, hook_event_name: 'PostToolUse', tool_output: 'ok' },
    env(),
  )
  assert.deepEqual(out, {})
  assert.equal(warn, undefined)
  failMode = null
})

test('fixture wrapper shape { event, stdin } is accepted', async () => {
  nextResponse = { decision: 'deny', reason: 'nope' }
  requests.length = 0
  // decide() receives the already-unwrapped payload in main(); simulate the
  // unwrap contract here to pin it.
  const wrapped = { event: 'PreToolUse', stdin: { tool_name: 'shell', tool_input: {} } }
  const payload = { hook_event_name: wrapped.event, ...wrapped.stdin }
  const { out } = await decide(payload, env())
  assert.equal(requests[0].body.hook_event_name, 'PreToolUse')
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
})

test('receipt message covers counts and links the session', () => {
  const line = buildReceiptMessage({ calls: 3, denied: 1, asked: 0, notices: 2 }, 'sess-9')
  assert.match(line, /3 tool calls governed/)
  assert.match(line, /1 denied/)
  assert.match(line, /2 shadow notices/)
  assert.match(line, /sessions\/sess-9/)
  assert.equal(buildReceiptMessage({ calls: 0 }, 'sess-9'), null)
})
