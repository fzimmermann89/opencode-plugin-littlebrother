import type { PluginInput } from '@opencode-ai/plugin'
import type { LittleBrotherConfig } from '../config'
import type { SupervisorClient } from '../supervisor-client'
import type { SessionState, ToolExecuteBeforeOutput, ToolExecuteInput } from '../types'
import type { Logger } from '../utils/logger'
import { showToast } from '../utils/notifications'

export class GatekeeperBlockError extends Error {
  constructor(reason: string) {
    super(`[LittleBrother] Blocked: ${reason}`)
    this.name = 'GatekeeperBlockError'
  }
}

export function createActionGatekeeper(
  client: PluginInput['client'],
  supervisorClient: SupervisorClient,
  config: LittleBrotherConfig,
  logger: Logger,
  sessionStates: Map<string, SessionState>,
) {
  const handler = async (input: ToolExecuteInput, output: ToolExecuteBeforeOutput): Promise<void> => {
    if (!config.gatekeeper.enabled) return
    if (supervisorClient.isInternalSession(input.sessionID)) return

    const toolName = input.tool.toLowerCase()

    if (config.gatekeeper.blockedTools.some((t) => t.toLowerCase() === toolName)) {
      logger.info('Tool blocked by policy', { tool: input.tool, sessionID: input.sessionID })
      throw new GatekeeperBlockError(`Tool "${input.tool}" is blocked by policy`)
    }

    if (config.gatekeeper.alwaysAllowTools.some((t) => t.toLowerCase() === toolName)) {
      logger.debug('Tool allowed by whitelist', { tool: input.tool })
      return
    }

    const state = sessionStates.get(input.sessionID)
    const userGoal = state?.userGoal || 'Unknown goal'

    const payload = JSON.stringify({
      tool: input.tool,
      args: output.args,
    })

    try {
      logger.debug('Gatekeeper check', { tool: input.tool, sessionID: input.sessionID })

      const decision = await supervisorClient.query(input.sessionID, 'gatekeeper', payload, { userGoal })

      if (decision.status === 'BLOCK') {
        logger.warn('Gatekeeper blocked tool', {
          tool: input.tool,
          sessionID: input.sessionID,
          reason: decision.reason,
        })
        await showToast(client, `Blocked ${input.tool}: ${decision.reason}`, 'warning')
        throw new GatekeeperBlockError(decision.reason)
      }

      logger.debug('Gatekeeper allowed tool', { tool: input.tool, reason: decision.reason })
    } catch (err) {
      if (err instanceof GatekeeperBlockError) throw err

      logger.warn('Gatekeeper supervisor check failed', { tool: input.tool, error: String(err) })

      if (config.failOpen) {
        await showToast(client, `Supervisor unavailable - allowing ${input.tool} (fail-open)`, 'warning')
        return
      }

      await showToast(client, `Supervisor unavailable - blocking ${input.tool} (fail-closed)`, 'error')
      throw new GatekeeperBlockError('Supervisor unavailable and fail-closed policy is active')
    }
  }

  return { 'tool.execute.before': handler }
}
