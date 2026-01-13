import type { Plugin } from '@opencode-ai/plugin';
import { z } from 'zod';
import { createActionGatekeeper, createResultSanitizer, createStreamWatchdog } from './components';
import { DEFAULT_SUPERVISOR_MODEL, LittleBrotherConfigSchema, parseModelString } from './config';
import type { LittleBrotherConfig } from './config';
import { SupervisorClient } from './supervisor-client';
import type { EventPayload, SessionState } from './types';
import { createLogger } from './utils';
import { showToast } from './utils/notifications';

async function loadPluginConfig(directory: string): Promise<unknown> {
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const configPath = path.join(directory, '.opencode', 'littlebrother.json');
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

const LittleBrotherPlugin: Plugin = async (ctx) => {
  try {
    const pluginRaw = await loadPluginConfig(ctx.directory);

    const lenientPluginConfig = z
      .object({
        supervisor: z.object({ model: z.string().optional() }).default({}),
      })
      .passthrough();
    const basePluginConfig = lenientPluginConfig.parse(pluginRaw);

    const requestedSupervisorModel = basePluginConfig.supervisor.model;

    let supervisorModel: string | undefined;
    if (requestedSupervisorModel) {
      try {
        parseModelString(requestedSupervisorModel);
        supervisorModel = requestedSupervisorModel;
      } catch {
        // Invalid model format in config - will use lazy-loaded small_model or default
      }
    }

    const config: LittleBrotherConfig = LittleBrotherConfigSchema.parse({
      ...basePluginConfig,
      supervisor: { ...basePluginConfig.supervisor, model: supervisorModel },
    });

    const logger = createLogger(ctx.client, config.debug);

    const supervisorClient = new SupervisorClient({
      client: ctx.client,
      logger,
      config,
      directory: ctx.directory,
    });

    const sessionStates = new Map<string, SessionState>();

    logger.info('LittleBrother plugin initialized', {
      supervisorModel: config.supervisor.model ?? 'lazy-loaded',
      failOpen: config.failOpen,
      watchdogEnabled: config.watchdog.enabled,
      gatekeeperEnabled: config.gatekeeper.enabled,
      sanitizerEnabled: config.sanitizer.enabled,
    });

    const watchdog = config.watchdog.enabled
      ? createStreamWatchdog(ctx.client, supervisorClient, config, logger, sessionStates)
      : null;

    const gatekeeper = config.gatekeeper.enabled
      ? createActionGatekeeper(ctx.client, supervisorClient, config, logger, sessionStates)
      : null;

    const sanitizer = config.sanitizer.enabled
      ? createResultSanitizer(ctx.client, supervisorClient, config, logger)
      : null;

    return {
      event: async (input: { event: EventPayload }) => {
        if (input.event.type === 'session.deleted') {
          const deletedID = (input.event.properties?.info as { id?: string })?.id;
          if (deletedID) {
            supervisorClient.cleanupSession(deletedID);
            watchdog?.cleanup(deletedID);
            sessionStates.delete(deletedID);
          }
          return;
        }

        const eventSessionID =
          input.event.properties?.part?.sessionID ||
          (input.event.properties?.info as { id?: string })?.id ||
          undefined;

        if (supervisorClient.isInternalSession(eventSessionID)) return;

        await watchdog?.event(input);
      },

      'chat.message': async (input, output) => {
        const sessionID = (input as { sessionID: string }).sessionID;
        if (supervisorClient.isInternalSession(sessionID)) return;

        const parts = (output as { parts?: Array<{ type: string; text?: string }> }).parts;
        await watchdog?.['chat.message']?.({ sessionID }, { parts });
      },

      'tool.execute.before': async (input, output) => {
        const typedInput = input as { tool: string; sessionID: string; callID: string };
        if (supervisorClient.isInternalSession(typedInput.sessionID)) return;

        await gatekeeper?.['tool.execute.before'](
          typedInput,
          output as { args: Record<string, unknown> }
        );
      },

      'tool.execute.after': async (input, output) => {
        const typedInput = input as { tool: string; sessionID: string; callID: string };
        if (supervisorClient.isInternalSession(typedInput.sessionID)) return;

        await sanitizer?.['tool.execute.after'](
          typedInput,
          output as { title: string; output: string; metadata: unknown }
        );
      },
    };
  } catch (err) {
    console.error('[LittleBrother] Fatal error:', err);
    throw err;
  }
};

export default LittleBrotherPlugin;
