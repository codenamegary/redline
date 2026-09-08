import { describe, expect, it } from "vitest"
import { versionOptionLabel } from "./VersionsSelect"

describe("versionOptionLabel", () => {
  it("joins note and state chips", () => {
    expect(
      versionOptionLabel({
        version: "v3",
        createdAt: "2026-09-07T10:00:00.000Z",
        note: "redline pass",
        batch: { threadIds: ["t"], submittedAt: "2026-09-07T11:00:00.000Z" },
      }),
    ).toBe("v3 · redline pass · awaiting agent")
    expect(
      versionOptionLabel({
        version: "v1",
        createdAt: "2026-09-07T10:00:00.000Z",
        approvedAt: "2026-09-07T11:00:00.000Z",
      }),
    ).toBe("v1 · approved")
  })
})
