import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface HarnessPinsModule {
  resolveHarnessPins(
    rootNames: string[],
    exactVersion: string,
    readManifest?: (name: string, version: string) => Promise<unknown>,
  ): Promise<Record<string, string>>
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { resolveHarnessPins } = await import(
  pathToFileURL(join(root, 'scripts', 'resolve-harness-pins.mjs')).href
) as HarnessPinsModule
const version = '0.1.5-alpha.1'
const cli = '@deepseek-ai/dsh'
const tools = '@deepseek-ai/dsh-tools'
const agent = '@deepseek-ai/dsh-agent'

describe('exact Harness dependency pins', () => {
  it('pins recursive dependencies, peers, and optional packages once despite ranges and cycles', async () => {
    const leaves = Array.from({ length: 10 }, (_, index) => `@deepseek-ai/dsh-leaf-${index}`)
    const graph: Record<string, Record<string, unknown>> = {
      [cli]: { dependencies: { [tools]: '^0.1.5-alpha.1' } },
      [tools]: { peerDependencies: { [agent]: '^0.1.5-alpha.1' } },
      [agent]: {
        peerDependencies: { [tools]: '^0.1.5-alpha.2' },
        optionalDependencies: Object.fromEntries(leaves.map(name => [name, 'latest'])),
      },
      ...Object.fromEntries(leaves.map(name => [name, { dependencies: { [cli]: '*' } }])),
    }
    const calls: string[] = []
    let active = 0
    let maximumActive = 0
    const pins = await resolveHarnessPins([cli, tools, cli], version, async (name, requestedVersion) => {
      expect(requestedVersion).toBe(version)
      calls.push(name)
      maximumActive = Math.max(maximumActive, ++active)
      await new Promise(resolve => setImmediate(resolve))
      active -= 1
      return { name, version: requestedVersion, ...graph[name] }
    })

    expect(pins).toEqual(Object.fromEntries(Object.keys(graph).map(name => [name, version])))
    expect(calls).toHaveLength(Object.keys(graph).length)
    expect(new Set(calls).size).toBe(calls.length)
    expect(maximumActive).toBeGreaterThan(1)
    expect(maximumActive).toBeLessThanOrEqual(6)
  })

  it('does not fetch or override unrelated dependencies or development-only DSH packages', async () => {
    const calls: string[] = []
    const pins = await resolveHarnessPins([cli], version, async name => {
      calls.push(name)
      return {
        name,
        version,
        dependencies: { '@deepseek-ai/cordis': '^4.0.1', '@modelcontextprotocol/sdk': '^1.30.0' },
        peerDependencies: { '@other/dsh-tools': '*', '@deepseek-ai/dshx': '*' },
        optionalDependencies: { 'dsh-tools': '*' },
        devDependencies: { [agent]: version },
      }
    })
    expect(calls).toEqual([cli])
    expect(pins).toEqual({ [cli]: version })
  })

  it('rejects wrong or missing metadata and reports the failing exact package', async () => {
    for (const metadata of [
      undefined, null, {}, { name: cli }, { name: tools, version },
      { name: cli, version: '0.1.5-alpha.2' },
      { name: cli, version, dependencies: ['invalid'] },
    ]) {
      await expect(resolveHarnessPins([cli], version, async () => metadata)).rejects.toThrow(`${cli}@${version}`)
    }
    await expect(resolveHarnessPins([cli], version, async () => {
      throw new Error('HTTP 404: version not published')
    })).rejects.toThrow(`Cannot resolve Harness pins for ${cli}@${version}: HTTP 404`)
    for (const range of ['latest', '^0.1.5-alpha.1', '0.1.5-alpha.1\n']) {
      await expect(resolveHarnessPins([cli], range, async () => {
        throw new Error('reader must not run')
      })).rejects.toThrow(/exact SemVer/)
    }
  })
})
