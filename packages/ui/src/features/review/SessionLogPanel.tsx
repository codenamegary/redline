import React from "react"
import { Spinner } from "../../components/Spinner"
import { useIterationLogQuery } from "./queries"

export type SessionLogPanelProps = {
  id: string
  onClose: () => void
}

// Read-only transcript of the running worker session, polled live. Closes
// with the backdrop, the Close button, or Escape.
export const SessionLogPanel: React.FC<SessionLogPanelProps> = ({ id, onClose }) => {
  const logQuery = useIterationLogQuery(id, true)
  const log = logQuery.data?.log ?? ""
  const preRef = React.useRef<HTMLPreElement>(null)

  React.useEffect(() => {
    const pre = preRef.current
    if (pre !== null) pre.scrollTop = pre.scrollHeight
  }, [log])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex h-[70vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-edge bg-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-edge px-3.5 py-2 text-sm">
          <span className="font-semibold">Worker session log</span>
          {logQuery.data === undefined ? null : logQuery.data.running ? (
            <span className="flex items-center gap-1.5 text-xs text-warn">
              <Spinner className="border-t-warn" /> live
            </span>
          ) : (
            <span className="text-xs text-mist">session ended</span>
          )}
          {logQuery.data?.sessionId !== null && logQuery.data?.sessionId !== undefined ? (
            <span className="truncate text-xs text-mist">{logQuery.data.sessionId}</span>
          ) : null}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-edge-strong bg-panel px-2.5 py-1 text-xs text-fog hover:border-hover"
          >
            Close
          </button>
        </header>
        <pre
          ref={preRef}
          className="min-h-0 flex-1 overflow-auto p-3 text-xs leading-relaxed whitespace-pre-wrap text-fog"
        >
          {log.length > 0 ? log : logQuery.isLoading ? "loading…" : "no session output yet…"}
        </pre>
      </div>
    </div>
  )
}
