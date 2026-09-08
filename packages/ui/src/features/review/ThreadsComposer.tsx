import React from "react"

import { primaryButtonClass, secondaryButtonClass } from "../gallery/create.dialog"

export type ThreadsComposerProps = {
  target: string
  busy: boolean
  onCancel: () => void
  onSave: (body: string) => void
}

export const ThreadsComposer: React.FC<ThreadsComposerProps> = ({ target, busy, onCancel, onSave }) => {
  const [body, setBody] = React.useState("")
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const save = () => {
    const trimmed = body.trim()
    if (trimmed.length === 0) return
    onSave(trimmed)
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-edge-strong bg-[#191d27] p-2.5">
      <div className="break-all text-xs text-warn">{target}</div>
      <textarea
        ref={inputRef}
        value={body}
        rows={3}
        placeholder="What should change?"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save()
        }}
        className="min-h-16 resize-y rounded-md border border-edge-strong bg-ink px-2 py-1.5 font-sans text-sm text-fog placeholder:text-dim"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={secondaryButtonClass}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={busy} className={primaryButtonClass}>
          Save
        </button>
      </div>
    </div>
  )
}
