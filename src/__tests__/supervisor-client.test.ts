import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { LittleBrotherConfigSchema } from '../config';
import { SupervisorClient } from '../supervisor-client';

const createMockLogger = () => ({
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
});

const createMockClient = () => ({
  session: {
    create: mock(() => Promise.resolve({ data: { id: 'supervisor-session-1' } })),
    prompt: mock(() =>
      Promise.resolve({
        data: {
          parts: [{ type: 'text', text: '{"status":"OK","reason":"ok"}' }],
        },
      })
    ),
  },
  config: {
    get: mock(() => Promise.resolve({ data: { small_model: 'google/gemini-3.0-flash' } })),
  },
  tool: {
    ids: mock(() => Promise.resolve({ data: ['bash', 'write', 'edit'] })),
  },
});

describe('SupervisorClient', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    logger = createMockLogger();
    client = createMockClient();
  });

  test('creates supervisor session per main session', async () => {
    const config = LittleBrotherConfigSchema.parse({ timeout: 2000 });

    const supervisor = new SupervisorClient({
      client: client as never,
      logger,
      config,
      directory: '/tmp',
    });

    await supervisor.query('main-session-1', 'watchdog', 'payload');
    await supervisor.query('main-session-1', 'watchdog', 'payload2');

    expect(client.session.create).toHaveBeenCalledTimes(1);
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
  });

  test('passes model, system, tools into prompt', async () => {
    const config = LittleBrotherConfigSchema.parse({
      timeout: 2000,
      supervisor: { model: 'anthropic/claude-3-haiku-20240307' },
    });

    const supervisor = new SupervisorClient({
      client: client as never,
      logger,
      config,
      directory: '/tmp',
    });

    await supervisor.query('main-session-1', 'gatekeeper', 'payload', { userGoal: 'Goal' });

    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: 'supervisor-session-1' },
        query: { directory: '/tmp' },
        body: expect.objectContaining({
          model: { providerID: 'anthropic', modelID: 'claude-3-haiku-20240307' },
          tools: { bash: false, write: false, edit: false },
          system: expect.any(String),
        }),
      })
    );
  });

  test('detects internal sessions', async () => {
    const config = LittleBrotherConfigSchema.parse({ timeout: 2000 });

    const supervisor = new SupervisorClient({
      client: client as never,
      logger,
      config,
      directory: '/tmp',
    });

    await supervisor.query('main-session-1', 'watchdog', 'payload');

    expect(supervisor.isInternalSession('supervisor-session-1')).toBe(true);
    expect(supervisor.isInternalSession('main-session-1')).toBe(false);
  });
});
