/**
 * Progressive-disclosure MCP access for DeepSeek Harness.
 *
 * Remote MCP schemas stay in a private catalog. The model-facing registry is
 * constant: `mcp_search` reveals only relevant schemas and `mcp_call` invokes
 * one exact, policy-allowed capability.
 * @module dsh-mcp-lens
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolOutputDefinition } from '@deepseek-ai/dsh-tools'
import {
  ToolCatalog,
  catalogToolFromRemote,
  filterCatalog,
  searchCatalog,
  serverFingerprint,
  writeCatalogCache,
  type CatalogSearchResult,
  type CatalogSnapshot,
  type CatalogTool,
  type ConfiguredServer,
} from './catalog.js'
import { ConnectionPool, type RemoteCallResult, type ServerConfig } from './pool.js'
import { compileToolPolicy, type ToolPolicy } from './policy.js'

export * from './catalog.js'
export * from './pool.js'
export * from './policy.js'

export const name = 'mcp-lens'
export const inject = ['tools']

// Harness moved JsonValue between packages. Derive it from the public output
// contract so old and new hosts share the same type without a transitive import.
type JsonValue = Parameters<ToolOutputDefinition['render']>[1]

const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULTS = Object.freeze({
  catalogTtlMs: 86_400_000,
  idleDisconnectMs: 300_000,
  connectTimeoutMs: 30_000,
  callTimeoutMs: 60_000,
  discoveryTimeoutMs: 30_000,
  maxDiscoveryPages: 1_000,
  maxToolsPerServer: 10_000,
  maxBytesPerTool: 1_048_576,
  maxTotalCatalogBytes: 67_108_864,
  maxHttpResponseBytes: 16_777_216,
  maxCursorBytes: 4_096,
  searchLimitDefault: 5,
  searchLimitMax: 10,
  allowTools: [] as string[],
  denyTools: [] as string[],
})

export interface Config {
  /** Trusted MCP endpoints. Nothing is contacted during plugin activation. */
  servers: ServerConfig[]
  /** Derived catalog cache. Projected server metadata is stored with mode 0600; configured connection secrets are never stored. */
  cachePath: string
  /** Refresh a last-good catalog after this many milliseconds. Zero always refreshes. */
  catalogTtlMs: number
  /** Retire an unused MCP connection after this many milliseconds. */
  idleDisconnectMs: number
  /** Default initialize handshake timeout. A server may override it. */
  connectTimeoutMs: number
  /** Default tools/list and tools/call timeout. A server may override it. */
  callTimeoutMs: number
  /** Overall wall-clock deadline for one complete paginated tools/list discovery. */
  discoveryTimeoutMs: number
  /** Maximum tools/list pages accepted in one discovery. */
  maxDiscoveryPages: number
  /** Maximum number of tools accepted from one server. */
  maxToolsPerServer: number
  /** Maximum UTF-8 JSON bytes accepted for one raw MCP tool definition. */
  maxBytesPerTool: number
  /** Maximum UTF-8 JSON bytes across the latest accepted server catalogs. */
  maxTotalCatalogBytes: number
  /** Maximum bytes accepted from one Streamable HTTP response body. */
  maxHttpResponseBytes: number
  /** Maximum UTF-8 bytes accepted for one tools/list pagination cursor. */
  maxCursorBytes: number
  /** Default number of relevant schemas returned by mcp_search. */
  searchLimitDefault: number
  /** Hard cap on schemas returned by one mcp_search. */
  searchLimitMax: number
  /** Allowed `server/tool` globs. The glob language has only `*` and literals. */
  allowTools: string[]
  /** Denied `server/tool` globs. Deny takes precedence. */
  denyTools: string[]
}

const TimeoutFields = {
  connectTimeoutMs: z.number(),
  callTimeoutMs: z.number(),
  idleTimeoutMs: z.number(),
}

const StdioServer = z.object({
  name: z.string().required(),
  transport: z.const('stdio').required(),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  cwd: z.string(),
  cacheNamespace: z.string(),
  ...TimeoutFields,
})

