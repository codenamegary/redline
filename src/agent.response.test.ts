import { describe, expect, it } from "bun:test"

import { buildCreateResponseText, buildUpdateResponseText } from "./agent.response"

const summary = (reviewer?: "none" | "starting" | "idle") => ({
  id: "a1",
  current: "v1",
  status: "review",
  reviewUrl: "http://127.0.0.1:4739/a/a1",
  reviewer: reviewer,
})

describe("plugin response text", () => {
  it("stops after create when no reviewer is configured", () => {
    const text = buildCreateResponseText(summary("none"))
    expect(text).toContain("Give the user the review URL and stop")
    expect(text).toContain("get_feedback")
    expect(text).not.toContain("wait_for_feedback")
  })

  it("stops after create when the server runs reviewer lanes", () => {
    for (const reviewer of ["starting", "idle"] as const) {
      const text = buildCreateResponseText(summary(reviewer))
      expect(text).toContain("Reviewer configured on the redline server")
      expect(text).toContain("Give the user the review URL and stop")
      expect(text).not.toContain("wait_for_feedback")
    }
  })

  it("treats a missing reviewer flag as none on create", () => {
    expect(buildCreateResponseText(summary(undefined))).toContain("No reviewer lane is configured")
  })

  it("stops after update when no reviewer is configured", () => {
    const text = buildUpdateResponseText(summary("none"))
    expect(text).toContain("Published v1 of a1")
    expect(text).toContain("Give the user the review URL and stop")
    expect(text).not.toContain("wait_for_feedback")
  })

  it("stops after update when the server runs reviewer lanes", () => {
    const text = buildUpdateResponseText(summary("idle"))
    expect(text).toContain("Published v1 of a1")
    expect(text).toContain("Reviewer configured on the redline server")
    expect(text).not.toContain("wait_for_feedback")
  })

  it("treats a missing reviewer flag as none on update", () => {
    expect(buildUpdateResponseText(summary(undefined))).toContain("No reviewer lane is configured")
  })
})
