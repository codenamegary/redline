import { replaceThinkingMessage } from "../../../../store/artifact.store"
import { MessageParamsSchema, PatchMessageBodySchema } from "@redline/http-contracts/artifact.schemas"
import { RouteDescriptor, RoutesContext } from "../../../routes.context"

// Replace a thinking placeholder with the agent's real reply.
export const patchThreadMessageRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "PATCH",
  url: "/api/v1/artifacts/:id/threads/:threadId/messages/:messageId",
  handler: async (request) => {
    const { id, threadId, messageId } = MessageParamsSchema.parse(request.params)
    const body = PatchMessageBodySchema.parse(request.body)
    return replaceThinkingMessage(ctx.store, id, threadId, messageId, body.body)
  },
})
