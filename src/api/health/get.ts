import { RouteDescriptor, RoutesContext } from "../routes.context"

export const getHealth = (ctx: RoutesContext): RouteDescriptor => ({
  method: "GET",
  url: "/api/v1/health",
  handler: async () => ({ ok: true, service: "redline", home: ctx.store.home }),
})
