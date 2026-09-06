import { listArtifacts } from "../../store/artifact.store"

import { origin, RouteDescriptor, RoutesContext } from "../routes.context"

export const listArtifactsRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "GET",
  url: "/api/v1/artifacts",
  handler: async (request) => {
    const metas = await listArtifacts(ctx.store)
    return Promise.all(metas.map((meta) => ctx.summarizeArtifact(origin(request), meta)))
  },
})
