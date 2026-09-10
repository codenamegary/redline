import { ArtifactVersion, Version } from "@redline/http-contracts/artifact.models"
import { Check } from "lucide-react"
import React from "react"
import { versionOptionLabel } from "../review/VersionsSelect"

export type VersionChipsProps = {
  versions: ArtifactVersion[]
  current: Version
}

// One chip per version in the ledger: approved versions wear a green check,
// a pending iteration renders dashed, the current version is emphasized.
// Hover repeats the review shell's version label (note + state).
export const VersionChips: React.FC<VersionChipsProps> = ({ versions, current }) => {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {versions.map((entry) => {
        const approved = entry.approvedAt !== undefined
        const pending = entry.batch !== undefined && entry.publishedAt === undefined
        const isCurrent = entry.version === current
        const look = approved
          ? "border-go/40 bg-go/10 text-go"
          : pending
            ? "border-dashed border-warn/50 bg-warn/10 text-warn"
            : "border-edge-strong bg-panel text-mist"
        return (
          <span
            key={entry.version}
            title={versionOptionLabel(entry)}
            className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px font-mono text-[11px] leading-4 ${look} ${isCurrent && !approved ? "border-fog/40 text-fog" : ""}`}
          >
            {approved ? <Check className="size-3" aria-hidden /> : null}
            {entry.version}
          </span>
        )
      })}
    </span>
  )
}
