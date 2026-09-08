import React from "react"
import { LaneId, laneLabel, secondaryButton } from "./LanesEditor"

export type PromptsEditorProps = {
  lane: LaneId
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onReset: () => void
}

export const PromptsEditor: React.FC<PromptsEditorProps> = ({
  lane,
  value,
  disabled,
  onChange,
  onReset,
}) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between text-xs text-mist">
      <span>Template</span>
      <button type="button" onClick={onReset} disabled={disabled} className={secondaryButton}>
        Reset template
      </button>
    </div>
    <textarea
      aria-label={laneLabel(lane) + " prompt template"}
      value={value}
      rows={14}
      spellCheck={false}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="resize-y rounded-md border border-edge-strong bg-ink px-2.5 py-1.5 font-mono text-[13px] text-fog"
    />
  </div>
)
