import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "../worker/prompts"
import { hasErrorCode } from "./errors"
import {
  ImageGenConfigSchema,
  LaneConfig,
  LaneConfigSchema,
  RedlineSettings,
  RedlineSettingsSchema,
} from "./settings.models"

export const settingsPath = (home: string): string => join(home, "settings.json")

// Shipped defaults: lane config from schema defaults, prompts from the
// worker templates. Built per call so callers can mutate their copy freely.
export const defaultSettings = (): RedlineSettings => {
  const lane = (): LaneConfig =>
    LaneConfigSchema.parse({
      adapter: "acp",
      preset: "opencode",
      acpCommand: ["opencode", "acp"],
    })
  return RedlineSettingsSchema.parse({
    reviewer: lane(),
    worker: lane(),
    imageGen: ImageGenConfigSchema.parse({}),
    prompts: { reviewer: DEFAULT_REVIEWER_PROMPT, worker: DEFAULT_WORKER_PROMPT },
  })
}

// Missing or corrupt settings fall back to defaults: the server must come up
// serving defaults even when the file was hand-edited into garbage.
export const loadSettings = async (home: string): Promise<RedlineSettings> => {
  let raw: string
  try {
    raw = await readFile(settingsPath(home), "utf8")
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return defaultSettings()
    throw error
  }
  try {
    return RedlineSettingsSchema.parse(JSON.parse(raw))
  } catch {
    return defaultSettings()
  }
}

// Pretty JSON, written atomically: tmp file first, then rename over the
// target. Only user-saved values reach disk; defaults are a read-time
// concern.
export const saveSettings = async (
  home: string,
  settings: RedlineSettings,
): Promise<RedlineSettings> => {
  const validated = RedlineSettingsSchema.parse(settings)
  const path = settingsPath(home)
  const tmpPath = path + ".tmp"
  await mkdir(home, { recursive: true })
  await writeFile(tmpPath, JSON.stringify(validated, null, 2) + "\n", "utf8")
  await rename(tmpPath, path)
  return validated
}

// Load plus empty-prompt fallback: blank prompt strings read as the shipped
// templates without ever being persisted.
export const readEffectiveSettings = async (home: string): Promise<RedlineSettings> => {
  const settings = await loadSettings(home)
  const defaults = defaultSettings()
  return {
    ...settings,
    prompts: {
      reviewer:
        settings.prompts.reviewer.length > 0 ? settings.prompts.reviewer : defaults.prompts.reviewer,
      worker: settings.prompts.worker.length > 0 ? settings.prompts.worker : defaults.prompts.worker,
    },
  }
}
