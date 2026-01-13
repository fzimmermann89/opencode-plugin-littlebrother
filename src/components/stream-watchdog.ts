import type { PluginInput } from '@opencode-ai/plugin';
import type { LittleBrotherConfig } from '../config';
import type { SupervisorClient } from '../supervisor-client';
import type { EventPayload, SessionState } from '../types';
import type { Logger } from '../utils/logger';
import { injectSupervisorMessage, showToast } from '../utils/notifications';

export function createStreamWatchdog(
  client: PluginInput['client'],
  supervisorClient: SupervisorClient,
  config: LittleBrotherConfig,
  logger: Logger,
  sessionStates: Map<string, SessionState>
) {
  const pendingChecks = new Map<string, Promise<void>>();

  const getOrCreateSessionState = (sessionID: string): SessionState => {
    let state = sessionStates.get(sessionID);
    if (!state) {
      state = { tokenBuffer: [], lastCheckTokenCount: 0, aborting: false };
      sessionStates.set(sessionID, state);
    }
    return state;
  };

  const shouldShowFailureToast = (state: SessionState): boolean => {
    const now = Date.now();
    const last = state.lastSupervisorFailureToastAt || 0;
    if (now - last < 30_000) return false;
    state.lastSupervisorFailureToastAt = now;
    return true;
  };

  const handleEvent = async (input: { event: EventPayload }) => {
    if (!config.watchdog.enabled) return;
    if (input.event.type !== 'message.part.updated') return;

    const part = input.event.properties?.part;
    if (!part || part.type !== 'text') return;

    const sessionID = part.sessionID;
    if (supervisorClient.isInternalSession(sessionID)) return;

    const delta = input.event.properties?.delta || '';
    if (!delta) return;

    const state = getOrCreateSessionState(sessionID);
    if (state.aborting) return;

    if (delta.includes('[LittleBrother]')) return;

    state.tokenBuffer.push(delta);

    const totalChars = state.tokenBuffer.reduce((sum, t) => sum + t.length, 0);
    const charsSinceLastCheck = totalChars - state.lastCheckTokenCount;

    if (charsSinceLastCheck >= config.watchdog.checkIntervalTokens) {
      state.lastCheckTokenCount = totalChars;

      if (totalChars > config.watchdog.maxBufferTokens) {
        let remaining = totalChars;
        while (remaining > config.watchdog.maxBufferTokens && state.tokenBuffer.length > 0) {
          remaining -= state.tokenBuffer.shift()?.length || 0;
        }
      }

      if (pendingChecks.has(sessionID)) return;

      const checkPromise = performSupervisorCheck(sessionID, state);
      pendingChecks.set(sessionID, checkPromise);
      checkPromise.finally(() => pendingChecks.delete(sessionID));
    }
  };

  const performSupervisorCheck = async (sessionID: string, state: SessionState) => {
    const recentContent = state.tokenBuffer.slice(-50).join('');

    try {
      logger.debug('Watchdog check', { sessionID, contentLength: recentContent.length });
      await showToast(client, `🔍 Watchdog: checking response...`, 'info');

      const decision = await supervisorClient.query(sessionID, 'watchdog', recentContent, {
        userGoal: state.userGoal,
      });

      if (decision.status === 'ABORT') {
        state.aborting = true;
        logger.warn('Watchdog triggered abort', { sessionID, reason: decision.reason });

        await injectSupervisorMessage(
          client,
          sessionID,
          `Session aborted: ${decision.reason}`,
          'error'
        );
        await showToast(client, `Aborted: ${decision.reason}`, 'error');

        try {
          await client.session.abort({ path: { id: sessionID } });
        } catch (err) {
          logger.error('Failed to abort session', { sessionID, error: String(err) });
        }
      }
    } catch (err) {
      logger.warn('Watchdog supervisor check failed', { sessionID, error: String(err) });

      if (!config.failOpen) {
        state.aborting = true;
        await injectSupervisorMessage(
          client,
          sessionID,
          'Supervisor unavailable (fail-closed) - aborting session',
          'error'
        );
        await showToast(client, 'Supervisor unavailable - aborting session (fail-closed)', 'error');
        try {
          await client.session.abort({ path: { id: sessionID } });
        } catch (abortErr) {
          logger.error('Failed to abort session after supervisor failure', {
            sessionID,
            error: String(abortErr),
          });
        }
        return;
      }

      if (shouldShowFailureToast(state)) {
        await showToast(client, 'Supervisor unavailable - watchdog skipped (fail-open)', 'warning');
      }
    }
  };

  const handleChatMessage = async (
    input: { sessionID: string },
    output: { parts?: Array<{ type: string; text?: string }> }
  ) => {
    if (supervisorClient.isInternalSession(input.sessionID)) return;

    const textParts = output.parts?.filter((p) => p.type === 'text' && p.text);
    if (!textParts?.length) return;

    const state = getOrCreateSessionState(input.sessionID);
    state.userGoal = textParts
      .map((p) => p.text)
      .join(' ')
      .slice(0, 500);
  };

  const cleanup = (sessionID: string) => {
    sessionStates.delete(sessionID);
    pendingChecks.delete(sessionID);
  };

  return {
    event: handleEvent,
    'chat.message': handleChatMessage,
    cleanup,
  };
}
