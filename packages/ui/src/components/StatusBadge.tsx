import React from "react"
import type { ArtifactStatus } from "@redline/http-contracts/artifact.models"

export type StatusBadgeProps = {
  status: ArtifactStatus
  approved?: boolean
}

const classes: Record<ArtifactStatus, string> = {
  draft: "border-edge-strong bg-mist/10 text-mist",
  review: "border-warn/40 bg-warn/10 text-warn",
  iterating: "border-warn/40 bg-warn/10 text-warn",
}

const labels: Record<ArtifactStatus, string> = {
  draft: "draft",
  review: "in review",
  iterating: "iterating",
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, approved = false }) => {
  if (approved) {
    return (
      <span className="rounded-full border border-go/40 bg-go/10 px-2.5 py-0.5 text-xs whitespace-nowrap text-go">
        approved
      </span>
    )
  }
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap ${classes[status]}`}>
      {labels[status]}
    </span>
  )
}
