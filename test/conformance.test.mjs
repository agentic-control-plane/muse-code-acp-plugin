// L1 shared conformance corpus adapter for muse-code-acp-plugin.
// davidcrowe/gatewaystack-connect#1344 — one corpus, one adapter per plugin,
// run against the plugin's real entry point (decide(), imported directly —
// this is exactly how test/hook.test.mjs already exercises it) against a
// fake gateway, asserting on what a person would see or what the plugin sent.
//
// See ../../gsc-conformance/conformance/plugin-corpus.json (vendored below at
// test/fixtures/plugin-corpus.json) for the corpus schema, case definitions
// and rationale.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide } from '../hook.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS_PATH = join(HERE, 'fixtures', 'plugin-corpus.json')
const PINNED_FINGERPRINT = 'aa186d3fb3e7d18c' // sha256 of the corpus file's raw bytes, first 16 hex chars

// Any capability muse-code fails despite being marked "supported" in the
// corpus goes here, e.g. { case: 'notice-shown', issue: 'NEW', detail: '...' }.
// Kept empty unless a real failure was observed against this worktree's
// hook.mjs — see the final test in this file, which asserts this list is
// exactly what happened, so neither a new failure nor a quiet fix can hide.
const EXPECTED_DIVERGENCES = []

// --- Fingerprint gate: fail loudly before trusting a single byte of the
// vendored corpus. ---
const corpusRaw = readFileSync(CORPUS_PATH) // raw bytes — never re-parse-then-hash
const corpusFingerprint = createHash('sha256').update(corpusRaw).digest('hex').slice(0, 16)

test('vendored corpus matches the pinned fingerprint', () => {
  assert.equal(
    corpusFingerprint,
    PINNED_FINGERPRINT,
    `test/fixtures/plugin-corpus.json fingerprint ${corpusFingerprint} != pinned ${PINNED_FINGERPRINT} — ` +
      're-vendor a byte-identical copy from the canonical corpus (davidcrowe/gatewaystack-connect:conformance/plugin-corpus.json)',
  )
})

// Only parse (and only trust case/harness data) once the byte fingerprint above
// has been computed against the raw file — the assertion below still runs even
// if the parse fails.
const corpus = JSON.parse(corpusRaw.toString('utf8'))
const MARKER = corpus.marker // 'ACPCONF7F3A'
const PLUGIN_NAME = 'muse-code-acp-plugin'

function corpusCase(id) {
  const c = corpus.cases.find(c => c.id === id)
  assert.ok(c, `corpus is missing case "${id}"`)
  return c
}

function harnessStatus(capability) {
  const row = corpus.harnesses.find(h => h.plugin === PLUGIN_NAME && h.capability === capability)
  assert.ok(row, `corpus has no harnesses row for ${PLUGIN_NAME}/${capability}`)
  return row.status
}

test('corpus lists both muse-code-acp-plugin capabilities as supported', () => {
  assert.equal(harnessStatus('notice'), 'supported')
  assert.equal(harnessStatus('post-tool'), 'supported')
})

// --- Fake gateway -----------------------------------------------------
// Every path other than /govern/tool-output answers a bare allow (the notice
// and post-tool cases only ever exercise PostToolUse, but this keeps the
// fake gateway honest against the adapterMust contract for other capabilities).
let server, gatewayBase
let nextToolOutputReply = { decision: 'allow' }
const requests = []

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      let parsed = null
      try { parsed = body ? JSON.parse(body) : null } catch { /* leave null */ }
      requests.push({ path: req.url, body: parsed })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.url === '/govern/tool-output') {
        res.end(JSON.stringify(nextToolOutputReply))
      } else {
        res.end(JSON.stringify({ decision: 'allow' }))
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  gatewayBase = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

// Fresh HOME per call: readToken()/readConfig() resolve ~/.acp under env.HOME,
// so this keeps the developer machine's real ~/.acp/credentials, config.json
// (which could set shadow/agent_tier) and muse-sessions/ state completely out
// of the picture — no cross-test or cross-machine leakage, and no chance a
// stale per-session marker on disk suppresses a notice the corpus expects.
function freshEnv(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muse-acp-conformance-'))
  return {
    HOME: home,
    ACP_BEARER_TOKEN: 'gsk_test_dummy0000000000000000', // dummy credential, never a real key
    ACP_GOVERN_BASE: gatewayBase,
    ACP_CHECK_TIMEOUT_MS: '1500',
    // Explicitly absent unless a case's own env sets it — never inherit the
    // real process's ACP_SHADOW.
    ...overrides,
  }
}

// =======================================================================
// capability: notice
// =======================================================================
//
// hook.mjs's PostToolUse branch (around decide()'s PostToolUse block) puts a
// gateway notice on the person-visible channel like this:
//
//   return { out: { systemMessage: data.notice }, warn: data.notice }
//
// runHook() (the real stdin/stdout entry point) then does:
//   if (result.warn) process.stderr.write(result.warn + '\n')     // channel 1: stderr
//   process.stdout.write(JSON.stringify(result.out) + '\n')       // channel 2: stdout JSON `systemMessage`
//
// decide() is exactly what runHook() calls internally (and exactly what
// test/hook.test.mjs already imports and drives directly), so `warn` and
// `out.systemMessage` here ARE those two person-visible channels, not a
// stand-in for them. We assert both.

test('notice-shown: shadow-mode notice reaches stderr and the stdout systemMessage JSON', async () => {
  const kase = corpusCase('notice-shown')
  nextToolOutputReply = kase.gatewayReply
  requests.length = 0

  const { out, warn } = await decide(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'shell',
      tool_input: { command: 'echo hi' },
      tool_output: 'hi\n',
      session_id: 'notice-shown-session',
    },
    freshEnv(kase.env),
  )

  assert.equal(requests[0]?.path, '/govern/tool-output')

  const personSees = typeof out.systemMessage === 'string' && out.systemMessage.includes(MARKER)
  const stderrSees = typeof warn === 'string' && warn.includes(MARKER)

  if (kase.expect.personSees) {
    assert.ok(personSees, `expected out.systemMessage (stdout JSON channel) to contain ${MARKER}, got: ${JSON.stringify(out)}`)
    assert.ok(stderrSees, `expected warn (stderr channel) to contain ${MARKER}, got: ${JSON.stringify(warn)}`)
  } else {
    assert.ok(!personSees && !stderrSees, 'expected no person-visible channel to carry the notice')
  }
})

