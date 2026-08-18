# Agentic Control Plane for Meta Muse Code

Policy-check every tool call Muse Code makes — before it runs — against your
[Agentic Control Plane](https://agenticcontrolplane.com) workspace: allow /
ask / deny per call, output scanning after the call, one receipt line per
session, every decision in your activity log with the reason attached.

## Status: beta-tracking-beta

Muse Code is in beta and ships its hook engine ahead of its hook docs: the
0.2.1 binary carries the full lifecycle event set (`PreToolUse`,
`PermissionRequest`, `PostToolUse`, `Stop`, …) and the Claude-Code-style
decision vocabulary, but not yet the documented `muse hooks` management CLI,
and the exact `hooks.json` schema is unpublished. This hook is built against
what the binary demonstrably contains, is defensive about field spellings,
and will be pinned to the published contract the moment it lands. Treat it
the way you treat Muse Code itself: early, tested, tracking a fast-moving
target.

## Install

```bash
npm install -g @agenticcontrolplane/muse-code
```

Copy `hooks.example.json` to your project's `.muse/hooks.json` (or your user
settings), then trust the hooks once the `muse hooks trust` CLI ships in your
build. Sign in once to get a credential:

- a key in `~/.acp/credentials` (written by the
  [installer](https://agenticcontrolplane.com/install-explained) — one
  command, free for individuals).

Muse Code runs hooks with a **cleared environment**, so `ACP_BEARER_TOKEN`
does not reach them in live sessions — the file is the real path. Optional
operational overrides live in `~/.acp/config.json`: `govern_base`,
`console_base`, `agent_tier`, `check_timeout_ms`, `shadow`.

## What it does

| Event | Gateway call | Effect |
|---|---|---|
| `PreToolUse` | `POST /govern/tool-use` | allow / ask / deny before the tool runs |
| `PermissionRequest` | `POST /govern/tool-use` | a policy deny settles Muse's own approval; anything else lets the native prompt proceed |
| `PostToolUse` | `POST /govern/tool-output` | output scanning; a server block becomes a deny the model sees |
| `Stop` | — | one session receipt line with a deep link to the session timeline |

## Failure posture

An unreachable control plane must never brick your session, and must never
be mistaken for a live one:

- **Interactive sessions fail open, loudly** — the call proceeds, you get an
  `[ACP] ⚠ UNGOVERNED` warning, and a lapse line lands in `~/.acp/lapse.log`.
- **Unattended tiers fail closed** — `CI`/`MUSE_HEADLESS`/`ACP_AGENT_TIER`
  mark a run as unattended, and a run nobody is watching stays blocked when
  policy can't be consulted.
- Policy **denies** are unaffected either way; the posture only covers the
  inability to *ask* the policy.

## Security notes

- Muse Code executes hooks **outside** its own sandbox, with a cleared
  environment. That is exactly why this hook has **zero dependencies** and no
  build step: every transitive dependency on a control-plane hook is a
  credential-adjacent supply-chain target. It is one file of plain ESM you
  can read in two minutes.
- `managed_hooks_path` hooks run with no trust step. If you deploy this hook
  through that channel, the managed file's write access is your control
  boundary — treat it like sudoers.

## Test

```bash
npm test
```

Offline suite against a mock gateway: decision mapping, both fail postures,
retry-once transport behavior, payload shape, receipt.
