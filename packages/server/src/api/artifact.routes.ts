import { FastifyInstance } from "fastify"

import { Store } from "../store/artifact.store"
import { DispatcherAdapters } from "../worker/dispatcher"
import { createRoutesContext, installDispatcher, RouteDescriptor, RoutesContext } from "./routes.context"

import { getHealth } from "./health/get"
import { listArtifactsRoute } from "./artifacts/list"
import { createArtifactRoute } from "./artifacts/create"
import { getArtifactRoute } from "./artifacts/get"
import { getWorkerRoute } from "./artifacts/worker/get"
import { createIterationRoute } from "./artifacts/iterations/create"
import { stopIterationRoute } from "./artifacts/iterations/stop"
import { getIterationLogRoute } from "./artifacts/iterations/log"
import { createVersionRoute } from "./artifacts/versions/create"
import { approveVersionRoute } from "./artifacts/versions/approve"
import { createAssetRoute } from "./artifacts/assets/create"
import { getFeedbackRoute } from "./artifacts/feedback/get"
import { createFeedbackRoute } from "./artifacts/feedback/create"
import { patchThreadRoute } from "./artifacts/threads/patch"
import { createThreadMessageRoute } from "./artifacts/threads/messages/create"
import { patchThreadMessageRoute } from "./artifacts/threads/messages/patch"

export type ApiRoutesOptions = {
  // Test seam: replaces the default adapter registry (the real ACP adapter).
  adapters?: DispatcherAdapters
}

export const registerRouteDescriptors = (app: FastifyInstance, descriptors: RouteDescriptor[]): void => {
  for (const route of descriptors) {
    app.route({ method: route.method, url: route.url, handler: route.handler })
  }
}

const artifactRoutes = (ctx: RoutesContext): RouteDescriptor[] => [
  getHealth(ctx),
  listArtifactsRoute(ctx),
  createArtifactRoute(ctx),
  getArtifactRoute(ctx),
  getWorkerRoute(ctx),
  createIterationRoute(ctx),
  stopIterationRoute(ctx),
  getIterationLogRoute(ctx),
  createVersionRoute(ctx),
  approveVersionRoute(ctx),
  createAssetRoute(ctx),
  getFeedbackRoute(ctx),
  createFeedbackRoute(ctx),
  patchThreadRoute(ctx),
  createThreadMessageRoute(ctx),
  patchThreadMessageRoute(ctx),
]

export const registerApiRoutes = (app: FastifyInstance, store: Store, options?: ApiRoutesOptions): void => {
  installDispatcher(store, { adapters: options?.adapters })
  const ctx = createRoutesContext(store, { adapters: options?.adapters })
  registerRouteDescriptors(app, artifactRoutes(ctx))
}
