import { appendFile, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const LENS_SURFACE = Object.freeze({
  tools: 2,
  bytes: 1114,
})

export const MAX_TOOLS_FILE_BYTES = 64 * 1024 * 1024

export function extractTools(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") {
    if (Array.isArray(value.tools)) return value.tools
    if (Array.isArray(value.schemas)) return value.schemas
    if (
      value.request
      && typeof value.request === "object"
      && value.request.header
      && typeof value.request.header === "object"
      && Array.isArray(value.request.header.tools)
    ) return value.request.header.tools
  }

  throw new Error("Expected a JSON array, a tools/schemas array, or a request.header.tools array.")
}

export function measurePayload(value) {
  const tools = extractTools(value)
  const bytes = Buffer.byteLength(JSON.stringify(tools), "utf8")

  return {
    toolCount: tools.length,
    bytes,
    reductionPercent: reductionPercent(bytes, LENS_SURFACE.bytes),
  }
}

export function reductionPercent(currentBytes, lensBytes) {
  if (currentBytes <= 0 || currentBytes <= lensBytes) return 0
  return ((currentBytes - lensBytes) / currentBytes) * 100
}

export function parsePayload(raw) {
  let text
  try {
    text = typeof raw === "string"
      ? raw
      : new TextDecoder("utf-8", { fatal: true }).decode(raw)
  } catch {
    throw new Error("The tools file must contain valid UTF-8 JSON.")
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("The tools file must contain valid UTF-8 JSON.")
  }

  return parsed
}

function assertInsideWorkspace(workspacePath, filePath) {
  const relation = relative(workspacePath, filePath)
  const outside = relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)
  if (outside) throw new Error("The tools file must resolve inside GITHUB_WORKSPACE.")
}

export function assertToolsFileSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_TOOLS_FILE_BYTES) {
    throw new Error(`The tools file must not exceed ${MAX_TOOLS_FILE_BYTES} bytes.`)
  }
}

export function parseOptionalLimit(value, label) {
  const text = value?.trim()
  if (!text) return undefined
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${label} must be a positive integer.`)

  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a positive safe integer.`)
  return parsed
}

export function budgetViolations(measurement, budgets = {}) {
  const violations = []
  if (budgets.maxTools !== undefined && measurement.toolCount > budgets.maxTools) {
    violations.push(`tool count ${measurement.toolCount} exceeds ${budgets.maxTools}`)
  }
  if (budgets.maxSchemaBytes !== undefined && measurement.bytes > budgets.maxSchemaBytes) {
    violations.push(`schema bytes ${measurement.bytes} exceeds ${budgets.maxSchemaBytes}`)
  }
  return Object.freeze(violations)
}

export async function resolveToolsFile(inputPath, workspacePath) {
  const workspace = await realpath(resolve(workspacePath))
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(workspace, inputPath)

  let filePath
  try {
    filePath = await realpath(candidate)
  } catch {
    throw new Error("The tools file does not exist or is not accessible.")
  }

  assertInsideWorkspace(workspace, filePath)

  const fileStats = await stat(filePath)
  if (!fileStats.isFile()) throw new Error("The tools-file input must identify a regular file.")
  assertToolsFileSize(fileStats.size)

  return filePath
}

export function buildOutputs(measurement) {
  return Object.freeze({
    "tool-count": String(measurement.toolCount),
    "schema-bytes": String(measurement.bytes),
    "lens-tool-count": String(LENS_SURFACE.tools),
    "lens-schema-bytes": String(LENS_SURFACE.bytes),
    "schema-byte-reduction-percent": measurement.reductionPercent.toFixed(3),
  })
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(value)
}

function comparison(current, lens, unit) {
  const difference = Math.abs(current - lens)
  if (current === lens) return `No ${unit} difference.`
  if (current > lens) return `${formatInteger(difference)} fewer ${unit} at the fixed Lens surface.`
  return `${formatInteger(difference)} more ${unit} at the fixed Lens surface.`
}

export function buildStepSummary(measurement, budgets = {}) {
  const violations = budgetViolations(measurement, budgets)
  const lines = [
    "## MCP Lens schema surface",
    "",
    "| Surface | Model-facing tools | Canonical `JSON.stringify(tools)` UTF-8 bytes |",
    "| --- | ---: | ---: |",
    `| Current input | ${formatInteger(measurement.toolCount)} | ${formatInteger(measurement.bytes)} B |`,
    `| Fixed MCP Lens benchmark | ${formatInteger(LENS_SURFACE.tools)} | ${formatInteger(LENS_SURFACE.bytes)} B |`,
    "",
    `- Tool-count comparison: **${comparison(measurement.toolCount, LENS_SURFACE.tools, "tools")}**`,
    `- Schema-byte comparison: **${comparison(measurement.bytes, LENS_SURFACE.bytes, "bytes")}**`,
    `- Schema-byte reduction versus this payload: **${measurement.reductionPercent.toFixed(3)}%**`,
  ]

  if (budgets.maxTools !== undefined || budgets.maxSchemaBytes !== undefined) {
    lines.push(
      "",
      `- Configured tool-count budget: **${budgets.maxTools === undefined ? "not set" : formatInteger(budgets.maxTools)}**`,
      `- Configured schema-byte budget: **${budgets.maxSchemaBytes === undefined ? "not set" : `${formatInteger(budgets.maxSchemaBytes)} B`}**`,
      `- Budget result: **${violations.length === 0 ? "PASS" : "FAIL"}**`,
    )
  }

  lines.push(
    "",
    "> Schema bytes only; this does not measure tokens, billing, latency, or task quality.",
    "",
  )
  return lines.join("\n")
}

async function writeOutputs(outputPath, outputs) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is unavailable.")
  const body = Object.entries(outputs).map(([name, value]) => `${name}=${value}`).join("\n")
  await appendFile(outputPath, `${body}\n`, "utf8")
}

async function writeStepSummary(summaryPath, summary) {
  if (!summaryPath) throw new Error("GITHUB_STEP_SUMMARY is unavailable.")
  await appendFile(summaryPath, summary, "utf8")
}

export async function run(environment = process.env) {
  const input = environment["INPUT_TOOLS-FILE"]?.trim()
  if (!input) throw new Error("The required tools-file input is empty.")
  const budgets = Object.freeze({
    maxTools: parseOptionalLimit(environment["INPUT_MAX-TOOLS"], "max-tools"),
    maxSchemaBytes: parseOptionalLimit(environment["INPUT_MAX-SCHEMA-BYTES"], "max-schema-bytes"),
  })

  const workspace = environment.GITHUB_WORKSPACE || process.cwd()
  const toolsFile = await resolveToolsFile(input, workspace)
  const payload = parsePayload(await readFile(toolsFile))
  const measurement = measurePayload(payload)

  await writeOutputs(environment.GITHUB_OUTPUT, buildOutputs(measurement))
  await writeStepSummary(environment.GITHUB_STEP_SUMMARY, buildStepSummary(measurement, budgets))

  const violations = budgetViolations(measurement, budgets)
  if (violations.length > 0) throw new Error(`Schema budget exceeded: ${violations.join("; ")}.`)

  return measurement
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : "Unknown failure."
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 500)
}

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  run().catch((error) => {
    console.error(`MCP Lens schema audit failed: ${safeErrorMessage(error)}`)
    process.exitCode = 1
  })
}
