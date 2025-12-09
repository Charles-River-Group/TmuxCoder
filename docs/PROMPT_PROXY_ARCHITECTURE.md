# OpenCode Prompt Proxy Architecture

## 1. Overview

This document outlines the architecture for the **OpenCode Prompt Proxy**, a system designed to decouple prompt management and model configuration from the core OpenCode codebase. By introducing a plugin-based architecture that communicates with an external service, we enable dynamic prompt updates, A/B testing, and centralized management without requiring client-side code changes or long-lived forks.

## 2. Goals & Design Principles

### 2.1 Core Goals
- **Decoupling**: Move system prompts, agent rules, and model parameters out of the OpenCode core and into an external, versioned service.
- **Dynamic Updates**: Allow prompt logic updates to be pushed immediately to all users without requiring a software update.
- **Experimentation**: Enable A/B testing of prompts and model parameters (Temperature, TopP) for specific user groups or agents.
- **Centralized Governance**: Provide a single source of truth for compliance rules, safety guardrails, and organizational policies.

### 2.2 Constraints
- **Latency**: The proxy lookup must be fast to avoid delaying the user's chat experience.
- **Fallback**: The system should gracefully degrade if the proxy service is unreachable (e.g., fall back to local defaults).
- **Compatibility**: Must integrate with OpenCode's existing plugin hooks (`chat.message`, `chat.params`) without modifying core logic.

## 3. System Architecture

The architecture consists of three main components: the **OpenCode Core**, the **Prompt Proxy Plugin**, and the **External Prompt Service**.

![System Architecture](images/architecture_diagram.svg)

### 3.1 Components

#### 1. Prompt Proxy Plugin
A lightweight TypeScript plugin installed in the OpenCode environment.
- **Responsibility**: Intercepts user messages, queries the Proxy Service, and injects the returned system prompts and parameters into the chat session.
- **State**: Caches session-specific parameters to ensure consistency between message processing and model generation.

#### 2. Prompt Proxy Service
An external HTTP service (Node.js, Go, etc.).
- **Responsibility**: Determines the appropriate system prompt and model parameters based on the user, agent, and context.
- **Features**: Handles logic for experiment allocation, template rendering, and audit logging.

#### 3. Configuration Layer
Managed via `opencode.json`.
- **Responsibility**: Defines which plugin version to load and provides necessary environment variables (e.g., Service URL).

## 4. Detailed Design

### 4.1 Plugin Hooks

The plugin leverages two specific OpenCode hooks:

1.  **`chat.message`**:
    *   **Trigger**: Before a user message is saved/processed.
    *   **Action**: Sends message context to Proxy Service. Receives updated `system` prompt and `parts` (injections).
    *   **Outcome**: Mutates `output.message.system` and `output.parts`.

2.  **`chat.params`**:
    *   **Trigger**: Before the LLM inference request.
    *   **Action**: Retrieves cached parameters (Temperature, TopP) determined during the `chat.message` phase.
    *   **Outcome**: Mutates `output.temperature`, `output.topP`, `output.options`.

### 4.2 Data Flow

![Data Flow](images/data_flow_diagram.svg)

### 4.3 API Contract

**Request: `POST /prompt`**
```json
{
  "sessionID": "string",
  "agent": "string",
  "user": {
    "system": "string",
    "parts": []
  },
  "metadata": {
    "project": "string",
    "directory": "string"
  }
}
```

**Response**
```json
{
  "system": "string (The authoritative system prompt)",
  "parts": ["(Optional) Synthetic message parts to inject"],
  "params": {
    "temperature": 0.7,
    "topP": 0.9,
    "options": {}
  }
}
```

## 5. Implementation Strategy

### 5.1 Phase 1: Bootstrap
- Create `tmuxcoder-prompt-proxy` repo.
- Implement basic `chat.message` hook with hardcoded service URL.
- Verify system prompt injection works locally.

### 5.2 Phase 2: Service Integration
- Build minimal Proxy Service (e.g., using Hono/Express).
- Implement `chat.params` hook for model configuration.
- Add caching mechanism in the plugin for session parameters.

### 5.3 Phase 3: Rollout & Hardening
- Add error handling (fallback to default if service fails).
- Implement timeout logic for service calls.
- Deploy plugin to internal registry.
- Update `opencode.json` in target projects.

## 6. Security & Observability

- **Security**: The Proxy Service should validate requests. If sensitive code context is sent, ensure encryption in transit (HTTPS).
- **Observability**: The Proxy Service must log all requests with `sessionID` and `experimentID` to allow tracing specific model behaviors back to the prompt version used.

## 7. Verification Plan

To ensure the reliability and correctness of the Prompt Proxy system, the following verification strategy will be employed.

### 7.1 Unit Testing

#### Plugin Logic
- **Hook Execution**: Verify that `chat.message` and `chat.params` hooks are triggered at the correct lifecycle events.
- **State Management**: Test that parameters returned by the service in `chat.message` are correctly cached and retrieved in `chat.params`.
- **Payload Construction**: Ensure the plugin correctly serializes the user message and context (project, directory) before sending to the service.

#### Service Logic
- **Prompt Resolution**: Test that the service returns the correct system prompt based on input metadata (e.g., specific agent, project).
- **Parameter Overrides**: Verify that model parameters (temperature, topP) are correctly assigned based on experiment rules.

### 7.2 Integration Testing

#### End-to-End Flow
1.  **Setup**: Start a local instance of the Proxy Service and configure OpenCode to use the local plugin.
2.  **Action**: Send a chat message via the OpenCode interface.
3.  **Assertion**:
    *   Verify the Proxy Service receives the request with correct metadata.
    *   Verify the OpenCode session reflects the updated system prompt (visible in debug logs or session file).
    *   Verify the LLM request uses the overridden parameters (e.g., by inspecting network traffic or proxy logs).

### 7.3 Manual Verification

#### 1. System Prompt Injection
- **Steps**:
    1.  Configure the Proxy Service to return a distinct system prompt (e.g., "You are a pirate").
    2.  Start a new chat session in OpenCode.
    3.  Ask "Who are you?".
- **Expected Result**: The model responds in the persona defined by the injected prompt.

#### 2. Parameter Control
- **Steps**:
    1.  Configure the Proxy Service to set `temperature` to `0.0` (deterministic).
    2.  Ask the same question multiple times.
- **Expected Result**: The model provides identical responses for identical inputs.

### 7.4 Failure Scenarios (Resilience)

#### Service Downtime
- **Scenario**: Stop the Proxy Service.
- **Action**: Send a message in OpenCode.
- **Expected Result**:
    *   The plugin should timeout gracefully (e.g., after 500ms).
    *   The chat should proceed using the default local system prompt.
    *   An error should be logged, but the user experience should not be blocked.

#### Invalid Response
- **Scenario**: Service returns malformed JSON or 500 error.
- **Expected Result**: Plugin ignores the response and proceeds with defaults.

