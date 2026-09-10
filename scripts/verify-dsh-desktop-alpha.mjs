import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveHarnessCompatibility } from './harness-compatibility.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopVersion = '2.0.4'
const desktopTag = `v${desktopVersion}`
const desktopCommit = 'd29bf7a965fc68bf09750bc329905ecb17afe48b'
const harnessVersion = '0.1.2-alpha.1'
const harnessCommit = 'cd5ef8148158c3a752a658978873241fdf8e2bbc'
const expectedRuntimePackageCount = 241
const commandTimeoutMs = 600_000
const corepackCommand = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const nodeCommand = process.execPath
const alphaDevelopmentPackages = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-code-runtime',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-user-approval',
]
const runtimeTests = [
  'tests/action.spec.ts',
  'tests/catalog.spec.ts',
  'tests/integration.spec.ts',
  'tests/policy.spec.ts',
  'tests/pool.spec.ts',
  'tests/search-cache-benchmark.spec.ts',
]

function parseArguments(argv) {
  let desktopSource
  let outputPath
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === '--desktop-source' && value && !value.startsWith('--')) {
      desktopSource = resolve(value)
      index += 1
      continue
    }
    if (argument === '--output' && value && !value.startsWith('--')) {
      outputPath = resolve(root, value)
      index += 1
      continue
    }
    throw new Error('Usage: npm run verify:dsh-desktop-alpha -- --desktop-source <dsh-desktop-v2.0.4> [--output <receipt.json>]')
  }
  if (!desktopSource) {
    throw new Error('Missing --desktop-source for the pinned DSH Desktop v2.0.4 checkout')
  }
  return { desktopSource, outputPath }
}

function run(command, args, cwd, options = {}) {
  const needsWindowsShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CI: '1', NO_COLOR: '1', ...options.env },
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

function requireCleanTrackedSource(directory) {
  const result = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], {
    cwd: directory,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    timeout: commandTimeoutMs,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status === 1) {
    throw new Error('Desktop alpha verification requires the candidate tracked source to match HEAD')
  }
  if (result.status !== 0) {
    throw new Error(`git diff --quiet HEAD -- failed: ${result.stderr ?? ''}`)
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function copyFilter(sourcePath) {
  const parts = sourcePath.split(sep)
  if (parts.some(part => ['.git', 'node_modules', 'lib', 'dist', 'coverage'].includes(part))) return false
  return !parts.some((part, index) => part === 'cache' && parts[index - 1] === '.yarn')
}

async function copyEntry(sourceRoot, destinationRoot, entry) {
  await cp(join(sourceRoot, entry), join(destinationRoot, entry), {
    recursive: true,
    filter: copyFilter,
  })
}

async function verifyVendoredRuntime(desktopSource) {
  const upstream = await readJson(join(desktopSource, 'upstream.json'))
  if (upstream.commit !== harnessCommit
      || upstream.sourceVersion !== harnessVersion
      || upstream.runtimePackageVersion !== harnessVersion) {
    throw new Error(`DSH Desktop ${desktopTag} no longer pins the reviewed Harness ${harnessVersion} source`)
  }

  const runtimeRoot = join(desktopSource, 'vendor', 'dsh-runtime', harnessVersion)
  const manifestPath = join(runtimeRoot, 'manifest.json')
  const manifest = await readJson(manifestPath)
  if (manifest.version !== harnessVersion
      || manifest.commit !== harnessCommit
      || manifest.buildProfile !== 'official'
      || manifest.packages?.length !== expectedRuntimePackageCount) {
    throw new Error(`Unexpected DSH Desktop vendored runtime manifest: ${manifestPath}`)
  }

  for (const packageEntry of manifest.packages) {
    if (packageEntry.version !== harnessVersion
        || typeof packageEntry.filename !== 'string'
        || typeof packageEntry.size !== 'number'
        || typeof packageEntry.sha256 !== 'string') {
      throw new Error(`Invalid vendored package entry: ${JSON.stringify(packageEntry)}`)
    }
    const packagePath = resolve(runtimeRoot, packageEntry.filename)
    if (!packagePath.startsWith(`${runtimeRoot}${sep}`)) {
      throw new Error(`Vendored package filename escapes its runtime root: ${packageEntry.filename}`)
    }
    const packageStat = await stat(packagePath)
    if (packageStat.size !== packageEntry.size || await sha256(packagePath) !== packageEntry.sha256) {
      throw new Error(`Vendored package integrity mismatch: ${packageEntry.filename}`)
    }
  }

  return {
    manifestPath,
    manifestSha256: await sha256(manifestPath),
    packageCount: manifest.packages.length,
  }
}

async function findNestedHarnessEntries(directory, found = []) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }
  for (const entry of entries) {
    if (basename(directory) === '@deepseek-ai' && /^dsh(?:-|$)/.test(entry.name)) {
      found.push(join(directory, entry.name))
    }
    if (basename(directory) === '.pnpm' && /^@deepseek-ai\+dsh(?:[-+@]|$)/.test(entry.name)) {
      found.push(join(directory, entry.name))
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.bin') continue
    const child = join(directory, entry.name)
    await findNestedHarnessEntries(child, found)
  }
  return found
}

