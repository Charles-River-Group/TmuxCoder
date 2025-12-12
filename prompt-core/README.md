# @tmuxcoder/prompt-core

TmuxCoder Prompt Management SDK - A flexible system for managing AI prompts with templates, experiments, and dynamic configuration.

## Features

- **Template Engine**: Handlebars-based prompt templates with custom helpers
- **Experiment Management**: A/B testing support with consistent variant allocation
- **Parameter Management**: Hierarchical configuration (experiment > agent > model > defaults)
- **Caching**: Built-in caching for improved performance
- **Extensible**: Support for local and remote prompt resolution (remote coming soon)

## Installation

```bash
npm install @tmuxcoder/prompt-core
# or
bun add @tmuxcoder/prompt-core
```

## Quick Start

```typescript
import { TmuxCoderPrompts } from '@tmuxcoder/prompt-core'

// Initialize SDK
const prompts = new TmuxCoderPrompts({
  mode: 'local',
  local: {
    templatesDir: '.opencode/prompts/templates',
    parametersPath: '.opencode/prompts/parameters.json',
    experimentsPath: '.opencode/prompts/experiments.json',
  },
  cache: {
    enabled: true,
    ttl: 300,
    maxSize: 100,
  },
})

await prompts.initialize()

// Resolve a prompt
const result = await prompts.resolve({
  agent: 'coder',
  sessionID: 'session-123',
  project: {
    name: 'my-project',
    path: '/path/to/project',
  },
  model: {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4',
  },
})

console.log(result.system) // Rendered system prompt
console.log(result.parameters) // { temperature: 0.7, topP: 0.9, ... }
console.log(result.metadata) // { templateID: 'coder', variantID: 'control', ... }
```

## Configuration

### Main Config (config.json)

```json
{
  "mode": "local",
  "cache": {
    "enabled": true,
    "ttl": 300,
    "maxSize": 100
  },
  "debug": false
}
```

### Parameters (parameters.json)

```json
{
  "defaults": {
    "temperature": 0.7,
    "topP": 0.9
  },
  "agents": {
    "coder": {
      "temperature": 0.7,
      "topP": 0.9
    },
    "reviewer": {
      "temperature": 0.3,
      "topP": 0.95
    }
  }
}
```

### Templates

Templates use Handlebars syntax with custom helpers:

```handlebars
You are an expert software engineer working on {{project_name}}.

## Project Context
- **Branch**: {{git_branch}}
- **Working Tree**: {{#if git_dirty}}Modified{{else}}Clean{{/if}}
- **Model**: {{model_id}}

Start implementing now. Think step-by-step and write high-quality code.
```

## API Reference

### TmuxCoderPrompts

Main SDK class for resolving prompts.

#### Methods

- `initialize()`: Initialize the SDK (must be called before use)
- `resolve(context: PromptContext)`: Resolve a prompt based on context
- `clearSessionCache(sessionID: string)`: Clear cache for a specific session
- `healthCheck()`: Check if resolver is healthy
- `dispose()`: Clean up resources

### Types

See [types.ts](src/types.ts) for complete type definitions.

## Development

```bash
# Build
bun run build

# Watch mode
bun run dev

# Test
bun run test

# Lint
bun run lint
```

## License

MIT
