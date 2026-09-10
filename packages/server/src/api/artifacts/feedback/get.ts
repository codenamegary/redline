import { readFeedbackView } from "../../../store/artifact.store"
import { FeedbackQuerySchema, IdParamsSchema } from "@redline/http-contracts/artifact.schemas"
import { RouteDescriptor, RoutesContext } from "../../routes.context"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const getFeedbackRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "GET",
  url: "/api/v1/artifacts/:id/feedback",
  handler: async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    const query = FeedbackQuerySchema.parse(request.query)
    const waits = query.wait ?? 0
    if (waits <= 0) {
      const view = await readFeedbackView(ctx.store, id, query.version)
      return {
        ...view,
        agentAttached: ctx.isAgentAttached(id),
        ...ctx.lanePresence(id),
        workerLive: await ctx.workerLive(id),
      }
    }
    const deadline = Date.now() + waits * 1000
    ctx.beginWaitingAgent(id)
    try {
      for (;;) {
        // Artifact-scoped view: every thread, newest first. With ?version=vN,
        // only threads pinned on vN. The poll wakes when updatedAt (thread
        // activity, replies, approve) or iteratedAt (Iterate) moves past
        // `after` — no matter which version a thread lives in.
        const view = await readFeedbackView(ctx.store, id, query.version)
        const changed =
          query.after !== undefined && (view.updatedAt > query.after || view.iteratedAt > query.after)
        if (changed || Date.now() >= deadline) {
          return {
            ...view,
            agentAttached: true,
            ...ctx.lanePresence(id),
            workerLive: await ctx.workerLive(id),
          }
        }
        await sleep(500)
      }
    } finally {
      ctx.endWaitingAgent(id)
    }
  },
})
