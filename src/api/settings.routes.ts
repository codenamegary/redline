import { FastifyInstance } from "fastify"

import { AcpProbe } from "../worker/probe"
import { createRoutesContext, RouteDescriptor, RoutesContext } from "./routes.context"
import { registerRouteDescriptors } from "./artifact.routes"
import { getSettingsRoute } from "./settings/get"
import { getSettingsDefaultsRoute } from "./settings/defaults"
import { putSettingsRoute } from "./settings/put"
import { probeSettingsRoute } from "./settings/probe"
import { resetPromptsRoute } from "./settings/prompts.reset"

export type SettingsRoutesOptions = {
  // Test seam: overrides the ACP handshake probe (defaults to the real one).
  probeAcp?: AcpProbe
}

const settingsRoutes = (ctx: RoutesContext): RouteDescriptor[] => [
  getSettingsRoute(ctx),
  getSettingsDefaultsRoute(ctx),
  putSettingsRoute(ctx),
  probeSettingsRoute(ctx),
  resetPromptsRoute(ctx),
]

export const registerSettingsRoutes = (app: FastifyInstance, home: string, options?: SettingsRoutesOptions): void => {
  const ctx = createRoutesContext({ home } as never, { probeAcp: options?.probeAcp })
  registerRouteDescriptors(app, settingsRoutes(ctx))
}
