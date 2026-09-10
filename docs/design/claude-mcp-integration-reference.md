# Claude Code integration reference: plugins, MCP 2026-07-28, session wake

Reference for the MCP integration program. Every claim was verified against the
live sources on **2026-09-09**; the plugin section additionally carries findings
**measured on Claude Code 2.1.266** during the Substrate closeout, where the
documentation and the runtime disagree. Measured findings are marked
**[measured]** and matter more than the doc text they contradict.

---

# 1. Claude Code plugins

## 1.1 What a plugin is

A self-contained directory of components. Manifest at
`.claude-plugin/plugin.json` (optional — a directory with just `skills/` works).
Components: skills, agents, hooks, MCP servers, LSP servers, workflows, output
styles, themes, monitors, channels, executables.

## 1.2 Directory layout

```
my-plugin/
├── .claude-plugin/plugin.json   # manifest (optional)
├── skills/<name>/SKILL.md       # skills → /my-plugin:<name>
├── commands/*.md                # flat-file skills (legacy shape; prefer skills/)
├── agents/*.md                  # subagents → my-plugin:agent-name
├── workflows/*.js
├── output-styles/  themes/
├── hooks/hooks.json
├── monitors/monitors.json       # experimental
├── .mcp.json
├── .lsp.json
├── bin/                         # added to the Bash tool PATH while enabled
├── settings.json                # only `agent` + `subagentStatusLine` honoured
└── scripts/
```

Manifest fields: `name`, `displayName`, `description`, `version`,
`author{name,email,url}`, `homepage`, `repository`, `license`, `keywords`,
`category`, `tags`, `metadata` (free-form, unread), `strict` (default true),
`defaultEnabled`, `dependencies[{name,version}]`, plus component-path overrides
`skills`, `commands`, `agents`, `workflows`, `hooks`, `mcpServers`,
`outputStyles`, `lspServers`, `experimental.themes`, `experimental.monitors`,
`userConfig`, `channels`.

Path semantics: `commands`, `agents`, `workflows`, `outputStyles`,
`experimental.*` **replace** the default directory; `skills` **adds** to the
default `skills/` scan; `hooks`, `mcpServers`, `lspServers` have their own merge
rules — see §1.3, which is where the documentation is least reliable.

## 1.3 Component discovery is NOT uniform [measured]

The docs describe hooks, MCP servers and monitors with the same phrasing —
*"Location: `<path>` in plugin root, **or** inline in plugin.json"* — but the
three behave differently. All three deviations fail **silently**, and
`claude plugin validate --strict` passes in every case.

| Component | Default path | Behaviour |
| --- | --- | --- |
| `hooks/hooks.json` | auto-discovered | Declaring it **also** in the manifest double-loads it (`Duplicate hooks file`). Do **not** declare it. |
| `.mcp.json` | **not** auto-discovered | Must be declared: `"mcpServers": "./.mcp.json"`. Omit it and the server never spawns — skill loads, tools absent. |
| `monitors/monitors.json` | **not** auto-discovered | Must be declared: `"experimental": { "monitors": "./monitors/monitors.json" }`. |

Also measured: the monitor skill gate needs the **plugin-namespaced** skill name,
`"when": "on-skill-invoke:<plugin>:<skill>"`. The bare form the docs example shows
(`on-skill-invoke:debug`) never fires.

A correct minimal manifest for a plugin shipping hooks, an MCP server and
monitors is therefore:

```json
{
  "name": "example",
  "version": "0.1.0",
  "description": "…",
  "author": { "name": "…" },
  "mcpServers": "./.mcp.json",
  "experimental": { "monitors": "./monitors/monitors.json" }
}
```

Note what is absent: no `hooks` key.

## 1.4 Other measured traps

- **`author` is effectively required.** Its absence is a *warning*, and
  `--strict` turns warnings into errors, so an otherwise-correct manifest fails
  acceptance on a field nothing else mentions.
- **Hook entry scripts should be `.mjs` when they wrap a `.ts` module that
  self-invokes.** A module gating direct execution on
  `process.argv[1].endsWith("<name>.ts")` will fire when imported from any `.ts`
  file whose name ends with that suffix — including a prefixed one like
  `hook-precompact.ts` — double-executing the handler. A module gating on an
  exact URL match (`import.meta.url === pathToFileURL(process.argv[1]).href`) is
  safe from any filename.