const HttpServer = z.object({
  name: z.string().required(),
  transport: z.const('streamable-http').required(),
  url: z.string().required(),
  headers: z.dict(z.string()).default({}),
  cacheNamespace: z.string(),
  ...TimeoutFields,
})

export const Config: z<Config> = z.object({
  servers: z.array(z.union([StdioServer, HttpServer])).default([]),
  cachePath: z.string().required(),
  catalogTtlMs: z.number().default(DEFAULTS.catalogTtlMs),
  idleDisconnectMs: z.number().default(DEFAULTS.idleDisconnectMs),
  connectTimeoutMs: z.number().default(DEFAULTS.connectTimeoutMs),
  callTimeoutMs: z.number().default(DEFAULTS.callTimeoutMs),
  discoveryTimeoutMs: z.number().default(DEFAULTS.discoveryTimeoutMs),
  maxDiscoveryPages: z.number().default(DEFAULTS.maxDiscoveryPages),
  maxToolsPerServer: z.number().default(DEFAULTS.maxToolsPerServer),
  maxBytesPerTool: z.number().default(DEFAULTS.maxBytesPerTool),
  maxTotalCatalogBytes: z.number().default(DEFAULTS.maxTotalCatalogBytes),
  maxHttpResponseBytes: z.number().default(DEFAULTS.maxHttpResponseBytes),
  maxCursorBytes: z.number().default(DEFAULTS.maxCursorBytes),
  searchLimitDefault: z.number().default(DEFAULTS.searchLimitDefault),
  searchLimitMax: z.number().default(DEFAULTS.searchLimitMax),
  allowTools: z.array(z.string()).default(DEFAULTS.allowTools),
  denyTools: z.array(z.string()).default(DEFAULTS.denyTools),
}) as unknown as z<Config>

interface ResolvedState {
  readonly config: Config
  readonly servers: readonly ServerConfig[]
  readonly fingerprints: ReadonlyMap<string, string>
  readonly policy: ToolPolicy
  readonly redact: (error: unknown) => string
}

interface UnavailableServer {
  readonly server: string
  readonly reason: string
}

interface RefreshAttempt {
  readonly controller: AbortController
  promise: Promise<UnavailableServer | undefined>
  waiters: number
  settled: boolean
}

