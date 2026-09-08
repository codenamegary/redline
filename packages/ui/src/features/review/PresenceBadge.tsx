import React from "react"
import { Spinner } from "../../components/Spinner"

export type PresenceBadgeProps = {
  iterating: boolean
  reviewerAttached: boolean
  workerRunning: boolean
}

export const PresenceBadge: React.FC<PresenceBadgeProps> = ({
  iterating,
  reviewerAttached,
  workerRunning,
}) => {
  const working = iterating || workerRunning
  const live = reviewerAttached
  const label = workerRunning
    ? "worker running"
    : iterating
      ? "agent working"
      : live
        ? "reviewer live"
        : "agents idle"
  const tone = working
    ? "border-warn/40 text-warn"
    : live
      ? "border-go/40 text-go"
      : "border-edge-strong text-mist"
  const dot = working ? "bg-warn presence-dot-working" : live ? "bg-go" : "bg-dim"
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap ${tone}`}
    >
      {working ? <Spinner className="border-t-warn" /> : <span className={`size-2 rounded-full ${dot}`} />}
      {label}
    </span>
  )
}
