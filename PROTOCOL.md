# Prime Studio — Prime Agent RPC contract (verified 2026-08-08, prime-agent 0.7.1)

Spawn: `node [--require <SHIM>] <CLI> --mode rpc [-d] [--daemon-socket S] [--provider X --model Y --cwd DIR]`
- CLI: `<prime-agent>/dist/bundle/cli.js`. Windows global npm puts it at
  `%APPDATA%\npm\node_modules\prime-agent\dist`; see the README for the full resolution order.
  Always launched as `node <cli.js>` — on Windows the `prime-agent` PATH entry is a `.cmd`
  shim that `CreateProcess` cannot execute.
- SHIM: `<prime-agent>/dist/windowshide-shim.cjs` — **optional**. A local patch that stops
  console-window flashing on Windows; a stock install may not have it, so the `--require`
  pair is passed only when the file exists.
- Env: prime's IPython kernel needs `PRIME_AGENT_KERNEL_PYTHON`; the child inherits the
  app's environment wholesale, so set it before launching Prime Studio.
- Always spawn with `windowsHide: true` from Rust too.

## Daemon-backed sessions (`-d`) — needs a prime newer than 0.7.1

Verified 2026-08-08 against a build from prime's `windows-kernel-and-rate-limits` branch
(`packages/coding-agent/dist/cli.js`). **Stock prime-agent 0.7.1 does not have this**, so it is
**feature-detected, never assumed**: the app runs `node <cli> --help` on whatever binary it
resolved and requires *both* `-d, --background` in the run options *and* an `attach` command.
0.7.1 has `attach` (interactive UI only) and no `--background`, so the flag is what actually
discriminates. The result rides on `resolve_prime_cli().daemon`.

- `--mode rpc -d` — the session is owned by a resident daemon worker rather than by the client.
  **SIGKILL the client and the agent survives**: `prime-agent list` then shows
  `gui-tab  b33c8be400f6  idle  0s  …  messages 2  clients 0`. Without `-d`, the same test
  prints `No active agents.`
- Closing stdin gracefully is a **detach**, not a kill — the agent stays resident.
- `attach <id|name> --mode rpc` reattaches a headless client. `get_messages` returns the prior
  transcript and a following `prompt` runs on the same agent.
- **Two RPC clients can attach to one agent at once** (`attachedClients` goes to 2 and both get
  `get_state` answers). Never assume exclusivity: read `attachedClients` from the listing.
- `--daemon-socket <path>` selects the daemon. The Windows default is the fixed global pipe
  `\\.\pipe\prime-agent-daemon` — it is **not** derived from `PRIME_AGENT_CODING_AGENT_DIR`, so
  one daemon can hold agents from several account profiles. Attribute a row to an account by its
  `sessionFile` path, not by which env you asked with.
- `--background --no-session` is rejected; `-d` is a no-op for interactive/daemon modes.
- `shutdown` does **not** accept `--daemon-socket` (only `list`, `attach`, `stop`, `rename` do).

### `prime-agent list --json` — the fleet source of truth

One key, `sessions`, each row carrying (verified): `id`, `lifecycle`, `activity`,
`isSessionActive`, `lastActivityAt`, `runtimeKind`, `rlmDepth`, `activeSessionId`, `sessionId`,
`sessionFile`, `sessionName`, `cwd`, `model` (`id`/`provider`/`cost`/`contextWindow`/…),
`thinkingLevel`, `isStreaming`, `isCompacting`, `isBashRunning`, `hasRunningRlmChildren`,
`isRunningTools`, `attachedClients`, `messageCount`, `unfinishedActionCount`, `sessionActions`,
`created`, `modified`, `firstMessage`, `diagnostics`, `summary`, `taskState`, `workerState`,
`workerPid`.

**There is no cost, token, gate, schedule or auth field in the listing.** Money has to be read
from each row's own `sessionFile`; anything else the design asks for that is not in this list
does not exist and must not be drawn.

`set_session_name` renames a live agent from RPC (emits `session_info_changed`) and shows up
immediately in `prime-agent list`; `rename <agent> <name>` does the same from outside.

Framing: **strict JSONL, split on `\n` ONLY** (payloads may contain U+2028/U+2029 — do not use a line reader that splits on those).

## Prime Studio account-removal IPC (not prime-agent RPC)

Account removal crosses the Tauri invoke bridge; it is not one of prime-agent's JSONL commands.
The production Accounts UI uses only these throwing typed calls:

