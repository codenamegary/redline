import { publishIteration } from "../../../store/artifact.store"
import { AddVersionBodySchema, IdParamsSchema } from "@redline/http-contracts/artifact.schemas"
import { origin, RouteDescriptor, RoutesContext } from "../../routes.context"

// Publish the pending iteration. 409 unless iterating — the gate that
// makes live comment replies consequence-free. Success returns the
// artifact to review.
export const createVersionRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/artifacts/:id/versions",
  handler: async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params)
    const body = AddVersionBodySchema.parse(request.body)
    const meta = await publishIteration(ctx.store, id, body)
    const from = origin(request)
    reply.header("location", ctx.artifactApiUrl(from, meta.id))
    return reply.status(201).send(await ctx.summarizeArtifact(from, meta))
  },
})
