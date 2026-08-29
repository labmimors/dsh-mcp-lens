import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const harnessVersion = '0.1.1-rc.2'
const supportedHarnessPeerRange = '0.1.1-rc.2 || 0.1.2-alpha.1'
const pnpmVersion = '10.20.0'
const commandTimeoutMs = 180_000
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const corepackCommand = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
const outputFlagIndex = process.argv.indexOf('--output')
const outputPath = outputFlagIndex === -1 ? undefined : process.argv[outputFlagIndex + 1]

if (outputFlagIndex !== -1 && (!outputPath || outputPath.startsWith('--'))) {
  throw new Error('Usage: npm run verify:dsh-profile -- --output <receipt.json>')
}

for (const packageName of ['@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-tools']) {
  if (manifest.peerDependencies[packageName] !== supportedHarnessPeerRange) {
    throw new Error(`DeepSeek Harness peer range must stay at ${supportedHarnessPeerRange}: ${packageName}`)
  }
}

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

async function collectDeepSeekHarnessPackages(directory, found = []) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.bin') continue
    const child = join(directory, entry.name)
    if (entry.name === '@deepseek-ai') {
      for (const scopedEntry of await readdir(child, { withFileTypes: true })) {
        if (!scopedEntry.isDirectory() || !/^dsh(?:-|$)/.test(scopedEntry.name)) continue
        const packageRoot = join(child, scopedEntry.name)
        const packageManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
        found.push({
          name: packageManifest.name,
          version: packageManifest.version,
          path: packageRoot,
        })
      }
    }
    await collectDeepSeekHarnessPackages(child, found)
  }
  return found
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
  if (!filename) throw new Error('npm pack did not report a tarball filename')
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
    [`pnpm@${pnpmVersion}`, 'add', '--save-exact', '--ignore-scripts', `@deepseek-ai/dsh@${harnessVersion}`],
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
    ['plugin', '--profile', 'smoke', 'add', tarballPath],
    harnessRoot,
    { capture: true, env: commandEnvironment },
  )
  const dumpedConfig = run(
    dshCommand,
    ['--profile', 'smoke', '--dump-config'],
    harnessRoot,
    { capture: true, env: commandEnvironment },
  )
  if (!dumpedConfig.includes('# == dsh-mcp-lens')
      || !dumpedConfig.includes('- id: mcp-lens')
      || !dumpedConfig.includes('name: dsh-mcp-lens')) {
    throw new Error('Fresh DeepSeek Harness profile did not load the MCP Lens bundle')
  }

  const profileModules = join(dshHome, 'profiles', 'smoke', 'node_modules')
  const installed = await collectDeepSeekHarnessPackages(join(harnessRoot, 'node_modules'))
  installed.push(...await collectDeepSeekHarnessPackages(profileModules))
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
      candidate: {
        name: manifest.name,
        version: manifest.version,
        tarballSha256,
      },
      harness: {
        requestedVersion: harnessVersion,
        reportedVersion,
        pnpmVersion,
        packageInstances: installed.length,
        packages: packageSummary,
      },
      profile: {
        name: 'smoke',
        bundleLoaded: true,
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
