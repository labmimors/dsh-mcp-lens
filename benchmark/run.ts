import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyStockMcpClient, type Config as StockMcpConfig } from '@deepseek-ai/dsh-mcp-client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as applyLens, Config as resolveLensConfig } from '../src/index.js'

const COUNTS = [12, 100, 1_000] as const
const WARM_CALL_REPETITIONS = 7
const candidateRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureServerPath = fileURLToPath(new URL('../tests/fixture-server.ts', import.meta.url))
const require = createRequire(import.meta.url)
const tsxCliPath = require.resolve('tsx/cli')
const neverAbort = new AbortController().signal
const CANDIDATE_DIGEST_FILES = [
  'benchmark/run.ts',
  'cordis.patch.yml',
  'npm-shrinkwrap.json',
  'package.json',
  'src/catalog.ts',
  'src/index.ts',
  'src/policy.ts',
  'src/pool.ts',
  'tests/fixture-server.ts',
  'tsconfig.json',
  'tsdown.config.ts',
] as const

interface SurfaceMeasurement {
  visibleSchemaCount: number
  visibleSchemaUtf8Bytes: number
}

interface StockMeasurement extends SurfaceMeasurement {
  implementation: 'stock-mcp-client'
  requestedRemoteTools: number
  activationMs: number
}

interface LatencySummary {
  samplesMs: number[]
  medianMs: number
  p95Ms: number
}

interface SearchResultRow {
  server: string
  name: string
  title?: string
  description: string
  inputSchema: unknown
  score: number
  matchedTerms: string[]
  fresh: boolean
}

interface SearchValue {
  results: SearchResultRow[]
  unavailable: Array<{ server: string; reason: string }>
}

interface LensMeasurement extends SurfaceMeasurement {
  implementation: 'dsh-mcp-lens'
  requestedRemoteTools: number
  activationMs: number
  coldSearchMs: number
  selectedSearchOutputUtf8Bytes: number
  warmCall: LatencySummary
}

interface RetrievalCase {
  id: string
  query: string
  expected: string
}

interface RetrievalCaseResult extends RetrievalCase {
  lensRank: number | null
  naiveRank: number | null
  lensTop5: string[]
  naiveTop5: string[]
}

interface RetrievalMetrics {
  recallAt1: number
  recallAt5: number
  meanReciprocalRank: number
}

interface RetrievalReport {
  corpusSize: number
  lens: RetrievalMetrics
  naiveAllTokenSubstring: RetrievalMetrics
  cases: RetrievalCaseResult[]
}

interface BenchmarkReport {
  format: 'dsh-mcp-lens/component-benchmark'
  formatVersion: 2
  generatedAt: string
  environment: {
    node: string
    platform: NodeJS.Platform
    arch: string
    packages: Record<string, string>
  }
  provenance: {
    candidate: {
      name: 'dsh-mcp-lens'
      version: string
      sourceDigest: SourceDigest
    }
    resolvedPackageVersions: Record<string, string>
  }
  methodology: {
    remoteToolCounts: readonly number[]
    warmCallRepetitions: number
    exactSchemaMeasurement: string
    latencyMeasurement: string
    retrievalBaseline: string
    claimBoundary: string
  }
  schemaSurface: Array<{
    requestedRemoteTools: number
    stock: StockMeasurement
    lens: LensMeasurement
    exactUtf8ByteReduction: number
    exactUtf8ByteReductionPercent: number
  }>
  retrieval: RetrievalReport
}

interface SourceDigestFile {
  path: string
  bytes: number
  sha256: string
}

interface SourceDigest {
  algorithm: 'sha256'
  manifestFormat: string
  digest: string
  files: SourceDigestFile[]
}

const RETRIEVAL_CORPUS: readonly RetrievalCase[] = [
  { id: 'github-issue', query: 'open a bug issue in a repository', expected: 'github_create_issue' },
  { id: 'github-prs', query: 'find open pull requests by author', expected: 'github_list_pull_requests' },
  { id: 'slack-search', query: 'look through workspace channel messages', expected: 'slack_search_messages' },
  { id: 'calendar-event', query: 'schedule a meeting with attendees and start time', expected: 'calendar_create_event' },
  { id: 'read-file', query: 'read UTF-8 text from an absolute path', expected: 'filesystem_read_file' },
  { id: 'database-query', query: 'run read only analytics SQL with row limit', expected: 'database_run_query' },
  { id: 'deploy', query: 'deploy a service revision into staging', expected: 'deploy_service' },
  { id: 'customer-email', query: 'find a CRM customer by email address', expected: 'lookup_customer_by_email' },
  { id: 'cloud-delete', query: 'permanently delete a cloud resource identifier', expected: 'remove_cloud_resource' },
  { id: 'chinese-ticket', query: '搜尋 客戶 支援 工單 關鍵字', expected: 'search_support_tickets' },
  { id: 'calendar-common-typo', query: 'calender', expected: 'calendar_create_event' },
  { id: 'customer-common-typo', query: 'custmer', expected: 'lookup_customer_by_email' },
]

