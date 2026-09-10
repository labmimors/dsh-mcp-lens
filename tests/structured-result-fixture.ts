import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'structured-result-fixture', version: '1.0.0' })
server.registerTool('lookup_customer', {
  description: 'Return a runtime customer identifier in structured content.',
  inputSchema: { format: z.enum(['summary', 'empty', 'duplicate', 'resource', 'error']) },
}, async ({ format }) => {
  const structuredContent = { customerId: randomUUID(), region: 'eu' }
  const content = format === 'empty' ? []
    : format === 'resource' ? [{
      type: 'resource' as const,
      resource: { uri: 'fixture://private', mimeType: 'text/plain', text: 'PRIVATE_RESOURCE_MUST_NOT_APPEAR' },
    }]
      : [{ type: 'text' as const, text: format === 'duplicate' ? JSON.stringify(structuredContent) : 'Customer found.' }]
  return { content, structuredContent, ...(format === 'error' ? { isError: true } : {}),
    _meta: { privateTrace: 'PRIVATE_META_MUST_NOT_APPEAR' },
  }
})
await server.connect(new StdioServerTransport())