| Tauri command | camel-case arguments | result |
|---|---|---|
| `prepare_remove_account` | `{ id, deleteData }` | credential-free `AccountRemovalPlan` |
| `commit_remove_account` | `{ planId, typedLabel }` | `null` on a completed clean path |

The plan contains `planId`, `accountLabel`, the exact derived `targetPath`, `deleteData`,
`expiresAtMs`, `registryGeneration`, optional target volume/file identity, bounded
`estimate { items, bytes, truncated }`, safety-check booleans, and blocker codes. Production
plans expire after five minutes and are opaque and single-use. Preparation does not mutate the
registry or profile. Data deletion requires an ordinal, case-sensitive exact label; entry-only
commit sends an empty label. On non-Windows builds a data plan also contains the
`unsupportedPlatform` blocker, so the rendered review disables profile-data commit and directs
the user to entry-only removal.

Commit rechecks registry bytes/identity/generation, account and label, active sessions,
default/migrated/shared state, the direct-child target, file identity, hard-link/reparse state,
and the proposed registry while holding the account mutation lock. The target is always derived
from the validated account id under `%USERPROFILE%\.prime\profiles`; persisted `agentDir` is not
filesystem authority.

Errors are serialized as typed codes: `accountNotFound`, `invalidAccountId`, `planNotFound`,
`planExpired`, `planReplayed`, `planBlocked`, `planRequired`, `registryChanged`, `targetChanged`,
`labelMismatch`, `quarantineConflict`, `recoveryRequired`, `outcomeUnknown`, `cleanupPending`,
`registryInvalid`, `unsafeTarget`, or `io`. The TypeScript wrappers never use `safeInvoke`, never
reflect backend messages, and do not convert rejection into success. After a resolved commit the
UI performs a throwing `list_accounts` refresh and reports ordinary success only after the id is
absent.

Windows keeps the approved journal, sealed proposal, identity-bound registry installation, and
recovery path for both prepared modes; profile-data mode additionally quarantines and cleans the
verified profile. On macOS and Linux, only prepared entry-only commit takes a separate portable
branch: after the same mutation lock and plan/generation/account revalidation, it uses the
registry's durable atomic replacement and never creates transaction state or touches profile
data. Non-Windows profile-data commit remains fail-closed.

`cleanupPending` is a committed-registry state: the row may be refresh-confirmed absent while
cleanup remains for restart. `recoveryRequired` and `outcomeUnknown` are terminal in the dialog;
the user must restart instead of replaying authority. Startup recovery restores or finalizes
journals from exact registry-generation truth before later account mutations. The profile
quarantine, sealed-proposal install, and no-follow cleanup implementation is Windows-only. That
restriction does not apply to the portable entry-only registry replacement described above.

## Commands (stdin, one JSON per line)
`{id?, type, ...}` — 48 types. Key ones:
| type | fields | purpose |
|---|---|---|
| `prompt` | `message`, `images?`, `streamingBehavior?: "steer"\|"followUp"` | send user turn |
| `steer` / `follow_up` | `message` | interject while busy / queue after turn |
| `abort` | — | stop current turn |
| `get_state` | — | session state snapshot |
| `get_messages` | — | full history (for restoring UI) |
| `get_session_stats` | — | tokens + cost + contextUsage |
| `get_available_models` | — | model picker source |
| `get_commands` | — | slash commands |
| `set_model` | model selector | switch model mid-session |
| `set_thinking_level` | level | off…max |
| `new_session` / `switch_session` / `fork` / `clone` | — | session lifecycle |
| `compact` | — | context compaction |
| `export_html` | — | share transcript |
| `observe` / `unobserve` | target | watch sub-agent ("sol kids") streams |
| `add_schedule` / `list_schedules` / `cancel_schedule` | — | scheduled prompts |
| `set_heartbeat` / `manage_heartbeat` | — | background/cron agents |
| `bash` / `abort_bash` | — | direct shell |
| `refine` | — | continual-harness refinement |

## Responses
`{id, type:"response", command, success, data}` — echoes the command id.

`get_session_stats.data`:

Synthetic deterministic example (values are illustrative, not captured usage):

```json
{"sessionFile":"example-session.jsonl","sessionId":"session-example","userMessages":1,"assistantMessages":2,
 "toolCalls":1,"toolResults":1,"totalMessages":4,
 "tokens":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"total":100},
 "cost":0.01,
 "contextUsage":{"tokens":50,"contextWindow":1000,"percent":5.0}}
```
→ drives the live cost meter AND the context-usage bar.

