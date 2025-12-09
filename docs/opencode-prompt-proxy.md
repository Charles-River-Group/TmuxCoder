# OpenCode Prompt Proxy Integration Plan

## Goals & Constraints
- Avoid long-lived forks of the upstream `opencode` repo; keep all custom prompt logic in external plugins or services so upgrades are painless.
- Provide a single place to manage system prompts, per-agent rules, and model parameters, and allow experimentation without touching OpenCode core.
- Support team-wide rollout (shared config) while keeping local overrides for experimentation.

## Current Prompt Lifecycle (Key References)
- User messages are persisted and passed through plugin hooks before saving; this is the only safe place to mutate the system prompt without editing core code (`packages/opencode/packages/opencode/src/session/prompt.ts:1037`).
- Later in the run loop, OpenCode resolves the final system prompt by merging headers, user-provided `system`, agent defaults, and environment snippets (`packages/opencode/packages/opencode/src/session/prompt.ts:614`). Whatever you write into `output.message.system` at the hook stage becomes the `lastUser.system` consumed here (`packages/opencode/packages/opencode/src/session/prompt.ts:463`).
- Model parameters (temperature/topP/options) are also passed through the `Plugin.trigger("chat.params", …)` hook before dispatch (`packages/opencode/packages/opencode/src/session/prompt.ts:472`).
- Plugin hooks are declared in `@opencode-ai/plugin` (`packages/opencode/packages/plugin/src/index.ts:138`), so you can override both `chat.message` and `chat.params`.
- Plugins are loaded dynamically from the `plugin` array in `opencode.json` and from any `plugin/*.ts|js` files in project or global config folders (`packages/opencode/packages/opencode/src/config/config.ts:34`, `packages/opencode/packages/opencode/src/config/config.ts:279`, `packages/opencode/packages/opencode/src/config/config.ts:93`).
- At runtime, OpenCode installs and imports every configured plugin, handing them the project context (`packages/opencode/packages/opencode/src/plugin/index.ts:14` onward).

## Proposed Architecture
1. **Prompt Proxy Plugin** (lives in its own repo, versioned by you). Implements `chat.message` and `chat.params`, and optionally calls an external prompt service to fetch the latest instructions/parameters.
2. **Prompt Proxy Service** (could be Bun/Node, Go, etc.) that stores prompt templates, agent-specific overrides, audit logs, and experiment flags. The plugin sends the raw user message + metadata and receives back the authoritative system prompt and param overrides.
3. **Configuration Layer** using `opencode.json` (project or global) to point OpenCode at your plugin package (npm tag, git tag, or local file URL). Team members add a single entry instead of editing OpenCode core.

### Data Flow
1. User submits message.
2. `chat.message` hook serializes the message/parts and POSTs to the proxy service.
3. Service returns `{ system, injections, params }`.
4. Plugin updates `output.message.system`, optionally adds synthetic parts, and caches params into a shared Map keyed by `sessionID`.
5. When OpenCode later invokes `chat.params`, the plugin reads the cached params (or asks the service again) and mutates `output.temperature`, `output.topP`, or `output.options`.
6. Downstream `resolveSystemPrompt` now sees the overridden system prompt and streams the model with your desired behavior.

## Implementation Steps

### 1. Bootstrap a Plugin Package
Create a new repo (e.g., `tmuxcoder-prompt-proxy`) and scaffold:

```text
tmuxcoder-prompt-proxy/
├─ package.json         // type: module, exports "./dist/index.js"
├─ tsconfig.json
├─ src/index.ts         // plugin entry
├─ src/client.ts        // HTTP client for the proxy service (optional)
└─ README.md
```

Install the dependencies you need:

```bash
pnpm add @opencode-ai/plugin zod node-fetch
pnpm dlx tsup src/index.ts --dts --format esm
```

### 2. Implement the `chat.message` Hook

