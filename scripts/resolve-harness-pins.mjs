const concurrency = 6
const requestTimeoutMs = 15_000
const maximumPackages = 512
const isHarnessPackage = name => typeof name === 'string' && /^@deepseek-ai\/dsh(?:-[a-z0-9][a-z0-9._-]*)?$/.test(name)
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const numericIdentifier = '(?:0|[1-9][0-9]*)'
const prereleaseIdentifier = `(?:${numericIdentifier}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const exactVersionPattern = new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)

async function readRegistryManifest(name, version) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${url}`)
  return await response.json()
}

/**
 * Resolve the DSH dependency/peer closure at one exact published version.
 * readManifest(name, version) may be injected for local metadata or tests.
 */
export async function resolveHarnessPins(rootNames, exactVersion, readManifest = readRegistryManifest) {
  if (!Array.isArray(rootNames) || !rootNames.every(isHarnessPackage)) {
    throw new Error('Harness roots must be @deepseek-ai/dsh or @deepseek-ai/dsh-* package names')
  }
  if (typeof exactVersion !== 'string' || exactVersion !== exactVersion.trim() || !exactVersionPattern.test(exactVersion)) {
    throw new Error('Harness pins require an exact SemVer version; tags and ranges are not accepted')
  }
  if (typeof readManifest !== 'function') throw new Error('readManifest must be a function')

  const queued = new Set()
  const pending = []
  function enqueue(name) {
    if (queued.has(name)) return
    if (queued.size >= maximumPackages) throw new Error(`Harness dependency graph exceeds ${maximumPackages} packages at ${name}`)
    queued.add(name)
    pending.push(name)
  }
  for (const name of rootNames) enqueue(name)

  async function readDependencies(name) {
    try {
      const manifest = await readManifest(name, exactVersion)
      if (!isRecord(manifest) || manifest.name !== name || manifest.version !== exactVersion) {
        throw new Error(`Expected metadata for ${name}@${exactVersion}; received ${manifest?.name ?? '(missing name)'}@${manifest?.version ?? '(missing version)'}`)
      }
      const dependencies = []
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        if (manifest[field] === undefined) continue
        if (!isRecord(manifest[field])) throw new Error(`Invalid ${field} in package metadata`)
        dependencies.push(...Object.keys(manifest[field]).filter(isHarnessPackage))
      }
      return dependencies
    } catch (error) {
      throw new Error(`Cannot resolve Harness pins for ${name}@${exactVersion}: ${error?.message ?? String(error)}`, { cause: error })
    }
  }

  while (pending.length > 0) {
    const batch = pending.splice(0, concurrency)
    const results = await Promise.allSettled(batch.map(readDependencies))
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, failures.map(error => error.message).join('\n'))
    }
    for (const result of results) {
      if (result.status === 'fulfilled') for (const name of result.value) enqueue(name)
    }
  }

  return Object.fromEntries([...queued].sort().map(name => [name, exactVersion]))
}
