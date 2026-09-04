import { FastifyInstance } from "fastify"
import { z } from "zod"

import { sendProblem } from "./problem.details"
import { LaneAdapterSchema, RedlineSettingsSchema } from "../store/settings.models"
import {
  defaultSettings,
  loadSettings,
  readEffectiveSettings,
  saveSettings,
} from "../store/settings.store"
import { probeLaneCommand } from "../worker/probe"

const ProbeBodySchema = z.object({
  lane: z.enum(["reviewer", "worker"]),
  adapter: LaneAdapterSchema,
  acpCommand: z.array(z.string().min(1)),
})

export const registerSettingsRoutes = (app: FastifyInstance, home: string): void => {
  app.get("/api/v1/settings", async () => readEffectiveSettings(home))

  // The PUT probes every lane that will actually spawn something, then
  // persists the saved values as-is — empty prompts stay empty on disk and
  // defaults are applied at read time. The response is saved, not effective.
  app.put("/api/v1/settings", async (request, reply) => {
    const body = RedlineSettingsSchema.parse(request.body)
    for (const lane of [body.reviewer, body.worker]) {
      if (lane.adapter === "none") continue
      const probe = await probeLaneCommand(lane.acpCommand)
      if (!probe.ok) return sendProblem(reply, 400, "Probe failed", probe.detail)
    }
    return saveSettings(home, body)
  })

  app.post("/api/v1/settings/probe", async (request, reply) => {
    const body = ProbeBodySchema.parse(request.body)
    const probe = await probeLaneCommand(body.acpCommand)
    if (!probe.ok) return sendProblem(reply, 422, "Probe failed", probe.detail)
    return { ok: true }
  })

  app.post("/api/v1/settings/prompts/reset", async () => {
    const settings = await loadSettings(home)
    await saveSettings(home, { ...settings, prompts: defaultSettings().prompts })
    return readEffectiveSettings(home)
  })
}
