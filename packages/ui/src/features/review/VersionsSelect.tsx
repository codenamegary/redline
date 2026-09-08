import { ArtifactVersion, Version } from "@redline/http-contracts/artifact.models"
import React from "react"

// Dropdown label: version, then note and state chips the way the review
// shell has always shown them ("v2 · redline pass · awaiting agent").
export const versionOptionLabel = (entry: ArtifactVersion): string => {
  const bits = [entry.version]
  if (entry.note !== undefined && entry.note.length > 0) bits.push(entry.note)
  if (entry.approvedAt !== undefined) bits.push("approved")
  if (entry.batch !== undefined && entry.publishedAt === undefined) bits.push("awaiting agent")
  return bits.join(" · ")
}

export type VersionsSelectProps = {
  versions: ArtifactVersion[]
  value: Version
  onChange: (version: Version) => void
}

export const VersionsSelect: React.FC<VersionsSelectProps> = ({ versions, value, onChange }) => {
  return (
    <label className="flex items-center gap-1.5 text-xs text-mist">
      Version
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-[14rem] rounded-md border border-edge-strong bg-panel px-2 py-1 text-[13px] text-fog"
      >
        {versions.map((entry) => (
          <option key={entry.version} value={entry.version}>
            {versionOptionLabel(entry)}
          </option>
        ))}
      </select>
    </label>
  )
}
