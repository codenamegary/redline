import type { LaneConfig, RedlineSettings } from "@redline/http-contracts/settings.models"
import { RedlineSettingsSchema } from "@redline/http-contracts/settings.models"
import React from "react"
import { Link } from "react-router"

import { SiteHeader } from "../../components/site.header"
import { Spinner } from "../../components/spinner"
import { LanesEditor, laneIds, type LaneForm, type LaneId } from "./lanes.editor"
import { PromptsEditor } from "./prompts.editor"
import { useDefaultsQuery, useProbeMutation, useSaveSettingsMutation, useSettingsQuery } from "./queries"

const tagline = "agent lanes, prompt templates, and origin notifications"

// ---------- settings form state ----------

export type SettingsForm = {
  reviewer: LaneForm
  worker: LaneForm
  prompts: Record<LaneId, string>
  notifyOrigin: boolean
  opencodeServerUrl: string
  imageGen: { enabled: boolean; agent: string; model: string }
}

const laneFormFrom = (config: LaneConfig): LaneForm => ({
  adapter: config.adapter,
  preset: config.preset,
  command: config.acpCommand.join(" "),
  model: config.model,
})

const settingsFormFrom = (settings: RedlineSettings): SettingsForm => ({
  reviewer: laneFormFrom(settings.reviewer),
  worker: laneFormFrom(settings.worker),
  prompts: { reviewer: settings.prompts.reviewer, worker: settings.prompts.worker },
  notifyOrigin: settings.notifyOrigin,
  opencodeServerUrl: settings.opencodeServerUrl,
  imageGen: {
    enabled: settings.imageGen.enabled,
    agent: settings.imageGen.agent,
    model: settings.imageGen.model,
  },
})

const laneConfigFrom = (form: LaneForm): LaneConfig =>
  RedlineSettingsSchema.shape.reviewer.parse({
    adapter: form.adapter,
    preset: form.preset,
    acpCommand: splitCommand(form.command),
    model: form.model,
  })

const settingsPayload = (form: SettingsForm): RedlineSettings =>
  RedlineSettingsSchema.parse({
    reviewer: laneConfigFrom(form.reviewer),
    worker: laneConfigFrom(form.worker),
    imageGen: {
      enabled: form.imageGen.enabled,
      agent: form.imageGen.agent.trim(),
      model: form.imageGen.model.trim(),
    },
    notifyOrigin: form.notifyOrigin,
    opencodeServerUrl: form.opencodeServerUrl.trim(),
    prompts: { reviewer: form.prompts.reviewer, worker: form.prompts.worker },
  })

