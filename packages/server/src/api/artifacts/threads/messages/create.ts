import {
  appendThreadMessage,
  readArtifactMeta,
} from "../../../../store/artifact.store"
import {
  CreateThreadMessageBodySchema,
  ThreadParamsSchema,
} from "@redline/http-contracts/artifact.schemas"
import { RouteDescriptor, RoutesContext } from "../../../routes.context"

export const createThreadMessageRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/artifacts/:id/threads/:threadId/messages",
  handler: async (request, reply) => {
    const { id, threadId } = ThreadParamsSchema.parse(request.params)
    const body = CreateThreadMessageBodySchema.parse(request.body)
    let thread = await appendThreadMessage(ctx.store, id, threadId, body)
    // Replies are allowed during iterating; the placeholder (a signal of
    // live attention) only makes sense while the agent is parked in review,
    // and rapid-fire comments share one pending placeholder.
    const previous = thread.messages[thread.messages.length - 2]
    if (
      body.author === "user" &&
      previous?.kind !== "thinking" &&
      (await readArtifactMeta(ctx.store, id)).status === "review" &&
      (ctx.isAgentAttached(id) || (await ctx.reviewerConfigured()))
    ) {
      thread = await appendThreadMessage(ctx.store, id, threadId, {
        body: "…",
        author: "agent",
        kind: "thinking",
      })
    }
    void ctx.dispatchReplies(id).catch(() => undefined)
    return reply.status(201).send(thread)
  },
})
