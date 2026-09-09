import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const developmentVersion = '0.1.2-rc.1'
const supportedVersions = ['0.1.1-rc.2', '0.1.2-alpha.1', developmentVersion, '0.1.5-alpha.1']
interface Manifest {
  devDependencies: Record<string, string>
  peerDependencies: Record<string, string>
}
interface CompatibilityModule {
  harnessPackages: readonly string[]
  resolveHarnessCompatibility(manifest: Manifest, argv: string[], options?: { allowOutput?: boolean }): {
    harnessVersion: string
    versionSelection: 'devDependencies' | 'command-line'
    outputPath: string | undefined
  }
}
const { harnessPackages, resolveHarnessCompatibility } = await import(
  pathToFileURL(join(root, 'scripts', 'harness-compatibility.mjs')).href
) as CompatibilityModule

function manifest(): Manifest {
  return {
    devDependencies: Object.fromEntries(harnessPackages.map(name => [name, developmentVersion])),
    peerDependencies: {
      '@deepseek-ai/dsh-subprocess': supportedVersions.join(' || '),
      '@deepseek-ai/dsh-tools': supportedVersions.join(' || '),
    },
  }
}

describe('exact Harness compatibility selection', () => {
  it('defaults to the lockstep development version', () => {
    expect(harnessPackages).toHaveLength(5)
    expect(resolveHarnessCompatibility(manifest(), [])).toEqual({
      harnessVersion: developmentVersion,
      versionSelection: 'devDependencies',
      outputPath: undefined,
    })
  })

  it.each(supportedVersions)('selects the declared exact version %s, including legacy Desktop alpha', version => {
    expect(resolveHarnessCompatibility(manifest(), ['--harness-version', version])).toMatchObject({
      harnessVersion: version,
      versionSelection: 'command-line',
    })
  })

  it.each(['latest', 'next', '^0.1.2', '~0.1.2', '>=0.1.2', '*', '0.1.x', '0.1', 'v0.1.2',
    '0.1.2 || 0.1.3', '0.1.2-rc.01', '00.1.2', 'https://example.test/dsh.tgz', 'file:./dsh.tgz',
    '0.1.2-rc.1\n', ' 0.1.2-rc.1'])('rejects non-exact version %j', version => {
    expect(() => resolveHarnessCompatibility(manifest(), ['--harness-version', version])).toThrow(/exact SemVer/)
  })

  it.each([
    ['--help'], ['--unknown', 'value'], ['--harness-version=0.1.2-rc.1'], ['0.1.2-rc.1'],
    ['--harness-version'], ['--harness-version', ''], ['--harness-version', '--output'],
    ['--harness-version', developmentVersion, '--harness-version', developmentVersion],
  ])('rejects malformed or unknown arguments %j', (...argv) => {
    expect(() => resolveHarnessCompatibility(manifest(), argv)).toThrow(/verification argument|Missing value/)
  })

  it('allows --output only for profile verification, in either argument order', () => {
    for (const argv of [
      ['--output', 'receipts/profile.json', '--harness-version', developmentVersion],
      ['--harness-version', developmentVersion, '--output', 'receipts/profile.json'],
    ]) {
      expect(resolveHarnessCompatibility(manifest(), argv, { allowOutput: true }).outputPath).toBe('receipts/profile.json')
      expect(() => resolveHarnessCompatibility(manifest(), argv)).toThrow(/Unknown verification argument: --output/)
    }
  })

  it.each([
    ['--output'], ['--output', ''], ['--output', '   '], ['--output', '--harness-version', developmentVersion],
    ['--output', 'first.json', '--output', 'second.json'], ['--output', 'first.json', 'extra'],
  ])('rejects malformed receipt arguments %j', (...argv) => {
    expect(() => resolveHarnessCompatibility(manifest(), argv, { allowOutput: true })).toThrow()
  })

  it.each(harnessPackages)('rejects development version drift in %s even with an explicit target', name => {
    const changed = manifest()
    changed.devDependencies[name] = '0.1.1-rc.2'
    expect(() => resolveHarnessCompatibility(changed, ['--harness-version', developmentVersion])).toThrow(/lockstep/)
  })

  it.each(harnessPackages)('rejects a missing development package %s', name => {
    const changed = manifest()
    delete changed.devDependencies[name]
    expect(() => resolveHarnessCompatibility(changed, [])).toThrow(/lockstep|exact SemVer/)
  })

  it('rejects non-exact development dependencies even if all five match', () => {
    const changed = manifest()
    changed.devDependencies = Object.fromEntries(harnessPackages.map(name => [name, '^0.1.2']))
    expect(() => resolveHarnessCompatibility(changed, [])).toThrow(/exact SemVer/)
  })

  it.each(['@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-tools'])('requires the selected version in %s peers', name => {
    const changed = manifest()
    changed.peerDependencies[name] = '0.1.1-rc.2 || 0.1.2-alpha.1'
    expect(() => resolveHarnessCompatibility(changed, [])).toThrow(/not declared/)
  })

  it.each(['*', '^0.1.2', 'latest', '0.1.2-rc.1||0.1.5-alpha.1',
    '0.1.2-rc.1 || 0.1.2-rc.1', '0.1.2-rc.1 || ^0.1.5', ''])('rejects a non-exact peer set %j', range => {
    const changed = manifest()
    changed.peerDependencies['@deepseek-ai/dsh-tools'] = range
    expect(() => resolveHarnessCompatibility(changed, [])).toThrow(/exact/)
  })

  it('rejects an undeclared exact version', () => {
    expect(() => resolveHarnessCompatibility(manifest(), ['--harness-version', '0.1.9'])).toThrow(/not declared/)
  })
})

describe.each(['verify-dsh-install.mjs', 'verify-dsh-profile-install.mjs'])('%s command-line boundary', script => {
  it.each([
    ['--unknown'], ['--harness-version', 'latest'], ['--harness-version', '^0.1.2'],
    ['--harness-version'], ['--harness-version', '0.1.2-rc.1', '--harness-version', '0.1.5-alpha.1'],
  ])('fails before package-manager commands for %j', (...argv) => {
    const result = spawnSync(process.execPath, [join(root, 'scripts', script), ...argv], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
      env: { ...process.env, PATH: '' },
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/Unknown verification argument|Duplicate verification argument|exact SemVer|Missing value/)
    expect(result.stderr).not.toMatch(/ENOENT|Missing lib\/index.js/)
  })
})
