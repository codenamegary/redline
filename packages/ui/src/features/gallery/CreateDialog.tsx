import { CreateArtifactBody } from "@redline/http-contracts/artifact.schemas"
import React from "react"
import { useCreateArtifactMutation } from "./queries"

export type CreateDialogProps = {
  onClose: () => void
}

export const CreateDialog: React.FC<CreateDialogProps> = ({ onClose }) => {
  const [title, setTitle] = React.useState("")
  const [prompt, setPrompt] = React.useState("")
  const [cwd, setCwd] = React.useState("")
  const [html, setHtml] = React.useState("")
  const [error, setError] = React.useState<string | undefined>(undefined)
  const create = useCreateArtifactMutation()

  const submit = () => {
    if (title.trim().length === 0 || cwd.trim().length === 0 || html.trim().length === 0) {
      setError("title, project directory, and html are required")
      return
    }
    const input: CreateArtifactBody = { title: title.trim(), prompt: prompt.trim(), cwd: cwd.trim(), html: html }
    setError(undefined)
    create.mutate(input, {
      onSuccess: onClose,
      onError: (mutationError) => setError(mutationError.message),
    })
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create artifact"
        className="flex w-full max-w-[36rem] flex-col gap-3 rounded-[10px] border border-edge-strong bg-card p-5"
      >
        <h2 className="m-0 text-[15px] font-semibold">Create artifact</h2>
        <label className="flex flex-col gap-1 text-xs text-mist">
          Title
          <input
            type="text"
            value={title}
            spellCheck={false}
            onChange={(event) => setTitle(event.target.value)}
            className="rounded-md border border-edge-strong bg-ink px-2.5 py-1.5 font-sans text-sm text-fog"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-mist">
          Project directory
          <input
            type="text"
            value={cwd}
            spellCheck={false}
            placeholder="/path/to/project"
            onChange={(event) => setCwd(event.target.value)}
            className="rounded-md border border-edge-strong bg-ink px-2.5 py-1.5 font-mono text-sm text-fog"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-mist">
          Brief
          <input
            type="text"
            value={prompt}
            spellCheck={false}
            onChange={(event) => setPrompt(event.target.value)}
            className="rounded-md border border-edge-strong bg-ink px-2.5 py-1.5 font-sans text-sm text-fog"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-mist">
          HTML
          <textarea
            value={html}
            rows={8}
            spellCheck={false}
            onChange={(event) => setHtml(event.target.value)}
            className="resize-y rounded-md border border-edge-strong bg-ink px-2.5 py-1.5 font-mono text-[13px] text-fog"
          />
        </label>
        {error !== undefined ? <p className="m-0 text-[13px] text-warn">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={create.isPending}
            className={primaryButtonClass}
          >
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  )
}

export const primaryButtonClass =
  "rounded-md border border-redline bg-redline px-3 py-1.5 font-sans text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"

export const secondaryButtonClass =
  "rounded-md border border-edge-strong bg-panel px-3 py-1.5 font-sans text-sm text-fog hover:border-hover disabled:cursor-not-allowed disabled:opacity-40"
