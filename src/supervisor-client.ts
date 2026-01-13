import type { PluginInput } from '@opencode-ai/plugin'
import type { LittleBrotherConfig } from './config'
import { parseModelString } from './config'
import { GATEKEEPER_SYSTEM, SANITIZER_SYSTEM, WATCHDOG_SYSTEM } from './prompts'
import type { SupervisorDecision } from './types'
import type { Logger } from './utils/logger'
import { showToast } from './utils/notifications'

type ModelRef = { providerID: string; modelID: string }

type ToolsConfig = { [key: string]: boolean }

type PromptResponse = {
  parts?: Array<{ type: string; text?: string }>
}

const SYSTEM_PROMPTS = {
  watchdog: WATCHDOG_SYSTEM,
  gatekeeper: GATEKEEPER_SYSTEM,
  sanitizer: SANITIZER_SYSTEM,
} as const

function extractText(resp: PromptResponse): string {
  const parts = resp.parts ?? []
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim()
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise

  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('Supervisor timeout')), timeoutMs)
    promise
      .then((value) => {
        clearTimeout(id)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(id)
        reject(err)
      })
  })
}

export class SupervisorClient {
  private client: PluginInput['client']
  private logger: Logger
  private config: LittleBrotherConfig
  private directory: string
  private model: ModelRef
  private disabledTools: ToolsConfig

  private supervisorSessionByMainSession = new Map<string, string>()
  private creatingSupervisorSession = new Map<string, Promise<string>>()

  constructor(args: {
    client: PluginInput['client']
    logger: Logger
    config: LittleBrotherConfig
    directory: string
    model: string
    disabledTools: ToolsConfig
  }) {
    this.client = args.client
    this.logger = args.logger
    this.config = args.config
    this.directory = args.directory
    this.model = parseModelString(args.model)
    this.disabledTools = args.disabledTools
  }

  isInternalSession(sessionID: string | undefined): boolean {
    if (!sessionID) return false
    for (const internal of this.supervisorSessionByMainSession.values()) {
      if (internal === sessionID) return true
    }
    return false
  }

  cleanupSession(sessionID: string): void {
    for (const [mainID, internalID] of this.supervisorSessionByMainSession.entries()) {
      if (mainID === sessionID || internalID === sessionID) {
        this.supervisorSessionByMainSession.delete(mainID)
      }
    }
  }

  async query(
    mainSessionID: string,
    type: 'watchdog' | 'gatekeeper' | 'sanitizer',
    payload: string,
    context?: { userGoal?: string },
  ): Promise<SupervisorDecision> {
    const systemPrompt = SYSTEM_PROMPTS[type]
    const userContent = context?.userGoal ? `User Goal: ${context.userGoal}\n\nPayload:\n${payload}` : payload

    if (this.config.debug) {
      await showToast(this.client, `Supervisor[${type}]: Querying with payload length ${userContent.length}`, 'info')
    }

    const decision = await this.callWithRetry(mainSessionID, systemPrompt, userContent)

    if (this.config.debug) {
      await showToast(this.client, `Supervisor[${type}]: ${decision.status} - ${decision.reason}`, 'info')
    }

    return decision
  }

  private async ensureSupervisorSession(mainSessionID: string): Promise<string> {
    const existing = this.supervisorSessionByMainSession.get(mainSessionID)
    if (existing) return existing

    const inFlight = this.creatingSupervisorSession.get(mainSessionID)
    if (inFlight) return inFlight

    const createPromise = (async () => {
      const created = await this.client.session.create({
        query: { directory: this.directory },
        body: {
          parentID: mainSessionID,
          title: 'LittleBrother Supervisor',
        },
      })

      const id = created.data?.id
      if (!id) throw new Error('Supervisor session create returned no id')

      this.supervisorSessionByMainSession.set(mainSessionID, id)
      return id
    })()

    this.creatingSupervisorSession.set(mainSessionID, createPromise)
    try {
      return await createPromise
    } finally {
      this.creatingSupervisorSession.delete(mainSessionID)
    }
  }

  private async callWithRetry(
    mainSessionID: string,
    systemPrompt: string,
    userContent: string,
    retries = 2,
  ): Promise<SupervisorDecision> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.callOnce(mainSessionID, systemPrompt, userContent)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        this.logger.warn('Supervisor call failed', { attempt, error: lastError.message })

        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
        }
      }
    }

    throw lastError || new Error('Supervisor call failed')
  }

  private async callOnce(
    mainSessionID: string,
    systemPrompt: string,
    userContent: string,
  ): Promise<SupervisorDecision> {
    const supervisorSessionID = await this.ensureSupervisorSession(mainSessionID)

    const promptPromise = this.client.session.prompt({
      throwOnError: true,
      path: { id: supervisorSessionID },
      query: { directory: this.directory },
      body: {
        agent: 'general',
        model: this.model,
        system: systemPrompt,
        tools: this.disabledTools,
        parts: [{ type: 'text', text: userContent }],
      },
    })

    const response = await withTimeout(promptPromise, this.config.timeout)
    const data = response.data
    if (!data) throw new Error('Supervisor prompt returned no data')

    const text = extractText(data as unknown as PromptResponse)

    return this.parseResponse(text)
  }

  private parseResponse(rawResponse: string): SupervisorDecision {
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/)
      const jsonStr = jsonMatch ? jsonMatch[0] : rawResponse
      const parsed = JSON.parse(jsonStr)

      const status = String(parsed.status).toUpperCase()
      if (!['OK', 'ABORT', 'ALLOW', 'BLOCK', 'SAFE', 'REDACT'].includes(status)) {
        throw new Error('Invalid status')
      }

      return {
        status: status as SupervisorDecision['status'],
        reason: String(parsed.reason || 'No reason provided'),
        replacement: parsed.replacement ? String(parsed.replacement) : undefined,
      }
    } catch {
      this.logger.warn('Failed to parse supervisor response', { raw: rawResponse })
      return { status: 'OK', reason: 'Parse error - defaulting to OK' }
    }
  }
}
