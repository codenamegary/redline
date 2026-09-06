import { DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "../../worker/prompts"

import { RouteDescriptor, RoutesContext } from "../routes.context"

// Shipped prompt templates: what "Reset template" refills from and what
// empty saved prompts fall back to. Static — no probe, no disk.
export const getSettingsDefaultsRoute = (_ctx: RoutesContext): RouteDescriptor => ({
  method: "GET",
  url: "/api/v1/settings/defaults",
  handler: async () => ({
    prompts: { reviewer: DEFAULT_REVIEWER_PROMPT, worker: DEFAULT_WORKER_PROMPT },
  }),
})
