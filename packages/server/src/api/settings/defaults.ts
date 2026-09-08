import { DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "../../worker/prompts"
import { ACP_PRESETS } from "../../worker/presets"

import { RouteDescriptor, RoutesContext } from "../routes.context"

// Shipped prompt templates: what "Reset template" refills from and what
// empty saved prompts fall back to. Static — no probe, no disk. Presets
// ride along so the settings UI prefills command boxes from the same table
// the server uses instead of a drifting client copy.
export const getSettingsDefaultsRoute = (_ctx: RoutesContext): RouteDescriptor => ({
  method: "GET",
  url: "/api/v1/settings/defaults",
  handler: async () => ({
    prompts: { reviewer: DEFAULT_REVIEWER_PROMPT, worker: DEFAULT_WORKER_PROMPT },
    presets: ACP_PRESETS,
  }),
})
