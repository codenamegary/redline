import { RouteDescriptor, RoutesContext } from "../routes.context"
import { appVersion } from "../../version"

export const getHealth = (ctx: RoutesContext): RouteDescriptor => ({
  method: "GET",
  url: "/api/v1/health",
  handler: async () => ({ ok: true, service: "redline", version: appVersion(), home: ctx.store.home }),
})
