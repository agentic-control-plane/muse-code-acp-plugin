#!/usr/bin/env node
// Per-event entry: Muse requires a distinct source file per hook id.
import { runHook } from '../hook.mjs'
runHook('PostToolUse')
