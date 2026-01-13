# LittleBrother Plugin for OpenCode 👀

Supervisor plugin for OpenCode—the "little big brother" that uses a compact LLM to monitor, audit, and intervene in your main AI agent's behavior.

## Features

- **Stream Watchdog**: Monitors streaming output in real-time, aborts sessions with explanatory messages when policy violations are detected
- **Action Gatekeeper**: Intercepts and evaluates tool execution requests before invocation; supports configurable allow/block lists and fail modes
- **Result Sanitizer**: Post-processes tool outputs; truncates oversized content, redacts secrets, and optionally performs deep content analysis

## Quick Start

```bash
npm install opencode-littlebrother
```

Add to `.opencode/config.json`:
```json
{
  "plugin": ["opencode-littlebrother"]
}
```

Configure in `.opencode/littlebrother.json`:
```json
{
  "supervisor": {
    "model": "google/gemini-2.5-flash"
  },
  "failOpen": true
}
```

## Configuration

Configuration files are resolved in order:
1. `.opencode/littlebrother.json` (project)
2. `~/.config/opencode/littlebrother.json` (global)

### Options

| Option | Type | Default | Range | Description |
|--------|------|---------|-------|-------------|
| `supervisor.model` | `string` | `google/gemini-2.5-flash` | — | Provider/model identifier. Falls back to OpenCode's `small_model` if unspecified. |
| `failOpen` | `boolean` | `true` | — | Supervisor failure behavior: `true` allows actions with warning; `false` blocks actions and aborts. |
| `timeout` | `number` | `5000` | [1000, 30000] | Supervisor query timeout (ms). |
| `watchdog.enabled` | `boolean` | `true` | — | Enable stream monitoring. |
| `watchdog.checkIntervalTokens` | `number` | `500` | [100, 5000] | Token interval between supervisor checks. |
| `watchdog.maxBufferTokens` | `number` | `2000` | [500, 10000] | Maximum buffer size before truncation. |
| `gatekeeper.enabled` | `boolean` | `true` | — | Enable tool execution gating. |
| `gatekeeper.blockedTools` | `string[]` | `[]` | — | Tool names always blocked. |
| `gatekeeper.alwaysAllowTools` | `string[]` | `["read", "glob", "grep", "lsp_hover", "lsp_diagnostics"]` | — | Tools bypassing supervisor evaluation. |
| `sanitizer.enabled` | `boolean` | `true` | — | Enable result sanitization. |
| `sanitizer.maxOutputChars` | `number` | `5000` | [1000, 50000] | Character limit before truncation. |
| `sanitizer.redactSecrets` | `boolean` | `true` | — | Redact API keys, tokens, JWTs, and connection strings via pattern matching. |
| `sanitizer.deepAnalysis` | `boolean` | `false` | — | Query supervisor for content analysis on outputs >1000 chars. |
| `debug` | `boolean` | `false` | — | Enable debug logging. |

## Supervisor Model Resolution

The supervisor model is resolved in descending priority:
1. `littlebrother.supervisor.model` in plugin config
2. `small_model` from OpenCode global config
3. Default: `google/gemini-2.5-flash`

Malformed model identifiers trigger a warning toast and fallback to default.

## Behavior

### Watchdog

Monitors `message.part.updated` events:
- Accumulates text deltas in buffer
- Queries supervisor every `checkIntervalTokens` characters
- On `ABORT` response: injects explanation message, shows error toast, terminates session
- Ignores deltas containing `[LittleBrother]` to prevent recursive monitoring

### Gatekeeper

Intercepts `tool.execute.before` events:
- `alwaysAllowTools`: bypass supervisor, execute immediately
- `blockedTools`: block execution, show toast, throw `GatekeeperBlockError`
- Other tools: query supervisor
  - `ALLOW`: execute tool
  - `BLOCK`: block execution, show toast, throw `GatekeeperBlockError`
- Supervisor failure:
  - `failOpen=true`: allow execution, show warning toast
  - `failOpen=false`: block execution, show error toast, throw `GatekeeperBlockError`

### Sanitizer

Intercepts `tool.execute.after` events:
- Truncates outputs exceeding `maxOutputChars`
- Redacts secrets using regex patterns when `redactSecrets=true`
- Deep analysis (`deepAnalysis=true`):
  - Queries supervisor for outputs >1000 chars
  - `SAFE`: return unmodified
  - `REDACT`: replace with supervisor-provided `replacement` text

### Internal Sessions

Creates isolated supervisor sessions per main session:
- Child sessions with `parentID` reference
- Title: "LittleBrother Supervisor"
- All tools disabled to prevent recursion
- Automatic cleanup on main session deletion

## Development

Prerequisites: Node.js ≥18, mise

```bash
# Install dependencies
npm install

# Build
mise run build

# Run tests
mise run test

# Lint
mise run lint

# Fix linting issues
mise run lint:fix

# Format code
mise run format
```