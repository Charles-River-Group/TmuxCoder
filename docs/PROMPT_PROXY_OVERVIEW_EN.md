# TmuxCoder Prompt Proxy - Technical Overview

## 1. Project Goal

**Implement a dynamic, configurable AI Prompt management system without modifying OpenCode source code.**

Core Requirements:
- ✅ Keep OpenCode as submodule pristine, updatable anytime
- ✅ File-based, version-controlled, experimentable Prompt configuration
- ✅ Project-level isolated configuration

---

## 2. Core Architecture

### 2.1 Overall Design

```
┌─────────────────────────────────────────────────────┐
│  Prompt Proxy Plugin (Local)                        │
│  Intercepts OpenCode hooks → Replaces system prompt │
└──────────────┬──────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│  @tmuxcoder/prompt-core (Universal SDK)             │
│  Template Engine + Parameter Manager + A/B Testing  │
└──────────────┬──────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│  .opencode/prompts/ (Configuration)                 │
│  - templates/*.txt   (Prompt Templates)             │
│  - parameters.json   (Model Parameters)             │
│  - experiments.json  (A/B Testing)                  │
└─────────────────────────────────────────────────────┘
```

### 2.2 Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Core SDK | TypeScript | Type safety, maintainability |
| Template Engine | Handlebars | Variable substitution + conditional logic |
| Plugin System | OpenCode Plugin API | Native support, zero-intrusion |

---

## 3. Key Advantages

### 3.1 Zero-Intrusion + Updatable

```
OpenCode (Git Submodule)
├── No modifications whatsoever
└── Regular git pull updates ✅

TmuxCoder
├── .opencode/plugin/prompt-proxy.ts  ← Our code
└── .opencode/prompts/                ← Configuration files
```

### 3.2 Dynamic Configuration

```handlebars
<!-- .opencode/prompts/templates/coder.txt -->
You are working on {{project_name}}.
Branch: {{git_branch}}
{{#if git_dirty}}⚠️ Uncommitted changes{{/if}}
```

Real-time rendering of project info, changes take effect immediately.

### 3.3 A/B Testing

```json
{
  "experiments": [{
    "id": "temp-test",
    "allocation": { "control": 0.5, "low-temp": 0.5 },
    "variants": {
      "control": { "temperature": 0.7 },
      "low-temp": { "temperature": 0.3 }
    }
  }]
}
```

Consistent per-session allocation, rapid effect validation.

### 3.4 Relationship with OpenCode Built-in Prompts

| Dimension | OpenCode Built-in | Prompt Proxy |
|-----------|------------------|--------------|
| **Location** | OpenCode source | `.opencode/prompts/` |
| **Priority** | Low (default) | High (override) |
| **Modification** | Source code + recompile | Edit config files |
| **Project Isolation** | Global shared | Per-project independent |

---

## 4. Implementation Plan

### Phase Breakdown

| Phase | Tasks | Timeline |
|-------|-------|----------|
| **Phase 1** | Core SDK Development<br>- Type definitions<br>- LocalResolver implementation<br>- Template engine integration | 2 weeks |
| **Phase 2** | OpenCode Integration<br>- Plugin development<br>- Hook registration<br>- Configuration examples | 1 week |
| **Phase 3** | Advanced Features<br>- A/B testing<br>- Monitoring & logging<br>- Documentation refinement | 1-2 weeks |
| **Phase 4** | Multi-platform Support<br>- CLI tooling<br>- Claude Code bridge | Optional |

### Core Code Example

```typescript
// .opencode/plugin/prompt-proxy.ts (20 lines to get it done)
import { TmuxCoderPrompts } from "@tmuxcoder/prompt-core"

export const PromptProxy: Plugin = async ({ project, directory }) => {
  const prompts = new TmuxCoderPrompts({
    mode: "local",
    local: {
      templatesDir: `${directory}/.opencode/prompts/templates`,
      parametersPath: `${directory}/.opencode/prompts/parameters.json`,
    }
  })
  await prompts.initialize()

  return {
    "chat.message": async (input, output) => {
      const resolved = await prompts.resolve({
        agent: input.agent || "default",
        sessionID: input.sessionID,
        project: { name: project.name, path: directory }
      })
      output.message.system = resolved.system  // ← Replace Prompt
    }
  }
}
```

### Success Criteria

- ✅ OpenCode can be updated normally (no code modifications)
- ✅ Prompt changes take effect immediately (no restart required)
- ✅ Support for multi-project independent configuration
- ✅ Configuration files are version-controllable

---

**Document Version**: 2.0 (Concise Edition)
**Last Updated**: 2025-01-09
