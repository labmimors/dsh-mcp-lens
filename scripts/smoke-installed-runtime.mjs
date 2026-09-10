import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Lens from 'dsh-mcp-lens'

// This file is copied into the isolated consumer so these imports exercise its
// installed Lens tarball and Harness. Only the local MCP fixture uses the repo.
const fixtureRoot = process.argv[2]
assert.ok(fixtureRoot && isAbsolute(fixtureRoot), 'Expected an absolute fixture repository path')
const fixtureRequire = createRequire(join(fixtureRoot, 'package.json'))
const fixtureLoader = pathToFileURL(fixtureRequire.resolve('tsx')).href
const ctx = new Context()
const scratch = await mkdtemp(join(tmpdir(), 'dsh-mcp-lens-installed-runtime-'))
let callSequence = 0

async function execute(name, arguments_) {
  return await ctx.tools.execute({
    callId: `installed-lens-${++callSequence}`,
    name,
    arguments: arguments_,
    signal: new AbortController().signal,
  })
}

function valueOf(result) {
  assert.equal(result.isError, false, result.error?.message)
  return result.value
}

function checkToolSurface() {
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), ['mcp_call', 'mcp_search'])
}

try {
  assert.equal(Lens.name, 'mcp-lens')
  assert.equal(typeof Lens.apply, 'function')
  assert.deepEqual(Lens.inject, ['tools'])
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Tools, {})
  await ctx.plugin(Lens, {
    servers: [{
      name: 'fixture',
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', fixtureLoader, join(fixtureRoot, 'tests', 'fixture-server.ts'), '12'],
      cwd: fixtureRoot,
    }],
    cachePath: join(scratch, 'catalog.json'),
    connectTimeoutMs: 10_000,
    callTimeoutMs: 10_000,
    discoveryTimeoutMs: 10_000,
    idleDisconnectMs: 60_000,
    allowTools: ['fixture/*'],
    denyTools: ['fixture/github_create_issue'],
  })
  checkToolSurface()

  const search = valueOf(await execute('mcp_search', { query: 'structured echo', limit: 3 }))
  assert.deepEqual(search.unavailable, [])
  const echo = search.results.find(tool => tool.name === 'echo_structured')
  assert.equal(echo?.server, 'fixture')
  assert.equal(echo?.inputSchema.properties?.message?.type, 'string')
  assert.deepEqual(echo?.inputSchema.required, ['message'])

  const message = 'packed Lens on exact Harness'
  const called = valueOf(await execute('mcp_call', {
    server: echo.server,
    tool: echo.name,
    arguments: { message },
  }))
  assert.deepEqual(called.structuredContent, { echoed: message })
  assert.ok(called.content.some(item => item.type === 'text' && item.text === message))

  const filtered = valueOf(await execute('mcp_search', { query: 'github create issue', limit: 10 }))
  assert.ok(!filtered.results.some(tool => tool.name === 'github_create_issue'))
  const denied = await execute('mcp_call', {
    server: 'fixture',
    tool: 'github_create_issue',
    arguments: { repository: 'fixture/repo', title: 'must be denied' },
  })
  assert.equal(denied.isError, true)
  assert.match(denied.error.message, /blocked by allowTools\/denyTools/)
  checkToolSurface()
  console.log('DSH_INSTALLED_RUNTIME_OK search=pass structured_call=pass deny=pass schemas=2')
} finally {
  try {
    await ctx.fiber.dispose()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
