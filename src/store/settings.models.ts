import { z } from "zod"

export const laneAdapters = ["acp", "opencode-sdk", "none"] as const

export const LaneAdapterSchema = z.enum(laneAdapters)

export type LaneAdapter = (typeof laneAdapters)[number]

export const lanePresets = ["opencode", "claude-code", "gemini", "codex", "custom"] as const

export const LanePresetSchema = z.enum(lanePresets)

export type LanePreset = (typeof lanePresets)[number]

export const LaneConfigSchema = z.object({
  adapter: LaneAdapterSchema,
  preset: LanePresetSchema,
  acpCommand: z.array(z.string().min(1)),
  model: z.string().default(""),
})

export type LaneConfig = z.infer<typeof LaneConfigSchema>

export const RedlineSettingsSchema = z.object({
  reviewer: LaneConfigSchema,
  worker: LaneConfigSchema,
  notifyOrigin: z.boolean().default(true),
  opencodeServerUrl: z.url().default("http://127.0.0.1:4096"),
  prompts: z.object({
    reviewer: z.string().default(""),
    worker: z.string().default(""),
  }),
})

export type RedlineSettings = z.infer<typeof RedlineSettingsSchema>