/** Load the catalog, create the lazy pool, and register exactly two tools. */
export async function apply(ctx: Context, rawConfig: Config): Promise<void> {
  const config = resolveConfig(rawConfig)
  const servers = resolveServers(config)
  const maxConnectTimeoutMs = maximumServerTimeout(servers, 'connectTimeoutMs', config.connectTimeoutMs)
  const maxCallTimeoutMs = maximumServerTimeout(servers, 'callTimeoutMs', config.callTimeoutMs)

  // Construct first so transport/name/timeout validation fails before any
  // lifecycle effect or tool registration is committed.
  const fingerprints = new Map<string, string>()
  const persistentServerNames = new Set<string>()
  const volatileCacheNamespace = `volatile:${randomUUID()}`
  const catalog = new ToolCatalog([], {
    maxSnapshotBytes: config.maxTotalCatalogBytes,
    maxToolsPerServer: config.maxToolsPerServer,
    maxBytesPerTool: config.maxBytesPerTool,
  })
  const invalidationEpochs = new Map<string, number>()
  const refreshes = new Map<string, RefreshAttempt>()
  let persistence: Promise<void> = Promise.resolve()
  const pool = new ConnectionPool(servers, {
    discoveryTimeoutMs: config.discoveryTimeoutMs,
    maxDiscoveryPages: config.maxDiscoveryPages,
    maxToolsPerServer: config.maxToolsPerServer,
    maxBytesPerTool: config.maxBytesPerTool,
    maxTotalCatalogBytes: config.maxTotalCatalogBytes,
    maxHttpResponseBytes: config.maxHttpResponseBytes,
    maxCursorBytes: config.maxCursorBytes,
    onCatalogInvalidated(server) {
      invalidationEpochs.set(server, (invalidationEpochs.get(server) ?? 0) + 1)
      const fingerprint = fingerprints.get(server)
      if (fingerprint !== undefined && catalog.invalidate(server, fingerprint)) void saveCatalog()
    },
  })
  for (const server of servers) {
    const credentialScoped = hasCredentialScopedConfiguration(server)
    const cacheNamespace = server.cacheNamespace
      ?? (credentialScoped ? volatileCacheNamespace : undefined)
    fingerprints.set(server.name, serverFingerprint({
      ...server,
      ...(cacheNamespace === undefined ? {} : { cacheNamespace }),
    }))
    if (!credentialScoped || server.cacheNamespace !== undefined) persistentServerNames.add(server.name)
  }
  const configured: ConfiguredServer[] = [...fingerprints].map(([serverName, fingerprint]) => ({
    name: serverName,
    fingerprint,
  }))
  catalog.configure(configured)

  const state: ResolvedState = {
    config,
    servers,
    fingerprints,
    policy: compileToolPolicy(config.allowTools, config.denyTools),
    redact: createRedactor(servers),
  }

  function saveCatalog(): Promise<void> {
    const snapshot = catalog.snapshot()
    const persistentSnapshot: CatalogSnapshot = {
      ...snapshot,
      servers: snapshot.servers.filter(server => persistentServerNames.has(server.name)),
    }
    persistence = persistence.then(async () => writeCatalogCache(
      config.cachePath,
      persistentSnapshot,
      {
        maxSnapshotBytes: config.maxTotalCatalogBytes,
        maxToolsPerServer: config.maxToolsPerServer,
        maxBytesPerTool: config.maxBytesPerTool,
      },
    )).catch((error: unknown) => {
      ctx.logger.warn(`mcp-lens: catalog cache write failed: ${state.redact(error)}`)
    })
    return persistence
  }

  const loaded = await catalog.load(config.cachePath)
  if (loaded.status === 'corrupt'
    || loaded.status === 'incompatible'
    || loaded.status === 'oversized'
    || loaded.status === 'limit-exceeded') {
    ctx.logger.warn(`mcp-lens: ignored ${loaded.status} catalog cache; discovery will rebuild it`)
  }
  // Canonically re-project and prune immediately. This also removes a previous
  // credential scope before any new server is contacted.
  if (loaded.status !== 'missing') await saveCatalog()

  ctx.effect(() => async () => {
    for (const attempt of refreshes.values()) {
      attempt.controller.abort(new DOMException('mcp-lens plugin disposed', 'AbortError'))
    }
    await pool.dispose()
    await Promise.allSettled([...refreshes.values()].map(attempt => attempt.promise))
    await persistence
  }, 'mcp-lens.pool')

  // A monotonic owner guard keeps the policy binding even if another plugin
  // adds permissive pre-execute listeners around the shared mcp_call surface.
  ctx.tools.guard((execution) => {
    if (execution.name !== 'mcp_call' || !isRecord(execution.arguments)) return undefined
    const server = execution.arguments.server
    const tool = execution.arguments.tool
    if (typeof server !== 'string' || typeof tool !== 'string') return undefined
    return state.policy.allows(server, tool) ? undefined : state.policy.denialReason(server, tool)
  })

  async function runRefresh(server: string, signal: AbortSignal): Promise<UnavailableServer | undefined> {
    const fingerprint = state.fingerprints.get(server)
    if (fingerprint === undefined) return { server, reason: unknownServerMessage(server, pool.serverNames()) }
    for (let retry = 0; retry < 2; retry += 1) {
      const invalidationEpoch = invalidationEpochs.get(server) ?? 0
      try {
        const tools = await pool.listTools(server, signal)
        if ((invalidationEpochs.get(server) ?? 0) !== invalidationEpoch) continue
        const accepted = catalog.replaceServerTools(
          server,
          fingerprint,
          tools.map(catalogToolFromRemote),
          Date.now(),
        )
        if (!accepted) return { server, reason: 'server configuration changed while discovery was running' }
        await saveCatalog()
        return undefined
      } catch (error) {
        if (signal.aborted) throw signal.reason
        return { server, reason: state.redact(error) }
      }
    }
    return { server, reason: 'tool catalog changed repeatedly during discovery; retry the search' }
  }

  async function refresh(server: string, signal: AbortSignal): Promise<UnavailableServer | undefined> {
    const fingerprint = state.fingerprints.get(server)
    if (fingerprint === undefined) return { server, reason: unknownServerMessage(server, pool.serverNames()) }
    if (!catalog.needsRefresh(server, fingerprint, config.catalogTtlMs)) return undefined

    let attempt = refreshes.get(server)
    if (attempt === undefined) {
      const controller = new AbortController()
      attempt = {
        controller,
        promise: Promise.resolve(undefined),
        waiters: 0,
        settled: false,
      }
      attempt.promise = runRefresh(server, controller.signal)
      refreshes.set(server, attempt)
      void attempt.promise.then(
        () => finishRefresh(server, attempt!),
        () => finishRefresh(server, attempt!),
      )
    }

    attempt.waiters += 1
    try {
      return await waitWithSignal(attempt.promise, signal)
    } finally {
      attempt.waiters -= 1
      if (!attempt.settled && attempt.waiters === 0) {
        attempt.controller.abort(new DOMException('MCP discovery has no remaining waiters', 'AbortError'))
      }
    }
  }

  function finishRefresh(server: string, attempt: RefreshAttempt): void {
    attempt.settled = true
    if (refreshes.get(server) === attempt) refreshes.delete(server)
  }

  ctx.tools.register(defineTool({
    name: 'mcp_search',
    description: 'Search configured MCP capabilities and reveal only the most relevant exact input schemas. Use this before mcp_call unless you already know the server, tool, and arguments.',
    parameters: {
      query: { type: 'string', description: 'Capability intent, keywords, or argument names. Empty lists the first allowed tools.' },
      server: { type: 'string', description: 'Optional configured server name to search.' },
      limit: { type: 'integer', description: `Maximum schemas to reveal (default ${config.searchLimitDefault}, cap ${config.searchLimitMax}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                server: { type: 'string', required: true },
                name: { type: 'string', required: true },
                title: { type: 'string' },
                description: { type: 'string', required: true },
                inputSchema: { type: 'json', required: true },
                annotations: { type: 'json' },
                score: { type: 'number', required: true },
                matchedTerms: { type: 'array', required: true, items: { type: 'string' } },
                fresh: { type: 'boolean', required: true },
              },
            },
          },
          unavailable: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                server: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResults(value.results, value.unavailable) }],
      presentationMeta: (_args, value) => ({ resultCount: value.results.length, unavailableCount: value.unavailable.length }),
    },
    timeoutMs: timeoutBudget(maxConnectTimeoutMs, config.discoveryTimeoutMs, 5_000),
    presentCall: args => ({
      card: 'generic',
      title: args.query === undefined || args.query.length === 0 ? 'Search MCP tools' : `Search MCP: ${args.query}`,
      kind: 'search',
    }),
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      const requestedLimit = args.limit ?? config.searchLimitDefault
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
        throw new Error(`mcp_search: limit must be a positive integer (got ${requestedLimit})`)
      }
      const scope = args.server === undefined ? pool.serverNames() : [args.server]
      if (args.server !== undefined && !state.fingerprints.has(args.server)) {
        throw new Error(unknownServerMessage(args.server, pool.serverNames()))
      }
      const unavailable = (await Promise.all(scope.map(server => refresh(server, execution.signal))))
        .filter((entry): entry is UnavailableServer => entry !== undefined)
      const limit = Math.min(requestedLimit, config.searchLimitMax)
      const visibleCatalog = filterCatalog(catalog.snapshot(), state.policy)
      const hits = searchCatalog(visibleCatalog, args.query ?? '', {
        ...(args.server === undefined ? {} : { server: args.server }),
        limit,
      })
      return {
        results: hits.map(hit => searchResult(hit, catalog, config.catalogTtlMs)),
        unavailable,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mcp_call',
    description: 'Call one exact MCP capability. Use the server, tool name, and inputSchema returned by mcp_search. Calls outside allowTools/denyTools policy are denied.',
    parameters: {
      server: { type: 'string', required: true, description: 'Configured MCP server name from mcp_search.' },
      tool: { type: 'string', required: true, description: 'Exact remote MCP tool name from mcp_search.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Arguments matching the selected inputSchema.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          tool: { type: 'string', required: true },
          content: { type: 'array', required: true, items: { type: 'json' } },
          structuredContent: { type: 'json' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderMcpResult(value.content, value.structuredContent),
      }],
      presentationMeta: (_args, value) => ({ server: value.server, tool: value.tool }),
    },
    // A peer may close after discovery, so budget a second cold handshake
    // before tools/call rather than letting the outer policy preempt valid work.
    timeoutMs: timeoutBudget(
      maxConnectTimeoutMs,
      config.discoveryTimeoutMs,
      maxConnectTimeoutMs,
      maxCallTimeoutMs,
      5_000,
    ),
    presentCall: args => ({ card: 'generic', title: `${args.server}/${args.tool}`, kind: 'execute', rawInput: args }),
    async execute(args, execution) {
      if (!state.fingerprints.has(args.server)) {
        throw new Error(unknownServerMessage(args.server, pool.serverNames()))
      }
      if (!state.policy.allows(args.server, args.tool)) throw new Error(state.policy.denialReason(args.server, args.tool))
      const unavailable = await refresh(args.server, execution.signal)
      const remoteTool = catalog.get(args.server, args.tool)
      if (remoteTool === undefined) {
        const suffix = unavailable === undefined ? '' : `; discovery failed: ${unavailable.reason}`
        throw new Error(`mcp_call: unknown tool ${JSON.stringify(`${args.server}/${args.tool}`)}${suffix}; run mcp_search first`)
      }
      if (requiresTaskExecution(remoteTool)) {
        throw new Error(`mcp_call: ${JSON.stringify(`${args.server}/${args.tool}`)} requires MCP task execution, which this gateway does not support`)
      }

      let result: RemoteCallResult
      try {
        result = await pool.callTool(args.server, args.tool, args.arguments ?? {}, execution.signal)
      } catch (error) {
        if (execution.signal.aborted) throw execution.signal.reason
        throw new Error(`mcp_call: ${JSON.stringify(`${args.server}/${args.tool}`)} failed: ${state.redact(error)}`, { cause: error })
      }
      if (result.isError === true) {
        throw new Error(renderMcpResult(result.content as JsonValue[], result.structuredContent as JsonValue | undefined))
      }
      return {
        server: args.server,
        tool: args.tool,
        content: result.content as JsonValue[],
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent as JsonValue }),
      }
    },
  }))
}

function resolveConfig(raw: Config): Config {
  const candidate = raw as Partial<Config>
  const config: Config = {
    servers: [...(candidate.servers ?? [])],
    cachePath: candidate.cachePath ?? '',
    catalogTtlMs: candidate.catalogTtlMs ?? DEFAULTS.catalogTtlMs,
    idleDisconnectMs: candidate.idleDisconnectMs ?? DEFAULTS.idleDisconnectMs,
    connectTimeoutMs: candidate.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
    callTimeoutMs: candidate.callTimeoutMs ?? DEFAULTS.callTimeoutMs,
    discoveryTimeoutMs: candidate.discoveryTimeoutMs ?? DEFAULTS.discoveryTimeoutMs,
    maxDiscoveryPages: candidate.maxDiscoveryPages ?? DEFAULTS.maxDiscoveryPages,
    maxToolsPerServer: candidate.maxToolsPerServer ?? DEFAULTS.maxToolsPerServer,
    maxBytesPerTool: candidate.maxBytesPerTool ?? DEFAULTS.maxBytesPerTool,
    maxTotalCatalogBytes: candidate.maxTotalCatalogBytes ?? DEFAULTS.maxTotalCatalogBytes,
    maxHttpResponseBytes: candidate.maxHttpResponseBytes ?? DEFAULTS.maxHttpResponseBytes,
    maxCursorBytes: candidate.maxCursorBytes ?? DEFAULTS.maxCursorBytes,
    searchLimitDefault: candidate.searchLimitDefault ?? DEFAULTS.searchLimitDefault,
    searchLimitMax: candidate.searchLimitMax ?? DEFAULTS.searchLimitMax,
    allowTools: [...(candidate.allowTools ?? DEFAULTS.allowTools)],
    denyTools: [...(candidate.denyTools ?? DEFAULTS.denyTools)],
  }
  if (config.cachePath.trim().length === 0) throw new Error('mcp-lens: cachePath must not be empty')
  validateInteger(config.catalogTtlMs, 'catalogTtlMs', 0)
  validateInteger(config.idleDisconnectMs, 'idleDisconnectMs', 0)
  validateInteger(config.connectTimeoutMs, 'connectTimeoutMs', 1)
  validateInteger(config.callTimeoutMs, 'callTimeoutMs', 1)
  validateInteger(config.discoveryTimeoutMs, 'discoveryTimeoutMs', 1)
  validateInteger(config.maxDiscoveryPages, 'maxDiscoveryPages', 1)
  validateInteger(config.maxToolsPerServer, 'maxToolsPerServer', 1)
  validateInteger(config.maxBytesPerTool, 'maxBytesPerTool', 1)
  validateInteger(config.maxTotalCatalogBytes, 'maxTotalCatalogBytes', 1)
  validateInteger(config.maxHttpResponseBytes, 'maxHttpResponseBytes', 1)
  validateInteger(config.maxCursorBytes, 'maxCursorBytes', 1)
  validateInteger(config.searchLimitDefault, 'searchLimitDefault', 1, 100)
  validateInteger(config.searchLimitMax, 'searchLimitMax', 1, 100)
  if (config.searchLimitDefault > config.searchLimitMax) {
    throw new Error('mcp-lens: searchLimitDefault must not exceed searchLimitMax')
  }
  if (config.maxBytesPerTool > config.maxTotalCatalogBytes) {
    throw new Error('mcp-lens: maxBytesPerTool must not exceed maxTotalCatalogBytes')
  }
  return config
}

function resolveServers(config: Config): readonly ServerConfig[] {
  return config.servers.map(server => {
    if (server.cacheNamespace !== undefined
      && (server.cacheNamespace.trim().length === 0 || server.cacheNamespace.length > 128)) {
      throw new Error('mcp-lens: cacheNamespace must be 1-128 non-whitespace characters')
    }
    return {
      ...server,
      connectTimeoutMs: server.connectTimeoutMs ?? config.connectTimeoutMs,
      callTimeoutMs: server.callTimeoutMs ?? config.callTimeoutMs,
      idleTimeoutMs: server.idleTimeoutMs ?? config.idleDisconnectMs,
    }
  })
}

function validateInteger(value: number, field: string, minimum: number, maximum = MAX_TIMER_DELAY_MS): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`mcp-lens: ${field} must be an integer from ${minimum} to ${maximum}`)
  }
}

function timeoutBudget(...parts: readonly number[]): number {
  let total = 0
  for (const part of parts) total = Math.min(MAX_TIMER_DELAY_MS, total + part)
  return total
}

function maximumServerTimeout(
  servers: readonly ServerConfig[],
  field: 'connectTimeoutMs' | 'callTimeoutMs',
  fallback: number,
): number {
  return servers.reduce((maximum, server) => Math.max(maximum, server[field] ?? fallback), fallback)
}

function hasCredentialScopedConfiguration(server: ServerConfig): boolean {
  if (server.transport === 'stdio') {
    if (Object.keys(server.env ?? {}).length > 0) return true
    return (server.args ?? []).some((argument) => {
      const equals = argument.indexOf('=')
      const flag = equals < 0 ? argument : argument.slice(0, equals)
      return /^(?:--?|\/).*(?:token|secret|pass|key|auth|cookie|credential)/i.test(flag)
    })
  }
  if (Object.keys(server.headers ?? {}).length > 0) return true
  const url = new URL(server.url)
  return url.username.length > 0 || url.password.length > 0 || [...url.searchParams].length > 0
}

function searchResult(hit: CatalogSearchResult, catalog: ToolCatalog, ttlMs: number) {
  const tool = hit.tool
  return {
    server: hit.server,
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description ?? '',
    inputSchema: tool.inputSchema as JsonValue,
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations as JsonValue }),
    score: hit.score,
    matchedTerms: [...hit.matchedTerms],
    fresh: !catalog.needsRefresh(hit.server, hit.fingerprint, ttlMs),
  }
}

function requiresTaskExecution(tool: CatalogTool): boolean {
  return isRecord(tool.execution) && tool.execution.taskSupport === 'required'
}

function renderSearchResults(
  results: readonly { server: string, name: string, title?: string, description: string, inputSchema: JsonValue, annotations?: JsonValue, fresh: boolean }[],
  unavailable: readonly UnavailableServer[],
): string {
  const rendered = results.map((result) => {
    const heading = `${result.server}/${result.name}${result.title === undefined ? '' : ` — ${result.title}`}`
    const description = result.description.length === 0 ? '(no description)' : result.description
    const annotations = result.annotations === undefined ? '' : `\n  annotations: ${JSON.stringify(result.annotations)}`
    const freshness = result.fresh ? '' : '\n  catalog: stale last-good schema'
    return `${heading}\n  ${description}\n  inputSchema: ${JSON.stringify(result.inputSchema)}${annotations}${freshness}`
  })
  const failures = unavailable.map(entry => `${entry.server}: ${entry.reason}`)
  const body = rendered.length === 0 ? 'No allowed matching MCP tools.' : rendered.join('\n\n')
  return failures.length === 0 ? body : `${body}\n\nUnavailable servers:\n${failures.join('\n')}`
}

function renderMcpResult(content: readonly JsonValue[], structuredContent?: JsonValue): string {
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) {
      parts.push('[unsupported MCP content]')
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'resource' || block.type === 'resource_link') {
      parts.push('[resource: content discarded]')
      continue
    }
    const type = typeof block.type === 'string' ? block.type : 'unknown'
    const mime = typeof block.mimeType === 'string' ? ` ${block.mimeType}` : ''
    parts.push(`[${type}${mime} content]`)
  }
  if (parts.length > 0) return parts.join('\n')
  if (structuredContent !== undefined) return JSON.stringify(structuredContent)
  return '(MCP tool returned no content)'
}

function unknownServerMessage(server: string, configured: readonly string[]): string {
  return `mcp-lens: unknown server ${JSON.stringify(server)}; configured: ${configured.join(', ') || '(none)'}`
}

function createRedactor(servers: readonly ServerConfig[]): (error: unknown) => string {
  const secrets = new Set<string>()
  for (const server of servers) {
    if (server.transport === 'stdio') {
      for (const value of Object.values(server.env ?? {})) if (value.length > 0) secrets.add(value)
      const args = server.args ?? []
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index] ?? ''
        const equals = argument.indexOf('=')
        const flag = equals < 0 ? argument : argument.slice(0, equals)
        if (!/(?:token|secret|pass|key|auth|cookie|credential)/i.test(flag)) continue
        const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1)
        if (value !== undefined && value.length > 0) secrets.add(value)
      }
      continue
    }
    for (const value of Object.values(server.headers ?? {})) if (value.length > 0) secrets.add(value)
    const url = new URL(server.url)
    secrets.add(server.url)
    if (url.username.length > 0) secrets.add(url.username)
    if (url.password.length > 0) secrets.add(url.password)
    for (const value of url.searchParams.values()) if (value.length > 0) secrets.add(value)
  }
  const ordered = [...secrets].sort((left, right) => right.length - left.length)
  return (error: unknown): string => {
    let text: string
    try {
      text = error instanceof Error ? error.message : String(error)
    } catch {
      text = '<unprintable error>'
    }
    for (const secret of ordered) text = text.split(secret).join('[REDACTED]')
    return text
  }
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
