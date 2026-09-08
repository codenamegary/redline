import { z } from "zod"

import { sendProblem } from "../problem.details"
import { LaneAdapterSchema } from "@redline/http-contracts/settings.models"
import { probeLaneCommand } from "../../worker/probe"

import { RouteDescriptor, RoutesContext } from "../routes.context"

const ProbeBodySchema = z.object({
  lane: z.enum(["reviewer", "worker"]),
  adapter: LaneAdapterSchema,
  acpCommand: z.array(z.string().min(1)),
})

export const probeSettingsRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/settings/probe",
  handler: async (request, reply) => {
    const body = ProbeBodySchema.parse(request.body)
    const probe =
      body.adapter === "acp"
        ? await ctx.probeAcp(body.acpCommand)
        : await probeLaneCommand(body.acpCommand)
    if (!probe.ok) return sendProblem(reply, 422, "Probe failed", probe.detail)
    return { ok: true }
  },
})