async function copyDesktopSource(desktopSource, destination) {
  await mkdir(destination)
  for (const entry of [
    '.yarn',
    '.yarnrc.yml',
    'dsh-community-fabric',
    'dsh-community-market',
    'dsh-plugin-desktop',
    'package.json',
    'patches',
    'scripts',
    'upstream.json',
    `vendor/dsh-runtime/${harnessVersion}`,
    'yarn.lock',
  ]) {
    await copyEntry(desktopSource, destination, entry)
  }
}

async function copyCandidateSource(destination) {
  await mkdir(destination, { recursive: true })
  const trackedFiles = run('git', ['ls-files', '-z'], root, { capture: true })
    .split('\0')
    .filter(Boolean)
  if (trackedFiles.length === 0) throw new Error('Candidate checkout has no tracked source files')
  for (const trackedFile of trackedFiles) {
    const destinationPath = join(destination, trackedFile)
    await mkdir(dirname(destinationPath), { recursive: true })
    await cp(join(root, trackedFile), destinationPath)
  }
  run('git', ['init'], destination, { capture: true })
  run('git', ['add', '--all'], destination, { capture: true })
  run(
    'git',
    [
      '-c', 'user.name=MCP Lens compatibility gate',
      '-c', 'user.email=compatibility-gate@invalid.example',
      'commit', '--no-gpg-sign', '-m', 'snapshot candidate for compatibility verification',
    ],
    destination,
    { capture: true },
  )
}

async function prepareWorkspace(desktopRoot) {
  const desktopManifestPath = join(desktopRoot, 'package.json')
  const desktopManifest = await readJson(desktopManifestPath)
  desktopManifest.workspaces = [...new Set([...desktopManifest.workspaces, 'compat/dsh-mcp-lens'])]
  await writeFile(desktopManifestPath, `${JSON.stringify(desktopManifest, null, 2)}\n`)

  const candidateRoot = join(desktopRoot, 'compat', 'dsh-mcp-lens')
  await copyCandidateSource(candidateRoot)
  const candidateManifestPath = join(candidateRoot, 'package.json')
  const publicManifestText = await readFile(candidateManifestPath, 'utf8')
  const candidateManifest = JSON.parse(publicManifestText)
  resolveHarnessCompatibility(candidateManifest, ['--harness-version', harnessVersion])
  for (const packageName of alphaDevelopmentPackages) {
    candidateManifest.devDependencies[packageName] = harnessVersion
  }
  await writeFile(candidateManifestPath, `${JSON.stringify(candidateManifest, null, 2)}\n`)
  return { candidateRoot, candidateManifestPath, publicManifestText, candidateManifest }
}

