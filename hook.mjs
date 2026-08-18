#!/usr/bin/env node
/**
 * Agentic Control Plane hook for Meta Muse Code.
 *
 * Muse Code hooks are one-shot shell commands: the harness invokes the
 * command per lifecycle event with a JSON payload on stdin and reads a JSON
 * decision from stdout. This command handles:
 *
 *   PreToolUse / PermissionRequest -> POST {ACP_GOVERN}/govern/tool-use
 *   PostToolUse                    -> POST {ACP_GOVERN}/govern/tool-output
 *   Stop                           -> session receipt (gatewaystack-connect#606)
 *
 * Decision encoding: Muse Code's binary carries the same camelCase output
 * vocabulary as Claude Code hooks (`permissionDecision`,
 * `permissionDecisionReason`) alongside a plain `decision` field; until the
 * output schema is published we emit BOTH spellings in one object — unknown
 * keys are ignored, so the harness reads whichever it supports.
 *
 * CONTRACT STATUS: stdin field names below are permissive on purpose — the
 * beta binary (0.2.1) ships the hook engine but not the documented
 * `muse hooks` CLI, and the payload schema is not yet published. Fields are
 * read under every plausible name; anything unrecognized still produces a
 * valid decision object rather than a crash.
 *
 * Unreachability posture (gatewaystack-connect#385, never-brick): interactive
 * sessions fail OPEN with a loud UNGOVERNED warning and a ~/.acp/lapse.log
 * entry; unattended tiers fail CLOSED — nobody is watching, so the block is
 * the safety net. Policy denies are unaffected; this posture only covers the
 * inability to ASK the policy.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOOK_VERSION = '0.1.0'

/** 200 KB ceiling on tool output sent for post-hoc scanning (matches the backend). */
const POST_HOOK_PAYLOAD_CEILING = 200 * 1024

/** Hook decision budget: control-plane calls answer fast or get out of the way. */
const CHECK_TIMEOUT_MS = 4000

const ACP_DIR = join(homedir(), '.acp')

function acpDir(env = process.env) {
  return env.HOME ? join(env.HOME, '.acp') : ACP_DIR
}

function readToken(env = process.env) {
  if (env.ACP_BEARER_TOKEN) return env.ACP_BEARER_TOKEN
  // Same order as the other harness plugins' credential lookup — keep in sync.
  for (const file of ['credentials', 'proxy-key']) {
    try {
      const value = readFileSync(join(acpDir(env), file), 'utf8').trim()
      if (value) return value
    } catch { /* absent or unreadable — try the next path */ }
  }
  return null
}

function lapseLine(fields) {
  try {
    mkdirSync(ACP_DIR, { recursive: true })
    appendFileSync(
      join(ACP_DIR, 'lapse.log'),
      JSON.stringify({ at: new Date().toISOString(), client: 'muse-code-hook', ...fields }) + '\n',
    )
  } catch { /* the lapse log is best-effort — never block a call on it */ }
}

/**
 * Muse Code has no documented way to tell the hook it is headless; the tier
 * must come from the environment. `muse exec` in CI is where fail-closed
 * matters, and CI is exactly where operators set env vars.
 */
function resolveTier(env = process.env) {
  if (env.ACP_AGENT_TIER) return env.ACP_AGENT_TIER
  if (env.CI || env.MUSE_HEADLESS) return 'background'
  return 'interactive'
}

/** Read a field under every plausible spelling — see CONTRACT STATUS above. */
const pick = (obj, ...keys) => {
  for (const k of keys) if (obj?.[k] !== undefined) return obj[k]
  return undefined
}

function normalize(payload, env = process.env) {
  return {
    event: pick(payload, 'hook_event_name', 'event', 'hookEvent') ?? env.MUSE_HOOK_EVENT ?? 'PreToolUse',
    toolName: pick(payload, 'tool_name', 'toolName', 'tool', 'name') ?? 'unknown',
    toolInput: pick(payload, 'tool_input', 'toolInput', 'arguments', 'input') ?? {},
    toolOutput: pick(payload, 'tool_output', 'toolOutput', 'result', 'output'),
    sessionId: pick(payload, 'session_id', 'sessionId'),
    cwd: pick(payload, 'cwd', 'workspace_root', 'workspaceRoot') ?? process.cwd(),
  }
}

