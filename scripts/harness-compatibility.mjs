export const harnessPackages = Object.freeze([
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
])

const harnessPeerPackages = ['@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-tools']
const numericIdentifier = '(?:0|[1-9][0-9]*)'
const prereleaseIdentifier = `(?:${numericIdentifier}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const exactVersion = new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)

function requireExactVersion(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !exactVersion.test(value)) {
    throw new Error(`${label} must be an exact SemVer version; tags, ranges and URLs are not accepted`)
  }
  return value
}

export function resolveHarnessCompatibility(manifest, argv, { allowOutput = false } = {}) {
  let requestedVersion
  let outputPath
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index]
    if (argument !== '--harness-version' && !(allowOutput && argument === '--output')) {
      throw new Error(`Unknown verification argument: ${argument}`)
    }
    if (seen.has(argument)) throw new Error(`Duplicate verification argument: ${argument}`)
    seen.add(argument)
    const value = argv[index + 1]
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) {
      throw new Error(`Missing value for ${argument}`)
    }
    if (argument === '--harness-version') requestedVersion = requireExactVersion(value, argument)
    else outputPath = value
  }

  const developmentVersion = requireExactVersion(
    manifest.devDependencies?.['@deepseek-ai/dsh-tools'],
    'DeepSeek Harness development version',
  )
  for (const packageName of harnessPackages) {
    if (manifest.devDependencies?.[packageName] !== developmentVersion) {
      throw new Error(`DeepSeek Harness development packages must stay in lockstep: ${packageName}`)
    }
  }

  const harnessVersion = requestedVersion ?? developmentVersion
  for (const packageName of harnessPeerPackages) {
    const range = manifest.peerDependencies?.[packageName]
    const versions = typeof range === 'string' ? range.split(' || ') : []
    if (versions.length === 0 || new Set(versions).size !== versions.length) {
      throw new Error(`${packageName} peers must be a unique exact-version set separated by ' || '`)
    }
    for (const version of versions) requireExactVersion(version, `${packageName} peer`)
    if (!versions.includes(harnessVersion)) {
      throw new Error(`DeepSeek Harness ${harnessVersion} is not declared in ${packageName} peers`)
    }
  }

  return {
    harnessVersion,
    versionSelection: requestedVersion === undefined ? 'devDependencies' : 'command-line',
    outputPath,
  }
}
