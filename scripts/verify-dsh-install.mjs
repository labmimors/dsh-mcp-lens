import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const supportedHarnessVersion = '0.1.1-rc.2'
const harnessVersion = manifest.devDependencies['@deepseek-ai/dsh-tools']
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const commandTimeoutMs = 180_000
const harnessPackages = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
]

if (harnessVersion !== supportedHarnessVersion) {
  throw new Error(`Packed-install verification must target DeepSeek Harness ${supportedHarnessVersion}`)
}

for (const packageName of harnessPackages) {
  if (manifest.devDependencies[packageName] !== harnessVersion) {
    throw new Error(`DeepSeek Harness development packages must stay in lockstep: ${packageName}`)
  }
}

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
  if (!filename) throw new Error('npm pack did not report a tarball filename')

  const tarballPath = join(temporaryRoot, basename(filename))
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

  run(npmCommand, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumerRoot)
  run(npmCommand, ['ls', '--all'], consumerRoot, true)
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const lens = await import('dsh-mcp-lens'); await import('@deepseek-ai/dsh-tools'); await import('@deepseek-ai/dsh-subprocess'); if (lens.name !== 'mcp-lens' || typeof lens.apply !== 'function' || lens.inject?.[0] !== 'tools') process.exit(1)",
    ],
    consumerRoot,
  )

  const installed = await collectDeepSeekHarnessPackages(join(consumerRoot, 'node_modules'))
  const mismatches = installed.filter(pkg => pkg.version !== harnessVersion)
  if (mismatches.length > 0) {
    throw new Error(`Mixed DeepSeek Harness versions detected:\n${mismatches
      .map(pkg => `- ${pkg.name}@${pkg.version}: ${pkg.path}`)
      .join('\n')}`)
  }

  const lensNestedMarker = `${sep}node_modules${sep}dsh-mcp-lens${sep}node_modules${sep}@deepseek-ai${sep}`
  const lensNested = installed.filter(pkg => pkg.path.includes(lensNestedMarker))
  if (lensNested.length > 0) {
    throw new Error(`Lens installed a nested DeepSeek Harness graph:\n${lensNested
      .map(pkg => `- ${pkg.name}@${pkg.version}: ${pkg.path}`)
      .join('\n')}`)
  }

  for (const required of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-subprocess']) {
    if (!installed.some(pkg => pkg.name === required)) throw new Error(`Missing required host package: ${required}`)
  }

  console.log(`DSH_INSTALL_OK lens=${manifest.version} harness=${harnessVersion} packages=${installed.length}`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
