import { sendProblem } from "../problem.details"
import { RedlineSettingsSchema } from "@redline/http-contracts/settings.models"
import { saveSettings } from "../../store/settings.store"

import { RouteDescriptor, RoutesContext } from "../routes.context"

export const putSettingsRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "PUT",
  url: "/api/v1/settings",
  handler: async (request, reply) => {
    const body = RedlineSettingsSchema.parse(request.body)
    for (const lane of [body.reviewer, body.worker]) {
      if (lane.adapter === "none") continue
      const probe = await ctx.probeAcp(lane.acpCommand)
      if (!probe.ok) return sendProblem(reply, 400, "Probe failed", probe.detail)
    }
    return saveSettings(ctx.store.home, body)
  },
})
