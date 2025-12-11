/**
 * Context information (platform-agnostic)
 */
interface PromptContext {
    agent: string;
    sessionID: string;
    project?: {
        name: string;
        path: string;
    };
    git?: {
        branch: string;
        isDirty: boolean;
        commitHash?: string;
    };
    model?: {
        providerID: string;
        modelID: string;
    };
    user?: {
        id: string;
        email?: string;
    };
    environment?: Record<string, any>;
}
/**
 * Resolved Prompt configuration
 */
interface ResolvedPrompt {
    system: string;
    parameters: {
        temperature?: number;
        topP?: number;
        maxTokens?: number;
        options?: Record<string, any>;
    };
    metadata: {
        templateID: string;
        templateVersion?: string;
        variantID?: string;
        experimentID?: string;
        resolverType: "local" | "remote" | "hybrid";
        resolvedAt: string;
    };
}
/**
 * Configuration mode
 */
type PromptMode = "local" | "remote" | "hybrid";
/**
 * Prompt configuration
 */
interface PromptConfig {
    mode: PromptMode;
    local?: {
        templatesDir: string;
        experimentsPath?: string;
        parametersPath?: string;
    };
    remote?: {
        url: string;
        apiKey?: string;
        timeout?: number;
        fallback?: "local" | "error";
    };
    cache?: {
        enabled: boolean;
        ttl?: number;
        maxSize?: number;
    };
    debug?: boolean;
}

/**
 * Prompt Resolver abstract interface
 */
declare abstract class PromptResolver {
    protected config: PromptConfig;
    constructor(config: PromptConfig);
    /**
     * Initialize Resolver
     */
    abstract initialize(): Promise<void>;
    /**
     * Resolve Prompt
     */
    abstract resolve(context: PromptContext): Promise<ResolvedPrompt>;
    /**
     * Release resources (optional)
     */
    dispose(): Promise<void>;
    /**
     * Health check (optional)
     */
    healthCheck(): Promise<boolean>;
}
/**
 * Resolver Factory
 */
declare class ResolverFactory {
    static create(config: PromptConfig): PromptResolver;
}

interface CacheEntry {
    value: ResolvedPrompt;
    timestamp: number;
    ttl: number;
}
declare class PromptCache {
    private config;
    private cache;
    private cleanupInterval?;
    constructor(config: {
        enabled: boolean;
        ttl?: number;
        maxSize?: number;
        cleanupIntervalMs?: number;
    });
    static generateKey(agent: string, sessionID: string, modelID?: string): string;
    get(key: string): ResolvedPrompt | null;
    set(key: string, value: ResolvedPrompt, ttl?: number): void;
    clearSession(sessionID: string): void;
    clear(): void;
    private cleanup;
    private findOldestKey;
    dispose(): void;
}

declare class LocalResolver extends PromptResolver {
    private templateEngine;
    private experimentManager;
    private parameterManager;
    private initialized;
    constructor(config: PromptConfig);
    initialize(): Promise<void>;
    resolve(context: PromptContext): Promise<ResolvedPrompt>;
    /**
     * Enrich context (add runtime information)
     */
    private enrichContext;
    /**
     * Fallback: return minimal usable prompt
     */
    private getFallbackPrompt;
    healthCheck(): Promise<boolean>;
}

/**
 * TmuxCoder Prompt SDK main entry point
 */
declare class TmuxCoderPrompts {
    private config;
    private resolver;
    private cache;
    private initialized;
    constructor(config: PromptConfig);
    initialize(): Promise<void>;
    resolve(context: PromptContext): Promise<ResolvedPrompt>;
    clearSessionCache(sessionID: string): void;
    healthCheck(): Promise<boolean>;
    dispose(): Promise<void>;
}

export { type CacheEntry, LocalResolver, PromptCache, type PromptConfig, type PromptContext, type PromptMode, PromptResolver, type ResolvedPrompt, ResolverFactory, TmuxCoderPrompts };
