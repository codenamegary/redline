import { countOpenThreads, startIteration } from "../../../store/artifact.store"
import { readEffectiveSettings } from "../../../store/settings.store"
import { storeError } from "../../../store/errors"
import { workerRuntime } from "../../../worker/dispatcher"
import { IdParamsSchema } from "@redline/http-contracts/artifact.schemas"
import { origin, RouteDescriptor, RoutesContext } from "../../routes.context"

export const createIterationRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/artifacts/:id/iterations",
  handler: async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params)
    if ((await countOpenThreads(ctx.store, id)) === 0) {
      throw storeError("unprocessable", "nothing to iterate: no open threads")
    }
    const settings = await readEffectiveSettings(ctx.store.home)
    // One work duty at a time per artifact: reject before startIteration so
    // a busy worker never leaves a stranded iterating artifact behind.
    if (workerRuntime.current?.presence(id).workerRunning === true) {
      throw storeError("conflict", "worker is busy")
    }
    const { meta, version } = await startIteration(ctx.store, id)
    if (!(await ctx.dispatchIteration(id, meta, version, settings))) {
      throw storeError("conflict", "worker lane failed to start")
    }
    reply.header("location", ctx.artifactApiUrl(origin(request), id))
    return reply.status(201).send({
      status: meta.status,
      iteratedAt: meta.iteratedAt,
      version: version,
      openThreads: version.batch?.threadIds.length ?? 0,
    })
  },
})