- **Import a dependency from exactly one place.** `require.resolve` applies the
  CJS condition; an ESM sibling import of the same package yields a *second*
  instance. Two instances of an SDK whose objects cross between them fail at
  runtime in ways no static check sees.

## 1.5 Skills, agents, hooks, user config

- **Skills**: `skills/<n>/SKILL.md`. Set `name:` explicitly — otherwise the
  invocation name falls back to the install directory, which for marketplace
  installs is a version string that changes on every update. Plugin skills are
  always namespaced: `/plugin-name:skill-name`.
- **Agents**: frontmatter `name, description, model, effort, maxTurns, tools,
  disallowedTools, skills, memory, background, isolation` (`isolation` only
  accepts `"worktree"`). `hooks`, `mcpServers` and `permissionMode` are rejected
  in plugin-shipped agents for security.
- **Hooks**: `hooks/hooks.json`, same events as user hooks. Reference scripts via
  `${CLAUDE_PLUGIN_ROOT}`; `${CLAUDE_PROJECT_DIR}` is for user-project state only,
  `${CLAUDE_PLUGIN_DATA}` for plugin-owned persistent data. Prefer exec form
  (`command` + `args`) whenever a path placeholder appears — args are passed
  verbatim with no shell quoting.
- **User config**: `userConfig` prompts at enable time; values substitute as
  `${user_config.KEY}` in MCP/LSP configs and exec-form hook commands, and export
  as `CLAUDE_PLUGIN_OPTION_<KEY>`. Shell-form commands and monitor commands
  **reject** `${user_config.*}` rather than substituting it.

## 1.6 Install, develop, distribute

```bash
claude plugin init my-tool                     # scaffold
claude --plugin-dir ./my-plugin                # local test (also accepts .zip)
/reload-plugins                                # hot-reload without restart
claude plugin validate ./my-plugin [--strict]  # or /plugin validate <path>
claude --debug                                 # plugin load trace

/plugin marketplace add anthropics/claude-plugins-official
/plugin install <plugin>@<marketplace>
claude plugin enable|disable <plugin> [-s user|project|local]
```

Marketplace catalog: `.claude-plugin/marketplace.json`. Plugin `source` types:
relative path, `github` (`repo`/`ref`/`sha`), `url`, `git-subdir`, `npm`,
`archive` (v2.1.224+), `command` (v2.1.229+). Distinguish the *marketplace*
source (where the catalog lives; supports `ref`, not `sha`) from the *plugin*
source (where each plugin lives).

Governance in `managed-settings.json`: `extraKnownMarketplaces`,
`strictKnownMarketplaces` (allowlist with `repo` wildcards, `hostPattern`,
`pathPattern`), `enabledPlugins` (force enable/disable — `--plugin-dir` cannot
override these), `allowManagedHooksOnly`.

---

# 2. MCP revision 2026-07-28

Current spec revision (previous: `2025-11-25`). The headline is in the overview:
*stateless, self-contained requests; per-request capability negotiation.*

## 2.1 Breaking changes

1. **Protocol sessions removed.** No `Mcp-Session-Id`. List endpoints no longer
   vary per connection. Cross-call state is an explicit, server-minted handle
   passed as an ordinary tool argument (SEP-2567).
2. **No handshake.** `initialize` / `notifications/initialized` are gone. Every
   request carries `_meta`: `io.modelcontextprotocol/protocolVersion`,
   `io.modelcontextprotocol/clientCapabilities`, SHOULD carry `clientInfo`; every
   result SHOULD carry `serverInfo`. Mismatch → `UnsupportedProtocolVersionError`.
3. **`server/discover` is mandatory** — advertises supported versions,
   capabilities, identity. Clients MAY call it first, or use it as a
   back-compat probe on STDIO.
4. **`subscriptions/listen`** replaces the HTTP GET endpoint and
   `resources/subscribe`/`unsubscribe`: one long-lived POST-response stream,
   opt-in per type, notifications tagged with `subscriptionId`. Request-scoped
   `notifications/progress` and `notifications/message` still ride their own
   request's response stream.
5. **Removed:** `ping`, `logging/setLevel`, `notifications/roots/list_changed`.
   Log level is per-request via `_meta` `io.modelcontextprotocol/logLevel`.
6. **Tasks moved to an extension** (`io.modelcontextprotocol/tasks`): polling
   `tasks/get`, new `tasks/update`, `tasks/list` removed.
