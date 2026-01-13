import type { Plugin } from '@opencode-ai/plugin'
import { z } from 'zod'
import { createActionGatekeeper, createResultSanitizer, createStreamWatchdog } from './components'
import { DEFAULT_SUPERVISOR_MODEL, LittleBrotherConfigSchema, parseModelString } from './config'
import type { LittleBrotherConfig } from './config'
import { SupervisorClient } from './supervisor-client'
import type { EventPayload, SessionState } from './types'
import { createLogger } from './utils'
import { showToast } from './utils/notifications'

async function loadConfig(ctx: {
  directory: string
  client: {
    config: { get: (args?: { query?: { directory?: string } }) => Promise<{ data?: Record<string, unknown> }> }
  }
}): Promise<{
  pluginRaw: unknown
  smallModel: string | undefined
}> {
  const resp = await ctx.client.config.get({ query: { directory: ctx.directory } })
  const rawConfig = resp?.data || {}

  const plugins = (rawConfig as Record<string, unknown>).plugins as Record<string, unknown> | undefined
  const pluginRaw =
    (rawConfig as Record<string, unknown>).littlebrother ||
    plugins?.littlebrother ||
    plugins?.['opencode-plugin-littlebrother'] ||
    {}

  const smallModel =
    typeof (rawConfig as Record<string, unknown>).small_model === 'string'
      ? String((rawConfig as Record<string, unknown>).small_model)
      : undefined

  return { pluginRaw, smallModel }
}

async function buildDisabledTools(
  client: { tool: { ids: (args: { query?: { directory?: string } }) => Promise<{ data?: string[] }> } },
  directory: string,
): Promise<Record<string, boolean>> {
  try {
    const idsResp = await client.tool.ids({ query: { directory } })
    const ids = idsResp?.data || []
    const map: Record<string, boolean> = {}
    for (const id of ids) {
      map[id] = false
    }
    return map
  } catch {
    return {
      task: false,
      bash: false,
      interactive_bash: false,
      write: false,
      edit: false,
      webfetch: false,
      call_omo_agent: false,
      sisyphus_task: false,
      slashcommand: false,
    }
  }
}

const LittleBrotherPlugin: Plugin = async (ctx) => {
  const { pluginRaw, smallModel } = await loadConfig(ctx)

  const lenientPluginConfig = z
    .object({
      supervisor: z.object({ model: z.string().optional() }).default({}),
    })
    .passthrough()
  const basePluginConfig = lenientPluginConfig.parse(pluginRaw)

  const requestedSupervisorModel = basePluginConfig.supervisor.model
  const supervisorModelCandidate = requestedSupervisorModel ?? smallModel ?? DEFAULT_SUPERVISOR_MODEL

  let supervisorModel = DEFAULT_SUPERVISOR_MODEL
  let supervisorModelWasInvalid = false
  try {
    parseModelString(supervisorModelCandidate)
    supervisorModel = supervisorModelCandidate
  } catch {
    supervisorModelWasInvalid = requestedSupervisorModel !== undefined
  }

  const config: LittleBrotherConfig = LittleBrotherConfigSchema.parse({
    ...basePluginConfig,
    supervisor: { ...basePluginConfig.supervisor, model: supervisorModel },
  })

  const logger = createLogger(ctx.client, config.debug)

  const disabledTools = await buildDisabledTools(ctx.client, ctx.directory)

  const supervisorClient = new SupervisorClient({
    client: ctx.client,
    logger,
    config,
    directory: ctx.directory,
    model: config.supervisor.model ?? DEFAULT_SUPERVISOR_MODEL,
    disabledTools,
  })

  const sessionStates = new Map<string, SessionState>()

  logger.info('LittleBrother plugin initialized', {
    supervisorModel: config.supervisor.model ?? DEFAULT_SUPERVISOR_MODEL,
    failOpen: config.failOpen,
    watchdogEnabled: config.watchdog.enabled,
    gatekeeperEnabled: config.gatekeeper.enabled,
    sanitizerEnabled: config.sanitizer.enabled,
  })

  if (supervisorModelWasInvalid) {
    await showToast(
      ctx.client,
      `Invalid supervisor model "${requestedSupervisorModel}", using ${supervisorModel}`,
      'warning',
    )
  }

  const watchdog = config.watchdog.enabled
    ? createStreamWatchdog(ctx.client, supervisorClient, config, logger, sessionStates)
    : null

  const gatekeeper = config.gatekeeper.enabled
    ? createActionGatekeeper(ctx.client, supervisorClient, config, logger, sessionStates)
    : null

  const sanitizer = config.sanitizer.enabled
    ? createResultSanitizer(ctx.client, supervisorClient, config, logger)
    : null

  return {
    event: async (input: { event: EventPayload }) => {
      if (input.event.type === 'session.deleted') {
        const deletedID = (input.event.properties?.info as { id?: string })?.id
        if (deletedID) {
          supervisorClient.cleanupSession(deletedID)
          watchdog?.cleanup(deletedID)
          sessionStates.delete(deletedID)
        }
        return
      }

      const eventSessionID =
        input.event.properties?.part?.sessionID || (input.event.properties?.info as { id?: string })?.id || undefined

      if (supervisorClient.isInternalSession(eventSessionID)) return

      await watchdog?.event(input)
    },

    'chat.message': async (input, output) => {
      const sessionID = (input as { sessionID: string }).sessionID
      if (supervisorClient.isInternalSession(sessionID)) return

      const parts = (output as { parts?: Array<{ type: string; text?: string }> }).parts
      await watchdog?.['chat.message']?.({ sessionID }, { parts })
    },

    'tool.execute.before': async (input, output) => {
      const typedInput = input as { tool: string; sessionID: string; callID: string }
      if (supervisorClient.isInternalSession(typedInput.sessionID)) return

      await gatekeeper?.['tool.execute.before'](typedInput, output as { args: Record<string, unknown> })
    },

    'tool.execute.after': async (input, output) => {
      const typedInput = input as { tool: string; sessionID: string; callID: string }
      if (supervisorClient.isInternalSession(typedInput.sessionID)) return

      await sanitizer?.['tool.execute.after'](
        typedInput,
        output as { title: string; output: string; metadata: unknown },
      )
    },
  }
}

export default LittleBrotherPlugin

export { LittleBrotherConfigSchema } from './config'
export type { LittleBrotherConfig, SupervisorModelConfig } from './config'
export type { SupervisorDecision } from './types'
export { GatekeeperBlockError } from './components'
