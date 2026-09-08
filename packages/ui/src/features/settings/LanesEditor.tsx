import { LaneAdapter, LanePreset, SettingsDefaults } from "@redline/http-contracts/settings.models"
import React from "react"

export type LaneId = "reviewer" | "worker"

export const laneIds: LaneId[] = ["reviewer", "worker"]

export const laneLabel = (lane: LaneId): string => (lane === "reviewer" ? "Reviewer" : "Worker")

// Editable view of one lane's config; the command stays a raw string until
// save, when splitCommand turns it back into argv.
export type LaneForm = {
  adapter: LaneAdapter
  preset: LanePreset
  command: string
  model: string
}

export type LanesEditorProps = {
  lane: LaneId
  form: LaneForm
  defaults: SettingsDefaults | undefined
  disabled: boolean
  onChange: (update: Partial<LaneForm>) => void
  onTest: () => void
}

const adapterOptions: Array<{ value: LaneAdapter; label: string }> = [
  { value: "acp", label: "ACP" },
  { value: "opencode-sdk", label: "OpenCode SDK" },
  { value: "none", label: "None (wait in the agent)" },
]

export const LanesEditor: React.FC<LanesEditorProps> = ({
  lane,
  form,
  defaults,
  disabled,
  onChange,
  onTest,
}) => {
  const presets: Array<{ value: LanePreset; label: string }> = Object.entries(
    defaults?.presets ?? {},
  ).map(([id, preset]) => ({
    value: id as LanePreset,
    label: preset.label.replace(/ ACP$/, "") + " · " + preset.argv.join(" "),
  }))
  presets.push({ value: "custom", label: "Custom" })

  const inputClass =
    "rounded-md border border-edge-strong bg-ink px-2.5 py-1.5 font-sans text-sm text-fog disabled:opacity-45"

  return (
    <div className="flex flex-col gap-3.5">
      <h2 className="m-0 text-[15px]">{laneLabel(lane)} lane</h2>
      <label className="flex flex-col gap-1 text-xs text-mist">
        Adapter
        <select
          value={form.adapter}
          disabled={disabled}
          onChange={(event) => onChange({ adapter: event.target.value as LaneAdapter })}
          className={inputClass}
        >
          {adapterOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-mist">
        ACP preset
        <select
          value={form.preset}
          disabled={disabled || defaults === undefined}
          onChange={(event) => {
            const preset = event.target.value as LanePreset
            const argv = defaults?.presets[preset]?.argv
            onChange(argv !== undefined ? { preset: preset, command: argv.join(" ") } : { preset: preset })
          }}
          className={inputClass}
        >
          {presets.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-mist">
        ACP command
        <input
          type="text"
          value={form.command}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange({ command: event.target.value })}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-mist">
        Model
        <input
          type="text"
          value={form.model}
          disabled={disabled}
          placeholder="leave empty for the agent default"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange({ model: event.target.value })}
          className={inputClass}
        />
      </label>
      {form.adapter === "acp" ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onTest}
            disabled={disabled}
            className={secondaryButton}
          >
            Test
          </button>
        </div>
      ) : (
        <p className="m-0 text-xs text-mist">
          {form.adapter === "opencode-sdk"
            ? "OpenCode SDK lanes are validated on save."
            : "None needs no validation."}
        </p>
      )}
    </div>
  )
}

export const secondaryButton =
  "rounded-md border border-edge-strong bg-panel px-3 py-1.5 font-sans text-sm text-fog hover:border-hover disabled:cursor-not-allowed disabled:opacity-40"
