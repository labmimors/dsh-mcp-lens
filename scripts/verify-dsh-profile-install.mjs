import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveHarnessCompatibility } from './harness-compatibility.mjs'
import { assertNoProfileHarnessPackages, collectDeepSeekHarnessPackages } from './harness-package-graph.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const { harnessVersion, versionSelection, outputPath } = resolveHarnessCompatibility(
  manifest,
  process.argv.slice(2),
  { allowOutput: true },
)
const pnpmVersion = '10.20.0'
const commandTimeoutMs = 180_000
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const corepackCommand = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'

try {
  await access(join(root, 'lib', 'index.js'))
} catch {
  throw new Error('Missing lib/index.js; run npm run build before the profile verification')
}

function run(command, args, cwd, options = {}) {
  const needsWindowsShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: needsWindowsShell,
    timeout: commandTimeoutMs,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = options.capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : ''
    throw new Error(`${command} ${args.join(' ')} failed${output}`)
  }
  return result.stdout ?? ''
}

async function writePnpmShim(directory) {
  await mkdir(directory)
  if (process.platform === 'win32') {
    await writeFile(join(directory, 'pnpm.cmd'), `@echo off\r\ncorepack pnpm@${pnpmVersion} %*\r\n`)
    return
  }
  await writeFile(
    join(directory, 'pnpm'),
    `#!/bin/sh\nexec corepack pnpm@${pnpmVersion} "$@"\n`,
    { mode: 0o755 },
  )
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-mcp-lens-profile-'))
try {
  const packOutput = run(
    npmCommand,
    ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot],
    root,
    { capture: true },
  )
  const packResult = JSON.parse(packOutput)
  const filename = packResult[0]?.filename
  if (packResult.length !== 1 || !filename) throw new Error('npm pack must report exactly one tarball filename')
  const tarballPath = join(temporaryRoot, basename(filename))
  const tarballSha256 = createHash('sha256').update(await readFile(tarballPath)).digest('hex')

  const harnessRoot = join(temporaryRoot, 'harness')
  await mkdir(harnessRoot)
  await writeFile(join(harnessRoot, 'package.json'), `${JSON.stringify({
    name: 'dsh-mcp-lens-profile-smoke',
    private: true,
    packageManager: `pnpm@${pnpmVersion}`,
  }, null, 2)}\n`)
  run(
    corepackCommand,
    [`pnpm@${pnpmVersion}`, 'add', '--save-exact', '--strict-peer-dependencies', '--ignore-scripts', `@deepseek-ai/dsh@${harnessVersion}`],
    harnessRoot,
    { capture: true },
  )

  const shimRoot = join(temporaryRoot, 'bin')
  await writePnpmShim(shimRoot)
  const executableSuffix = process.platform === 'win32' ? '.cmd' : ''
  const dshCommand = join(harnessRoot, 'node_modules', '.bin', `dsh${executableSuffix}`)
  const dshHome = join(temporaryRoot, 'dsh-home')
  const commandEnvironment = {
    DSH_HOME: dshHome,
    PATH: [shimRoot, join(harnessRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
  }

  const reportedVersion = run(dshCommand, ['--version'], harnessRoot, {
    capture: true,
    env: commandEnvironment,
  }).trim()
  if (reportedVersion !== harnessVersion) {
    throw new Error(`Expected dsh ${harnessVersion}, received ${reportedVersion}`)
  }

  run(
    dshCommand,
    ['plugin', '--profile', 'smoke', 'add', '--strict-peer-dependencies', tarballPath],
    harnessRoot,
    { capture: true, env: commandEnvironment },
  )
  const dumpedConfig = run(
    dshCommand,
    ['--profile', 'smoke', '--dump-config'],
    harnessRoot,
    { capture: true, env: commandEnvironment },
  )
  const bundleRows = dumpedConfig.match(/^# == dsh-mcp-lens\s*$/gm) ?? []
  const pluginRows = dumpedConfig.match(/^\s*- id: mcp-lens\s*$/gm) ?? []
  if (bundleRows.length !== 1 || pluginRows.length !== 1
      || !dumpedConfig.includes('name: dsh-mcp-lens')) {
    throw new Error('Fresh DeepSeek Harness profile did not compose exactly one MCP Lens bundle')
  }

  const profileModules = join(dshHome, 'profiles', 'smoke', 'node_modules')
  const profileHarnessPackages = await collectDeepSeekHarnessPackages(profileModules)
  assertNoProfileHarnessPackages(profileHarnessPackages)
  const installed = await collectDeepSeekHarnessPackages(join(harnessRoot, 'node_modules'))
  const mismatches = installed.filter(pkg => pkg.version !== harnessVersion)
  if (mismatches.length > 0) {
    throw new Error(`Mixed DeepSeek Harness versions detected:\n${mismatches
      .map(pkg => `- ${pkg.name}@${pkg.version}: ${pkg.path}`)
      .join('\n')}`)
  }
  if (!installed.some(pkg => pkg.name === '@deepseek-ai/dsh-tools')) {
    throw new Error('Fresh profile did not resolve @deepseek-ai/dsh-tools')
  }

  const packageSummary = [...installed.reduce((summary, pkg) => {
    const key = `${pkg.name}@${pkg.version}`
    summary.set(key, (summary.get(key) ?? 0) + 1)
    return summary
  }, new Map())]
    .map(([key, instances]) => {
      const separator = key.lastIndexOf('@')
      return { name: key.slice(0, separator), version: key.slice(separator + 1), instances }
    })
    .sort((left, right) => left.name.localeCompare(right.name))

  if (outputPath) {
    const receiptPath = resolve(root, outputPath)
    await mkdir(dirname(receiptPath), { recursive: true })
    await writeFile(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      verifiedAt: new Date().toISOString(),
      candidate: {
        name: manifest.name,
        version: manifest.version,
        tarballSha256,
      },
      harness: {
        requestedVersion: harnessVersion,
        reportedVersion,
        source: {
          type: 'npm-exact',
          specifier: `@deepseek-ai/dsh@${harnessVersion}`,
          selectedBy: versionSelection,
        },
        pnpmVersion,
        packageInstances: installed.length,
        packages: packageSummary,
      },
      profile: {
        name: 'smoke',
        bundleLoaded: true,
        bundleInstances: bundleRows.length,
        strictPeerDependencies: true,
        nestedHarnessPackageInstances: profileHarnessPackages.length,
        dumpConfigSha256: createHash('sha256').update(dumpedConfig).digest('hex'),
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
    }, null, 2)}\n`)
  }

  console.log(`DSH_PROFILE_OK lens=${manifest.version} harness=${harnessVersion} packages=${installed.length} sha256=${tarballSha256}`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