// Splits a command line into argv, honoring double quotes:
// 'opencode acp --model "big model"' → ["opencode", "acp", "--model", "big model"]
export const splitCommand = (line: string): string[] => {
  const out: string[] = []
  let current = ""
  let quoted = false
  for (const character of line) {
    if (quoted) {
      if (character === '"') {
        quoted = false
      } else {
        current += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === " " || character === "\t") {
      if (current.length > 0) {
        out.push(current)
        current = ""
      }
    } else {
      current += character
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

// ---------- page ----------

type TabId = LaneId | "notify" | "imagegen"

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "reviewer", label: "Reviewer" },
  { id: "worker", label: "Worker" },
  { id: "notify", label: "Notify" },
  { id: "imagegen", label: "Image Gen" },
]

export const SettingsPage: React.FC = () => {
  const settingsQuery = useSettingsQuery()
  const defaultsQuery = useDefaultsQuery()
  const save = useSaveSettingsMutation()
  const probe = useProbeMutation()

  const [tab, setTab] = React.useState<TabId>("reviewer")
  const [form, setForm] = React.useState<SettingsForm | undefined>(undefined)
  const [toast, setToast] = React.useState<{ message: string; ok: boolean } | undefined>(undefined)

  React.useEffect(() => {
    if (form === undefined && settingsQuery.data !== undefined) {
      setForm(settingsFormFrom(settingsQuery.data))
    }
  }, [form, settingsQuery.data])

  const show = (message: string, ok: boolean) => setToast({ message: message, ok: ok })

  if (settingsQuery.isPending || form === undefined) {
    return (
      <div className="min-h-screen">
        <SiteHeader tagline={tagline} />
        <main className="px-7 pt-5 pb-10">
          <p className="flex items-center gap-2 text-mist">
            <Spinner /> loading settings…
          </p>
        </main>
      </div>
    )
  }

  if (settingsQuery.isError) {
    return (
      <div className="min-h-screen">
        <SiteHeader tagline={tagline} />
        <main className="px-7 pt-5 pb-10">
          <p className="text-warn">{settingsQuery.error.message}</p>
        </main>
      </div>
    )
  }

  const updateLane = (lane: LaneId, update: Partial<LaneForm>) =>
    setForm((previous) =>
      previous === undefined ? previous : { ...previous, [lane]: { ...previous[lane], ...update } },
    )

  const saveForm = () => {
    save.mutate(settingsPayload(form), {
      onSuccess: () => show("Saved", true),
      onError: (error) => show(error.message, false),
    })
  }

  const testLane = (lane: LaneId) => {
    const laneForm = form[lane]
    const command = splitCommand(laneForm.command)
    if (command.length === 0) {
      show("enter an ACP command first", false)
      return
    }
    show("probing " + command.join(" ") + " …", true)
    probe.mutate(
      { lane: lane, adapter: "acp", acpCommand: command },
      {
        onSuccess: () => show("probe ok", true),
        onError: (error) => show(error.message, false),
      },
    )
  }

  const inputClass =
    "rounded-md border border-edge-strong bg-ink px-2.5 py-1.5 font-sans text-sm text-fog disabled:opacity-45"

  return (
    <div className="min-h-screen">
      <SiteHeader tagline={tagline}>
        <Link to="/" className="text-link no-underline hover:underline">
          Back to gallery
        </Link>
      </SiteHeader>
      <main className="max-w-[47.5rem] px-7 pt-5 pb-10">
        <nav className="mb-4.5 flex gap-2" role="tablist" aria-label="Settings sections">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={`rounded-md border border-edge-strong bg-panel px-3 py-1.5 font-sans text-sm text-fog hover:border-hover ${
                tab === entry.id ? "border-redline bg-redline font-semibold text-white" : ""
              }`}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <section className="rounded-[10px] border border-edge bg-card px-5 py-4.5">
          {laneIds.includes(tab as LaneId) ? (
            <div className="flex flex-col gap-3.5">
              <LanesEditor
                lane={tab as LaneId}
                form={form[tab as LaneId]}
                defaults={defaultsQuery.data}
                disabled={save.isPending}
                onChange={(update) => updateLane(tab as LaneId, update)}
                onTest={() => testLane(tab as LaneId)}
              />
              <PromptsEditor
                lane={tab as LaneId}
                value={form.prompts[tab as LaneId]}
                disabled={save.isPending}
                onChange={(value) =>
                  setForm((previous) =>
                    previous === undefined
                      ? previous
                      : { ...previous, prompts: { ...previous.prompts, [tab]: value } },
                  )
                }
                onReset={() => {
                  const shipped = defaultsQuery.data?.prompts[tab as LaneId]
                  if (shipped === undefined) return
                  setForm((previous) =>
                    previous === undefined
                      ? previous
                      : { ...previous, prompts: { ...previous.prompts, [tab]: shipped } },
                  )
                  show("template reset (unsaved — hit Save)", true)
                }}
              />
            </div>
          ) : null}
          {tab === "notify" ? (
            <div className="flex flex-col gap-3.5">
              <h2 className="m-0 text-[15px]">Notify</h2>
              <label className="flex flex-col gap-1 text-xs text-mist">
                Origin notifications
                <select
                  value={form.notifyOrigin ? "true" : "false"}
                  onChange={(event) =>
                    setForm((previous) =>
                      previous === undefined
                        ? previous
                        : { ...previous, notifyOrigin: event.target.value === "true" },
                    )
                  }
                  className={inputClass}
                >
                  <option value="true">Post a one-line status when a duty finishes</option>
                  <option value="false">Never post to the origin session</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-mist">
                OpenCode server URL
                <input
                  type="text"
                  value={form.opencodeServerUrl}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) =>
                    setForm((previous) =>
                      previous === undefined
                        ? previous
                        : { ...previous, opencodeServerUrl: event.target.value },
                    )
                  }
                  className={inputClass}
                />
                <span className="text-xs text-mist">
                  Only used when create stored an origin and the lane adapter can notify.
                </span>
              </label>
            </div>
          ) : null}
          {tab === "imagegen" ? (
            <div className="flex flex-col gap-3.5">
              <h2 className="m-0 text-[15px]">Image generation</h2>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fog">
                <input
                  type="checkbox"
                  checked={form.imageGen.enabled}
                  onChange={(event) =>
                    setForm((previous) =>
                      previous === undefined
                        ? previous
                        : { ...previous, imageGen: { ...previous.imageGen, enabled: event.target.checked } },
                    )
                  }
                  className="size-4 cursor-pointer accent-redline"
                />
                <span>
                  Enabled — agents with image tools may generate static images and attach them to artifact
                  versions
                </span>
              </label>
              <label className="flex flex-col gap-1 text-xs text-mist">
                Agent
                <input
                  type="text"
                  value={form.imageGen.agent}
                  disabled={!form.imageGen.enabled}
                  placeholder="the image agent or command you use"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) =>
                    setForm((previous) =>
                      previous === undefined
                        ? previous
                        : { ...previous, imageGen: { ...previous.imageGen, agent: event.target.value } },
                    )
                  }
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-mist">
                Model
                <input
                  type="text"
                  value={form.imageGen.model}
                  disabled={!form.imageGen.enabled}
                  placeholder="e.g. gpt-image-1"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) =>
                    setForm((previous) =>
                      previous === undefined
                        ? previous
                        : { ...previous, imageGen: { ...previous.imageGen, model: event.target.value } },
                    )
                  }
                  className={inputClass}
                />
              </label>
              <p className="m-0 text-xs text-mist">
                Optional and config-only: redline never spawns this agent. The setting tells capable agents that
                image generation is wanted and which agent/model to prefer when attaching images to artifact
                versions.
              </p>
            </div>
          ) : null}
        </section>
        <div className="mt-4.5 flex items-center gap-3">
          <button
            type="button"
            onClick={saveForm}
            disabled={save.isPending}
            className="rounded-md border border-redline bg-redline px-3.5 py-1.5 font-sans text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save
          </button>
          <span
            role="status"
            aria-live="polite"
            className={`min-h-[1em] text-[13px] ${toast === undefined ? "" : toast.ok ? "text-go" : "text-warn"}`}
          >
            {toast?.message}
          </span>
        </div>
      </main>
    </div>
  )
}
