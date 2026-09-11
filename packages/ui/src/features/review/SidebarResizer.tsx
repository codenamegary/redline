import React from "react"

export type SidebarResizerProps = {
  // Raw pointer x while dragging; the parent derives the sidebar width
  // (it knows which edge the sidebar hugs and the viewport width).
  onDrag: (clientX: number) => void
  // Keyboard nudges: positive means wider, negative narrower.
  onNudge: (delta: number) => void
  onReset: () => void
  // Bracket a pointer drag so the parent can disable the iframe (which
  // would otherwise swallow pointermove while the cursor is over it).
  onDragStart?: () => void
  onDragEnd?: () => void
}

// The draggable separator between the artifact frame and the threads sidebar.
// Uses window-level pointer listeners so the drag keeps tracking when the
// cursor leaves the 6px handle.
export const SidebarResizer: React.FC<SidebarResizerProps> = ({ onDrag, onNudge, onReset, onDragStart, onDragEnd }) => {
  const draggingRef = React.useRef(false)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    draggingRef.current = true
    onDragStart?.()
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    const move = (moveEvent: PointerEvent) => {
      if (!draggingRef.current) return
      onDrag(moveEvent.clientX)
    }
    const up = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      onDragEnd?.()
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }

  React.useEffect(
    () => () => {
      draggingRef.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    },
    [],
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize comments sidebar"
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault()
          onNudge(16)
        }
        if (event.key === "ArrowRight") {
          event.preventDefault()
          onNudge(-16)
        }
      }}
      className="group relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-edge transition-colors hover:bg-redline focus-visible:bg-redline"
    >
      {/* fat invisible hit area so the 1px line is easy to grab */}
      <div className="absolute inset-y-0 -left-2 -right-2" />
    </div>
  )
}