/** Both output vocabularies in one object; unknown keys are ignored. */
function encodeDecision(kind, reason) {
  if (kind === 'allow') return {}
  const out = { decision: kind === 'deny' ? 'deny' : 'ask', reason }
  out.permissionDecision = out.decision
  out.permissionDecisionReason = reason
  return out
}

async function post(base, headers, path, payload, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
    })
    if (!res.ok) {
      // Tagged so the retry can tell "the server answered with a status" from
      // "the request never landed". Re-rolling a 429 would deepen the rate
      // limit it is reporting.
      const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
      err.httpStatus = res.status
      throw err
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// --- Session receipt bookkeeping. Each hook invocation is a fresh process,
// so counts live in a per-session file; a stats failure must never affect a
// call, so every touch is wrapped. ---
function statsPath(sessionId) {
  return join(ACP_DIR, 'muse-sessions', `${String(sessionId).replace(/[^\w-]/g, '_')}.json`)
}

function bump(sessionId, field) {
  if (!sessionId) return
  try {
    mkdirSync(join(ACP_DIR, 'muse-sessions'), { recursive: true })
    const p = statsPath(sessionId)
    let s = { calls: 0, denied: 0, asked: 0, notices: 0 }
    try { s = JSON.parse(readFileSync(p, 'utf8')) } catch { /* first call this session */ }
    s[field] = (s[field] ?? 0) + 1
    writeFileSync(p, JSON.stringify(s))
  } catch { /* bookkeeping only */ }
}

export function buildReceiptMessage(stats, sessionId, consoleBase = 'https://cloud.agenticcontrolplane.com') {
  if (!stats || !(stats.calls > 0)) return null
  const parts = [`${stats.calls} tool call${stats.calls === 1 ? '' : 's'} governed`]
  if (stats.denied > 0) parts.push(`${stats.denied} denied`)
  if (stats.asked > 0) parts.push(`${stats.asked} held for approval`)
  if (stats.notices > 0) parts.push(`${stats.notices} shadow notice${stats.notices === 1 ? '' : 's'}`)
  const url = `${consoleBase}/sessions/${encodeURIComponent(String(sessionId))}`
  return `[ACP] Session receipt: ${parts.join(' · ')} — review this session: ${url}`
}

export async function decide(payload, env = process.env) {
  const call = normalize(payload, env)
  const tier = resolveTier(env)
  const token = readToken(env)

  if (!token) {
    // Loud, once per invocation, plus a durable lapse line — an uncredentialed
    // control plane must never be mistaken for a live one.
    lapseLine({ kind: 'UNGOVERNED', reason: 'no-credentials', tool: call.toolName, session: call.sessionId })
    return {
      out: {},
      warn: '[ACP] ⚠ UNGOVERNED: no credential (ACP_BEARER_TOKEN or ~/.acp/credentials) — '
        + 'tool calls run WITHOUT policy checks and ACP has no record of them. '
        + 'Connect at https://cloud.agenticcontrolplane.com',
    }
  }

  const govern = (env.ACP_GOVERN_BASE ?? env.ACP_API_BASE ?? 'https://govern.agenticcontrolplane.com').replace(/\/$/, '')
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GS-Client': `muse-code-hook/${HOOK_VERSION}`,
  }
  const timeoutMs = Number(env.ACP_CHECK_TIMEOUT_MS) || CHECK_TIMEOUT_MS
  const base = {
    tool_name: call.toolName,
    tool_input: call.toolInput,
    session_id: call.sessionId,
    cwd: call.cwd,
    hook_event_name: call.event,
    agent_tier: tier,
  }

  if (call.event === 'Stop') {
    // Session end: emit the receipt and clear the counter file.
    try {
      const p = statsPath(call.sessionId)
      const s = JSON.parse(readFileSync(p, 'utf8'))
      unlinkSync(p)
      const line = buildReceiptMessage(s, call.sessionId, env.ACP_CONSOLE_BASE)
      return { out: {}, warn: line ?? undefined }
    } catch { return { out: {} } }
  }

  if (call.event === 'PostToolUse') {
    let outputStr = typeof call.toolOutput === 'string' ? call.toolOutput : JSON.stringify(call.toolOutput ?? '')
    if (Buffer.byteLength(outputStr, 'utf8') > POST_HOOK_PAYLOAD_CEILING) {
      outputStr = outputStr.slice(0, POST_HOOK_PAYLOAD_CEILING)
    }
    let data
    try {
      data = await post(govern, headers, '/govern/tool-output', { ...base, tool_output: outputStr }, timeoutMs)
    } catch {
      // Post-hoc scanning is observability: silent pass-through, the call
      // already ran. The pre-call check is where unreachability gets loud.
      return { out: {} }
    }
    if (data.action === 'block') {
      bump(call.sessionId, 'denied')
      return { out: encodeDecision('deny', `[ACP] Blocked: ${data.reason ?? 'policy'}`) }
    }
    if (typeof data.notice === 'string' && data.notice.trim() && !/^(off|0|false)$/i.test(env.ACP_SHADOW ?? '')) {
      // Shadow-mode counterfactual (#607): advisory, arrives with action "pass".
      bump(call.sessionId, 'notices')
      return { out: {}, warn: data.notice }
    }
    return { out: {} }
  }

  // PreToolUse and PermissionRequest both resolve against the pre-call policy.
  let data
  try {
    try {
      data = await post(govern, headers, '/govern/tool-use', base, timeoutMs)
    } catch (first) {
      // Retry once before applying the fail posture (gatewaystack-connect#690):
      // slow answers are cold starts, so the retry lands on a warm instance.
      // Retry only a transport failure — an HTTP status is the server answering.
      if (first?.httpStatus !== undefined) throw first
      data = await post(govern, headers, '/govern/tool-use', base, timeoutMs)
    }
  } catch (error) {
    const detail = error?.name === 'AbortError' ? 'request timed out' : (error?.message ?? 'network error')
    if (tier === 'interactive') {
      lapseLine({ kind: 'UNGOVERNED', tool: call.toolName, tier, detail })
      return {
        out: {},
        warn: `[ACP] ⚠ UNGOVERNED: gateway unreachable (${detail}) — ${call.toolName} proceeded WITHOUT policy check. Lapse logged to ~/.acp/lapse.log.`,
      }
    }
    return {
      out: encodeDecision('deny',
        `[ACP] Gateway unreachable (${detail}) — ${tier} tier stays blocked when policy can't be consulted (fail-closed for unattended agents; interactive sessions fail open).`),
    }
  }

  bump(call.sessionId, 'calls')
  if (data.decision === 'deny') {
    bump(call.sessionId, 'denied')
    return { out: encodeDecision('deny', `[ACP] Denied by policy: ${data.reason ?? 'policy did not return a reason'}`) }
  }
  if (data.decision === 'ask') {
    bump(call.sessionId, 'asked')
    return { out: encodeDecision('ask', `[ACP] Approval required: ${data.reason ?? 'approval required'}`) }
  }
  return { out: {}, warn: data.warning ? String(data.warning) : undefined }
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let payload = {}
  try { payload = JSON.parse(raw) } catch { /* empty or non-JSON stdin — still answer */ }
  // `muse hooks run --fixture` wraps the payload as { event, stdin: {...} };
  // accept both the wrapped and the live shape.
  if (payload?.stdin && payload?.event) payload = { hook_event_name: payload.event, ...payload.stdin }

  let result
  try {
    result = await decide(payload)
  } catch (error) {
    // A hook crash must never take the harness down with it: fail open with
    // a loud trace rather than let an unhandled rejection decide anything.
    lapseLine({ kind: 'HOOK_ERROR', detail: error?.message })
    result = { out: {}, warn: `[ACP] hook error (${error?.message ?? 'unknown'}) — call proceeded WITHOUT policy check` }
  }
  if (result.warn) process.stderr.write(result.warn + '\n')
  process.stdout.write(JSON.stringify(result.out) + '\n')
}

// Only run the CLI when invoked directly — tests import decide() without I/O.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
