import { z } from "zod"

import { sendProblem } from "../problem.details"

import { RouteDescriptor, RoutesContext } from "../routes.context"

const ProbeBodySchema = z.object({
  lane: z.enum(["reviewer", "worker"]),
  acpCommand: z.array(z.string().min(1)),
})

export const probeSettingsRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/settings/probe",
  handler: async (request, reply) => {
    const body = ProbeBodySchema.parse(request.body)
    const probe = await ctx.probeAcp(body.acpCommand)
    if (!probe.ok) return sendProblem(reply, 422, "Probe failed", probe.detail)
    return { ok: true }
  },
})
