import { readArtifactMeta, rollbackIteration } from "../../../store/artifact.store"
import { workerRuntime } from "../../../worker/dispatcher"
import { IdParamsSchema } from "@redline/http-contracts/artifact.schemas"
import { isPendingVersion } from "@redline/http-contracts/artifact.models"
import { storeError } from "../../../store/errors"
import { RouteDescriptor, RoutesContext, postThreadNotes } from "../../routes.context"

// Stop the running (or orphaned) iteration: best-effort interrupt of the
// in-flight duty, then roll the pending version back so the artifact
// returns to review with every thread still open. Legal whenever the
// artifact is iterating — that includes a duty lost to a server restart.
export const stopIterationRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/artifacts/:id/iterations/current/stop",
  handler: async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    const meta = await readArtifactMeta(ctx.store, id)
    if (meta.status !== "iterating") {
      throw storeError("conflict", "artifact is not iterating")
    }
    const pending = meta.versions.find(isPendingVersion)
    if (pending === undefined) throw storeError("conflict", "no pending iteration to stop")
    // Roll back first, then interrupt: the interrupt settles the duty
    // through the error path, and by then the artifact is already back in
    // review, so the error handler finds nothing left to heal. A duty that
    // lands late is dropped by handleDocument's status check either way.
    const updated = await rollbackIteration(ctx.store, id)
    const interrupted = workerRuntime.current?.interruptWorker(id) ?? false
    await postThreadNotes(
      ctx.store,
      id,
      pending.batch?.threadIds ?? [],
      interrupted
        ? "Iteration stopped — threads stay open."
        : "Iteration stopped (worker was not running) — threads stay open.",
    )
    return { status: updated.status, current: updated.current, stoppedVersion: pending.version }
  },
})
