import { isPendingVersion } from "@redline/http-contracts/artifact.models"
import type { Anchor, Thread, Version } from "@redline/http-contracts/artifact.models"
import React from "react"
import { Link } from "react-router"

import { Spinner } from "../../components/spinner"
import { StatusBadge } from "../../components/status.badge"
import { numberedPins, PinsOverlay } from "./pins.overlay"
import { PresenceBadge } from "./presence.badge"
import {
  useApproveMutation,
  useArtifactQuery,
  useCreateThreadMutation,
  useFeedbackQuery,
  useIterateMutation,
  useReplyMutation,
  useThreadStatusMutation,
} from "./queries"
import { ThreadsComposer } from "./threads.composer"
import { ThreadsPanel } from "./threads.panel"
import { VersionsSelect } from "./versions.select"

export type ReviewShellProps = {
  id: string
}

type ComposerDraft = {
  anchor: Anchor | null
  label: string
}

export const ReviewShell: React.FC<ReviewShellProps> = ({ id }) => {
  const artifactQuery = useArtifactQuery(id)
  const [composerOpen, setComposerOpen] = React.useState(false)
  const feedbackQuery = useFeedbackQuery(id, composerOpen ? false : 5000)
  const view = feedbackQuery.data

  const iterate = useIterateMutation(id)
  const approve = useApproveMutation(id)
  const createThread = useCreateThreadMutation(id)
  const reply = useReplyMutation(id)
  const setThreadStatus = useThreadStatusMutation(id)

  const [selectedVersion, setSelectedVersion] = React.useState<Version | undefined>(undefined)
  const [pinMode, setPinMode] = React.useState(false)
  const [draft, setDraft] = React.useState<ComposerDraft | undefined>(undefined)
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})
  const [activeThreadId, setActiveThreadId] = React.useState<string | undefined>(undefined)
  const [dingOn, setDingOn] = React.useState(dingPreference)
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  const [frameEpoch, setFrameEpoch] = React.useState(0)
  const previousStatus = React.useRef<string | undefined>(undefined)

  const status = view?.artifactStatus
  const displayedVersion: Version = selectedVersion ?? view?.version ?? "v1"

  React.useEffect(() => {
    const current = view?.artifactStatus
    const before = previousStatus.current
    if (before === "iterating" && current === "review" && dingOn) playDing()
    previousStatus.current = current
  }, [view?.artifactStatus, dingOn])

  React.useEffect(() => {
    if (activeThreadId === undefined) return
    const timer = window.setTimeout(() => setActiveThreadId(undefined), 1600)
    return () => window.clearTimeout(timer)
  }, [activeThreadId])

  const focusThread = (thread: Thread) => {
    const doc = frameRef.current?.contentDocument
    if (doc !== undefined && doc !== null && thread.anchor !== null) {
      const target = doc.querySelector(thread.anchor.selector)
      if (target !== null) {
        target.scrollIntoView({ block: "center", behavior: "smooth" })
        target.classList.add("redline-flash")
        window.setTimeout(() => target.classList.remove("redline-flash"), 1600)
      }
    }
    setActiveThreadId(thread.id)
  }

  if (artifactQuery.isPending || feedbackQuery.isPending || view === undefined) {
    return (
      <div className="grid min-h-screen place-items-center text-mist">
        <p className="flex items-center gap-2">
          <Spinner /> loading artifact…
        </p>
      </div>
    )
  }

  if (artifactQuery.isError) {
    return (
      <div className="grid min-h-screen place-items-center">
        <p className="text-warn">{artifactQuery.error.message}</p>
      </div>
    )
  }

  const artifact = artifactQuery.data
  const review = status === "review"
  const iterating = status === "iterating"
  const approved = view.approvedAt !== undefined
  const pending = view.versions.find(isPendingVersion)
  const pins = numberedPins(view.threads, displayedVersion)
  const numbers = new Map(pins.map((pin) => [pin.thread.id, pin.number]))

  const iteratingBanner =
    iterating && pending !== undefined
      ? "Agent is iterating → " +
        pending.version +
        " (" +
        String(pending.batch?.threadIds.length ?? 0) +
        (pending.batch?.threadIds.length === 1 ? " thread" : " threads") +
        " in batch). Replies still reach it after this round."
      : undefined
  const banner = iterate.isError ? iterate.error.message : iteratingBanner

  const openComposer = (next: ComposerDraft) => {
    setDraft(next)
    setComposerOpen(true)
  }

  const saveComposer = (body: string) => {
    createThread.mutate(
      { version: displayedVersion, anchor: draft?.anchor ?? null, body: body },
      {
        onSuccess: () => {
          setComposerOpen(false)
          setDraft(undefined)
        },
      },
    )
  }

  const frameSrc = "/a/" + id + "/" + displayedVersion + "/index.html"

  const onFrameLoad = () => {
    const doc = frameRef.current?.contentDocument
    if (doc !== undefined && doc !== null && doc.head !== null) {
      const style = doc.createElement("style")
      style.textContent = ".redline-flash { outline: 3px solid #e5484d !important; outline-offset: 2px; }"
      doc.head.appendChild(style)
    }
    setFrameEpoch((epoch) => epoch + 1)
  }

  const buttonBase =
    "rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
  const neutralButton =
    buttonBase + " border-edge-strong bg-panel text-fog hover:border-hover disabled:hover:border-edge-strong"

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-edge bg-panel px-3.5 py-2">
        <Link to="/" className="font-bold text-redline no-underline">
          redline
        </Link>
        <span className="max-w-[28vw] overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
          {artifact.title}
        </span>
        <StatusBadge status={view.artifactStatus} approved={approved} />
        <PresenceBadge
          iterating={iterating}
          reviewerAttached={view.reviewerAttached === true}
          workerRunning={view.workerRunning === true}
        />
        <VersionsSelect
          versions={view.versions}
          value={displayedVersion}
          onChange={(version) => setSelectedVersion(version)}
        />
        <label className="flex items-center gap-1.5 text-xs text-mist">
          <input
            type="checkbox"
            checked={dingOn}
            onChange={(event) => {
              setDingOn(event.target.checked)
              setDingPreference(event.target.checked)
            }}
            className="cursor-pointer accent-redline"
          />
          ding when done
        </label>
        <span className="flex-1" />
        <button
          type="button"
          disabled={!review}
          onClick={() => openComposer({ anchor: null, label: "general comment (not pinned to an element)" })}
          className={neutralButton}
        >
          General
        </button>
        <button
          type="button"
          disabled={!review}
          onClick={() => setPinMode(true)}
          className={neutralButton}
        >
          + Comment
        </button>
        <button
          type="button"
          disabled={!review || iterate.isPending}
          title={
            iterating
              ? "Agent is already iterating"
              : review
                ? "Send open threads to the agent as one batch"
                : "Finish the iterating round first"
          }
          onClick={() => iterate.mutate(undefined, { onSuccess: () => setSelectedVersion(undefined) })}
          className={
            buttonBase +
            " border-redline bg-redline font-semibold text-white disabled:border-edge-strong disabled:bg-panel disabled:text-mist"
          }
        >
          {iterate.isPending ? "Iterating…" : "Iterate"}
        </button>
        <button
          type="button"
          disabled={!review || approved || approve.isPending}
          title={
            approved
              ? displayedVersion + " approved — done for now (Iterate to continue)"
              : review
                ? "Done for now: approve " + view.current + " (always iterable later)"
                : "Finish the iterating round first"
          }
          onClick={() => approve.mutate(view.current)}
          className={buttonBase + " border-go/40 bg-panel text-go disabled:hover:border-go/40"}
        >
          {approved ? "Approved" : "Approve"}
        </button>
      </header>
      {banner !== undefined ? (
        <div className="border-b border-warn/40 bg-warn/10 px-3.5 py-1.5 text-[13px] text-warn">{banner}</div>
      ) : null}
      <main className="flex min-h-0 flex-1">
        <section className="relative min-w-0 flex-1 bg-white">
          <iframe
            ref={frameRef}
            key={frameSrc}
            src={frameSrc}
            title="artifact"
            onLoad={onFrameLoad}
            className="block h-full w-full border-0"
          />
          <PinsOverlay
            pins={pins}
            armed={pinMode && review}
            epoch={frameEpoch}
            frameRef={frameRef}
            onSelect={(pin) => focusThread(pin.thread)}
            onPick={(pick) => {
              setPinMode(false)
              openComposer({ anchor: pick.anchor, label: pick.label })
            }}
          />
        </section>
        <aside className="flex w-[360px] shrink-0 flex-col gap-2.5 overflow-y-auto border-l border-edge bg-panel p-3">
          {artifact.prompt.length > 0 ? (
            <details className="rounded-lg border border-edge px-2.5 py-2 text-xs text-mist">
              <summary className="cursor-pointer text-[#c6cbd6]">Brief</summary>
              <p className="mt-2 mb-0 whitespace-pre-wrap">{artifact.prompt}</p>
            </details>
          ) : null}
          <div className="text-xs text-mist">
            Comment on anything — the agent answers live in the thread. Hit <b>Iterate</b> to send the batch: the
            agent rewrites the artifact and publishes the next version. <b>Approve</b> just means done for now.
          </div>
          {composerOpen && draft !== undefined ? (
            <ThreadsComposer
              target={draft.label}
              busy={createThread.isPending}
              onCancel={() => {
                setComposerOpen(false)
                setDraft(undefined)
              }}
              onSave={saveComposer}
            />
          ) : null}
          <ThreadsPanel
            threads={view.threads}
            review={review}
            numbers={numbers}
            expanded={expanded}
            activeThreadId={activeThreadId}
            busy={reply.isPending || setThreadStatus.isPending}
            onToggleExpanded={(threadId) =>
              setExpanded((previous) => ({ ...previous, [threadId]: !(previous[threadId] ?? false) }))
            }
            onFlash={focusThread}
            onReply={(threadId, body) => reply.mutate({ threadId: threadId, body: body })}
            onToggleStatus={(threadId, next) => setThreadStatus.mutate({ threadId: threadId, status: next })}
            onSwitchVersion={(version) => setSelectedVersion(version)}
          />
        </aside>
      </main>
    </div>
  )
}

// ---------- ding when a round finishes ----------

const dingKey = "redline.ding"

const dingPreference = (): boolean => {
  try {
    return localStorage.getItem(dingKey) !== "off"
  } catch {
    return true
  }
}

const setDingPreference = (on: boolean): void => {
  try {
    localStorage.setItem(dingKey, on ? "on" : "off")
  } catch {
    return
  }
}

let audioContext: AudioContext | undefined

const playDing = (): void => {
  const Ctor =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (Ctor === undefined) return
  try {
    if (audioContext === undefined) audioContext = new Ctor()
    const ctx = audioContext
    if (ctx.state === "suspended") void ctx.resume()
    const now = ctx.currentTime
    const notes: Array<[number, number]> = [
      [880, 0],
      [1174.66, 0.13],
    ]
    for (const [frequency, offset] of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.value = frequency
      const start = now + offset
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.5)
    }
  } catch {
    return
  }
}
