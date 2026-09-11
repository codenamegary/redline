import { isPendingVersion, Anchor, Thread, Version } from "@redline/http-contracts/artifact.models"
import React from "react"
import { Link, useSearchParams } from "react-router"
import { Spinner } from "../../components/Spinner"
import { StatusBadge } from "../../components/StatusBadge"
import { numberedPins, PinsOverlay } from "./PinsOverlay"
import { PinOffset } from "./PinsOverlay"
import { PresenceBadge } from "./PresenceBadge"
import { useApproveMutation, useArtifactQuery, useCreateThreadMutation, useFeedbackQuery, useIterateMutation, useReplyMutation, useStopIterationMutation, useThreadStatusMutation } from "./queries"
import { SessionLogPanel } from "./SessionLogPanel"
import { ThreadsComposer } from "./ThreadsComposer"
import { ThreadsPanel } from "./ThreadsPanel"
import { VersionsSelect } from "./VersionsSelect"

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
  const [searchParams, setSearchParams] = useSearchParams()
  const feedbackQuery = useFeedbackQuery(id, composerOpen ? false : 5000)
  const view = feedbackQuery.data

  const iterate = useIterateMutation(id)
  const stop = useStopIterationMutation(id)
  const approve = useApproveMutation(id)
  const createThread = useCreateThreadMutation(id)
  const reply = useReplyMutation(id)
  const setThreadStatus = useThreadStatusMutation(id)

  const [userSelected, setUserSelected] = React.useState<Version | undefined>(undefined)

  // Deep links (?v=v2, e.g. from gallery drawer rows) open that version;
  // unknown or absent versions fall through to the current one. All version
  // switches keep the param in sync so the URL stays shareable.
  const requestedVersion = searchParams.get("v") ?? undefined
  const validRequested =
    requestedVersion !== undefined && view?.versions.some((entry) => entry.version === requestedVersion)
      ? requestedVersion
      : undefined
  const selectedVersion = validRequested ?? userSelected

  const selectVersion = (version: Version | undefined) => {
    setUserSelected(version)
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (version === undefined) next.delete("v")
        else next.set("v", version)
        return next
      },
      { replace: true },
    )
  }
  const [pinMode, setPinMode] = React.useState(false)
  const [logOpen, setLogOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<ComposerDraft | undefined>(undefined)
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})
  const [activeThreadId, setActiveThreadId] = React.useState<string | undefined>(undefined)
  const [dingOn, setDingOn] = React.useState(dingPreference)
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  const [pinOffset, setPinOffset] = React.useState<PinOffset>({ x: 0, y: 0 })
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
  // Stuck = iterating but the server says no worker is live: a round
  // orphaned by a crash/restart, or a wedged duty. The server owns the
  // clock (workerRunning + heartbeat); the client just reads it.
  const stuck = iterating && view.workerLive !== true && !iterate.isPending
  const stuckBanner = stuck
    ? "The worker looks stuck or was interrupted (server restart?). Stop the round to return to review — your threads stay open."
    : undefined
  const banner = iterate.isError ? iterate.error.message : (stuckBanner ?? iteratingBanner)

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
    const win = frameRef.current?.contentWindow ?? null
    if (win !== null) {
      const sync = () => setPinOffset({ x: win.scrollX, y: win.scrollY })
      win.addEventListener("scroll", sync, true)
      win.addEventListener("resize", sync)
      sync()
    }
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
          onChange={selectVersion}
        />
        <label className="flex items-center gap-1.5 text-xs text-mist">
          <input
            type="checkbox"
            checked={dingOn}
            onChange={(event) => {
              setDingOn(event.target.checked)
              setDingPreference(event.target.checked)
              if (event.target.checked) playDing()
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
          onClick={() => iterate.mutate(undefined, { onSuccess: () => {
            selectVersion(undefined)
            setLogOpen(false)
          } })}
          className={
            buttonBase +
            " border-redline bg-redline font-semibold text-white disabled:border-edge-strong disabled:bg-panel disabled:text-mist"
          }
        >
          {iterate.isPending ? "Iterating…" : "Iterate"}
        </button>
        {iterating ? (
          <>
            <button
              type="button"
              onClick={() => setLogOpen(true)}
              title="Watch what the worker is doing"
              className={neutralButton}
            >
              Log
            </button>
            <button
              type="button"
              disabled={stop.isPending}
              title="Stop this iteration and return to review (threads stay open)"
              onClick={() => {
                if (window.confirm("Stop this iteration and return to review? Work in progress is discarded.")) {
                  stop.mutate(undefined)
                }
              }}
              className={buttonBase + " border-redline/40 bg-panel text-redline disabled:hover:border-redline/40"}
            >
              {stop.isPending ? "Stopping…" : "Stop"}
            </button>
          </>
        ) : null}
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
            offset={pinOffset}
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
            onSwitchVersion={selectVersion}
          />
        </aside>
      </main>
      {logOpen && iterating ? <SessionLogPanel id={id} onClose={() => setLogOpen(false)} /> : null}
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
