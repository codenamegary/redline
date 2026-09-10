import { z } from "zod"

export const laneAdapters = ["acp", "none"] as const

export const LaneAdapterSchema = z.enum(laneAdapters)

export type LaneAdapter = (typeof laneAdapters)[number]

export const lanePresets = ["opencode", "cursor", "claude-code", "gemini", "codex", "custom"] as const

export const LanePresetSchema = z.enum(lanePresets)

export type LanePreset = (typeof lanePresets)[number]

export const LaneConfigSchema = z.object({
  adapter: LaneAdapterSchema,
  preset: LanePresetSchema,
  acpCommand: z.array(z.string().min(1)),
})

export type LaneConfig = z.infer<typeof LaneConfigSchema>

// Optional image-generation setup. Config only: redline never spawns this
// agent — it records what the human wired up so capable agents know image
// generation is wanted and which model to prefer when attaching assets.
export const ImageGenConfigSchema = z.object({
  enabled: z.boolean().default(false),
  agent: z.string().default(""),
  model: z.string().default(""),
})

export type ImageGenConfig = z.infer<typeof ImageGenConfigSchema>

// imageGen arrives empty from pre-existing settings files; preprocess fills
// the object so schema defaults apply instead of failing the whole parse.
export const imageGenField = z.preprocess(
  (value) => (value === undefined || value === null ? {} : value),
  ImageGenConfigSchema,
)

export const RedlineSettingsSchema = z.object({
  reviewer: LaneConfigSchema,
  worker: LaneConfigSchema,
  imageGen: imageGenField,
  prompts: z.object({
    reviewer: z.string().default(""),
    worker: z.string().default(""),
  }),
})

export type RedlineSettings = z.infer<typeof RedlineSettingsSchema>

// ---------- responses ----------

// One ACP launcher preset: label plus the argv the settings UI drops into
// the command box when the preset is picked. Custom has no entry.
export const AcpPresetSchema = z.object({
  label: z.string(),
  argv: z.array(z.string()),
})

export type AcpPreset = z.infer<typeof AcpPresetSchema>

export const SettingsDefaultsSchema = z.object({
  prompts: z.object({
    reviewer: z.string(),
    worker: z.string(),
  }),
  presets: z.record(z.string(), AcpPresetSchema),
})

export type SettingsDefaults = z.infer<typeof SettingsDefaultsSchema>
