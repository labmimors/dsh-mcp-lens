import { readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const isHarnessPackage = name => typeof name === 'string' && /^@deepseek-ai\/dsh(?:-|$)/.test(name)
const isDirectoryEntry = entry => entry.isDirectory() || entry.isSymbolicLink()

async function existingRealPath(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

export async function collectDeepSeekHarnessPackages(modulesRoot) {
  const found = []
  const visitedModules = new Set()
  const visitedPackages = new Set()

  async function inspectPackage(packagePath, installedName) {
    // Resolve package links before reading their manifest. Physical identity
    // deduplicates pnpm links and terminates cyclic dependency graphs.
    const realPath = await realpath(packagePath)
    if (visitedPackages.has(realPath)) return
    visitedPackages.add(realPath)
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(realPath, 'package.json'), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT' && !isHarnessPackage(installedName)) return
      throw error
    }
    if (isHarnessPackage(installedName) && !isHarnessPackage(manifest.name)) {
      throw new Error(`Invalid DeepSeek Harness package manifest: ${packagePath}`)
    }
    if (isHarnessPackage(manifest.name)) {
      found.push({ name: manifest.name, version: manifest.version, path: packagePath, realPath })
    }
    await visitModules(join(realPath, 'node_modules'))
  }

  async function visitModules(directory) {
    const realDirectory = await existingRealPath(directory)
    if (!realDirectory || visitedModules.has(realDirectory)) return
    visitedModules.add(realDirectory)
    for (const entry of await readdir(realDirectory, { withFileTypes: true })) {
      if (!isDirectoryEntry(entry)) continue
      const child = join(realDirectory, entry.name)
      if (entry.name === '.pnpm') {
        // The virtual store contains package/node_modules trees, plus an
        // optional hoisted node_modules tree. Do not walk package assets.
        for (const stored of await readdir(child, { withFileTypes: true })) {
          if (!isDirectoryEntry(stored)) continue
          await visitModules(stored.name === 'node_modules'
            ? join(child, stored.name)
            : join(child, stored.name, 'node_modules'))
        }
      } else if (entry.name.startsWith('.')) {
        continue
      } else if (entry.name.startsWith('@')) {
        for (const scoped of await readdir(child, { withFileTypes: true })) {
          if (isDirectoryEntry(scoped)) await inspectPackage(join(child, scoped.name), `${entry.name}/${scoped.name}`)
        }
      } else {
        await inspectPackage(child, entry.name)
      }
    }
  }

  await visitModules(modulesRoot)
  return found
}

export async function findLensPrivateHarnessPackages(modulesRoot) {
  const lensRoot = await realpath(join(modulesRoot, 'dsh-mcp-lens'))
  const lensManifest = JSON.parse(await readFile(join(lensRoot, 'package.json'), 'utf8'))
  const candidates = await collectDeepSeekHarnessPackages(join(lensRoot, 'node_modules'))
  const lensRequire = createRequire(join(lensRoot, 'package.json'))
  const declaredHarnessPackages = new Set(Object.keys({
    ...lensManifest.dependencies,
    ...lensManifest.peerDependencies,
  }).filter(isHarnessPackage))

  // With a linked Lens package, its peer may resolve from a sibling pnpm
  // node_modules directory instead of Lens/node_modules. Compare identities.
  for (const name of declaredHarnessPackages) {
    const manifestPath = await realpath(lensRequire.resolve(`${name}/package.json`))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.name !== name) throw new Error(`Unexpected Lens peer package: ${manifestPath}`)
    candidates.push({ name, version: manifest.version, path: dirname(manifestPath), realPath: dirname(manifestPath) })
  }

  const privatePackages = new Map()
  for (const pkg of candidates) {
    const hostRoot = await existingRealPath(resolve(modulesRoot, pkg.name))
    if (hostRoot !== pkg.realPath) privatePackages.set(pkg.realPath, pkg)
  }
  return [...privatePackages.values()]
}

export function assertNoProfileHarnessPackages(packages) {
  if (packages.length > 0) {
    throw new Error(`Profile installed a private DeepSeek Harness graph; use the CLI host packages:\n${packages
      .map(pkg => `- ${pkg.name}@${pkg.version}: ${pkg.path}`)
      .join('\n')}`)
  }
}
