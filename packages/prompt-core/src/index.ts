export * from "./types"
export * from "./resolver"
export * from "./cache"
export { LocalResolver } from "./local/manager"

import { ResolverFactory } from "./resolver"
import { PromptCache } from "./cache"
import type { PromptConfig, PromptContext, ResolvedPrompt } from "./types"

/**
 * TmuxCoder Prompt SDK main entry point
 */
export class TmuxCoderPrompts {
  private resolver: ReturnType<typeof ResolverFactory.create>
  private cache: PromptCache
  private initialized = false

  constructor(private config: PromptConfig) {
    this.resolver = ResolverFactory.create(config)
    this.cache = new PromptCache(config.cache || { enabled: false })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    await this.resolver.initialize()
    this.initialized = true

    if (this.config.debug) {
      console.log("[TmuxCoderPrompts] SDK initialized", {
        mode: this.config.mode,
        cacheEnabled: this.config.cache?.enabled,
      })
    }
  }

  async resolve(context: PromptContext): Promise<ResolvedPrompt> {
    if (!this.initialized) {
      throw new Error("SDK not initialized. Call initialize() first.")
    }

    const cacheKey = PromptCache.generateKey(
      context.agent,
      context.sessionID,
      context.model?.modelID
    )
    const cached = this.cache.get(cacheKey)

    if (cached) {
      if (this.config.debug) {
        console.log("[TmuxCoderPrompts] Cache hit:", cacheKey)
      }
      return cached
    }

    const resolved = await this.resolver.resolve(context)
    this.cache.set(cacheKey, resolved)

    return resolved
  }

  clearSessionCache(sessionID: string): void {
    this.cache.clearSession(sessionID)
  }

  async healthCheck(): Promise<boolean> {
    return this.resolver.healthCheck()
  }

  async dispose(): Promise<void> {
    await this.resolver.dispose()
    this.cache.dispose()
    this.initialized = false
  }
}
