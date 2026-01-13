import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { GatekeeperBlockError, createActionGatekeeper } from '../components/action-gatekeeper'
import type { LittleBrotherConfig } from '../config'
import { LittleBrotherConfigSchema } from '../config'
import type { SessionState } from '../types'

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

const createMockSupervisorClient = (decision = { status: 'ALLOW' as const, reason: 'OK' }) => ({
  query: mock(() => Promise.resolve(decision)),
  isInternalSession: mock(() => false),
})

const createConfig = (overrides: Partial<LittleBrotherConfig> = {}): LittleBrotherConfig => {
  return LittleBrotherConfigSchema.parse(overrides)
}

describe('ActionGatekeeper', () => {
  let mockLogger: ReturnType<typeof createMockLogger>
  let mockClient: ReturnType<typeof createMockClient>
  let sessionStates: Map<string, SessionState>

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockClient = createMockClient()
    sessionStates = new Map()
  })

  test('should allow whitelisted tools without supervisor check', async () => {
    const config = createConfig({ gatekeeper: { alwaysAllowTools: ['read', 'glob'] } })
    const supervisorClient = createMockSupervisorClient()
    const gatekeeper = createActionGatekeeper(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await gatekeeper['tool.execute.before'](
      { tool: 'read', sessionID: 'test', callID: '1' },
      { args: { filePath: '/test.txt' } },
    )

    expect(supervisorClient.query).not.toHaveBeenCalled()
  })

  test('should block blacklisted tools immediately', async () => {
    const config = createConfig({ gatekeeper: { blockedTools: ['rm', 'dangerous'] } })
    const supervisorClient = createMockSupervisorClient()
    const gatekeeper = createActionGatekeeper(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await expect(
      gatekeeper['tool.execute.before']({ tool: 'dangerous', sessionID: 'test', callID: '1' }, { args: {} }),
    ).rejects.toThrow(GatekeeperBlockError)

    expect(supervisorClient.query).not.toHaveBeenCalled()
  })

  test('should query supervisor for unknown tools', async () => {
    const config = createConfig()
    const supervisorClient = createMockSupervisorClient({ status: 'ALLOW', reason: 'Safe operation' })
    const gatekeeper = createActionGatekeeper(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await gatekeeper['tool.execute.before'](
      { tool: 'custom_tool', sessionID: 'test', callID: '1' },
      { args: { foo: 'bar' } },
    )

    expect(supervisorClient.query).toHaveBeenCalledWith(
      'test',
      'gatekeeper',
      expect.stringContaining('custom_tool'),
      expect.any(Object),
    )
  })

  test('should block when supervisor returns BLOCK', async () => {
    const config = createConfig()
    const supervisorClient = createMockSupervisorClient({ status: 'BLOCK', reason: 'Dangerous operation' })
    const gatekeeper = createActionGatekeeper(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await expect(
      gatekeeper['tool.execute.before'](
        { tool: 'bash', sessionID: 'test', callID: '1' },
        { args: { command: 'rm -rf /' } },
      ),
    ).rejects.toThrow('Dangerous operation')
  })

  test('should fail-open when supervisor fails and failOpen=true', async () => {
    const config = createConfig({ failOpen: true })
    const supervisorClient = {
      query: mock(() => Promise.reject(new Error('Timeout'))),
      isInternalSession: mock(() => false),
    }
    const gatekeeper = createActionGatekeeper(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await gatekeeper['tool.execute.before']({ tool: 'bash', sessionID: 'test', callID: '1' }, { args: {} })

    expect(mockClient.tui.showToast).toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalled()
  })

  test('should fail-closed when supervisor fails and failOpen=false', async () => {
    const config = createConfig({ failOpen: false })
    const supervisorClient = {
      query: mock(() => Promise.reject(new Error('Timeout'))),
      isInternalSession: mock(() => false),
    }
    const gatekeeper = createActionGatekeeper(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await expect(
      gatekeeper['tool.execute.before']({ tool: 'bash', sessionID: 'test', callID: '1' }, { args: {} }),
    ).rejects.toThrow(GatekeeperBlockError)
  })

  test('should include user goal in supervisor query', async () => {
    const config = createConfig()
    const supervisorClient = createMockSupervisorClient()
    const gatekeeper = createActionGatekeeper(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    sessionStates.set('test-session', {
      userGoal: 'Build a REST API',
      tokenBuffer: [],
      lastCheckTokenCount: 0,
      aborting: false,
    })

    await gatekeeper['tool.execute.before'](
      { tool: 'write', sessionID: 'test-session', callID: '1' },
      { args: { filePath: '/api.ts' } },
    )

    expect(supervisorClient.query).toHaveBeenCalledWith('test-session', 'gatekeeper', expect.any(String), {
      userGoal: 'Build a REST API',
    })
  })
})
