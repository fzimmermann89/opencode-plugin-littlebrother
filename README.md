# LittleBrother Plugin for OpenCode

Supervisor plugin for OpenCode that monitors, audits, and intervenes in AI agent behavior using a configurable supervisor LLM.

## Features

- **Stream Watchdog**: Periodically queries a supervisor model to monitor streaming output, can abort sessions with explanatory messages when issues are detected
- **Action Gatekeeper**: Intercepts tool execution before execution, queries supervisor to allow or block operations, supports fail-open/fail-closed modes
- **Result Sanitizer**: Post-processes tool outputs, truncates large outputs and redacts potential secrets, with optional deep analysis via supervisor

## Configuration

Configuration is done via a dedicated config file at `.opencode/littlebrother.json` (per-project) or `~/.config/opencode/littlebrother.json` (global).


### Example Config (`.opencode/littlebrother.json`)

```json
{
  "supervisor": {
    "model": "google/gemini-2.5-flash"
  },
  "failOpen": true,
  "timeout": 5000,
  "watchdog": {
    "enabled": true,
    "checkIntervalTokens": 500,
    "maxBufferTokens": 2000
  },
  "gatekeeper": {
    "enabled": true,
    "blockedTools": [],
    "alwaysAllowTools": ["read", "glob", "grep", "lsp_hover", "lsp_diagnostics"]
  },
  "sanitizer": {
    "enabled": true,
    "maxOutputChars": 5000,
    "redactSecrets": true,
    "deepAnalysis": false
  },
  "debug": false
}
```

The plugin also reads `small_model` from OpenCode's main config as a fallback for the supervisor model.

### Options

| Option | Type | Default | Description |
|---------|--------|----------|-------------|
| `supervisor.model` | `string \| undefined` | Model in `provider/model` format. Falls back to `small_model` from global config, then `google/gemini-3.0-flash`. |
| `failOpen` | `boolean` | `true` | When supervisor fails, allow actions and show toast. `false` blocks actions and aborts on failure. |
| `timeout` | `number` | `5000` | Supervisor query timeout in ms (clamped 1000-30000). |
| `watchdog.enabled` | `boolean` | `true` | Enable stream monitoring. |
| `watchdog.checkIntervalTokens` | `number` | `500` | Check supervisor every N characters (clamped 100-5000). |
| `watchdog.maxBufferTokens` | `number` | `2000` | Max buffer size in characters before truncation (clamped 500-10000). |
| `gatekeeper.enabled` | `boolean` | `true` | Enable tool execution gating. |
| `gatekeeper.blockedTools` | `string[]` | `[]` | Tool names that are always blocked. |
| `gatekeeper.alwaysAllowTools` | `string[]` | `["read", "glob", "grep", "lsp_hover", "lsp_diagnostics"]` | Tools that bypass supervisor. |
| `sanitizer.enabled` | `boolean` | `true` | Enable result sanitization. |
| `sanitizer.maxOutputChars` | `number` | `5000` | Truncate outputs after N characters (clamped 1000-50000). |
| `sanitizer.redactSecrets` | `boolean` | `true` | Heuristically redact potential secrets. |
| `sanitizer.deepAnalysis` | `boolean` | `false` | Query supervisor for content analysis on outputs >1000 chars. |
| `debug` | `boolean` | `false` | Enable debug logging. |

## Supervisor Models

The supervisor model is specified in `provider/model` format (e.g., `google/gemini-3.0-flash`, `anthropic/claude-3-haiku-20240307`).

The plugin first checks the configured model:
1. `littlebrother.supervisor.model` (plugin-specific)
2. `small_model` (global OpenCode config)
3. Falls back to `google/gemini-3.0-flash`

If the configured model is invalid (malformed), the plugin uses the default and shows a warning toast.

## Behavior

### Watchdog

- Monitors `message.part.updated` events for text deltas
- Accumulates characters in a buffer and checks the supervisor every `checkIntervalTokens` chars
- When supervisor returns `ABORT`, the plugin:
  - Injects a message into the session explaining why
  - Shows an error toast
  - Aborts the session
- Ignores deltas containing `[LittleBrother]` to avoid recursion

### Gatekeeper

- Intercepts `tool.execute.before` events
- Whitelisted tools (default safe ones) bypass supervisor
- Blacklisted tools are always blocked
- Other tools are queried to supervisor:
  - `ALLOW`: tool executes
  - `BLOCK`: tool blocked, toast shown, `GatekeeperBlockError` thrown
- On supervisor failure:
  - `failOpen`: tool allowed, warning toast
  - `failClosed`: tool blocked, error toast, error thrown

### Sanitizer

- Intercepts `tool.execute.after` events
- Truncates outputs exceeding `maxOutputChars`
- Redacts potential secrets using regex patterns (API keys, tokens, JWTs, connection strings)
- Optionally runs deep analysis via supervisor (`deepAnalysis: true`):
  - `SAFE`: no changes
  - `REDACT`: output replaced with `replacement` field

### Internal Sessions

The plugin creates internal supervisor sessions per main session to avoid polluting user conversation. These are:
- Created as child sessions with `parentID` set
- Titled "LittleBrother Supervisor"
- Have all tools disabled to prevent recursion
- Tracked and cleaned up on main session deletion

## Installation

```bash
npm install opencode-littlebrother
```

Then add to your OpenCode config:

```json
{
  "plugin": ["opencode-littlebrother"]
}
```
## Development

- mise run build - Build the plugin
- mise run test - Run tests
- mise run lint - Lint code
- mise run lint:fix - Fix linting issues
- mise run format - Format code with Prettier