"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  LocalResolver: () => LocalResolver,
  PromptCache: () => PromptCache,
  PromptResolver: () => PromptResolver,
  ResolverFactory: () => ResolverFactory,
  TmuxCoderPrompts: () => TmuxCoderPrompts
});
module.exports = __toCommonJS(index_exports);

// src/local/template.ts
var import_promises = require("fs/promises");
var import_path = require("path");
var import_handlebars = __toESM(require("handlebars"));
var TemplateEngine = class {
  constructor(config) {
    this.config = config;
  }
  templates = /* @__PURE__ */ new Map();
  defaultTemplate;
  async initialize() {
    try {
      const defaultPath = (0, import_path.join)(this.config.templatesDir, "default.txt");
      const defaultContent = await (0, import_promises.readFile)(defaultPath, "utf-8");
      this.defaultTemplate = import_handlebars.default.compile(defaultContent, {
        noEscape: false,
        strict: true
      });
      if (this.config.debug) {
        console.log("[TemplateEngine] Loaded default template");
      }
    } catch (error) {
      console.warn("[TemplateEngine] No default template found, using hardcoded fallback");
      this.defaultTemplate = import_handlebars.default.compile("You are an AI assistant.");
    }
    this.registerHelpers();
  }
  async render(templateID, context) {
    const template = await this.loadTemplate(templateID);
    try {
      return template(context);
    } catch (error) {
      console.error(`[TemplateEngine] Failed to render template '${templateID}':`, error);
      throw error;
    }
  }
  async loadTemplate(templateID) {
    if (this.templates.has(templateID)) {
      return this.templates.get(templateID);
    }
    const templatePath = (0, import_path.join)(this.config.templatesDir, `${templateID}.txt`);
    try {
      const content = await (0, import_promises.readFile)(templatePath, "utf-8");
      const compiled = import_handlebars.default.compile(content, {
        noEscape: false,
        strict: true
      });
      this.templates.set(templateID, compiled);
      if (this.config.debug) {
        console.log(`[TemplateEngine] Loaded template: ${templateID}`);
      }
      return compiled;
    } catch (error) {
      console.warn(`[TemplateEngine] Template '${templateID}' not found, using default`);
      return this.defaultTemplate;
    }
  }
  /**
   * Register custom Handlebars helpers
   */
  registerHelpers() {
    import_handlebars.default.registerHelper("formatDate", (date, format) => {
      const d = new Date(date);
      if (format === "short") {
        return d.toLocaleDateString();
      }
      return d.toISOString();
    });
    import_handlebars.default.registerHelper("eq", (a, b) => a === b);
    import_handlebars.default.registerHelper("ne", (a, b) => a !== b);
    import_handlebars.default.registerHelper("gt", (a, b) => a > b);
    import_handlebars.default.registerHelper("lt", (a, b) => a < b);
    import_handlebars.default.registerHelper("uppercase", (str) => str?.toUpperCase() || "");
    import_handlebars.default.registerHelper("lowercase", (str) => str?.toLowerCase() || "");
    if (this.config.debug) {
      console.log("[TemplateEngine] Registered custom helpers");
    }
  }
  /**
   * Clear cache (for hot reload)
   */
  clearCache() {
    this.templates.clear();
    if (this.config.debug) {
      console.log("[TemplateEngine] Cache cleared");
    }
  }
};

