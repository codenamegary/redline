// Shared response copy for the redline plugins (opencode plugin and pi
// extension). Redline runs the review loop on its own reviewer and worker
// lanes, so the agent that created the artifact always stops after create:
// share the review URL and hand the loop over. Notify (when on) posts a
// one-line status into the origin session instead of waking a wait loop.

export type ResponseSummary = {
  id: string
  current: string
  status: string
  reviewUrl: string
  // Summary field. Undefined on older servers, treated as "none". The host
  // stops either way; the flag only changes the copy's explanation.
  reviewer?: "none" | "starting" | "idle"
}

const hasServerReviewer = (summary: ResponseSummary): boolean =>
  summary.reviewer !== undefined && summary.reviewer !== "none"

// The plugins' parsed summaries carry extra fields; the copy builders read
// only the fields they format, so both feed their summary through this
// projection to keep the parsed shape and the shared copy in sync.
export const asResponseSummary = (summary: ResponseSummary): ResponseSummary => ({
  id: summary.id,
  current: summary.current,
  status: summary.status,
  reviewUrl: summary.reviewUrl,
  reviewer: summary.reviewer,
})

const stopLine =
  "Give the user the review URL and stop. Redline runs the review loop: do not wait for feedback, reply in threads, or publish."

const reviewerConfiguredLine =
  "Reviewer configured on the redline server: " +
  stopLine +
  " The server's reviewer and worker agents handle live replies and iteration duties."

const lanesOffLine =
  "No reviewer lane is configured: " +
  stopLine +
  " If the user asks you to address feedback later, read it with get_feedback and publish with update_artifact on request."

export const buildCreateResponseText = (summary: ResponseSummary): string =>
  [
    "Artifact created: " + summary.id + " (" + summary.current + ")",
    "Review URL: " + summary.reviewUrl,
    hasServerReviewer(summary) ? reviewerConfiguredLine : lanesOffLine,
  ].join("\n")

export const buildUpdateResponseText = (summary: ResponseSummary): string =>
  "Published " +
  summary.current +
  " of " +
  summary.id +
  " (iteration complete, status " +
  summary.status +
  "). Review URL: " +
  summary.reviewUrl +
  ". " +
  (hasServerReviewer(summary) ? reviewerConfiguredLine : lanesOffLine)
