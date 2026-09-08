import { describe, expect, it } from "vitest"

import type { Thread, Version } from "@redline/http-contracts/artifact.models"
import { AnchorSchema } from "@redline/http-contracts/artifact.models"

import { numberedPins } from "./pins.overlay"

const thread = (overrides: Partial<Thread> & Pick<Thread, "id">): Thread => ({
  status: "open",
  anchor: null,
  messages: [
    { id: overrides.id + "-m1", author: "user", kind: "text", body: "b", createdAt: "2026-09-07T10:00:00.000Z" },
  ],
  createdAt: "2026-09-07T10:00:00.000Z",
  ...overrides,
})

const pinnedThread = (id: string, y: number, extra: Partial<Thread> = {}): Thread =>
  thread({
    id: id,
    anchor: AnchorSchema.parse({ selector: "#" + id, text: id, rect: { x: 10, y: y, width: 100, height: 20 } }),
    ...extra,
  })

describe("numberedPins", () => {
  const version = "v2" as Version

  it("numbers only open pinned threads on the viewed version, oldest first", () => {
    const threads = [
      pinnedThread("c", 3, { createdAt: "2026-09-07T12:00:00.000Z" }),
      pinnedThread("a", 1),
      thread({ id: "b", status: "resolved", anchor: { selector: "#c", text: "c", rect: { x: 10, y: 2, width: 100, height: 20 } } }),
      pinnedThread("d", 4, { anchorVersion: "v1" as Version }),
      thread({ id: "e" }),
    ]
    const pins = numberedPins(threads, version)
    expect(pins.map((pin) => pin.thread.id)).toEqual(["a", "c"])
    expect(pins.map((pin) => pin.number)).toEqual([1, 2])
  })

  it("breaks createdAt ties by id", () => {
    const threads = [pinnedThread("b", 1), pinnedThread("a", 2)]
    expect(numberedPins(threads, version).map((pin) => pin.thread.id)).toEqual(["a", "b"])
  })
})