let callSequence = 0

type RuntimeCallId = Parameters<Context['tools']['execute']>[0]['callId']

function nextCallId(label: string): RuntimeCallId {
  callSequence += 1
  return `mcp-lens-benchmark-${label}-${callSequence}` as RuntimeCallId
}

function utf8JsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('benchmark attempted to measure a non-JSON value')
  return Buffer.byteLength(serialized, 'utf8')
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) throw new Error('cannot summarize an empty latency sample')
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)
  return sortedValues[index] ?? sortedValues[sortedValues.length - 1]!
}

function summarizeLatency(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle]!
  return {
    samplesMs: samples.map(value => round(value)),
    medianMs: round(median),
    p95Ms: round(percentile(sorted, 0.95)),
  }
}

async function mountToolRuntime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function fixtureCommand(toolCount: number): { command: string; args: string[]; cwd: string } {
  return {
    command: process.execPath,
    args: [tsxCliPath, fixtureServerPath, String(toolCount)],
    cwd: candidateRoot,
  }
}

async function executeValue(ctx: Context, name: string, args: unknown): Promise<unknown> {
  const result = await ctx.tools.execute({
    callId: nextCallId(name),
    name,
    arguments: args,
    signal: neverAbort,
  })
  if (result.isError) {
    throw new Error(`${name} failed: ${result.error.message}`)
  }
  return result.value
}

function parseSearchValue(value: unknown): SearchValue {
  if (!isRecord(value) || !Array.isArray(value.results) || !Array.isArray(value.unavailable)) {
    throw new Error(`mcp_search returned an unexpected value: ${JSON.stringify(value)}`)
  }
  const results = value.results.map((entry): SearchResultRow => {
    if (!isRecord(entry)
      || typeof entry.server !== 'string'
      || typeof entry.name !== 'string'
      || typeof entry.description !== 'string'
      || typeof entry.score !== 'number'
      || !Array.isArray(entry.matchedTerms)
      || !entry.matchedTerms.every(term => typeof term === 'string')
      || typeof entry.fresh !== 'boolean') {
      throw new Error(`mcp_search returned an invalid result row: ${JSON.stringify(entry)}`)
    }
    return {
      server: entry.server,
      name: entry.name,
      ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
      description: entry.description,
      inputSchema: entry.inputSchema,
      score: entry.score,
      matchedTerms: entry.matchedTerms,
      fresh: entry.fresh,
    }
  })
  const unavailable = value.unavailable.map((entry) => {
    if (!isRecord(entry) || typeof entry.server !== 'string' || typeof entry.reason !== 'string') {
      throw new Error(`mcp_search returned an invalid unavailable row: ${JSON.stringify(entry)}`)
    }
    return { server: entry.server, reason: entry.reason }
  })
  return { results, unavailable }
}

