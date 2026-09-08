import { AnchorSchema } from "@redline/http-contracts/artifact.models"
import type { Anchor, Thread, Version } from "@redline/http-contracts/artifact.models"
import React from "react"

export type NumberedPin = {
  thread: Thread
  number: number
}

const oldestFirst = (a: Thread, b: Thread): number =>
  a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Open pinned threads on the viewed version, oldest first, so pin numbers
// stay stable as new comments arrive.
export const numberedPins = (threads: Thread[], version: Version): NumberedPin[] => {
  const pinnable = threads.filter(
    (thread) =>
      thread.status === "open" &&
      thread.anchor !== null &&
      thread.anchor.rect !== undefined &&
      (thread.anchorVersion ?? version) === version,
  )
  return pinnable.slice().sort(oldestFirst).map((thread, index) => ({ thread: thread, number: index + 1 }))
}

export type PinPick = {
  anchor: Anchor
  label: string
}

const cssEscape = (value: string): string => {
  const escape = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS?.escape
  return escape !== undefined ? escape(value) : value.replace(/([^a-zA-Z0-9_-])/g, "\\$1")
}

// CSS selector for an element inside the artifact iframe: prefers the
// nearest id, otherwise walks up building nth-of-type segments.
const buildSelector = (doc: Document, element: Element): string => {
  if (element.id.length > 0) return "#" + cssEscape(element.id)
  const parts: string[] = []
  let node: Element | null = element
  while (node !== null && node !== doc.documentElement) {
    const current: Element = node
    if (current.id.length > 0) {
      parts.unshift("#" + cssEscape(current.id))
      break
    }
    let segment = current.tagName.toLowerCase()
    const parent: Element | null = current.parentElement
    if (parent !== null) {
      const sameKind = Array.from(parent.children).filter((child) => child.tagName === current.tagName)
      if (sameKind.length > 1) {
        segment += ":nth-of-type(" + String(sameKind.indexOf(current) + 1) + ")"
      }
    }
    parts.unshift(segment)
    node = parent
  }
  return parts.join(" ")
}

// Captures an element picked in the artifact iframe as a comment anchor.
// Coordinates are document coordinates so pins survive scrolling.
const pickAnchor = (doc: Document, win: Window, element: Element): PinPick | undefined => {
  const rect = element.getBoundingClientRect()
  const anchor = AnchorSchema.parse({
    selector: buildSelector(doc, element),
    text: (element.textContent ?? "").trim().slice(0, 120),
    rect: {
      x: rect.x + win.scrollX,
      y: rect.y + win.scrollY,
      width: rect.width,
      height: rect.height,
    },
  })
  return {
    anchor: anchor,
    label: anchor.text.length > 0 ? "on: " + anchor.text : "on: " + anchor.selector,
  }
}

export type PinsOverlayProps = {
  pins: NumberedPin[]
  armed: boolean
  epoch: number
  frameRef: React.RefObject<HTMLIFrameElement | null>
  onSelect: (pin: NumberedPin) => void
  onPick: (pick: PinPick) => void
}

export const PinsOverlay: React.FC<PinsOverlayProps> = ({
  pins,
  armed,
  epoch,
  frameRef,
  onSelect,
  onPick,
}) => {
  const [, setScrollTick] = React.useState(0)

  React.useEffect(() => {
    const win = frameRef.current?.contentWindow ?? null
    if (win === null) return
    const rerender = () => setScrollTick((tick) => tick + 1)
    win.addEventListener("scroll", rerender, true)
    win.addEventListener("resize", rerender)
    return () => {
      win.removeEventListener("scroll", rerender, true)
      win.removeEventListener("resize", rerender)
    }
  }, [epoch, frameRef])

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!armed) return
    event.preventDefault()
    const frame = frameRef.current
    const doc = frame?.contentDocument ?? null
    const win = frame?.contentWindow ?? null
    if (frame === null || doc === null || win === null) return
    const frameRect = frame.getBoundingClientRect()
    const element = doc.elementFromPoint(event.clientX - frameRect.left, event.clientY - frameRect.top)
    if (element === null) return
    const pick = pickAnchor(doc, win, element)
    if (pick !== undefined) onPick(pick)
  }

  return (
    <div
      onClick={handleClick}
      className={`absolute inset-0 ${armed ? "pointer-events-auto cursor-crosshair bg-redline/[0.06]" : "pointer-events-none"}`}
    >
      {pins.map((pin) => {
        const rect = pin.thread.anchor?.rect
        const win = frameRef.current?.contentWindow ?? null
        if (rect === undefined || win === null) return null
        const text = pin.thread.anchor?.text
        return (
          <button
            key={pin.thread.id}
            type="button"
            title={text !== undefined && text.length > 0 ? text : "Comment"}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(pin)
            }}
            style={{ left: String(rect.x - win.scrollX) + "px", top: String(rect.y - win.scrollY) + "px" }}
            className="pointer-events-auto absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-redline text-xs font-bold text-white shadow-[0_2px_6px_rgba(0,0,0,0.35)]"
          >
            {String(pin.number)}
          </button>
        )
      })}
    </div>
  )
}
