import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { harnessPackages, resolveHarnessCompatibility } from './harness-compatibility.mjs'
import { collectDeepSeekHarnessPackages } from './harness-package-graph.mjs'
import { resolveHarnessPins } from './resolve-harness-pins.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const { harnessVersion } = resolveHarnessCompatibility(manifest, process.argv.slice(2))
const pins = await resolveHarnessPins(harnessPackages, harnessVersion)
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  'install', '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund',
  ...Object.entries(pins).map(([name, version]) => `${name}@${version}`),
], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', timeout: 180_000 })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Harness ${harnessVersion} installation failed`)
const installed = await collectDeepSeekHarnessPackages(join(root, 'node_modules'))
const mismatches = installed.filter(pkg => pkg.version !== harnessVersion)
if (mismatches.length) {
  throw new Error(`Unexpected Harness versions: ${mismatches.map(pkg => `${pkg.name}@${pkg.version}`).join(', ')}`)
}
console.log(`DSH_SELECTED version=${harnessVersion} packages=${installed.length}`)
