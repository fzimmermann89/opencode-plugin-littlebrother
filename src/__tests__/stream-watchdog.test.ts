import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createStreamWatchdog } from '../components/stream-watchdog'
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
  session: {
    abort: mock(() => Promise.resolve({ data: true })),
    prompt: mock(() => Promise.resolve({ data: {} })),
  },
  tui: {
    showToast: mock(() => Promise.resolve({ data: true })),
  },
})

const createMockSupervisorClient = (decision = { status: 'OK' as const, reason: 'All clear' }) => ({
  query: mock(() => Promise.resolve(decision)),
  isInternalSession: mock(() => false),
})

const createConfig = (overrides: Partial<LittleBrotherConfig> = {}): LittleBrotherConfig => {
  return LittleBrotherConfigSchema.parse(overrides)
}

describe('StreamWatchdog', () => {
  let mockLogger: ReturnType<typeof createMockLogger>
  let mockClient: ReturnType<typeof createMockClient>
  let sessionStates: Map<string, SessionState>

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockClient = createMockClient()
    sessionStates = new Map()
  })

  test('should capture user goal from chat message', async () => {
    const config = createConfig()
    const supervisorClient = createMockSupervisorClient()
    const watchdog = createStreamWatchdog(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await watchdog['chat.message'](
      { sessionID: 'test-session' },
      { parts: [{ type: 'text', text: 'Build a TODO app' }] },
    )

    const state = sessionStates.get('test-session')
    expect(state?.userGoal).toBe('Build a TODO app')
  })

  test('should accumulate tokens in buffer', async () => {
    const config = createConfig({ watchdog: { checkIntervalTokens: 1000 } })
    const supervisorClient = createMockSupervisorClient()
    const watchdog = createStreamWatchdog(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await watchdog.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: '1', type: 'text', sessionID: 'test', messageID: 'm1' },
          delta: 'Hello ',
        },
      },
    })

    await watchdog.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: '1', type: 'text', sessionID: 'test', messageID: 'm1' },
          delta: 'World!',
        },
      },
    })

    const state = sessionStates.get('test')
    expect(state?.tokenBuffer.join('')).toBe('Hello World!')
  })

  test('should trigger supervisor check after interval', async () => {
    const config = createConfig({ watchdog: { checkIntervalTokens: 100 } })
    const supervisorClient = createMockSupervisorClient()
    const watchdog = createStreamWatchdog(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await watchdog.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: '1', type: 'text', sessionID: 'test', messageID: 'm1' },
          delta: 'x'.repeat(150),
        },
      },
    })

    await new Promise((r) => setTimeout(r, 50))

    expect(supervisorClient.query).toHaveBeenCalled()
  })

  test('should abort session when supervisor returns ABORT', async () => {
    const config = createConfig({ watchdog: { checkIntervalTokens: 100 } })
    const supervisorClient = createMockSupervisorClient({ status: 'ABORT', reason: 'Infinite loop detected' })
    const watchdog = createStreamWatchdog(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await watchdog.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: '1', type: 'text', sessionID: 'abort-test', messageID: 'm1' },
          delta: 'x'.repeat(150),
        },
      },
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(mockClient.session.abort).toHaveBeenCalledWith({ path: { id: 'abort-test' } })
    expect(mockClient.session.prompt).toHaveBeenCalled()
    expect(mockClient.tui.showToast).toHaveBeenCalled()
  })

  test('should ignore non-text parts', async () => {
    const config = createConfig()
    const supervisorClient = createMockSupervisorClient()
    const watchdog = createStreamWatchdog(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await watchdog.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: '1', type: 'tool-invocation', sessionID: 'test', messageID: 'm1' },
          delta: 'some tool data',
        },
      },
    })

    expect(sessionStates.has('test')).toBe(false)
  })

  test('should cleanup session state', async () => {
    const config = createConfig()
    const supervisorClient = createMockSupervisorClient()
    const watchdog = createStreamWatchdog(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    sessionStates.set('cleanup-test', { tokenBuffer: ['test'], lastCheckTokenCount: 0, aborting: false })

    watchdog.cleanup('cleanup-test')

    expect(sessionStates.has('cleanup-test')).toBe(false)
  })

  test('should skip when disabled', async () => {
    const config = createConfig({ watchdog: { enabled: false } })
    const supervisorClient = createMockSupervisorClient()
    const watchdog = createStreamWatchdog(
      mockClient as never,
      supervisorClient as never,
      config,
      mockLogger,
      sessionStates,
    )

    await watchdog.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: '1', type: 'text', sessionID: 'test', messageID: 'm1' },
          delta: 'x'.repeat(1000),
        },
      },
    })

    expect(supervisorClient.query).not.toHaveBeenCalled()
  })
})
