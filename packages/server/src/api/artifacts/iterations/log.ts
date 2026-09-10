import { readArtifactMeta } from "../../../store/artifact.store"
import { workerRuntime } from "../../../worker/dispatcher"
import { IdParamsSchema } from "@redline/http-contracts/artifact.schemas"
import { isPendingVersion } from "@redline/http-contracts/artifact.models"
import { RouteDescriptor, RoutesContext } from "../../routes.context"

// Read-only transcript of the current iteration's host session: what the
// worker is doing while it runs. Empty log when the session has ended —
// ACP transcripts live (and die) with the spawned agent process.
export const getIterationLogRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "GET",
  url: "/api/v1/artifacts/:id/iterations/current/log",
  handler: async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    const meta = await readArtifactMeta(ctx.store, id)
    const batch = meta.versions.find(isPendingVersion)?.batch
    return {
      running: await ctx.workerLive(id),
      adapterId: batch?.adapterId ?? null,
      sessionId: batch?.sessionId ?? null,
      heartbeatAt: batch?.heartbeatAt ?? null,
      log: (await workerRuntime.current?.workerLog(id)) ?? "",
    }
  },
})