7. **MRTR replaces server-initiated requests** (`roots/list`,
   `sampling/createMessage`, `elicitation/create`). The server returns
   `InputRequiredResult` (`resultType: "input_required"`) with `inputRequests`;
   the client **retries the original request** with `inputResponses`. Continuity
   across retries is the server's own `requestState`.
8. **`resultType` required on every result** — `"complete"` or
   `"input_required"`. Older servers omitting it are treated as `"complete"`.
9. **No SSE resumability.** `Last-Event-ID` and event IDs are gone; a broken
   stream loses the in-flight request, re-issued with a new request ID.

## 2.2 Notable minor changes

- `extensions` on `ClientCapabilities`/`ServerCapabilities`.
- `CacheableResult`: `ttlMs` + `cacheScope` required on the list/read results.
  Servers SHOULD return tools in deterministic order.
- Required Streamable HTTP headers `Mcp-Method`, `Mcp-Name`; custom headers via
  `x-mcp-header`.
- OpenTelemetry `traceparent`/`tracestate`/`baggage` in `_meta`.
- Resource-not-found `-32002` → `-32602`. New error-code policy:
  `-32020..-32099` reserved for the spec (`HeaderMismatch` `-32020`,
  `MissingRequiredClientCapability` `-32021`, `UnsupportedProtocolVersion`
  `-32022`).
- Auth: `iss` per RFC 9207 MUST be validated; DCR MUST set `application_type`;
  credentials keyed by issuer.

## 2.3 Deprecated

**Roots, Sampling, Logging** (SEP-2577) — functional during the window, but new
implementations should not adopt them. Pass directories via tool parameters,
resource URIs or server config instead of Roots; use a provider API directly
instead of Sampling. **Elicitation** remains, delivered through MRTR.

## 2.4 Client-side reality [measured]

**Claude Code 2.1.266 opens MCP connections at `2025-11-25` by default.** A
modern-only server (`legacy: "reject"`) correctly refuses with `-32022`, and the
result is a session whose plugin skill loads while its tools are silently absent
— with the connection failure cached ~15 minutes, so it presents as intermittent.
The session must set:

```bash
MCP_SDK_GENERATION=v2
MCP_PROTOCOL_NEGOTIATION=auto
```

Verify from the log rather than the session, since the failure is silent:
`~/.cache/claude-cli-nodejs/<cwd-slug>/mcp-logs-<server>/` — a good connection
logs `Successfully connected (transport: stdio)`; a bad one logs
`Rejected 2025-era request … Unsupported protocol version: 2025-11-25` then
`Connection failed (-32022)`.

---

# 3. Waking a live session from an external event

Ranked by how close each is to true push-into-a-running-session.

## 3.1 Channels — push into an open session (research preview)

A channel is an MCP server that pushes events into an already-open Claude Code
session. Contract:

1. Declare `capabilities.experimental['claude/channel'] = {}` — presence
   registers the notification listener. Optional
   `experimental['claude/channel/permission'] = {}` opts into permission relay,
   forwarding tool-approval prompts to the remote surface.
2. Emit `notifications/claude/channel` with `params.content` (string) and
   optional `params.meta` (`Record<string,string>`).
3. Connect over stdio.

Claude sees:

```text
<channel source="webhook" severity="high" run_id="1234">build failed on main</channel>
```

**`meta` keys must match `[A-Za-z0-9_]`** — hyphenated keys are silently dropped.

**Launch gate:** a channel delivers nothing unless the session was started with
the flag; no already-running session can be attached to.

```bash
claude --channels plugin:telegram@claude-plugins-official
claude --dangerously-load-development-channels server:webhook   # custom channels
```

**No delivery acknowledgement.** `await mcp.notification()` resolves when bytes
hit the transport — not when Claude saw or acted on it. If the session did not
load the channel, or policy blocks it, events drop silently with no error to the
sender. Retain your own delivery state. Events queue and are delivered in order;
several arriving while Claude is busy are handed over together on the next turn.

Ships in the preview: `telegram`, `discord`, `imessage`, `fakechat`. Requires
Anthropic auth; **unavailable on Amazon Bedrock, Google Cloud's Agent Platform,
Microsoft Foundry**; Team/Enterprise must enable it in managed settings.

Inbound channel content is untrusted, webhook-grade input. Preserve sender
identity, transport identity, authorization state, event ID, origin, timestamp,
and the raw-content boundary before it can affect anything privileged.