## Events (stdout, unwrapped — `type` at top level)
Order per turn: `agent_start` → `turn_start` → (`message_start` → `message_update`* → `message_end` | `tool_execution_start` → `tool_execution_update`* → `tool_execution_end`)* → `turn_end` → `agent_end`

- `message_start|update|end`: `{message:{role,content:[{type:"text"|"thinking"|"toolCall",...,index}],model,provider,usage:{input,output,cacheRead,cacheWrite,cost:{total}},stopReason,timestamp}, assistantMessageEvent:{type:"text_start"|"text_delta"|"thinking_start"|…, contentIndex}}`
  - Render streaming text from `content[i].text` (full-so-far) keyed by `index`; `thinking` blocks render collapsed.
  - `message_end.message.usage` carries the authoritative per-message cost.
- `tool_execution_start`: `{toolCallId, toolName, args}` → tool card (args.code for ipython).
- `tool_execution_update|end`: same id + output → fill the card.

## Sessions on disk
`~/.prime/agent/sessions/*.jsonl` (Windows: `%USERPROFILE%\.prime\agent\sessions\`) — first line has `{cwd, timestamp, id}`; assistant `message` events carry per-message `usage`. Child-agent (fan-out) usage arrives as `child_usage_attributed` events with `childUsage`/`aggregateUsage`.

## Verified corrections (found by building against it)

- **`isError` on a tool result is NOT a reliable failure signal.** A `%%bash` cell running
  `python3 -c "import tracer"` returned `isError: false` while the output carried
  `exit code: 127` and a `ModuleNotFoundError`. Detect failure from the output as well:
  traceback header, `XxxError:` line, `command not found`, `No such file`, non-zero `exit code:`.
- **Subagent lifecycle arrives as `rlm_child_update`, not `child_usage_attributed`.** Verified
  payload carries `id`, `sessionName`, `model`, `sessionDir`, `status` (prime's own status word —
  print it verbatim rather than re-mapping). `child_usage_attributed` is the *cost* attribution
  event and its field spellings remain unverified; read it defensively.
- **`observe` mirrors the child's events onto the same stream**, so a naive client renders them
  into the *parent* transcript. To show a child's work, read its `sessionDir` transcript instead
  (a snapshot, not a live stream) unless you demultiplex by session id.

- **Resuming a *live* agent is now possible; resuming an *archived* one is not.** `attach` only
  targets an agent the daemon still holds. `start_session` still takes no session id, and
  `--resume <path|id>` exists on the CLI but has not been probed from this client — so a
  transcript whose agent is gone remains view-only.

## Not available from the protocol (do not design against these)

- **The kernel namespace cannot be read.** There is no command that returns live variables/types,
  so a "kernel variables" table is not implementable without patching prime (or injecting an
  introspection cell into the user's session, which costs tokens and pollutes the transcript).
- **`goal` / `plan` / `gate` data only exists for sessions started with `--goal` /
  `--autonomous-gate`.** An ordinary RPC-spawned session has none, so those meters have nothing
  to show unless the client sets a goal explicitly.

## Known quirks
- Prime CLI can exit non-zero (1, 13) even on success — do not treat exit code as failure signal in the app; rely on `agent_end`.

## Correction: gating and custom tools DO exist — via extensions, not RPC

An earlier version of this file claimed prime has no approval gating and only one
model-facing tool. Both are wrong. The mistake was looking only at the RPC command list;
the capability lives in prime's **extension API** (`packages/coding-agent/src/core/extensions/types.ts`):

- `on("tool_call", handler)` is documented *"Fired before a tool executes. Can block."* The
  handler returns `ToolCallEventResult { block?: boolean; reason?: string }`, and `event.input`
  is mutable in place, so arguments can be patched as well as denied.
- `registerTool()` registers **new first-class model-facing tools**, so `ipython` is not the
  only tool a model can call. Browser or computer control can be a real tool, not only a
  Python skill imported into the kernel.
- The approval prompt reaches a GUI client over RPC: `extension_ui_request`
  (`method: "confirm" | "select" | "editor" | …`, with `title`/`message`/`timeout`) is emitted
  on the event stream, and the client answers with `extension_ui_response`. See
  `modes/rpc/rpc-extension-ui-context.ts` and `rpc-types.ts`.

**Integration detail that will bite:** prime still emits `tool_execution_start` for a call that
is subsequently blocked. A client that maps events naively will show it as Running and then
never finish it. Render blocked calls as a distinct **Blocked** state — not Running, not Failed.
