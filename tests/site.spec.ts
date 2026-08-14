import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const siteRoot = join(repositoryRoot, 'site')
const appPath = join(siteRoot, 'app.js')

interface SiteModule {
  BENCHMARK_SOURCE_FILES: readonly string[]
  LENS_SURFACE: Readonly<{ tools: number, bytes: number }>
  SAMPLE_TOOLS: readonly unknown[]
  measurePayload(value: unknown): {
    tools: readonly unknown[]
    toolCount: number
    bytes: number
    reductionPercent: number
  }
  reductionPercent(currentBytes: number, lensBytes: number): number
  utf8Bytes(value: string): number
}

async function loadSiteModule(): Promise<SiteModule> {
  return await import(pathToFileURL(appPath).href) as SiteModule
}

function localMarkdownTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)]
    .map(match => match[1])
    .filter((target): target is string => Boolean(target))
    .filter(target => !/^(?:https?:|mailto:|#)/.test(target))
    .map(target => decodeURIComponent(target.split('#', 1)[0] ?? ''))
}

const frozenPilotDate = '2026-08-14'

describe('catalog calculator publishing contract', () => {
  it('ships every referenced static asset and required DOM target', async () => {
    const assets = ['index.html', 'app.js', 'styles.css', 'favicon.svg']
    await Promise.all(assets.map(asset => access(join(siteRoot, asset))))

    const html = await readFile(join(siteRoot, 'index.html'), 'utf8')
    const requiredIds = [
      'schema-input',
      'status',
      'tool-count',
      'schema-bytes',
      'lens-surface',
      'reduction',
      'current-summary',
      'claim-boundary',
      'analyze-button',
      'sample-button',
      'clear-button',
      'copy-summary-button',
      'copy-command-button',
      'download-card-button',
      'share-card',
    ]

    for (const id of requiredIds) {
      expect(html).toMatch(new RegExp(`id=["']${id}["']`))
    }

    expect(html).toMatch(/<script\s+type=["']module["']\s+src=["']\.\/app\.js["']><\/script>/)
    expect(html).toContain('only the measurement summary and claim boundary')
    expect(html).not.toContain('includes the exact inputs')
  })

  it('keeps calculator execution local and avoids HTML injection sinks', async () => {
    const source = await readFile(appPath, 'utf8')
    const forbiddenBehaviors = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\bsendBeacon\s*\(/,
      /\bFormData\b/,
      /\.innerHTML\s*=/,
      /\.outerHTML\s*=/,
    ]

    for (const behavior of forbiddenBehaviors) {
      expect(source).not.toMatch(behavior)
    }
  })

  it('measures the fixed 1,000-tool sample with exact UTF-8 byte math', async () => {
    const site = await loadSiteModule()
    const measurement = site.measurePayload(site.SAMPLE_TOOLS)

    expect(measurement.toolCount).toBe(1_000)
    expect(measurement.bytes).toBe(294_894)
    expect(site.utf8Bytes(JSON.stringify(site.SAMPLE_TOOLS))).toBe(294_894)
    expect(measurement.reductionPercent).toBeCloseTo(99.62223714283776, 12)
    expect(site.reductionPercent(2_000, 1_000)).toBe(50)
    expect(site.reductionPercent(1_000, 1_114)).toBe(0)
  })

  it('keeps every local README link and card benchmark source resolvable', async () => {
    const site = await loadSiteModule()
    expect(site.BENCHMARK_SOURCE_FILES).toEqual([
      'benchmark/run.ts',
      'benchmark/README.md',
    ])

    const readmePaths = ['README.md', 'README.zh-CN.md']
    for (const readmePath of readmePaths) {
      const markdown = await readFile(join(repositoryRoot, readmePath), 'utf8')
      for (const target of localMarkdownTargets(markdown)) {
        await expect(access(join(repositoryRoot, target))).resolves.toBeUndefined()
      }
    }

    for (const sourceFile of site.BENCHMARK_SOURCE_FILES) {
      await expect(access(join(repositoryRoot, sourceFile))).resolves.toBeUndefined()
    }

    const appSource = await readFile(appPath, 'utf8')
    expect(appSource).toContain('Source: benchmark/run.ts + benchmark/README.md')
    expect(appSource).not.toContain('benchmark.json and benchmark/README.md')
  })

  it('publishes bilingual, crawlable study pages with the frozen pilot boundary', async () => {
    const englishPath = join(siteRoot, '1000-tool-tax', 'index.html')
    const chinesePath = join(siteRoot, 'zh-CN', '1000-tool-tax', 'index.html')
    const [english, chinese, home, robots, sitemap, styles] = await Promise.all([
      readFile(englishPath, 'utf8'),
      readFile(chinesePath, 'utf8'),
      readFile(join(siteRoot, 'index.html'), 'utf8'),
      readFile(join(siteRoot, 'robots.txt'), 'utf8'),
      readFile(join(siteRoot, 'sitemap.xml'), 'utf8'),
      readFile(join(siteRoot, 'styles.css'), 'utf8'),
    ])

    expect(home).toContain('href="./1000-tool-tax/"')
    expect(english).toContain('rel="canonical" href="https://labmimors.github.io/dsh-mcp-lens/1000-tool-tax/"')
    expect(chinese).toContain('rel="canonical" href="https://labmimors.github.io/dsh-mcp-lens/zh-CN/1000-tool-tax/"')
    expect(english).toContain('href="../styles.css"')
    expect(chinese).toContain('href="../../styles.css"')
    for (const html of [english, chinese]) {
      expect(html).toContain('hreflang="en"')
      expect(html).toContain('hreflang="zh-CN"')
      expect(html).toContain(`"datePublished": "${frozenPilotDate}"`)
      expect(html).toContain(`"dateModified": "${frozenPilotDate}"`)
      expect(html).toContain('674,249 B')
      expect(html).toContain('27,401 B')
      expect(html).toContain('$0.0307204')
      expect(html).toContain('$0.0034707')
      expect(html).toContain('61.711%')
      expect(html).toContain('491')
      expect(html).toContain('794')
      expect(html).not.toContain('2026-08-15')
      expect(html).not.toMatch(/<script(?!\s+type="application\/ld\+json")/)
    }

    expect(english).toContain('pricing retrieved on August 14, 2026')
    expect(english).toContain('Published August 14, 2026')
    expect(english).toContain('href="../"')
    expect(english).toContain('href="../zh-CN/1000-tool-tax/"')
    expect(chinese).toContain('2026-08-14 抓取的 DeepSeek 价格')
    expect(chinese).toContain('发布于 2026-08-14')
    expect(chinese).toContain('href="../../"')
    expect(chinese).toContain('href="../../1000-tool-tax/"')
    expect(english).toContain('aggregate usage accounting')
    expect(chinese).toContain('聚合 Usage 计算')
    expect(robots).toContain('Sitemap: https://labmimors.github.io/dsh-mcp-lens/sitemap.xml')
    expect(sitemap).toContain('<loc>https://labmimors.github.io/dsh-mcp-lens/</loc>')
    expect(sitemap).toContain('<loc>https://labmimors.github.io/dsh-mcp-lens/1000-tool-tax/</loc>')
    expect(sitemap).toContain('<loc>https://labmimors.github.io/dsh-mcp-lens/zh-CN/1000-tool-tax/</loc>')

    await Promise.all([
      access(join(siteRoot, 'favicon.svg')),
      access(join(siteRoot, 'styles.css')),
    ])

    expect(styles).toContain('.article-shell')
    expect(styles).toContain('.article-proof')
    expect(styles).toContain('width: min(1040px, calc(100% - 20px));')
  })

  it('pins every Pages action to the reviewed immutable revision', async () => {
    const workflow = await readFile(join(repositoryRoot, '.github/workflows/pages.yml'), 'utf8')
    expect(workflow).toContain('actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5')
    expect(workflow).toContain('actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b # v5')
    expect(workflow).toContain('actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b # v4')
    expect(workflow).toContain('actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4')
    expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|configure-pages|upload-pages-artifact|deploy-pages)@v\d+/)
  })
})