## 3.2 `asyncRewake` — wake an idle session

A command-hook field. `async: true` runs in the background and delivers output on
the next turn — **if the session is idle, that output waits for the next user
interaction**. `asyncRewake: true` runs in the background and **wakes Claude on
exit code 2**, even when idle; the hook's stderr (or stdout if stderr is empty)
is shown as a system reminder. `timeout` is enforced for `asyncRewake` and not
for plain `async`.

This is the only documented primitive that wakes an *idle* session from a local
background condition with no preview dependency and no launch flag.

**Payload discipline:** carry references only — issue ref, event ID, reason — and
let the woken session read authoritative state through a tool. A watcher holding
the only copy of state, or emitting a prompt that carries authority, is the
failure mode this rule exists to prevent.

**Caveat:** under `claude -p`, background async hooks are killed at teardown and
finalized `cancelled`. Detach if the work must outlive the process.

## 3.3 Monitors — local event streams

`monitors/monitors.json` (declared in the manifest, per §1.3) starts commands
automatically; each stdout line becomes a session event. `when` is `"always"` or
`"on-skill-invoke:<plugin>:<skill>"`. The Monitor **tool** is the same mechanism,
armed by Claude in-session, and also accepts a WebSocket source.

Monitors run in interactive CLI sessions only, unsandboxed at hook trust level,
and are unavailable on Bedrock, Google Cloud's Agent Platform, Microsoft Foundry,
or when `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.
Monitor output is notification input, never durable state.

## 3.4 Other surfaces

- **Context injection (pull, not push):** `SessionStart` hooks (`source`:
  `startup|resume|clear|compact|fork`) and `UserPromptSubmit`
  (`hookSpecificOutput.additionalContext`). Injected text is saved to the
  transcript and *replayed* on `--continue`/`--resume`, so timestamps go stale.
  `SessionStart` hooks do re-run on resume. **Note the matcher:** a
  `SessionStart` entry with `"matcher": "compact"` fires only on compaction —
  not on fresh starts.
- **Agent SDK streaming input:** pass an `AsyncGenerator<SDKUserMessage>` as
  `prompt` to `query()`, or use `ClaudeSDKClient`. The cleanest programmatic
  path for an external event loop feeding a live agent. CLI equivalent:
  `claude -p --input-format stream-json --output-format stream-json`.
- **Cross-session messaging:** `ListAgents` / `SendMessage` deliver into another
  live session; messages enqueue and drain at the receiver's next tool round;
  `notify_when_idle: true` gives a one-shot idle notice. **[measured]** Delivery
  to a *non-Claude* peer can report `success: true` while nothing arrives —
  treat success as Claude↔Claude evidence only, never as a cross-provider
  acknowledgement.
- **Scheduling:** `/loop` and the in-session cron tools — session-scoped,
  in-memory, fire only while the REPL is idle, recurring jobs expire after 7
  days. The docs point at Channels instead when the trigger is an event.
- **Remote Control:** connects claude.ai/code or the mobile app to a session on
  your machine. Human transport; not an inter-agent transport.

## 3.5 Choosing

| Need | Use |
| --- | --- |
| External system pushes into an open session | Channels |
| Local stream / log / WebSocket | Monitors |
| Background condition must wake an idle session | `asyncRewake` hook, exit 2 |
| Long-lived programmatic participant | Agent SDK streaming input |
| Session → session | `SendMessage`, wrapped in your own message semantics |
| Human drives a local session remotely | Remote Control |
| **Durable work authority** | **none of the above** |

---

## Sources

All accessed 2026-09-09; measured findings from Claude Code 2.1.266, node
24.15.0, `@modelcontextprotocol/server` ^2.0.0.

- https://docs.claude.com/en/docs/claude-code/plugins
- https://docs.claude.com/en/docs/claude-code/plugins-reference
- https://docs.claude.com/en/docs/claude-code/plugin-marketplaces
- https://docs.claude.com/en/docs/claude-code/channels
- https://docs.claude.com/en/docs/claude-code/channels-reference
- https://docs.claude.com/en/docs/claude-code/hooks
- https://docs.claude.com/en/docs/claude-code/tools-reference
- https://docs.claude.com/en/docs/claude-code/remote-control
- https://docs.claude.com/en/docs/claude-code/scheduled-tasks
- https://docs.claude.com/en/api/agent-sdk/streaming-vs-single-mode
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/latest
