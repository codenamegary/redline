import { readArtifactMeta, setThreadStatus } from "../../../store/artifact.store"
import { storeError } from "../../../store/errors"
import { PatchThreadBodySchema, ThreadParamsSchema } from "../../artifact.schemas"
import { RouteDescriptor, RoutesContext } from "../../routes.context"

export const patchThreadRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "PATCH",
  url: "/api/v1/artifacts/:id/threads/:threadId",
  handler: async (request) => {
    const { id, threadId } = ThreadParamsSchema.parse(request.params)
    const body = PatchThreadBodySchema.parse(request.body)
    if ((await readArtifactMeta(ctx.store, id)).status !== "review") {
      throw storeError("conflict", "threads are locked while the agent is iterating")
    }
    return setThreadStatus(ctx.store, id, threadId, body.status)
  },
})
