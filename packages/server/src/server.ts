import Fastify, { FastifyInstance } from "fastify"
import { ZodError } from "zod"

import { registerApiRoutes } from "./api/artifact.routes"
import { registerSettingsRoutes } from "./api/settings.routes"
import { sendProblem } from "./api/problem.details"
import { registerArtifactFiles } from "./http/static.handlers"
import { registerWebappRoutes } from "./webapp/routes"
import { isStoreError } from "./store/errors"
import { Store } from "./store/artifact.store"
import { DispatcherAdapters } from "./worker/dispatcher"
import { AcpProbe } from "./worker/probe"

export type ServerOptions = {
  store: Store
  loggerLevel?: string
  // Test seam: overrides the ACP handshake probe in the settings routes.
  probeAcp?: AcpProbe
  // Test seam: replaces the dispatcher's default adapter registry (the real
  // ACP adapter) so lane duties run against fakes.
  adapters?: DispatcherAdapters
}

const errorStatus = (error: unknown): number | undefined => {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode: unknown = error.statusCode
    return typeof statusCode === "number" ? statusCode : undefined
  }
  return undefined
}

export const buildServer = (options: ServerOptions): FastifyInstance => {
  const app = Fastify({
    logger: { level: options.loggerLevel ?? "warn" },
    bodyLimit: 10_485_760,
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const detail = error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join(", ")
      return sendProblem(reply, 400, "Invalid request", detail)
    }
    if (isStoreError(error)) {
      const status = error.kind === "not-found" ? 404 : error.kind === "unprocessable" ? 422 : 409
      const title = status === 404 ? "Not found" : status === 422 ? "Unprocessable request" : "Conflict"
      return sendProblem(reply, status, title, error.message)
    }
    const status = errorStatus(error) ?? 500
    if (status >= 500) {
      request.log.error(error)
      return sendProblem(reply, status, "Internal Server Error")
    }
    return sendProblem(reply, status, error instanceof Error ? error.message : "Request failed")
  })

  registerApiRoutes(app, options.store, { adapters: options.adapters })
  registerSettingsRoutes(app, options.store.home, { probeAcp: options.probeAcp })
  registerArtifactFiles(app, options.store)
  registerWebappRoutes(app)

  return app
}
