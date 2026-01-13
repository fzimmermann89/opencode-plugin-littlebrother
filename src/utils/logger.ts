import type { PluginInput } from '@opencode-ai/plugin'
import type { LittleBrotherConfig } from '../config'

export function createLogger(client: PluginInput['client'], debug: boolean) {
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => {
    if (level === 'debug' && !debug) return

    client.app
      .log({
        body: {
          service: 'littlebrother',
          level,
          message,
          extra,
        },
      })
      .catch(() => {})
  }

  return {
    debug: (message: string, extra?: Record<string, unknown>) => log('debug', message, extra),
    info: (message: string, extra?: Record<string, unknown>) => log('info', message, extra),
    warn: (message: string, extra?: Record<string, unknown>) => log('warn', message, extra),
    error: (message: string, extra?: Record<string, unknown>) => log('error', message, extra),
  }
}

export type Logger = ReturnType<typeof createLogger>
