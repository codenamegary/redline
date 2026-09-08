import { readEffectiveSettings } from "../../store/settings.store"
import { RouteDescriptor, RoutesContext } from "../routes.context"

export const getSettingsRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "GET",
  url: "/api/v1/settings",
  handler: async () => readEffectiveSettings(ctx.store.home),
})
