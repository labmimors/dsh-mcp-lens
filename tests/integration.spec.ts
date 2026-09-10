import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Lens from '../src/index.js'
import type { Config } from '../src/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'tests', 'fixture-server.ts')
const INVALIDATING_FIXTURE = join(ROOT, 'tests', 'invalidating-fixture-server.ts')
const contexts: Context[] = []
const scratch: string[] = []
let callSequence = 0

async function freshCache(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-lens-'))
  scratch.push(directory)
  return join(directory, 'nested', 'catalog.json')
}

function fixtureServer(name = 'fixture'): Lens.StdioServerConfig {
  return {
    name,
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', FIXTURE, '12'],
    cwd: ROOT,
  }
}

async function harness(overrides: Partial<Config> = {}): Promise<{ ctx: Context, cachePath: string }> {
  const cachePath = overrides.cachePath ?? await freshCache()
  const config: Config = {
    servers: [fixtureServer()],
    cachePath,
    catalogTtlMs: 86_400_000,
    idleDisconnectMs: 60_000,
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
    discoveryTimeoutMs: 5_000,
    maxDiscoveryPages: 100,
    maxToolsPerServer: 2_000,
    maxBytesPerTool: 1_048_576,
    maxTotalCatalogBytes: 67_108_864,
    maxHttpResponseBytes: 16_777_216,
    maxCursorBytes: 4_096,
    searchLimitDefault: 5,
    searchLimitMax: 10,
    allowTools: ['*/*'],
    denyTools: [],
    ...overrides,
  }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Tools, {})
  contexts.push(ctx)
  await ctx.plugin(Lens, config)
  return { ctx, cachePath }
}

async function execute(
  ctx: Context,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof ctx.tools.execute>>> {
  callSequence += 1
  return await ctx.tools.execute({
    callId: `lens-test-${callSequence}` as Parameters<typeof ctx.tools.execute>[0]['callId'],
    name,
    arguments: arguments_,
    signal: new AbortController().signal,
  })
}

function valueOf<T>(result: Awaited<ReturnType<typeof execute>>): T {
  if (result.isError) throw new Error(result.error.message)
  return result.value as T
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  await Promise.all(scratch.splice(0).map(async directory => rm(directory, { recursive: true, force: true })))
})

