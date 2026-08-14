import { execFile } from 'node:child_process'
import { access, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const actionPath = join(repositoryRoot, 'action', 'index.js')

interface Measurement {
  toolCount: number
  bytes: number
  reductionPercent: number
}

interface ActionModule {
  LENS_SURFACE: Readonly<{ tools: number, bytes: number }>
  MAX_TOOLS_FILE_BYTES: number
  assertToolsFileSize(bytes: number): void
  parseOptionalLimit(value: string | undefined, label: string): number | undefined
  budgetViolations(measurement: Measurement, budgets?: { maxTools?: number, maxSchemaBytes?: number }): readonly string[]
  extractTools(value: unknown): readonly unknown[]
  measurePayload(value: unknown): Measurement
  parsePayload(raw: string | Uint8Array): unknown
  buildOutputs(measurement: Measurement): Readonly<Record<string, string>>
  buildStepSummary(measurement: Measurement, budgets?: { maxTools?: number, maxSchemaBytes?: number }): string
}

async function loadActionModule(): Promise<ActionModule> {
  return await import(pathToFileURL(actionPath).href) as ActionModule
}

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-lens-action-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('GitHub Action schema audit', () => {
  it('declares a dependency-free Node 24 action with the bounded output surface', async () => {
    const metadata = await readFile(join(repositoryRoot, 'action.yml'), 'utf8')
    const source = await readFile(actionPath, 'utf8')

    expect(metadata).toContain('using: node24')
    expect(metadata).toContain('main: action/index.js')
    expect(metadata).toMatch(/tools-file:\n\s+description:[^\n]+\n\s+required: true/)
    expect(metadata).toMatch(/max-tools:\n\s+description:[^\n]+\n\s+required: false/)
    expect(metadata).toMatch(/max-schema-bytes:\n\s+description:[^\n]+\n\s+required: false/)
    expect(metadata).toContain('tool-count:')
    expect(metadata).toContain('schema-bytes:')
    expect(metadata).toContain('lens-tool-count:')
    expect(metadata).toContain('lens-schema-bytes:')
    expect(metadata).toContain('schema-byte-reduction-percent:')

    expect(source).toMatch(/from "node:fs\/promises"/)
    expect(source).toMatch(/from "node:path"/)
    expect(source).not.toMatch(/from ["'](?!node:)/)
    expect(source).not.toMatch(/node:(?:http|https|net|tls|dns|dgram)/)
    expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/)
    expect(source).not.toMatch(/\b(?:exec|execFile|spawn|fork|eval)\s*\(/)
    expect(source).not.toMatch(/\b(?:sh|bash|zsh|cmd|powershell)\b/)
  })

  it('matches the calculator byte and reduction formula for arrays and {tools}', async () => {
    const action = await loadActionModule()
    const site = await import(pathToFileURL(join(repositoryRoot, 'site', 'app.js')).href) as {
      SAMPLE_TOOLS: readonly unknown[]
      measurePayload(value: unknown): Measurement
    }

    const arrayMeasurement = action.measurePayload(site.SAMPLE_TOOLS)
    const wrappedMeasurement = action.measurePayload({ tools: site.SAMPLE_TOOLS })
    const schemasMeasurement = action.measurePayload({ schemas: site.SAMPLE_TOOLS })
    const recordedMeasurement = action.measurePayload({ request: { header: { tools: site.SAMPLE_TOOLS } } })
    const siteMeasurement = site.measurePayload(site.SAMPLE_TOOLS)

    expect(action.LENS_SURFACE).toEqual({ tools: 2, bytes: 1_114 })
    expect(arrayMeasurement).toEqual(wrappedMeasurement)
    expect(arrayMeasurement).toEqual(schemasMeasurement)
    expect(arrayMeasurement).toEqual(recordedMeasurement)
    expect(arrayMeasurement.toolCount).toBe(1_000)
    expect(arrayMeasurement.bytes).toBe(294_894)
    expect(arrayMeasurement.reductionPercent).toBe(siteMeasurement.reductionPercent)
    expect(action.buildOutputs(arrayMeasurement)).toEqual({
      'tool-count': '1000',
      'schema-bytes': '294894',
      'lens-tool-count': '2',
      'lens-schema-bytes': '1114',
      'schema-byte-reduction-percent': '99.622',
    })
  })

  it('measures canonical JSON UTF-8 bytes, including non-ASCII tool data', async () => {
    const action = await loadActionModule()
    const tools = [
      { name: '天气', description: '查詢台北天氣', inputSchema: { type: 'object' } },
      { name: 'emoji', description: '🌧️', inputSchema: { type: 'object' } },
    ]
    const measurement = action.measurePayload(tools)

    expect(measurement.toolCount).toBe(2)
    expect(measurement.bytes).toBe(Buffer.byteLength(JSON.stringify(tools), 'utf8'))
    expect(measurement.reductionPercent).toBe(0)
  })

  it('rejects invalid JSON and every unsupported payload shape', async () => {
    const action = await loadActionModule()

    expect(() => action.parsePayload('{not-json')).toThrow('valid UTF-8 JSON')
    expect(() => action.parsePayload(Uint8Array.from([0xff, 0xfe, 0xfd]))).toThrow('valid UTF-8 JSON')
    for (const payload of [null, {}, { tools: null }, { schemas: null }, { header: { tools: [] } }, 'tools']) {
      expect(() => action.extractTools(payload)).toThrow('request.header.tools array')
    }

    expect(action.MAX_TOOLS_FILE_BYTES).toBe(64 * 1024 * 1024)
    expect(() => action.assertToolsFileSize(action.MAX_TOOLS_FILE_BYTES)).not.toThrow()
    expect(() => action.assertToolsFileSize(action.MAX_TOOLS_FILE_BYTES + 1)).toThrow('must not exceed')
    expect(action.parseOptionalLimit(undefined, 'max-tools')).toBeUndefined()
    expect(action.parseOptionalLimit(' 1000 ', 'max-tools')).toBe(1_000)
    for (const invalid of ['0', '-1', '1.5', '1e3', '9007199254740992']) {
      expect(() => action.parseOptionalLimit(invalid, 'max-tools')).toThrow('positive')
    }
  })

  it('reports optional schema budgets and identifies every exceeded limit', async () => {
    const action = await loadActionModule()
    const measurement = { toolCount: 3, bytes: 2_000, reductionPercent: 44.3 }
    const budgets = { maxTools: 2, maxSchemaBytes: 1_500 }

    expect(action.budgetViolations(measurement, budgets)).toEqual([
      'tool count 3 exceeds 2',
      'schema bytes 2000 exceeds 1500',
    ])
    const summary = action.buildStepSummary(measurement, budgets)
    expect(summary).toContain('Configured tool-count budget: **2**')
    expect(summary).toContain('Configured schema-byte budget: **1,500 B**')
    expect(summary).toContain('Budget result: **FAIL**')
  })

  it('writes only numeric outputs and a schema-free step summary', async () => {
    await withTemporaryDirectory(async (workspace) => {
      const fileName = 'tools;$(touch injected)\n.json'
      const payload = {
        tools: [
          { name: '::error::DO_NOT_LEAK', description: 'private-schema-value', inputSchema: { type: 'object' } },
          { name: 'second', inputSchema: { type: 'object', properties: { secret: { type: 'string' } } } },
        ],
      }
      const toolsFile = join(workspace, fileName)
      const outputFile = join(workspace, 'output.txt')
      const summaryFile = join(workspace, 'summary.md')
      await Promise.all([
        writeFile(toolsFile, JSON.stringify(payload), 'utf8'),
        writeFile(outputFile, '', 'utf8'),
        writeFile(summaryFile, '', 'utf8'),
      ])

      const result = await execFileAsync(process.execPath, [actionPath], {
        cwd: workspace,
        env: {
          ...process.env,
          'INPUT_TOOLS-FILE': fileName,
          GITHUB_WORKSPACE: workspace,
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: summaryFile,
        },
      })

      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
      expect(await readFile(outputFile, 'utf8')).toMatch(
        /^tool-count=2\nschema-bytes=\d+\nlens-tool-count=2\nlens-schema-bytes=1114\nschema-byte-reduction-percent=0\.000\n$/,
      )

      const summary = await readFile(summaryFile, 'utf8')
      expect(summary).toContain('Canonical `JSON.stringify(tools)` UTF-8 bytes')
      expect(summary).toContain('| Fixed MCP Lens benchmark | 2 | 1,114 B |')
      expect(summary).toContain('Schema bytes only')
      expect(summary).not.toContain('DO_NOT_LEAK')
      expect(summary).not.toContain('private-schema-value')
      expect(summary).not.toContain('secret')
      await expect(access(join(workspace, 'injected'))).rejects.toThrow()
    })
  })

  it('fails loudly without writing results for missing, malformed, or escaping inputs', async () => {
    await withTemporaryDirectory(async (workspace) => {
      const outside = await mkdtemp(join(tmpdir(), 'mcp-lens-action-outside-'))
      try {
        const invalidFile = join(workspace, 'invalid.json')
        const outsideFile = join(outside, 'outside.json')
        const symlinkFile = join(workspace, 'outside-link.json')
        await Promise.all([
          writeFile(invalidFile, '{not-json', 'utf8'),
          writeFile(outsideFile, '[]', 'utf8'),
          symlink(outsideFile, symlinkFile),
        ])

        for (const input of ['missing.json', 'invalid.json', 'outside-link.json']) {
          const outputFile = join(workspace, `output-${input.replace(/[^a-z]/gi, '-')}.txt`)
          const summaryFile = join(workspace, `summary-${input.replace(/[^a-z]/gi, '-')}.md`)
          await Promise.all([
            writeFile(outputFile, '', 'utf8'),
            writeFile(summaryFile, '', 'utf8'),
          ])

          await expect(execFileAsync(process.execPath, [actionPath], {
            cwd: workspace,
            env: {
              ...process.env,
              'INPUT_TOOLS-FILE': input,
              GITHUB_WORKSPACE: workspace,
              GITHUB_OUTPUT: outputFile,
              GITHUB_STEP_SUMMARY: summaryFile,
            },
          })).rejects.toMatchObject({ code: 1 })

          expect(await readFile(outputFile, 'utf8')).toBe('')
          expect(await readFile(summaryFile, 'utf8')).toBe('')
        }

        expect((await lstat(symlinkFile)).isSymbolicLink()).toBe(true)
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  it('fails a valid audit after writing schema-free results when a configured budget is exceeded', async () => {
    await withTemporaryDirectory(async (workspace) => {
      const toolsFile = join(workspace, 'tools.json')
      const outputFile = join(workspace, 'output.txt')
      const summaryFile = join(workspace, 'summary.md')
      await Promise.all([
        writeFile(toolsFile, JSON.stringify([{ name: 'one' }, { name: 'two' }]), 'utf8'),
        writeFile(outputFile, '', 'utf8'),
        writeFile(summaryFile, '', 'utf8'),
      ])

      await expect(execFileAsync(process.execPath, [actionPath], {
        cwd: workspace,
        env: {
          ...process.env,
          'INPUT_TOOLS-FILE': 'tools.json',
          'INPUT_MAX-TOOLS': '1',
          GITHUB_WORKSPACE: workspace,
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: summaryFile,
        },
      })).rejects.toMatchObject({ code: 1 })

      expect(await readFile(outputFile, 'utf8')).toMatch(/^tool-count=2\n/)
      const summary = await readFile(summaryFile, 'utf8')
      expect(summary).toContain('Budget result: **FAIL**')
      expect(summary).not.toContain('"name"')
    })
  })
})
