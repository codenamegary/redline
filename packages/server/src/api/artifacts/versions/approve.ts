import { approveVersion } from "../../../store/artifact.store"
import { workerRuntime } from "../../../worker/dispatcher"
import { ApproveParamsSchema } from "@redline/http-contracts/artifact.schemas"
import { RouteDescriptor, RoutesContext } from "../../routes.context"

// Approval is data on a version, not a loop state: the artifact stays in
// review and can always be iterated again. Ends the agent round: lanes
// detach (in-flight duties still land).
export const approveVersionRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/artifacts/:id/versions/:version/approve",
  handler: async (request) => {
    const { id, version } = ApproveParamsSchema.parse(request.params)
    const row = await approveVersion(ctx.store, id, version)
    workerRuntime.current?.unbindAll(id)
    return row
  },
})
