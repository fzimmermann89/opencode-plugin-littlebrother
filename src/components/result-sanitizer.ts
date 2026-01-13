import type { PluginInput } from '@opencode-ai/plugin';
import type { LittleBrotherConfig } from '../config';
import type { SupervisorClient } from '../supervisor-client';
import type { ToolExecuteAfterOutput, ToolExecuteInput } from '../types';
import type { Logger } from '../utils/logger';
import { showToast } from '../utils/notifications';

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|password|token|auth|credential)[\s:=]+['"]?[\w\-/+=]{20,}['"]?/gi,
  /(?:sk-|pk_|rk_|ghp_|gho_|glpat-|xox[baprs]-|AKIA|ASIA)[\w\-]{16,}/g,
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s]+:[^\s]+@[^\s]+/gi,
  /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
];

export function createResultSanitizer(
  client: PluginInput['client'],
  supervisorClient: SupervisorClient,
  config: LittleBrotherConfig,
  logger: Logger
) {
  const handler = async (
    input: ToolExecuteInput,
    output: ToolExecuteAfterOutput
  ): Promise<void> => {
    if (!config.sanitizer.enabled) return;
    if (supervisorClient.isInternalSession(input.sessionID)) return;

    await showToast(client, `🧹 Sanitizer: checking ${input.tool} output...`, 'info');

    let content = output.output;
    let modified = false;
    const redactions: string[] = [];

    if (content.length > config.sanitizer.maxOutputChars) {
      const truncatedLength = config.sanitizer.maxOutputChars;
      content = `${content.slice(0, truncatedLength)}\n\n[TRUNCATED: Output exceeded ${config.sanitizer.maxOutputChars} characters]`;
      modified = true;
      logger.debug('Truncated output', { tool: input.tool, originalLength: output.output.length });
    }

    if (config.sanitizer.redactSecrets) {
      for (const pattern of SECRET_PATTERNS) {
        const matches = content.match(pattern);
        if (matches) {
          for (const match of matches) {
            redactions.push(`${match.slice(0, 10)}...`);
          }
          content = content.replace(pattern, '[REDACTED: Potential secret]');
          modified = true;
        }
      }

      if (redactions.length > 0) {
        logger.warn('Redacted potential secrets', {
          tool: input.tool,
          sessionID: input.sessionID,
          count: redactions.length,
        });
        await showToast(client, `Redacted ${redactions.length} potential secret(s)`, 'warning');
      }
    }

    if (config.sanitizer.deepAnalysis && !modified && content.length > 1000) {
      try {
        const sampleContent = content.slice(0, 2000);
        const decision = await supervisorClient.query(input.sessionID, 'sanitizer', sampleContent);

        if (decision.status === 'REDACT' && decision.replacement) {
          content = decision.replacement;
          modified = true;
          logger.info('Deep analysis triggered redaction', {
            tool: input.tool,
            reason: decision.reason,
          });
          await showToast(client, `Content redacted: ${decision.reason}`, 'warning');
        }
      } catch (err) {
        logger.warn('Sanitizer deep analysis failed', { error: String(err) });
        await showToast(
          client,
          'Supervisor unavailable - sanitizer deep analysis skipped',
          'warning'
        );
      }
    }

    if (modified) {
      output.output = content;
    }
  };

  return { 'tool.execute.after': handler };
}