describe('dsh-mcp-lens real Harness + MCP integration', () => {
  it('activates without contacting MCP and exposes exactly two fixed schemas', async () => {
    const { ctx, cachePath } = await harness()

    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['mcp_call', 'mcp_search'])
    expect(ctx.tools.get('github_create_issue')).toBeUndefined()
    await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('declares outer tool deadlines that cover server-specific cold connection and call budgets', async () => {
    const { ctx } = await harness({
      discoveryTimeoutMs: 30_000,
      servers: [fixtureServer('fixture'), {
        ...fixtureServer('slow'),
        connectTimeoutMs: 120_000,
        callTimeoutMs: 180_000,
      }],
    })

    expect(ctx.tools.get('mcp_search')?.timeoutMs).toBe(155_000)
    expect(ctx.tools.get('mcp_call')?.timeoutMs).toBe(455_000)
  })

  it('searches real stdio tools and progressively reveals the exact input schema', async () => {
    const { ctx, cachePath } = await harness()
    const result = await execute(ctx, 'mcp_search', { query: 'open pull requests author', limit: 3 })
    const value = valueOf<{
      results: Array<{ server: string, name: string, inputSchema: { properties?: Record<string, unknown> }, fresh: boolean }>
      unavailable: unknown[]
    }>(result)

    expect(value.results[0]?.name).toBe('github_list_pull_requests')
    expect(value.results[0]?.server).toBe('fixture')
    expect(Object.keys(value.results[0]?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['repository', 'author', 'state']),
    )
    expect(value.results[0]?.fresh).toBe(true)
    expect(value.unavailable).toEqual([])
    expect(ctx.tools.schemas()).toHaveLength(2)

    const cache = JSON.parse(await readFile(cachePath, 'utf8')) as { servers: Array<{ tools: unknown[] }> }
    expect(cache.servers[0]?.tools).toHaveLength(12)
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600)
  })

  it('calls an exact catalogued tool and preserves structured protocol output', async () => {
    const { ctx } = await harness()
    const result = await execute(ctx, 'mcp_call', {
      server: 'fixture',
      tool: 'echo_structured',
      arguments: { message: 'hello lens' },
    })
    const value = valueOf<{
      content: Array<{ type: string, text?: string }>
      structuredContent?: { echoed?: string }
      _meta?: unknown
    }>(result)

    expect(value.content).toContainEqual({ type: 'text', text: 'hello lens' })
    expect(value.structuredContent).toEqual({ echoed: 'hello lens' })
    expect(value).not.toHaveProperty('_meta')
    expect(JSON.stringify(result.content)).toContain('[resource: content discarded]')
    expect(JSON.stringify(result.content)).not.toContain('RESOURCE_PAYLOAD_MUST_NOT_BE_RENDERED')
    expect(JSON.stringify(result.content)).not.toContain('SIGNED_URL_MUST_NOT_BE_RENDERED')
  })

  it('keeps allow/deny policy identical across search and direct call', async () => {
    const { ctx } = await harness({
      allowTools: ['fixture/github_*'],
      denyTools: ['fixture/github_create_issue'],
    })
    const search = valueOf<{ results: Array<{ name: string }> }>(
      await execute(ctx, 'mcp_search', { query: 'github issue pull requests', limit: 10 }),
    )

    expect(search.results.map(tool => tool.name)).toContain('github_list_pull_requests')
    expect(search.results.map(tool => tool.name)).not.toContain('github_create_issue')

    const denied = await execute(ctx, 'mcp_call', {
      server: 'fixture', tool: 'github_create_issue', arguments: { repository: 'a/b', title: 'x' },
    })
    expect(denied.isError).toBe(true)
    if (denied.isError) expect(denied.error.message).toMatch(/blocked by allowTools\/denyTools/)
  })

  it.each(['summary', 'empty', 'duplicate', 'resource'] as const)(
    'makes structured identifiers available in Native output with %s content', async (format) => {
      const { ctx } = await harness({ servers: [{
        ...fixtureServer(),
        args: ['--import', 'tsx', join(ROOT, 'tests', 'structured-result-fixture.ts')],
      }] })
      const result = await execute(ctx, 'mcp_call', {
        server: 'fixture', tool: 'lookup_customer', arguments: { format },
      })
      const value = valueOf<{ structuredContent: { customerId: string } }>(result)
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      expect(text).toContain(value.structuredContent.customerId)
      expect(text.split(value.structuredContent.customerId)).toHaveLength(2)
      expect(text).not.toContain('PRIVATE_RESOURCE_MUST_NOT_APPEAR')
      expect(text).not.toContain('PRIVATE_META_MUST_NOT_APPEAR')
      if (format === 'summary') expect(text).toContain('Customer found.')
      if (format === 'resource') expect(text).toContain('[resource: content discarded]')
    },
  )

  it('preserves structured recovery details in Native MCP error output', async () => {
    const { ctx } = await harness({ servers: [{
      ...fixtureServer(),
      args: ['--import', 'tsx', join(ROOT, 'tests', 'structured-result-fixture.ts')],
    }] })
    const result = await execute(ctx, 'mcp_call', {
      server: 'fixture', tool: 'lookup_customer', arguments: { format: 'error' },
    })
    expect(result.isError).toBe(true)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('Customer found.')
    expect(text).toMatch(/"customerId":"[0-9a-f-]{36}"/)
    expect(text).not.toContain('PRIVATE_META_MUST_NOT_APPEAR')
  })

  it('fails closed when allowTools is omitted', async () => {
    const cachePath = await freshCache()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(Tools, {})
    await ctx.plugin(Lens, {
      servers: [fixtureServer()],
      cachePath,
    } as Config)
    contexts.push(ctx)

    const search = valueOf<{ results: Array<{ name: string }> }>(
      await execute(ctx, 'mcp_search', { query: 'delete cloud resource' }),
    )
    expect(search.results).toEqual([])

    const denied = await execute(ctx, 'mcp_call', {
      server: 'fixture', tool: 'remove_cloud_resource', arguments: { resourceId: 'x', reason: 'test' },
    })
    expect(denied.isError).toBe(true)
    if (denied.isError) expect(denied.error.message).toMatch(/blocked by allowTools\/denyTools/)
  })

  it('keeps credential-scoped catalogs memory-only unless a non-secret namespace opts in', async () => {
    const cachePath = await freshCache()
    const credentialed = {
      ...fixtureServer('private'),
      env: { FIXTURE_TOKEN: 'credential-value-must-not-reach-cache' },
    }
    const { ctx } = await harness({ cachePath, servers: [credentialed] })

    const search = valueOf<{ results: Array<{ name: string }> }>(
      await execute(ctx, 'mcp_search', { query: 'structured echo' }),
    )
    expect(search.results[0]?.name).toBe('echo_structured')
    const memoryOnlyCache = await readFile(cachePath, 'utf8')
    expect(memoryOnlyCache).not.toContain('credential-value-must-not-reach-cache')
    expect((JSON.parse(memoryOnlyCache) as { servers: unknown[] }).servers).toEqual([])

    const namespacedPath = await freshCache()
    const namespaced = await harness({
      cachePath: namespacedPath,
      servers: [{ ...credentialed, cacheNamespace: 'tenant-a-readonly' }],
    })
    await execute(namespaced.ctx, 'mcp_search', { query: 'structured echo' })
    const persisted = JSON.parse(await readFile(namespacedPath, 'utf8')) as {
      servers: Array<{ name: string, tools: Array<{ name: string }> }>
    }
    expect(persisted.servers[0]?.name).toBe('private')
    expect(persisted.servers[0]?.tools.some(tool => tool.name === 'echo_structured')).toBe(true)
  })

  it('rejects an empty credential cache namespace', async () => {
    await expect(harness({
      servers: [{ ...fixtureServer('private'), env: { TOKEN: 'x' }, cacheNamespace: '   ' }],
    })).rejects.toThrow(/cacheNamespace must be 1-128/)
  })

  it('does not let a previously accepted disk cache bypass tightened discovery caps', async () => {
    const sourcePath = await freshCache()
    const seeded = await harness({ cachePath: sourcePath })
    await execute(seeded.ctx, 'mcp_search', { query: 'github' })
    const cache = await readFile(sourcePath, 'utf8')
    const countPath = join(dirname(sourcePath), 'count-limited.json')
    const bytesPath = join(dirname(sourcePath), 'bytes-limited.json')
    await Promise.all([writeFile(countPath, cache), writeFile(bytesPath, cache)])

    const countLimited = await harness({ cachePath: countPath, maxToolsPerServer: 1 })
    const countResult = valueOf<{ results: unknown[], unavailable: Array<{ reason: string }> }>(
      await execute(countLimited.ctx, 'mcp_search', { query: '' }),
    )
    expect(countResult.results).toEqual([])
    expect(countResult.unavailable[0]?.reason).toMatch(/maxToolsPerServer/)

    const bytesLimited = await harness({ cachePath: bytesPath, maxBytesPerTool: 32 })
    const bytesResult = valueOf<{ results: unknown[], unavailable: Array<{ reason: string }> }>(
      await execute(bytesLimited.ctx, 'mcp_search', { query: '' }),
    )
    expect(bytesResult.results).toEqual([])
    expect(bytesResult.unavailable[0]?.reason).toMatch(/maxBytesPerTool/)
  })

  it('coalesces concurrent refreshes and never publishes a generation invalidated in flight', async () => {
    const server: Lens.ServerConfig = {
      name: 'changing',
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', INVALIDATING_FIXTURE],
      cwd: ROOT,
    }
    const { ctx } = await harness({ servers: [server] })

    const [first, second] = await Promise.all([
      execute(ctx, 'mcp_search', { query: 'fresh catalog generation' }),
      execute(ctx, 'mcp_search', { query: 'fresh capability' }),
    ])
    const firstValue = valueOf<{ results: Array<{ name: string }> }>(first)
    const secondValue = valueOf<{ results: Array<{ name: string }> }>(second)
    expect(firstValue.results.map(tool => tool.name)).toContain('fresh_capability')
    expect(secondValue.results.map(tool => tool.name)).toContain('fresh_capability')
    expect(firstValue.results.map(tool => tool.name)).not.toContain('stale_capability')

    const count = valueOf<{ content: Array<{ type: string, text?: string }> }>(
      await execute(ctx, 'mcp_call', { server: 'changing', tool: 'list_count', arguments: {} }),
    )
    expect(count.content).toContainEqual({ type: 'text', text: '2' })
  })

  it('isolates one broken server and retains searchable results from healthy servers', async () => {
    const broken: Lens.ServerConfig = {
      name: 'broken',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      connectTimeoutMs: 1_000,
    }
    const { ctx } = await harness({ servers: [fixtureServer(), broken] })
    const result = valueOf<{
      results: Array<{ name: string }>
      unavailable: Array<{ server: string, reason: string }>
    }>(await execute(ctx, 'mcp_search', { query: 'calendar meeting' }))

    expect(result.results[0]?.name).toBe('calendar_create_event')
    expect(result.unavailable).toHaveLength(1)
    expect(result.unavailable[0]?.server).toBe('broken')
    expect(result.unavailable[0]?.reason.length).toBeGreaterThan(0)
  })

  it('turns MCP isError into a Harness failure instead of a false success', async () => {
    const { ctx } = await harness()
    const failed = await execute(ctx, 'mcp_call', { server: 'fixture', tool: 'always_fail', arguments: {} })

    expect(failed.isError).toBe(true)
    if (failed.isError) expect(failed.error.message).toContain('controlled fixture failure')
  })

  it('fails open from a corrupt derived cache and rebuilds on search', async () => {
    const cachePath = await freshCache()
    await writeFile(cachePath, '{ invalid json', 'utf8').catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dirname(cachePath), { recursive: true })
      await writeFile(cachePath, '{ invalid json', 'utf8')
    })
    const { ctx } = await harness({ cachePath })

    const result = valueOf<{ results: Array<{ name: string }> }>(
      await execute(ctx, 'mcp_search', { query: 'customer email' }),
    )
    expect(result.results[0]?.name).toBe('lookup_customer_by_email')
    await expect(readFile(cachePath, 'utf8')).resolves.toContain('dsh-mcp-lens/catalog')
  })
})
