import { describe, expect, test } from 'bun:test';
import { DEFAULT_SUPERVISOR_MODEL, LittleBrotherConfigSchema, parseModelString } from '../config';

describe('Config Schema', () => {
  test('should parse empty config with defaults', () => {
    const config = LittleBrotherConfigSchema.parse({});

    expect(config.supervisor).toBeDefined();
    expect(config.supervisor.model).toBeUndefined();
    expect(config.failOpen).toBe(true);
    expect(config.timeout).toBe(5000);
    expect(config.watchdog.enabled).toBe(true);
    expect(config.gatekeeper.enabled).toBe(true);
    expect(config.sanitizer.enabled).toBe(true);
  });

  test('should parse supervisor model string', () => {
    const config = LittleBrotherConfigSchema.parse({
      supervisor: { model: 'anthropic/claude-3-haiku-20240307' },
    });

    expect(config.supervisor.model).toBe('anthropic/claude-3-haiku-20240307');
    expect(parseModelString(config.supervisor.model ?? DEFAULT_SUPERVISOR_MODEL)).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-3-haiku-20240307',
    });
  });

  test('should reject invalid model string', () => {
    expect(() =>
      LittleBrotherConfigSchema.parse({
        supervisor: { model: 'invalid' },
      })
    ).toThrow();
  });

  test('should clamp timeout values', () => {
    const configLow = LittleBrotherConfigSchema.parse({ timeout: 500 });
    expect(configLow.timeout).toBe(1000);

    const configHigh = LittleBrotherConfigSchema.parse({ timeout: 60000 });
    expect(configHigh.timeout).toBe(30000);
  });

  test('default supervisor model is valid format', () => {
    expect(parseModelString(DEFAULT_SUPERVISOR_MODEL)).toBeDefined();
  });
});
