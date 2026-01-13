import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createResultSanitizer } from '../components/result-sanitizer'
import type { LittleBrotherConfig } from '../config'
import { LittleBrotherConfigSchema } from '../config'

const createMockLogger = () => ({
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
})

const createMockClient = () => ({
  tui: {
    showToast: mock(() => Promise.resolve({ data: true })),
  },
})

const createMockSupervisorClient = (decision = { status: 'SAFE' as const, reason: 'OK' }) => ({
  query: mock(() => Promise.resolve(decision)),
  isInternalSession: mock(() => false),
})

const createConfig = (overrides: Partial<LittleBrotherConfig> = {}): LittleBrotherConfig => {
  return LittleBrotherConfigSchema.parse(overrides)
}

describe('ResultSanitizer', () => {
  let mockLogger: ReturnType<typeof createMockLogger>
  let mockClient: ReturnType<typeof createMockClient>

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockClient = createMockClient()
  })

  test('should truncate long output', async () => {
    const config = createConfig({ sanitizer: { maxOutputChars: 1000 } })
    const supervisorClient = createMockSupervisorClient()
    const sanitizer = createResultSanitizer(mockClient as never, supervisorClient as never, config, mockLogger)

    const output = { title: 'test', output: 'x'.repeat(2000), metadata: {} }
    await sanitizer['tool.execute.after']({ tool: 'bash', sessionID: 'test', callID: '1' }, output)

    expect(output.output.length).toBeLessThan(2000)
    expect(output.output).toContain('[TRUNCATED')
  })

  test('should redact API keys', async () => {
    const config = createConfig({ sanitizer: { redactSecrets: true } })
    const supervisorClient = createMockSupervisorClient()
    const sanitizer = createResultSanitizer(mockClient as never, supervisorClient as never, config, mockLogger)

    const output = {
      title: 'test',
      output: 'Config: api_key="sk-1234567890abcdefghijklmnop"',
      metadata: {},
    }
    await sanitizer['tool.execute.after']({ tool: 'read', sessionID: 'test', callID: '1' }, output)

    expect(output.output).toContain('[REDACTED')
    expect(output.output).not.toContain('sk-1234567890')
    expect(mockLogger.warn).toHaveBeenCalled()
  })

  test('should use deep analysis when enabled', async () => {
    const config = createConfig({ sanitizer: { deepAnalysis: true } })
    const supervisorClient = createMockSupervisorClient({
      status: 'REDACT',
      reason: 'Found PII',
      replacement: '[Content redacted for privacy]',
    })
    const sanitizer = createResultSanitizer(mockClient as never, supervisorClient as never, config, mockLogger)

    const output = { title: 'test', output: 'a'.repeat(1500), metadata: {} }
    await sanitizer['tool.execute.after']({ tool: 'read', sessionID: 'test', callID: '1' }, output)

    expect(supervisorClient.query).toHaveBeenCalledWith('test', 'sanitizer', expect.any(String))
    expect(output.output).toBe('[Content redacted for privacy]')
  })
})
