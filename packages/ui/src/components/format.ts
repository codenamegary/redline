export const shortDate = (isoTimestamp: string): string =>
  isoTimestamp.slice(0, 16).replace("T", " ")

export const countLabel = (count: number, singular: string, plural?: string): string =>
  String(count) + " " + (count === 1 ? singular : (plural ?? singular + "s"))
