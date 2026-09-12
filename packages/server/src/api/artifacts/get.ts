import { readArtifactMeta } from "../../store/artifact.store"
import { IdParamsSchema } from "@redline/http-contracts/artifact.schemas"
import { origin, RouteDescriptor, RoutesContext } from "../routes.context"

export const getArtifactRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "GET",
  url: "/api/v1/artifacts/:id",
  handler: async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    const meta = await readArtifactMeta(ctx.store, id)
    const from = origin(request)
    return {
      ...(await ctx.summarizeArtifact(from, meta)),
      prompt: meta.prompt,
      cwd: meta.cwd,
      iteratedAt: meta.iteratedAt ?? null,
      versions: meta.versions,
    }
  },
})