// src/local/experiments.ts
var import_promises2 = require("fs/promises");
var import_fs = require("fs");
var ExperimentManager = class {
  constructor(opts) {
    this.opts = opts;
  }
  config;
  async initialize() {
    if (!this.opts.configPath || !(0, import_fs.existsSync)(this.opts.configPath)) {
      this.config = { experiments: [] };
      return;
    }
    try {
      const content = await (0, import_promises2.readFile)(this.opts.configPath, "utf-8");
      this.config = JSON.parse(content);
      if (this.opts.debug) {
        console.log(`[ExperimentManager] Loaded ${this.config.experiments.length} experiments`);
      }
    } catch (error) {
      console.error("[ExperimentManager] Failed to load experiments:", error);
      this.config = { experiments: [] };
    }
  }
  /**
   * Find matching active experiment
   */
  findActiveExperiment(agent, sessionID) {
    if (!this.config || this.config.experiments.length === 0) {
      return null;
    }
    return this.config.experiments.find((exp) => {
      if (!exp.enabled) return false;
      if (exp.targeting?.agents && !exp.targeting.agents.includes(agent)) {
        return false;
      }
      return true;
    }) || null;
  }
  /**
   * Allocate variant for session (ensures consistency)
   */
  allocateVariant(experiment, sessionID) {
    const hash = this.hashString(sessionID + experiment.id);
    const allocation = experiment.allocation;
    let cumulative = 0;
    for (const [variant, probability] of Object.entries(allocation)) {
      cumulative += probability;
      if (hash < cumulative) {
        return variant;
      }
    }
    return "control";
  }
  /**
   * Simple hash function (ensures same session always gets same variant)
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash) / 2147483647;
  }
};

// src/local/parameters.ts
var import_promises3 = require("fs/promises");
var import_fs2 = require("fs");
var ParameterManager = class {
  constructor(opts) {
    this.opts = opts;
  }
  config;
  async initialize() {
    if (!this.opts.configPath || !(0, import_fs2.existsSync)(this.opts.configPath)) {
      this.config = {
        defaults: {
          temperature: 0.7,
          topP: 0.9
        }
      };
      return;
    }
    try {
      const content = await (0, import_promises3.readFile)(this.opts.configPath, "utf-8");
      this.config = JSON.parse(content);
      if (this.opts.debug) {
        console.log("[ParameterManager] Loaded parameters config");
      }
    } catch (error) {
      console.error("[ParameterManager] Failed to load parameters:", error);
      this.config = { defaults: { temperature: 0.7, topP: 0.9 } };
    }
  }
  /**
   * Resolve parameters (priority: experiment variant > agent > model > global defaults)
   */
  resolve(opts) {
    const { agent, model, experiment, variantID } = opts;
    let params = { ...this.config?.defaults };
    if (model && this.config?.models?.[model]) {
      params = { ...params, ...this.config.models[model] };
    }
    if (this.config?.agents?.[agent]) {
      params = { ...params, ...this.config.agents[agent] };
    }
    if (experiment && variantID && experiment.variants[variantID]) {
      params = { ...params, ...experiment.variants[variantID] };
    }
    return params;
  }
};

