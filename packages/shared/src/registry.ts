import { z } from 'zod';

export const limitsSchema = z
  .object({
    rpm: z.number().int().positive().optional(),
    rpd: z.number().int().positive().optional(),
    tpm: z.number().int().positive().optional(),
    tpd: z.number().int().positive().optional(),
  })
  .strict();

/** Rough capability class used by complexity routing: small = fast/cheap, large = strongest available. */
export const tierSchema = z.enum(['small', 'medium', 'large']);

export const capabilitySchema = z.enum(['chat', 'tools', 'json_mode', 'vision']);

export const modelSchema = z
  .object({
    id: z.string().min(1),
    family: z.string().optional(),
    capabilities: z.array(capabilitySchema).default(['chat']),
    tier: tierSchema.optional(),
    context: z.number().int().positive().optional(),
    limits: limitsSchema.default({}),
    quirks: z.array(z.string()).default([]),
    verified_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
      .optional(),
  })
  .strict();

export const providerSchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    base_url: z.string().url(),
    api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    auth: z.enum(['bearer']).default('bearer'),
    trains_on_prompts: z.boolean().optional(),
    models: z.array(modelSchema).min(1),
  })
  .strict();

export type Limits = z.infer<typeof limitsSchema>;
export type Tier = z.infer<typeof tierSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type ModelEntry = z.infer<typeof modelSchema>;
export type ProviderEntry = z.infer<typeof providerSchema>;

/** Distributable snapshot of the whole registry, published as a single file (+ optional detached signature). */
export const bundleSchema = z
  .object({
    version: z.number().int().nonnegative(),
    generated_at: z.string(),
    providers: z.array(providerSchema).min(1),
  })
  .strict();

export type RegistryBundle = z.infer<typeof bundleSchema>;
