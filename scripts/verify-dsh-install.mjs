import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { harnessPackages, resolveHarnessCompatibility } from './harness-compatibility.mjs'
import { collectDeepSeekHarnessPackages, findLensPrivateHarnessPackages } from './harness-package-graph.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const { harnessVersion } = resolveHarnessCompatibility(manifest, process.argv.slice(2))
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const commandTimeoutMs = 180_000

try {
  await access(join(root, 'lib', 'index.js'))
} catch {
  throw new Error('Missing lib/index.js; run npm run build before the packed-install verification')
}

function run(command, args, cwd, capture = false) {
  const needsWindowsShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: needsWindowsShell,
    timeout: commandTimeoutMs,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : ''
    throw new Error(`${command} ${args.join(' ')} failed${output}`)
  }
  return result.stdout ?? ''
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-mcp-lens-install-'))
try {
  const packOutput = run(
    npmCommand,
    ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot],
    root,
    true,
  )
  const packResult = JSON.parse(packOutput)
  const filename = packResult[0]?.filename
  if (packResult.length !== 1 || !filename) throw new Error('npm pack must report exactly one tarball filename')

  const tarballPath = join(temporaryRoot, basename(filename))
  const tarballSha256 = createHash('sha256').update(await readFile(tarballPath)).digest('hex')
  const consumerRoot = join(temporaryRoot, 'consumer')
  const relativeTarballPath = relative(consumerRoot, tarballPath).split(sep).join('/')
  await mkdir(consumerRoot)
  await writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify({
    name: 'dsh-mcp-lens-install-smoke',
    private: true,
    type: 'module',
    dependencies: {
      '@deepseek-ai/cordis': manifest.devDependencies['@deepseek-ai/cordis'],
      ...Object.fromEntries(harnessPackages.map(packageName => [packageName, harnessVersion])),
      'dsh-mcp-lens': `file:${relativeTarballPath}`,
    },
  }, null, 2)}\n`)

  run(npmCommand, ['install', '--strict-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumerRoot)
  run(npmCommand, ['ls', '--all'], consumerRoot, true)
  const runtimeSmokePath = join(consumerRoot, 'smoke-installed-runtime.mjs')
  await copyFile(join(root, 'scripts', 'smoke-installed-runtime.mjs'), runtimeSmokePath)
  run(process.execPath, [runtimeSmokePath, root], consumerRoot)

  const installed = await collectDeepSeekHarnessPackages(join(consumerRoot, 'node_modules'))
  const mismatches = installed.filter(pkg => pkg.version !== harnessVersion)
  if (mismatches.length > 0) {
    throw new Error(`Mixed DeepSeek Harness versions detected:\n${mismatches
      .map(pkg => `- ${pkg.name}@${pkg.version}: ${pkg.path}`)
      .join('\n')}`)
  }

  const lensNested = await findLensPrivateHarnessPackages(join(consumerRoot, 'node_modules'))
  if (lensNested.length > 0) {
    throw new Error(`Lens installed a nested DeepSeek Harness graph:\n${lensNested
      .map(pkg => `- ${pkg.name}@${pkg.version}: ${pkg.path}`)
      .join('\n')}`)
  }

  for (const required of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-subprocess']) {
    if (!installed.some(pkg => pkg.name === required)) throw new Error(`Missing required host package: ${required}`)
  }

  console.log(`DSH_INSTALL_OK lens=${manifest.version} harness=${harnessVersion} packages=${installed.length} sha256=${tarballSha256}`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
