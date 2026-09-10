import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface HarnessPackage {
  name: string
  version: string
  path: string
  realPath: string
}
interface PackageGraphModule {
  collectDeepSeekHarnessPackages(path: string): Promise<HarnessPackage[]>
  findLensPrivateHarnessPackages(path: string): Promise<HarnessPackage[]>
  assertNoProfileHarnessPackages(packages: HarnessPackage[]): void
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { collectDeepSeekHarnessPackages, findLensPrivateHarnessPackages, assertNoProfileHarnessPackages } = await import(
  pathToFileURL(join(root, 'scripts', 'harness-package-graph.mjs')).href
) as PackageGraphModule
const scratch: string[] = []
const toolsName = '@deepseek-ai/dsh-tools'
const hostVersion = '0.1.2-rc.1'

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'lens-package-graph-'))
  scratch.push(directory)
  return directory
}

async function packageAt(path: string, name: string, version = hostVersion): Promise<string> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'package.json'), JSON.stringify({
    name,
    version,
    ...(name === 'dsh-mcp-lens' ? { peerDependencies: { [toolsName]: hostVersion } } : {}),
  }))
  return path
}

async function linkDirectory(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('installed Harness package graph boundaries', () => {
  it('detects a Lens-nested symlink to an older external DSH package, without cycling or scanning assets', async () => {
    const directory = await temporaryDirectory()
    const modules = join(directory, 'node_modules')
    await packageAt(join(modules, toolsName), toolsName)
    const lens = await packageAt(join(modules, 'dsh-mcp-lens'), 'dsh-mcp-lens')
    const external = await packageAt(join(directory, 'external-old-tools'), toolsName, '0.1.1-rc.2')
    await linkDirectory(external, join(lens, 'node_modules', toolsName))
    await linkDirectory(lens, join(external, 'node_modules', 'cycle-back-to-lens'))
    const unrelated = join(lens, 'assets', 'node_modules', toolsName)
    await mkdir(unrelated, { recursive: true })
    await writeFile(join(unrelated, 'package.json'), 'not a package manifest')

    const installed = await collectDeepSeekHarnessPackages(modules)
    expect(installed).toHaveLength(2)
    expect(installed.filter(pkg => pkg.version !== hostVersion)).toMatchObject([
      { name: toolsName, version: '0.1.1-rc.2', realPath: await realpath(external) },
    ])
    expect(await findLensPrivateHarnessPackages(modules)).toMatchObject([
      { name: toolsName, version: '0.1.1-rc.2', realPath: await realpath(external) },
    ])
  })

  it('rejects a same-version private peer beside a linked Lens, but permits a link to the identical host peer', async () => {
    const directory = await temporaryDirectory()
    const modules = join(directory, 'node_modules')
    const host = await packageAt(join(modules, toolsName), toolsName)
    const lensModules = join(modules, '.pnpm', 'dsh-mcp-lens@fixture', 'node_modules')
    const lens = await packageAt(join(lensModules, 'dsh-mcp-lens'), 'dsh-mcp-lens')
    const privatePeer = await packageAt(join(lensModules, toolsName), toolsName)
    await linkDirectory(lens, join(modules, 'dsh-mcp-lens'))

    expect(await findLensPrivateHarnessPackages(modules)).toMatchObject([
      { name: toolsName, version: hostVersion, realPath: await realpath(privatePeer) },
    ])
    await rm(privatePeer, { recursive: true })
    await linkDirectory(host, privatePeer)
    expect(await findLensPrivateHarnessPackages(modules)).toEqual([])
    expect(await collectDeepSeekHarnessPackages(modules)).toHaveLength(1)
  })

  it('rejects same-version DSH packages in the profile pnpm store, with or without a top-level symlink', async () => {
    const directory = await temporaryDirectory()
    const modules = join(directory, 'profile', 'node_modules')
    const stored = await packageAt(
      join(modules, '.pnpm', '@deepseek-ai+dsh-tools@0.1.2-rc.1', 'node_modules', toolsName),
      toolsName,
    )

    const storedPackages = await collectDeepSeekHarnessPackages(modules)
    expect(storedPackages).toHaveLength(1)
    expect(() => assertNoProfileHarnessPackages(storedPackages)).toThrow(/Profile installed a private DeepSeek Harness graph/)
    await linkDirectory(stored, join(modules, toolsName))
    const linkedPackages = await collectDeepSeekHarnessPackages(modules)
    expect(linkedPackages).toHaveLength(1)
    expect(() => assertNoProfileHarnessPackages(linkedPackages)).toThrow(/dsh-tools@0.1.2-rc.1/)
    expect(() => assertNoProfileHarnessPackages([])).not.toThrow()
  })
})
