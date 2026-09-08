import { appendThread, appendThreadMessage, readArtifactMeta } from "../../../store/artifact.store"
import { storeError } from "../../../store/errors"
import { CreateThreadBodySchema, IdParamsSchema } from "@redline/http-contracts/artifact.schemas"
import { origin, RouteDescriptor, RoutesContext } from "../../routes.context"

export const createFeedbackRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/artifacts/:id/feedback",
  handler: async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params)
    const body = CreateThreadBodySchema.parse(request.body)
    const meta = await readArtifactMeta(ctx.store, id)
    if (meta.status !== "review") {
      throw storeError("conflict", "artifact is iterating: new comments are locked until the agent publishes")
    }
    const thread = await appendThread(ctx.store, id, {
      version: body.version ?? meta.current,
      anchor: body.anchor,
      body: body.body,
      author: body.author,
    })
    const withPlaceholder =
      body.author === "user" && (ctx.isAgentAttached(id) || (await ctx.reviewerConfigured()))
        ? await appendThreadMessage(ctx.store, id, thread.id, {
            body: "…",
            author: "agent",
            kind: "thinking",
          })
        : thread
    // Fire-and-forget: the route answers with the placeholder now; the
    // reviewer duty fills it from the lane.
    void ctx.dispatchReplies(id).catch(() => undefined)
    reply.header("location", ctx.artifactApiUrl(origin(request), id) + "/threads/" + thread.id)
    return reply.status(201).send(withPlaceholder)
  },
})