```ts
// src/index.ts
import type { Plugin } from "@opencode-ai/plugin"
import { PromptProxyClient } from "./client"

export const promptProxy: Plugin = async ({ project, worktree, directory }) => {
  const client = new PromptProxyClient(process.env.PROMPT_PROXY_URL ?? "http://127.0.0.1:8787")

  return {
    async "chat.message"(input, output) {
      if (output.message.role !== "user") return

      const payload = {
        sessionID: input.sessionID,
        agent: input.agent,
        metadata: {
          project: project.slug,
          worktree,
          directory,
        },
        user: {
          parts: output.parts,
          system: output.message.system,
        },
      }

      const response = await client.buildPrompt(payload)
      if (response.system) {
        output.message.system = response.system
      }
      if (response.parts?.length) {
        // e.g., inject reminders or hidden context before saving
        output.parts = [...response.parts, ...output.parts]
      }
      if (response.params) {
        client.rememberParams(input.sessionID, response.params)
      }
    },
  }
}
```

Key points:
- This hook runs before `Session.updateMessage`, so any mutation persists and feeds directly into `resolveSystemPrompt` later (`packages/opencode/packages/opencode/src/session/prompt.ts:463` + `packages/opencode/packages/opencode/src/session/prompt.ts:614`).
- Use the `parts` array to inject synthetic reminders (e.g., policy statements) for specific agents.
- Cache any parameter overrides in memory; the example uses a helper on the client.

### 3. Implement the `chat.params` Hook

```ts
export const promptProxy: Plugin = async ({ project }) => {
  const client = new PromptProxyClient(process.env.PROMPT_PROXY_URL!)

  return {
    async "chat.params"(input, output) {
      const params =
        client.consumeParams(input.sessionID) ??
        (await client.fetchParams({
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          project: project.slug,
        }))

      if (!params) return
      if (typeof params.temperature === "number") output.temperature = params.temperature
      if (typeof params.topP === "number") output.topP = params.topP
      if (params.options) output.options = { ...output.options, ...params.options }
    },
  }
}
```

This hook runs immediately before `streamText` is called, so you can safely override every generation parameter without touching provider code (`packages/opencode/packages/opencode/src/session/prompt.ts:472`).

### 4. Prompt Proxy Service Contract

Minimum viable API:

```
POST /prompt
{
  sessionID,
  agent,
  user: { system, parts },
  metadata: { project, directory }
}
→ { system: string, parts?: Part[], params?: { temperature?, topP?, options? } }

POST /params
{
  sessionID,
  agent,
  model
}
→ { temperature?, topP?, options? }
```

Implementation ideas:
- Store prompt templates (Markdown/JSON) in Git; the service reads them and returns the correct variant.
- Attach experiment IDs or version hashes so you can audit which prompt generated which response.
- Optionally push analytics back to a datastore for offline evaluation.

### 5. Wire the Plugin into OpenCode

1. Publish the plugin to your internal npm registry (or use `file://` paths during development).
2. In the project’s `opencode.json`, add:

```json
{
  "plugin": [
    "tmuxcoder-prompt-proxy@0.1.0"
  ]
}
```

3. Alternatively, drop a compiled `plugin/prompt-proxy.js` file inside `.opencode/` or the repo root; OpenCode automatically picks up every `plugin/*.{ts,js}` file (`packages/opencode/packages/opencode/src/config/config.ts:279`).
4. Ensure `PROMPT_PROXY_URL` (and any API keys) are exported in your shell or `.env`. You can also inject env vars via the plugin input (`PluginInput.directory/worktree`).

### 6. Observability & Rollout
- Log every mutation with session/agent IDs so you can trace back unexpected behavior.
- Add feature flags in the proxy service to enable/disable overrides per agent or per directory.
- Use semantic versioning on the plugin; use OpenCode’s `plugin` array to pin exact versions during rollout.
- Write lightweight integration tests that instantiate the plugin, feed a fake message, and assert the mutated `system`/params.

## Future Extensions
- Push org-wide rules from the proxy service into `output.parts` as hidden attachments (instead of editing AGENTS.md).
- Automatically inject context from external systems (tickets, codeowners) via the proxy service.
- Add a secondary `permission.ask` hook to enforce policy when the proxy instructs a refusal.
