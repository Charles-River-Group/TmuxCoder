import type { Plugin } from "@opencode-ai/plugin"
import { TmuxCoderPrompts } from "@tmuxcoder/prompt-core"
import type { PromptConfig, PromptContext } from "@tmuxcoder/prompt-core"
import { join } from "path"
import { existsSync } from "fs"

export const PromptProxy: Plugin = async ({ project, directory, worktree, $ }) => {
  // Load configuration
  const config = await loadConfig(directory)

  // Initialize SDK
  const prompts = new TmuxCoderPrompts(config)
  await prompts.initialize()

  console.log("[PromptProxy] Initialized with mode:", config.mode)

  // Create parameter cache (for passing data between hooks)
  const parameterCache = new Map<string, any>()

  return {
    /**
     * Hook 1: Customize system prompt
     */
    "chat.message": async (input, output) => {
      const { sessionID, agent = "default", model } = input

      try {
        // Build context
        const context: PromptContext = {
          agent,
          sessionID,
          project: {
            name: project.name || "unknown",
            path: directory,
          },
          model: model
            ? {
                providerID: model.providerID,
                modelID: model.modelID,
              }
            : undefined,
          git: await getGitInfo(worktree, $),
          environment: {
            NODE_ENV: process.env.NODE_ENV,
          },
        }

        // Resolve Prompt
        const resolved = await prompts.resolve(context)

        // Apply to output
        output.message.system = resolved.system

        // Cache parameters for chat.params hook
        parameterCache.set(sessionID, resolved.parameters)

        if (config.debug) {
          console.log("[PromptProxy] Applied prompt:", {
            agent,
            templateID: resolved.metadata.templateID,
            variantID: resolved.metadata.variantID,
            systemLength: resolved.system.length,
          })
        }
      } catch (error) {
        console.error("[PromptProxy] Error in chat.message hook:", error)
      }
    },

    /**
     * Hook 2: Customize model parameters
     */
    "chat.params": async (input, output) => {
      const { sessionID } = input

      try {
        const params = parameterCache.get(sessionID)

        if (params) {
          if (params.temperature !== undefined) {
            output.temperature = params.temperature
          }
          if (params.topP !== undefined) {
            output.topP = params.topP
          }
          if (params.options) {
            output.options = {
              ...output.options,
              ...params.options,
            }
          }

          if (config.debug) {
            console.log("[PromptProxy] Applied parameters:", {
              temperature: params.temperature,
              topP: params.topP,
            })
          }
        }
      } catch (error) {
        console.error("[PromptProxy] Error in chat.params hook:", error)
      }
    },

    /**
     * Hook 3: Listen to events (optional)
     */
    event: async ({ event }) => {
      if (event.type === "session.completed" || event.type === "session.deleted") {
        const sessionID = (event as any).sessionID
        if (sessionID) {
          parameterCache.delete(sessionID)
          prompts.clearSessionCache(sessionID)
        }
      }
    },
  }
}

/**
 * Load configuration file
 */
async function loadConfig(directory: string): Promise<PromptConfig> {
  const configPath = join(directory, ".opencode/prompts/config.json")

  const defaultConfig: PromptConfig = {
    mode: "local",
    local: {
      templatesDir: join(directory, ".opencode/prompts/templates"),
      parametersPath: join(directory, ".opencode/prompts/parameters.json"),
      experimentsPath: join(directory, ".opencode/prompts/experiments.json"),
    },
    cache: {
      enabled: true,
      ttl: 300,
      maxSize: 100,
    },
    debug: process.env.TMUXCODER_DEBUG === "true",
  }

  if (existsSync(configPath)) {
    try {
      const content = await Bun.file(configPath).text()
      const userConfig = JSON.parse(content)

      return {
        ...defaultConfig,
        ...userConfig,
        local: {
          ...defaultConfig.local,
          ...userConfig.local,
        },
        cache: {
          ...defaultConfig.cache,
          ...userConfig.cache,
        },
      }
    } catch (error) {
      console.warn("[PromptProxy] Failed to load config, using defaults:", error)
    }
  }

  return defaultConfig
}

/**
 * Get Git information
 */
async function getGitInfo(worktree: string, $: any) {
  try {
    const branch = await $`git -C ${worktree} branch --show-current`.text()
    const status = await $`git -C ${worktree} status --short`.text()

    return {
      branch: branch.trim(),
      isDirty: status.trim().length > 0,
    }
  } catch {
    return {
      branch: "unknown",
      isDirty: false,
    }
  }
}