async function writePnpmShim(directory, pnpmVersion) {
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

async function runProfileGate(desktopRoot, candidateRoot, candidateManifest, temporaryRoot) {
  const artifactRoot = join(temporaryRoot, 'artifacts')
  await mkdir(artifactRoot)
  const packOutput = run(
    npmCommand,
    ['pack', '--ignore-scripts', '--json', '--pack-destination', artifactRoot],
    candidateRoot,
    { capture: true },
  )
  const packResult = JSON.parse(packOutput)
  const filename = packResult[0]?.filename
  if (!filename) throw new Error('npm pack did not report the Desktop-alpha candidate tarball')
  const tarballPath = join(artifactRoot, basename(filename))

  const desktopPluginRoot = join(desktopRoot, 'dsh-plugin-desktop')
  const desktopPluginManifest = await readJson(join(desktopPluginRoot, 'package.json'))
  const pnpmVersion = desktopPluginManifest.dependencies?.pnpm ?? desktopPluginManifest.devDependencies?.pnpm
  if (typeof pnpmVersion !== 'string') throw new Error('DSH Desktop did not declare its packaged pnpm version')
  const dshBin = join(desktopPluginRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const reportedVersion = run(nodeCommand, [dshBin, '--version'], desktopRoot, { capture: true }).trim()
  if (reportedVersion !== harnessVersion) {
    throw new Error(`Expected Desktop dsh ${harnessVersion}, received ${reportedVersion}`)
  }

  const shimRoot = join(temporaryRoot, 'bin')
  await writePnpmShim(shimRoot, pnpmVersion)
  const dshHome = join(temporaryRoot, 'dsh-home')
  const commandEnvironment = {
    DSH_HOME: dshHome,
    DSH_TELEMETRY: 'DISABLED',
    PATH: [shimRoot, process.env.PATH ?? ''].join(delimiter),
  }
  run(
    nodeCommand,
    [dshBin, 'plugin', '--profile', 'lens-alpha', 'add', '--strict-peer-dependencies', tarballPath],
    desktopRoot,
    { capture: true, env: commandEnvironment },
  )
  const dumpedConfig = run(
    nodeCommand,
    [dshBin, '--profile', 'lens-alpha', '--dump-config'],
    desktopRoot,
    { capture: true, env: commandEnvironment },
  )
  const bundleRows = dumpedConfig.match(/# == dsh-mcp-lens/g) ?? []
  const pluginRows = dumpedConfig.match(/- id: mcp-lens/g) ?? []
  if (bundleRows.length !== 1 || pluginRows.length !== 1 || !dumpedConfig.includes('name: dsh-mcp-lens')) {
    throw new Error('Desktop alpha profile did not compose exactly one MCP Lens bundle')
  }

  const nestedHarnessEntries = await findNestedHarnessEntries(
    join(dshHome, 'profiles', 'lens-alpha', 'node_modules'),
  )
  if (nestedHarnessEntries.length > 0) {
    throw new Error(`Desktop alpha profile installed a Lens-nested DSH graph:\n${nestedHarnessEntries
      .map(path => `- ${path}`)
      .join('\n')}`)
  }

  const hostPackages = {}
  for (const packageName of [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-mcp-client',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
  ]) {
    const hostManifest = await readJson(join(desktopPluginRoot, 'node_modules', ...packageName.split('/'), 'package.json'))
    if (hostManifest.version !== harnessVersion) {
      throw new Error(`Desktop host package drifted from ${harnessVersion}: ${packageName}@${hostManifest.version}`)
    }
    hostPackages[packageName] = hostManifest.version
  }

  return {
    candidateVersion: candidateManifest.version,
    tarballSha256: await sha256(tarballPath),
    reportedHarnessVersion: reportedVersion,
    pnpmVersion,
    hostPackages,
    nestedProfileHarnessPackageInstances: nestedHarnessEntries.length,
    dumpConfigSha256: createHash('sha256').update(dumpedConfig).digest('hex'),
  }
}

const { desktopSource, outputPath } = parseArguments(process.argv.slice(2))
requireCleanTrackedSource(root)
const sourceManifest = await readJson(join(desktopSource, 'package.json'))
if (sourceManifest.name !== 'deepseek-harness-desktop' || sourceManifest.version !== desktopVersion) {
  throw new Error(`Expected a DSH Desktop ${desktopTag} source checkout`)
}
const sourceCommit = run('git', ['rev-parse', 'HEAD'], desktopSource, { capture: true }).trim()
if (sourceCommit !== desktopCommit) {
  throw new Error(`Expected DSH Desktop ${desktopTag} at ${desktopCommit}, received ${sourceCommit}`)
}
const sourceStatus = run('git', ['status', '--porcelain'], desktopSource, { capture: true }).trim()
if (sourceStatus !== '') {
  throw new Error('DSH Desktop alpha verification requires a clean pinned source checkout')
}
const vendoredRuntime = await verifyVendoredRuntime(desktopSource)

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-mcp-lens-desktop-alpha-'))
try {
  const desktopRoot = join(temporaryRoot, 'desktop')
  await copyDesktopSource(desktopSource, desktopRoot)
  const {
    candidateRoot,
    candidateManifestPath,
    publicManifestText,
    candidateManifest,
  } = await prepareWorkspace(desktopRoot)

  run(corepackCommand, ['yarn', 'install', '--no-immutable'], desktopRoot)
  await writeFile(candidateManifestPath, publicManifestText)
  run(corepackCommand, ['yarn', 'workspace', 'dsh-mcp-lens', 'run', 'typecheck'], desktopRoot)
  run(corepackCommand, ['yarn', 'workspace', 'dsh-mcp-lens', 'run', 'build'], desktopRoot)

  const testReportPath = join(temporaryRoot, 'alpha-tests.json')
  run(
    corepackCommand,
    [
      'yarn', 'workspace', 'dsh-mcp-lens', 'exec', 'vitest', 'run',
      ...runtimeTests,
      '--reporter=json',
      `--outputFile=${testReportPath}`,
    ],
    desktopRoot,
  )
  const testReport = await readJson(testReportPath)
  if (!testReport.success || testReport.numTotalTests !== 89 || testReport.numPassedTests !== 89) {
    throw new Error(`Unexpected Desktop alpha test result: ${JSON.stringify({
      success: testReport.success,
      total: testReport.numTotalTests,
      passed: testReport.numPassedTests,
    })}`)
  }

  const benchmarkPath = join(temporaryRoot, 'alpha-benchmark.json')
  run(
    corepackCommand,
    ['yarn', 'workspace', 'dsh-mcp-lens', 'run', 'bench', '--output', benchmarkPath],
    desktopRoot,
  )
  const benchmark = await readJson(benchmarkPath)
  if (benchmark.format !== 'dsh-mcp-lens/component-benchmark'
      || benchmark.schemaSurface?.length !== 3
      || benchmark.retrieval?.lens?.recallAt1 !== 1) {
    throw new Error('Desktop alpha benchmark did not reproduce the frozen component contract')
  }

  const imported = run(
    nodeCommand,
    [
      '--input-type=module',
      '--eval',
      "const lens = await import('./lib/index.js'); if (lens.name !== 'mcp-lens' || typeof lens.apply !== 'function' || lens.inject?.[0] !== 'tools') process.exit(1)",
    ],
    candidateRoot,
    { capture: true },
  )
  if (imported.trim() !== '') throw new Error(`Unexpected candidate import output: ${imported.trim()}`)

  const profile = await runProfileGate(desktopRoot, candidateRoot, candidateManifest, temporaryRoot)
  const candidateCheckoutCommit = run('git', ['rev-parse', 'HEAD'], root, { capture: true }).trim()
  const candidateSourceTree = run('git', ['rev-parse', 'HEAD^{tree}'], root, { capture: true }).trim()
  const receipt = {
    schemaVersion: 1,
    candidate: {
      name: candidateManifest.name,
      version: profile.candidateVersion,
      checkoutCommit: candidateCheckoutCommit,
      sourceTree: candidateSourceTree,
      trackedSourceClean: true,
      peerRange: candidateManifest.peerDependencies['@deepseek-ai/dsh-tools'],
      sourceDigest: benchmark.provenance?.candidate?.sourceDigest,
      tarballSha256: profile.tarballSha256,
    },
    desktop: {
      repository: 'https://github.com/anywhere-labs/dsh-desktop.git',
      tag: desktopTag,
      version: desktopVersion,
      commit: desktopCommit,
    },
    harness: {
      version: harnessVersion,
      commit: harnessCommit,
      buildProfile: 'official',
      manifestSha256: vendoredRuntime.manifestSha256,
      vendoredPackageCount: vendoredRuntime.packageCount,
      reportedVersion: profile.reportedHarnessVersion,
      pnpmVersion: profile.pnpmVersion,
      hostPackages: profile.hostPackages,
      nestedProfilePackageInstances: profile.nestedProfileHarnessPackageInstances,
    },
    verification: {
      typecheck: true,
      build: true,
      runtimeTestFiles: runtimeTests.length,
      runtimeTests: testReport.numPassedTests,
      benchmark: true,
      benchmarkSha256: await sha256(benchmarkPath),
      resolvedPackageVersions: benchmark.provenance?.resolvedPackageVersions,
      import: true,
      packedProfileInstall: true,
      configComposition: true,
      dumpConfigSha256: profile.dumpConfigSha256,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
  }

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`)
  }
  console.log(`DSH_DESKTOP_ALPHA_OK lens=${candidateManifest.version} desktop=${desktopTag} harness=${harnessVersion} packages=${vendoredRuntime.packageCount} tests=${testReport.numPassedTests}`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
