import { createArtifact } from "../../store/artifact.store"
import { readEffectiveSettings } from "../../store/settings.store"
import { workerRuntime } from "../../worker/dispatcher"
import { CreateArtifactBodySchema } from "../artifact.schemas"
import { origin, RouteDescriptor, RoutesContext } from "../routes.context"

export const createArtifactRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/artifacts",
  handler: async (request, reply) => {
    const body = CreateArtifactBodySchema.parse(request.body)
    const meta = await createArtifact(ctx.store, body)
    const from = origin(request)
    // Attach the reviewer lane right away so comments from the first minute
    // get live replies. Bind lands async; the summary reports "starting".
    const settings = await readEffectiveSettings(ctx.store.home)
    if (settings.reviewer.adapter !== "none") workerRuntime.current?.attachReviewer(meta.id)
    reply.header("location", ctx.artifactApiUrl(from, meta.id))
    return reply.status(201).send(await ctx.summarizeArtifact(from, meta))
  },
})
