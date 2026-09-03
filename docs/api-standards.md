# API Standards

## Maturity
Richardson Level 2. Resources are nouns, verbs carry intent, status codes carry outcome.

## Paths
Plural nouns, kebab-case segments, shallow nesting.

- `/api/v1/artifacts`
- `/api/v1/artifacts/{id}/versions`
- `/api/v1/artifacts/{id}/feedback`
- `/api/v1/artifacts/{id}/threads/{threadId}/messages`

## Versioning
URL prefix `/api/v1/`.

## JSON
camelCase on the wire. Dates are ISO 8601 strings in UTC (`2026-01-15T14:32:05.000Z`).

## Status codes
- `200` read or update success
- `201` create success, with `Location` header when the created resource has a stable URL
- `400` invalid input (zod parse failure at the boundary)
- `404` unknown artifact, version, thread, or file
- `409` state conflict (reserved)

## Errors
RFC 7807 Problem Details with `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Artifact not found",
  "status": 404,
  "detail": "artifact not found: 2026-01-15-143205-dashboard"
}
```

## Query params
camelCase names. Long-poll reads on the feedback collection use `?after=<isoTimestamp>&wait=<seconds>`.

## Pagination
None. Redline is a single-user local tool and collections are small. Revisit if artifact counts grow past a few hundred.