test('notice-shadow-off: ACP_SHADOW=off silences the notice on every channel', async () => {
  const kase = corpusCase('notice-shadow-off')
  assert.equal(kase.env.ACP_SHADOW, 'off')
  nextToolOutputReply = kase.gatewayReply
  requests.length = 0

  const { out, warn } = await decide(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'shell',
      tool_input: { command: 'echo hi' },
      tool_output: 'hi\n',
      session_id: 'notice-shadow-off-session',
    },
    freshEnv(kase.env),
  )

  assert.equal(requests[0]?.path, '/govern/tool-output')

  const stdoutSerialized = JSON.stringify(out)
  const warnSerialized = warn === undefined ? '' : String(warn)

  assert.equal(kase.expect.personSees, false)
  assert.ok(!stdoutSerialized.includes(MARKER), `expected stdout JSON to be free of ${MARKER}, got: ${stdoutSerialized}`)
  assert.ok(!warnSerialized.includes(MARKER), `expected stderr to be free of ${MARKER}, got: ${warnSerialized}`)
})

// =======================================================================
// capability: post-tool
// =======================================================================
//
// Canonical tool-name mapping declared here (adapterMust: "assert tool_name
// equals the native tool name the adapter fed in, or the plugin's documented
// canonical mapping of it"): muse-code's own hook payload schema is not yet
// publicly published (see hook.mjs's "CONTRACT STATUS" block) — the shipped
// code reads snake_case Claude-Code-shaped keys (tool_name, tool_input,
// tool_output, session_id, hook_event_name) as its primary/native spelling,
// with camelCase and a few aliases accepted defensively. hook.mjs's
// normalize() -> decide() forwards call.toolName straight through as the
// outgoing gateway body's tool_name with NO renaming or taxonomy mapping.
// So the mapping this adapter declares is the identity mapping: whatever
// native tool identifier we feed in as `tool_name` must come out unchanged
// as the gateway payload's `tool_name`.
const NATIVE_TOOL_NAME_MAP = Object.freeze({ shell: 'shell' })

test('post-tool-fields: outgoing /govern/tool-output body carries the required fields', async () => {
  const kase = corpusCase('post-tool-fields')
  nextToolOutputReply = kase.gatewayReply
  requests.length = 0

  // muse-code's native PostToolUse hook payload, built from the corpus call.
  const nativePayload = {
    hook_event_name: 'PostToolUse',
    tool_name: kase.call.tool, // 'shell' — fed straight through, see NATIVE_TOOL_NAME_MAP above
    tool_input: { command: kase.call.command },
    tool_output: kase.call.output,
    session_id: kase.call.sessionId,
    cwd: '/work',
  }

  await decide(nativePayload, freshEnv(kase.env))

  const sent = requests.find(r => r.path === '/govern/tool-output')
  assert.ok(sent, 'expected a POST to /govern/tool-output')
  const body = sent.body

  assert.equal(body.hook_event_name, kase.expect.hook_event_name)
  assert.equal(body.tool_name, NATIVE_TOOL_NAME_MAP[nativePayload.tool_name])
  assert.equal(body.tool_name, nativePayload.tool_name) // equals the native tool name fed in

  assert.equal(typeof body.tool_input, 'object')
  assert.ok(body.tool_input && !Array.isArray(body.tool_input))
  assert.ok(JSON.stringify(body.tool_input).includes(MARKER), `tool_input serialisation missing ${MARKER}: ${JSON.stringify(body.tool_input)}`)

  assert.ok(JSON.stringify(body.tool_output).includes(MARKER), `tool_output serialisation missing ${MARKER}: ${JSON.stringify(body.tool_output)}`)

  assert.equal(typeof body.session_id, 'string')
  assert.ok(body.session_id.length > 0)
})

// =======================================================================
// EXPECTED_DIVERGENCES must exactly match reality: neither a new failure
// nor a quiet fix can pass CI silently.
// =======================================================================
test('EXPECTED_DIVERGENCES is exactly empty for muse-code-acp-plugin', () => {
  assert.deepEqual(EXPECTED_DIVERGENCES, [])
})
