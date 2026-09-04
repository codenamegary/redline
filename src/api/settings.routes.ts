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
import { AcpProbe, probeAcpHandshake, probeLaneCommand } from "../worker/probe"
import { DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "../worker/prompts"

const ProbeBodySchema = z.object({
  lane: z.enum(["reviewer", "worker"]),
  adapter: LaneAdapterSchema,
  acpCommand: z.array(z.string().min(1)),
})

export type SettingsRoutesOptions = {
  // Test seam: overrides the ACP handshake probe (defaults to the real one).
  probeAcp?: AcpProbe
}

export const registerSettingsRoutes = (
  app: FastifyInstance,
  home: string,
  options?: SettingsRoutesOptions,
): void => {
  const probeAcp = options?.probeAcp ?? probeAcpHandshake

  app.get("/api/v1/settings", async () => readEffectiveSettings(home))

  // Shipped prompt templates: what "Reset template" refills from and what
  // empty saved prompts fall back to. Static — no probe, no disk.
  app.get("/api/v1/settings/defaults", async () => ({
    prompts: { reviewer: DEFAULT_REVIEWER_PROMPT, worker: DEFAULT_WORKER_PROMPT },
  }))

  // The PUT probes every lane that will actually spawn something, then
  // persists the saved values as-is — empty prompts stay empty on disk and
  // defaults are applied at read time. The response is saved, not effective.
  app.put("/api/v1/settings", async (request, reply) => {
    const body = RedlineSettingsSchema.parse(request.body)
    for (const lane of [body.reviewer, body.worker]) {
      if (lane.adapter === "none") continue
      const probe =
        lane.adapter === "acp"
          ? await probeAcp(lane.acpCommand)
          : await probeLaneCommand(lane.acpCommand)
      if (!probe.ok) return sendProblem(reply, 400, "Probe failed", probe.detail)
    }
    return saveSettings(home, body)
  })

  app.post("/api/v1/settings/probe", async (request, reply) => {
    const body = ProbeBodySchema.parse(request.body)
    const probe =
      body.adapter === "acp"
        ? await probeAcp(body.acpCommand)
        : await probeLaneCommand(body.acpCommand)
    if (!probe.ok) return sendProblem(reply, 422, "Probe failed", probe.detail)
    return { ok: true }
  })

  app.post("/api/v1/settings/prompts/reset", async () => {
    const settings = await loadSettings(home)
    await saveSettings(home, { ...settings, prompts: defaultSettings().prompts })
    return readEffectiveSettings(home)
  })
}
