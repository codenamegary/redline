import type { Thread, ThreadStatus, Version } from "@redline/http-contracts/artifact.models"
import React from "react"

import { Spinner } from "../../components/spinner"

export type ThreadsPanelProps = {
  threads: Thread[]
  review: boolean
  numbers: Map<string, number>
  expanded: Record<string, boolean>
  activeThreadId: string | undefined
  busy: boolean
  onToggleExpanded: (threadId: string) => void
  onFlash: (thread: Thread) => void
  onReply: (threadId: string, body: string) => void
  onToggleStatus: (threadId: string, status: ThreadStatus) => void
  onSwitchVersion: (version: Version) => void
}

export const ThreadsPanel: React.FC<ThreadsPanelProps> = ({
  threads,
  review,
  numbers,
  expanded,
  activeThreadId,
  busy,
  onToggleExpanded,
  onFlash,
  onReply,
  onToggleStatus,
  onSwitchVersion,
}) => {
  const cardRefs = React.useRef(new Map<string, HTMLDivElement>())

  React.useEffect(() => {
    if (activeThreadId === undefined) return
    cardRefs.current.get(activeThreadId)?.scrollIntoView({ block: "nearest" })
  }, [activeThreadId])

  const open = threads.filter((thread) => thread.status === "open")
  const resolved = threads.filter((thread) => thread.status === "resolved")

  const renderCard = (thread: Thread): React.JSX.Element => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      number={numbers.get(thread.id)}
      resolved={thread.status === "resolved"}
      collapsed={thread.status === "resolved" && expanded[thread.id] !== true}
      active={thread.id === activeThreadId}
      review={review}
      busy={busy}
      register={(node) => {
        if (node === null) cardRefs.current.delete(thread.id)
        else cardRefs.current.set(thread.id, node)
      }}
      onHeadClick={() => {
        if (thread.status === "resolved") {
          onToggleExpanded(thread.id)
          return
        }
        onFlash(thread)
      }}
      onReply={(body) => onReply(thread.id, body)}
      onToggleStatus={(status) => onToggleStatus(thread.id, status)}
      onSwitchVersion={onSwitchVersion}
    />
  )

  return (
    <div className="flex flex-col gap-2.5">
      <div className="mt-1.5 text-[11px] tracking-[0.08em] text-mist uppercase">
        Open ({String(open.length)})
      </div>
      {open.map(renderCard)}
      {resolved.length > 0 ? (
        <div className="mt-1.5 text-[11px] tracking-[0.08em] text-mist uppercase opacity-70">
          Resolved ({String(resolved.length)})
        </div>
      ) : null}
      {resolved.map(renderCard)}
    </div>
  )
}

type ThreadCardProps = {
  thread: Thread
  number: number | undefined
  resolved: boolean
  collapsed: boolean
  active: boolean
  review: boolean
  busy: boolean
  register: (node: HTMLDivElement | null) => void
  onHeadClick: () => void
  onReply: (body: string) => void
  onToggleStatus: (status: ThreadStatus) => void
  onSwitchVersion: (version: Version) => void
}

const ThreadCard: React.FC<ThreadCardProps> = ({
  thread,
  number,
  resolved,
  collapsed,
  active,
  review,
  busy,
  register,
  onHeadClick,
  onReply,
  onToggleStatus,
  onSwitchVersion,
}) => {
  const [reply, setReply] = React.useState("")
  const anchorVersion = thread.anchorVersion
  const resolvedIn = thread.resolvedInVersion ?? "earlier version"

  return (
    <div
      ref={register}
      data-thread-id={thread.id}
      className={`flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 ${resolved ? "opacity-55" : ""} ${active ? "border-redline" : "border-edge"}`}
    >
      <div className="flex min-w-0 cursor-pointer items-center gap-2" onClick={onHeadClick}>
        {number !== undefined ? (
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-redline text-[11px] font-bold text-white">
            {String(number)}
          </span>
        ) : null}
        <span className="overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
          {thread.anchor !== null
            ? thread.anchor.text.length > 0
              ? thread.anchor.text
              : "Pinned comment"
            : "General comment"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {anchorVersion !== undefined ? (
            <span
              className="cursor-pointer rounded-full border border-warn/40 px-2 py-px text-[11px] text-warn hover:bg-warn/10"
              title={"Show " + anchorVersion + " to see this pin"}
              onClick={(event) => {
                event.stopPropagation()
                onSwitchVersion(anchorVersion)
              }}
            >
              pinned on {anchorVersion}
            </span>
          ) : null}
          {resolved ? (
            <>
              <span className="rounded-full border border-go/40 px-2 py-px text-[11px] text-go">
                resolved in {resolvedIn}
              </span>
              <span className="text-[11px] text-mist">{collapsed ? "▸" : "▾"}</span>
            </>
          ) : null}
        </span>
      </div>
      {collapsed ? null : (
        <div className="flex flex-col gap-1.5">
          {thread.messages.map((message) => (
            <div key={message.id} className="flex items-baseline gap-2 text-[13px]">
              <span
                className={`h-fit shrink-0 rounded border px-1.5 py-px text-[11px] ${
                  message.author === "user" ? "border-[#34437a] text-link" : "border-go/40 text-go"
                }`}
              >
                {message.author}
              </span>
              {message.kind === "thinking" ? (
                <>
                  <Spinner className="self-center" />
                  <span className="text-dim italic">thinking…</span>
                </>
              ) : (
                <span className="break-words whitespace-pre-wrap">{message.body}</span>
              )}
            </div>
          ))}
          <div className="mt-0.5 flex gap-1.5">
            <input
              type="text"
              value={reply}
              placeholder="Reply..."
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && reply.trim().length > 0) {
                  onReply(reply.trim())
                  setReply("")
                }
              }}
              className="min-w-0 flex-1 rounded-md border border-edge-strong bg-ink px-2 py-1 text-[13px] text-fog placeholder:text-dim"
            />
            <button
              type="button"
              disabled={busy || reply.trim().length === 0}
              onClick={() => {
                onReply(reply.trim())
                setReply("")
              }}
              className="rounded-md border border-edge-strong bg-panel px-2 py-1 text-xs text-fog hover:border-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reply
            </button>
            {review ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onToggleStatus(thread.status === "open" ? "resolved" : "open")}
                className="rounded-md border border-edge-strong bg-panel px-2 py-1 text-xs text-fog hover:border-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {thread.status === "open" ? "Resolve" : "Reopen"}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