// src/local/manager.ts
var LocalResolver = class extends PromptResolver {
  templateEngine;
  experimentManager;
  parameterManager;
  initialized = false;
  constructor(config) {
    super(config);
    if (!config.local) {
      throw new Error("Local config is required for LocalResolver");
    }
  }
  async initialize() {
    if (this.initialized) return;
    const { local } = this.config;
    this.templateEngine = new TemplateEngine({
      templatesDir: local.templatesDir,
      debug: this.config.debug
    });
    await this.templateEngine.initialize();
    if (local.experimentsPath) {
      this.experimentManager = new ExperimentManager({
        configPath: local.experimentsPath,
        debug: this.config.debug
      });
      await this.experimentManager.initialize();
    } else {
      this.experimentManager = new ExperimentManager({ configPath: "" });
      await this.experimentManager.initialize();
    }
    if (local.parametersPath) {
      this.parameterManager = new ParameterManager({
        configPath: local.parametersPath,
        debug: this.config.debug
      });
      await this.parameterManager.initialize();
    } else {
      this.parameterManager = new ParameterManager({ configPath: "" });
      await this.parameterManager.initialize();
    }
    this.initialized = true;
    if (this.config.debug) {
      console.log("[LocalResolver] Initialized successfully");
    }
  }
  async resolve(context) {
    if (!this.initialized) {
      throw new Error("LocalResolver not initialized. Call initialize() first.");
    }
    const startTime = Date.now();
    try {
      const enrichedContext = await this.enrichContext(context);
      const experiment = this.experimentManager.findActiveExperiment(
        context.agent,
        context.sessionID
      );
      const variantID = experiment ? this.experimentManager.allocateVariant(experiment, context.sessionID) : "default";
      const systemPrompt = await this.templateEngine.render(
        context.agent,
        enrichedContext
      );
      const parameters = this.parameterManager.resolve({
        agent: context.agent,
        model: context.model?.modelID,
        experiment,
        variantID
      });
      const resolved = {
        system: systemPrompt,
        parameters,
        metadata: {
          templateID: context.agent,
          variantID,
          experimentID: experiment?.id,
          resolverType: "local",
          resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      };
      if (this.config.debug) {
        const elapsed = Date.now() - startTime;
        console.log(`[LocalResolver] Resolved in ${elapsed}ms`, {
          agent: context.agent,
          variantID,
          temperature: parameters.temperature
        });
      }
      return resolved;
    } catch (error) {
      console.error("[LocalResolver] Failed to resolve prompt:", error);
      return this.getFallbackPrompt(context);
    }
  }
  /**
   * Enrich context (add runtime information)
   */
  async enrichContext(context) {
    return {
      // Basic info
      agent: context.agent,
      sessionID: context.sessionID,
      // Project info
      project_name: context.project?.name || "unknown",
      project_path: context.project?.path || "",
      // Git info
      git_branch: context.git?.branch || "unknown",
      git_dirty: context.git?.isDirty || false,
      git_commit: context.git?.commitHash?.substring(0, 7) || "",
      // Model info
      model_provider: context.model?.providerID || "unknown",
      model_id: context.model?.modelID || "unknown",
      // Timestamp
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      date: (/* @__PURE__ */ new Date()).toLocaleDateString(),
      time: (/* @__PURE__ */ new Date()).toLocaleTimeString(),
      // User info (if available)
      user_id: context.user?.id,
      user_email: context.user?.email,
      // Custom environment variables
      ...context.environment
    };
  }
  /**
   * Fallback: return minimal usable prompt
   */
  getFallbackPrompt(context) {
    return {
      system: `You are an AI assistant for the ${context.project?.name || "project"}.`,
      parameters: {
        temperature: 0.7,
        topP: 0.9
      },
      metadata: {
        templateID: "fallback",
        resolverType: "local",
        resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
  }
  async healthCheck() {
    return this.initialized;
  }
};

// src/resolver.ts
var PromptResolver = class {
  constructor(config) {
    this.config = config;
  }
  /**
   * Release resources (optional)
   */
  async dispose() {
  }
  /**
   * Health check (optional)
   */
  async healthCheck() {
    return true;
  }
};
var ResolverFactory = class {
  static create(config) {
    switch (config.mode) {
      case "local":
        return new LocalResolver(config);
      case "remote":
        throw new Error("Remote mode not implemented yet");
      case "hybrid":
        throw new Error("Hybrid mode not implemented yet");
      default:
        throw new Error(`Unknown mode: ${config.mode}`);
    }
  }
};

// src/cache.ts
var PromptCache = class {
  constructor(config) {
    this.config = config;
    if (config.enabled) {
      this.cleanupInterval = setInterval(
        () => this.cleanup(),
        config.cleanupIntervalMs || 6e4
      );
    }
  }
  cache = /* @__PURE__ */ new Map();
  cleanupInterval;
  static generateKey(agent, sessionID, modelID) {
    return `${agent}:${sessionID}:${modelID || "default"}`;
  }
  get(key) {
    if (!this.config.enabled) return null;
    const entry = this.cache.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl * 1e3) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }
  set(key, value, ttl) {
    if (!this.config.enabled) return;
    if (this.config.maxSize && this.cache.size >= this.config.maxSize) {
      const oldestKey = this.findOldestKey();
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl: ttl || this.config.ttl || 300
    });
  }
  clearSession(sessionID) {
    for (const key of this.cache.keys()) {
      if (key.includes(sessionID)) {
        this.cache.delete(key);
      }
    }
  }
  clear() {
    this.cache.clear();
  }
  cleanup() {
    const now = Date.now();
    let deletedCount = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl * 1e3) {
        this.cache.delete(key);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      console.log(`[PromptCache] Cleaned up ${deletedCount} expired entries`);
    }
  }
  findOldestKey() {
    let oldestKey = null;
    let oldestTime = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
  dispose() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cache.clear();
  }
};

// src/index.ts
var TmuxCoderPrompts = class {
  constructor(config) {
    this.config = config;
    this.resolver = ResolverFactory.create(config);
    this.cache = new PromptCache(config.cache || { enabled: false });
  }
  resolver;
  cache;
  initialized = false;
  async initialize() {
    if (this.initialized) return;
    await this.resolver.initialize();
    this.initialized = true;
    if (this.config.debug) {
      console.log("[TmuxCoderPrompts] SDK initialized", {
        mode: this.config.mode,
        cacheEnabled: this.config.cache?.enabled
      });
    }
  }
  async resolve(context) {
    if (!this.initialized) {
      throw new Error("SDK not initialized. Call initialize() first.");
    }
    const cacheKey = PromptCache.generateKey(
      context.agent,
      context.sessionID,
      context.model?.modelID
    );
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (this.config.debug) {
        console.log("[TmuxCoderPrompts] Cache hit:", cacheKey);
      }
      return cached;
    }
    const resolved = await this.resolver.resolve(context);
    this.cache.set(cacheKey, resolved);
    return resolved;
  }
  clearSessionCache(sessionID) {
    this.cache.clearSession(sessionID);
  }
  async healthCheck() {
    return this.resolver.healthCheck();
  }
  async dispose() {
    await this.resolver.dispose();
    this.cache.dispose();
    this.initialized = false;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LocalResolver,
  PromptCache,
  PromptResolver,
  ResolverFactory,
  TmuxCoderPrompts
});
