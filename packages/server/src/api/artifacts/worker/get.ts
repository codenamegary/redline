import { IdParamsSchema } from "@redline/http-contracts/artifact.schemas"
import { RouteDescriptor, RoutesContext } from "../../routes.context"

// Lane debug view: configured vs live per lane, plus the artifact origin.
export const getWorkerRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "GET",
  url: "/api/v1/artifacts/:id/worker",
  handler: async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    return ctx.workerStatus(id)
  },
})