async function benchmarkStock(toolCount: number): Promise<StockMeasurement> {
  const ctx = await mountToolRuntime()
  const fixture = fixtureCommand(toolCount)
  const config: StockMcpConfig = {
    transport: 'stdio',
    serverName: 'fixture',
    command: fixture.command,
    args: fixture.args,
    env: {},
    cwd: fixture.cwd,
    toolCallTimeoutMs: 30_000,
    failOnStartupError: true,
    reconnect: {
      enabled: false,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 10,
    },
  }
  try {
    const started = performance.now()
    await applyStockMcpClient(ctx, config)
    const activationMs = performance.now() - started
    const schemas = ctx.tools.schemas()
    if (schemas.length !== toolCount) {
      throw new Error(`stock mcp-client exposed ${schemas.length} schemas for ${toolCount} fixture tools`)
    }
    return {
      implementation: 'stock-mcp-client',
      requestedRemoteTools: toolCount,
      activationMs: round(activationMs),
      visibleSchemaCount: schemas.length,
      visibleSchemaUtf8Bytes: utf8JsonBytes(schemas),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function benchmarkLens(toolCount: number): Promise<{
  measurement: LensMeasurement
  retrieval?: RetrievalReport
}> {
  const ctx = await mountToolRuntime()
  const scratch = await mkdtemp(join(tmpdir(), `dsh-mcp-lens-bench-${toolCount}-`))
  const fixture = fixtureCommand(toolCount)
  const config = resolveLensConfig({
    servers: [{
      name: 'fixture',
      transport: 'stdio',
      command: fixture.command,
      args: fixture.args,
      env: {},
      cwd: fixture.cwd,
    }],
    cachePath: join(scratch, 'catalog.json'),
    catalogTtlMs: 3_600_000,
    idleDisconnectMs: 60_000,
    connectTimeoutMs: 30_000,
    callTimeoutMs: 30_000,
    discoveryTimeoutMs: 30_000,
    maxDiscoveryPages: 100,
    maxToolsPerServer: Math.max(1_000, toolCount),
    maxBytesPerTool: 1_048_576,
    maxTotalCatalogBytes: 67_108_864,
    maxHttpResponseBytes: 16_777_216,
    maxCursorBytes: 4_096,
    searchLimitDefault: 5,
    searchLimitMax: 25,
    allowTools: ['fixture/*'],
    denyTools: [],
  })

  try {
    const started = performance.now()
    await applyLens(ctx, config)
    const activationMs = performance.now() - started
    const schemas = ctx.tools.schemas()
    const lensSchemaNames = schemas.map(schema => schema.name).sort(codePointCompare)
    if (lensSchemaNames.length !== 2
      || lensSchemaNames[0] !== 'mcp_call'
      || lensSchemaNames[1] !== 'mcp_search') {
      throw new Error(`Lens did not expose its fixed two-tool surface: ${JSON.stringify(lensSchemaNames)}`)
    }

    const coldSearchStarted = performance.now()
    const coldSearchValue = await executeValue(ctx, 'mcp_search', {
      query: 'create a GitHub issue in a repository',
      server: 'fixture',
      limit: 5,
    })
    const coldSearch = parseSearchValue(coldSearchValue)
    const coldSearchMs = performance.now() - coldSearchStarted
    if (coldSearch.unavailable.length > 0) {
      throw new Error(`cold search reported unavailable servers: ${JSON.stringify(coldSearch.unavailable)}`)
    }
    if (coldSearch.results.length === 0) throw new Error('cold search returned no candidates')

    const warmSamples: number[] = []
    for (let index = 0; index < WARM_CALL_REPETITIONS; index += 1) {
      const callStarted = performance.now()
      const value = await executeValue(ctx, 'mcp_call', {
        server: 'fixture',
        tool: 'echo_structured',
        arguments: { message: `warm-${index}` },
      })
      const elapsed = performance.now() - callStarted
      if (!isRecord(value) || value.server !== 'fixture' || value.tool !== 'echo_structured') {
        throw new Error(`mcp_call returned an unexpected value: ${JSON.stringify(value)}`)
      }
      warmSamples.push(elapsed)
    }

    const retrieval = toolCount === 12 ? await benchmarkRetrieval(ctx) : undefined
    return {
      measurement: {
        implementation: 'dsh-mcp-lens',
        requestedRemoteTools: toolCount,
        activationMs: round(activationMs),
        visibleSchemaCount: schemas.length,
        visibleSchemaUtf8Bytes: utf8JsonBytes(schemas),
        coldSearchMs: round(coldSearchMs),
        selectedSearchOutputUtf8Bytes: utf8JsonBytes(coldSearchValue),
        warmCall: summarizeLatency(warmSamples),
      },
      ...(retrieval === undefined ? {} : { retrieval }),
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(scratch, { recursive: true, force: true })
  }
}

async function benchmarkRetrieval(ctx: Context): Promise<RetrievalReport> {
  const catalog = parseSearchValue(await executeValue(ctx, 'mcp_search', {
    query: '',
    server: 'fixture',
    limit: 12,
  })).results
  if (catalog.length !== 12) {
    throw new Error(`retrieval corpus expected 12 fixture tools, received ${catalog.length}`)
  }

  const cases: RetrievalCaseResult[] = []
  for (const testCase of RETRIEVAL_CORPUS) {
    const lens = parseSearchValue(await executeValue(ctx, 'mcp_search', {
      query: testCase.query,
      server: 'fixture',
      limit: 12,
    })).results.map(result => result.name)
    const naive = rankNaiveAllTokenSubstring(catalog, testCase.query)
    cases.push({
      ...testCase,
      lensRank: oneBasedRank(lens, testCase.expected),
      naiveRank: oneBasedRank(naive, testCase.expected),
      lensTop5: lens.slice(0, 5),
      naiveTop5: naive.slice(0, 5),
    })
  }

  return {
    corpusSize: cases.length,
    lens: retrievalMetrics(cases.map(result => result.lensRank)),
    naiveAllTokenSubstring: retrievalMetrics(cases.map(result => result.naiveRank)),
    cases,
  }
}

/**
 * Deliberately small comparison baseline: split the query into Unicode
 * alphanumeric tokens, award one point when a token is an exact substring of
 * the complete serialized tool metadata, then break ties by tool name. It has
 * no stemming, field weights, phrase boost, or inverse-document frequency.
 */
function rankNaiveAllTokenSubstring(catalog: readonly SearchResultRow[], query: string): string[] {
  const terms = [...new Set(normalizeNaive(query).match(/[\p{L}\p{N}]+/gu) ?? [])]
  return catalog
    .map(tool => {
      const surface = normalizeNaive(JSON.stringify({
        server: tool.server,
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
      return {
        name: tool.name,
        score: terms.reduce((total, term) => total + (surface.includes(term) ? 1 : 0), 0),
      }
    })
    .sort((left, right) => right.score - left.score || codePointCompare(left.name, right.name))
    .map(row => row.name)
}

function normalizeNaive(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLocaleLowerCase('en-US')
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function oneBasedRank(ranking: readonly string[], expected: string): number | null {
  const index = ranking.indexOf(expected)
  return index === -1 ? null : index + 1
}

function retrievalMetrics(ranks: readonly (number | null)[]): RetrievalMetrics {
  return {
    recallAt1: round(ranks.filter(rank => rank === 1).length / ranks.length, 4),
    recallAt5: round(ranks.filter(rank => rank !== null && rank <= 5).length / ranks.length, 4),
    meanReciprocalRank: round(
      ranks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / ranks.length,
      4,
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function packageVersion(packageName: string): Promise<string> {
  let directory = dirname(require.resolve(`${packageName}/package.json`))
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJsonPath = join(directory, 'package.json')
    try {
      const parsed: unknown = JSON.parse(await readFile(packageJsonPath, 'utf8'))
      if (isRecord(parsed) && parsed.name === packageName && typeof parsed.version === 'string') {
        return parsed.version
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`could not resolve installed version for ${packageName}`)
}

async function candidateVersion(): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(join(candidateRoot, 'package.json'), 'utf8'))
  if (!isRecord(parsed) || parsed.name !== 'dsh-mcp-lens' || typeof parsed.version !== 'string') {
    throw new Error('candidate package.json has no dsh-mcp-lens version')
  }
  return parsed.version
}

/**
 * Hash a transparent, path-bound manifest instead of concatenating files
 * ambiguously. Each raw file is hashed first; the aggregate is SHA-256 over
 * sorted UTF-8 lines `<relative-path>\t<raw-file-sha256>\n`.
 */
async function candidateSourceDigest(): Promise<SourceDigest> {
  const files: SourceDigestFile[] = []
  for (const relativePath of [...CANDIDATE_DIGEST_FILES].sort(codePointCompare)) {
    const bytes = await readFile(join(candidateRoot, relativePath))
    files.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const manifest = files.map(file => `${file.path}\t${file.sha256}\n`).join('')
  return {
    algorithm: 'sha256',
    manifestFormat: 'SHA-256 of sorted UTF-8 lines: <relative-path>\\t<raw-file-sha256>\\n',
    digest: createHash('sha256').update(manifest, 'utf8').digest('hex'),
    files,
  }
}

function parseOutputPath(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log('Usage: npm run bench -- [--output <report.json>]')
    process.exit(0)
  }
  if (argv.length === 2 && argv[0] === '--output' && argv[1] !== undefined && argv[1].length > 0) {
    return argv[1]
  }
  throw new Error(`unknown arguments: ${argv.join(' ')}`)
}

async function main(): Promise<void> {
  const outputPath = parseOutputPath(process.argv.slice(2))
  const version = await candidateVersion()
  const sourceDigest = await candidateSourceDigest()
  const resolvedPackageVersions = {
    '@deepseek-ai/cordis': await packageVersion('@deepseek-ai/cordis'),
    '@deepseek-ai/dsh-system-prompt': await packageVersion('@deepseek-ai/dsh-system-prompt'),
    '@deepseek-ai/dsh-tools': await packageVersion('@deepseek-ai/dsh-tools'),
    '@deepseek-ai/dsh-mcp-client': await packageVersion('@deepseek-ai/dsh-mcp-client'),
    '@deepseek-ai/schemastery': await packageVersion('@deepseek-ai/schemastery'),
    '@modelcontextprotocol/sdk': await packageVersion('@modelcontextprotocol/sdk'),
  }
  const schemaSurface: BenchmarkReport['schemaSurface'] = []
  let retrieval: RetrievalReport | undefined

  for (const toolCount of COUNTS) {
    const stock = await benchmarkStock(toolCount)
    const lensRun = await benchmarkLens(toolCount)
    retrieval ??= lensRun.retrieval
    const reduction = stock.visibleSchemaUtf8Bytes - lensRun.measurement.visibleSchemaUtf8Bytes
    schemaSurface.push({
      requestedRemoteTools: toolCount,
      stock,
      lens: lensRun.measurement,
      exactUtf8ByteReduction: reduction,
      exactUtf8ByteReductionPercent: round((reduction / stock.visibleSchemaUtf8Bytes) * 100),
    })
  }
  if (retrieval === undefined) throw new Error('retrieval benchmark did not run')

  const endingVersion = await candidateVersion()
  const endingSourceDigest = await candidateSourceDigest()
  if (endingVersion !== version || endingSourceDigest.digest !== sourceDigest.digest) {
    throw new Error(
      `candidate source changed during benchmark (version ${version} -> ${endingVersion}, digest ${sourceDigest.digest} -> ${endingSourceDigest.digest}); discard this run and retry on a stable tree`,
    )
  }

  const report: BenchmarkReport = {
    format: 'dsh-mcp-lens/component-benchmark',
    formatVersion: 2,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      packages: {
        'dsh-mcp-lens': version,
        ...resolvedPackageVersions,
      },
    },
    provenance: {
      candidate: {
        name: 'dsh-mcp-lens',
        version,
        sourceDigest,
      },
      resolvedPackageVersions,
    },
    methodology: {
      remoteToolCounts: COUNTS,
      warmCallRepetitions: WARM_CALL_REPETITIONS,
      exactSchemaMeasurement: 'Buffer.byteLength(JSON.stringify(ctx.tools.schemas()), utf8)',
      latencyMeasurement: 'performance.now wall time on this host; activation excludes Context/SystemPrompt/ToolRuntime mounting; activation and cold search are single, fixed-order, non-counterbalanced observations and are descriptive only',
      retrievalBaseline: 'naive all-query-token exact-substring count over serialized tool metadata; lexical tie-break',
      claimBoundary: 'Keyless component benchmark only. JSON bytes are not tokenizer tokens or provider billing; retrieval is not model task quality.',
    },
    schemaSurface,
    retrieval,
  }

  console.log('Exact visible tool-schema surface (UTF-8 JSON bytes; not model tokens)')
  console.table(schemaSurface.flatMap(row => [
    {
      remoteTools: row.requestedRemoteTools,
      implementation: 'stock',
      visibleSchemas: row.stock.visibleSchemaCount,
      schemaBytes: row.stock.visibleSchemaUtf8Bytes,
      byteReductionPercent: 0,
      activationMs: row.stock.activationMs,
      coldSearchMs: '-',
      selectedSearchBytes: '-',
      warmCallMedianMs: '-',
    },
    {
      remoteTools: row.requestedRemoteTools,
      implementation: 'lens',
      visibleSchemas: row.lens.visibleSchemaCount,
      schemaBytes: row.lens.visibleSchemaUtf8Bytes,
      byteReductionPercent: row.exactUtf8ByteReductionPercent,
      activationMs: row.lens.activationMs,
      coldSearchMs: row.lens.coldSearchMs,
      selectedSearchBytes: row.lens.selectedSearchOutputUtf8Bytes,
      warmCallMedianMs: row.lens.warmCall.medianMs,
    },
  ]))
  console.log('Deterministic retrieval corpus')
  console.table([
    { implementation: 'lens', ...retrieval.lens },
    { implementation: 'naive-all-token-substring', ...retrieval.naiveAllTokenSubstring },
  ])

  if (outputPath !== undefined) {
    const absoluteOutputPath = resolve(process.cwd(), outputPath)
    await mkdir(dirname(absoluteOutputPath), { recursive: true })
    await writeFile(absoluteOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`Wrote ${absoluteOutputPath}`)
  }
}

await main()
