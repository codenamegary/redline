import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SidebarResizer } from "./SidebarResizer"

const setup = () => {
  const onDrag = vi.fn()
  const onNudge = vi.fn()
  const onReset = vi.fn()
  const onDragStart = vi.fn()
  const onDragEnd = vi.fn()
  render(
    <SidebarResizer
      onDrag={onDrag}
      onNudge={onNudge}
      onReset={onReset}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    />,
  )
  const handle = screen.getByRole("separator")
  return { handle, onDrag, onNudge, onReset, onDragStart, onDragEnd }
}

describe("SidebarResizer", () => {
  it("drags via window pointer events and cleans up on release", () => {
    const { handle, onDrag, onDragStart, onDragEnd } = setup()

    fireEvent.pointerDown(handle, { button: 0, clientX: 600 })
    expect(onDragStart).toHaveBeenCalledTimes(1)
    expect(document.body.style.cursor).toBe("col-resize")

    fireEvent.pointerMove(window, { clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 480 })
    expect(onDrag).toHaveBeenNthCalledWith(1, 500)
    expect(onDrag).toHaveBeenNthCalledWith(2, 480)

    fireEvent.pointerUp(window)
    expect(onDragEnd).toHaveBeenCalledTimes(1)
    expect(document.body.style.cursor).toBe("")

    fireEvent.pointerMove(window, { clientX: 100 })
    expect(onDrag).toHaveBeenCalledTimes(2)
  })

  it("ignores non-primary buttons", () => {
    const { handle, onDragStart } = setup()
    fireEvent.pointerDown(handle, { button: 2 })
    expect(onDragStart).not.toHaveBeenCalled()
  })

  it("nudges wider with ArrowLeft and narrower with ArrowRight", () => {
    const { handle, onNudge } = setup()
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(onNudge).toHaveBeenCalledWith(16)
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(onNudge).toHaveBeenCalledWith(-16)
  })

  it("resets on double click", () => {
    const { handle, onReset } = setup()
    fireEvent.dblClick(handle)
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
