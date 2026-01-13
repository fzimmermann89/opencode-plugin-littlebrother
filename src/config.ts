import { z } from 'zod';

const clampNumber = (value: unknown, min: number, max: number): unknown => {
  if (typeof value !== 'number' || Number.isNaN(value)) return value;
  return Math.min(max, Math.max(min, value));
};

export const DEFAULT_SUPERVISOR_MODEL = 'google/gemini-2.5-flash';

const modelStringSchema = z.string().refine((v) => {
  const parts = v.split('/');
  return parts.length >= 2 && parts[0].length > 0 && parts.slice(1).join('/').length > 0;
}, 'Expected model in "provider/model" format');

export const SupervisorModelConfigSchema = z
  .object({
    model: modelStringSchema.optional(),
  })
  .default(() => ({}));

export type SupervisorModelConfig = z.infer<typeof SupervisorModelConfigSchema>;

export const WatchdogConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    checkIntervalTokens: z.preprocess((v) => clampNumber(v, 100, 5000), z.number()).default(500),
    maxBufferTokens: z.preprocess((v) => clampNumber(v, 500, 10000), z.number()).default(2000),
  })
  .default(() => ({
    enabled: true,
    checkIntervalTokens: 500,
    maxBufferTokens: 2000,
  }));

export type WatchdogConfig = z.infer<typeof WatchdogConfigSchema>;

export const GatekeeperConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    blockedTools: z.array(z.string()).default([]),
    alwaysAllowTools: z
      .array(z.string())
      .default(['read', 'glob', 'grep', 'lsp_hover', 'lsp_diagnostics']),
  })
  .default(() => ({
    enabled: true,
    blockedTools: [],
    alwaysAllowTools: ['read', 'glob', 'grep', 'lsp_hover', 'lsp_diagnostics'],
  }));

export type GatekeeperConfig = z.infer<typeof GatekeeperConfigSchema>;

export const SanitizerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxOutputChars: z.preprocess((v) => clampNumber(v, 1000, 50000), z.number()).default(5000),
    redactSecrets: z.boolean().default(true),
    deepAnalysis: z.boolean().default(false),
  })
  .default(() => ({
    enabled: true,
    maxOutputChars: 5000,
    redactSecrets: true,
    deepAnalysis: false,
  }));

export type SanitizerConfig = z.infer<typeof SanitizerConfigSchema>;

export const LittleBrotherConfigSchema = z.object({
  supervisor: SupervisorModelConfigSchema,
  failOpen: z.boolean().default(true),
  timeout: z.preprocess((v) => clampNumber(v, 1000, 30000), z.number()).default(5000),
  watchdog: WatchdogConfigSchema,
  gatekeeper: GatekeeperConfigSchema,
  sanitizer: SanitizerConfigSchema,
  debug: z.boolean().default(false),
});

export type LittleBrotherConfig = z.infer<typeof LittleBrotherConfigSchema>;

export function parseModelString(model: string): { providerID: string; modelID: string } {
  const parts = model.split('/');
  if (parts.length < 2) {
    throw new Error(`Invalid model format: "${model}". Expected "provider/model" format.`);
  }
  return {
    providerID: parts[0],
    modelID: parts.slice(1).join('/'),
  };
}
