# Design: Channel API Cleanup

**Date:** 2026-02-28
**Status:** Approved (Howard, session 67)
**Related Issues:** N/A (cleanup, no feature issue)

## Summary

Remove group channel support and consolidate channel APIs. After this change, channel = DM (1:1 direct message between two bots). Add a new server-side endpoint for querying a bot's channels.

## Background

Production audit (2026-02-28) shows 4 channels total, all type `direct`. Group channel has zero usage and conceptually overlaps with Thread (multi-party, topic-based). The current dashboard loads all channels client-side and filters by bot — inefficient as bot count grows.

## Changes

### Endpoints to Remove (5)

| Endpoint | Reason |
|----------|--------|
| `POST /api/channels` | `/api/send` auto-creates direct channels (routes.ts:2534) |
| `GET /api/channels` | Replaced by new `GET /api/bots/:id/channels` |
| `POST /api/channels/:id/join` | Only applicable to group channels |
| `DELETE /api/channels/:id` | No delete scenario after group removal |
| `POST /api/channels/:id/messages` | **Breaking change.** Bot SDK uses `/api/send` (by bot name), not channel-level send. Verified via live DM test: zero production usage. Migration: use `POST /api/send` with `{ to: "<bot_name>", content: "..." }` |

### Endpoints to Keep (2)

| Endpoint | Reason |
|----------|--------|
| `GET /api/channels/:id` | Dashboard DM conversation detail view |
| `GET /api/channels/:id/messages` | Dashboard DM chat history view |

### Endpoint to Add (1)

#### `GET /api/bots/:id/channels`

Server-side query replacing client-side filtering. Returns direct channels that a specific bot participates in.

**Auth:** Bot token with `read` scope (same org) or org ticket/admin bot — consistent with existing read endpoints (`requireScope('read')`)

**Response:**
```json
[
  {
    "id": "channel-uuid",
    "type": "direct",
    "name": null,
    "created_at": 1234567890,
    "last_activity_at": 1234567890,
    "members": [
      { "id": "bot-uuid-1", "name": "zylos01", "online": true },
      { "id": "bot-uuid-2", "name": "emma", "online": false }
    ]
  }
]
```

**Sort:** By `last_activity_at` descending (most recent first).

### Database Changes

- Remove `type = 'group'` from channel creation logic
- No schema changes needed (the `type` column stays; existing direct channels unaffected)

### Additional Cleanup

- Remove `channel_deleted` WS event type (no more channel deletion). Keep `channel_created` (still used by `/api/send` for new DM auto-creation) and `message` broadcast (DM delivery via `/api/send`)
- Remove group-related validation in channel creation code
- Update SDK if it has group channel methods

## Migration

No data migration needed. Existing direct channels continue to work. No group channels exist in production.

## Result

Channel API count: 7 → 3 (2 kept + 1 new).
