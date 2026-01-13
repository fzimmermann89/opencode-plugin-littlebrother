import type { PluginInput } from '@opencode-ai/plugin';

type Level = 'info' | 'warning' | 'error';

type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export async function injectSupervisorMessage(
  client: PluginInput['client'],
  sessionID: string,
  message: string,
  level: Level = 'warning',
  directory?: string
): Promise<void> {
  const icon = level === 'error' ? '🚫' : level === 'warning' ? '⚠️' : 'ℹ️';

  try {
    await client.session.prompt({
      path: { id: sessionID },
      query: directory ? { directory } : undefined,
      body: {
        noReply: true,
        parts: [{ type: 'text', text: `${icon} [LittleBrother] ${message}` }],
      },
    });
  } catch {}
}

export async function showToast(
  client: PluginInput['client'],
  message: string,
  variant: ToastVariant = 'warning'
): Promise<void> {
  try {
    await client.tui.showToast({
      body: {
        message: `[LittleBrother] ${message}`,
        variant,
      },
    });
  } catch {}
}
