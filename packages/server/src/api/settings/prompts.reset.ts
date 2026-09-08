import {
  defaultSettings,
  loadSettings,
  readEffectiveSettings,
  saveSettings,
} from "../../store/settings.store"

import { RouteDescriptor, RoutesContext } from "../routes.context"

export const resetPromptsRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/settings/prompts/reset",
  handler: async () => {
    const settings = await loadSettings(ctx.store.home)
    await saveSettings(ctx.store.home, { ...settings, prompts: defaultSettings().prompts })
    return readEffectiveSettings(ctx.store.home)
  },
})
