# Per-Sender Message Batching

## Problem

When Lumen is busy (mid-turn) and messages arrive from multiple senders, the
current poll loop pushes them all into the active stream as they land. This
causes two issues:

1. **Mid-stream push race**: a message arriving after the `result` event fires
   gets pushed into a dying stream, gets `markCompleted` called, but Lumen
   never meaningfully acts on it.

2. **Batch assumption**: when Lumen receives a mixed batch (e.g. messages from
   a peer agent, DMJ, and a subagent), she may treat earlier messages as already
   handled and respond only to the most recent. 19 messages across 5 senders
   would otherwise require 19 separate turns; batching by sender compresses
   them to 5 — more efficient, especially under load.

## Design

### During a turn: accumulate, don't push

The mid-stream follow-up poller (currently calls `query.push()`) is changed to
**not push**. Messages that arrive while a turn is in progress stay `pending`
in `inbound.db`. The current turn finishes cleanly.

System messages (CLI responses, MCP tool results) are excluded — they are
responses to things Lumen already initiated and ride along with the current
turn as before.

### After a turn: group by sender, one turn per sender

After `processQuery` returns, the outer poll loop immediately re-polls.
`getPendingMessages` is changed to return only **one sender's messages per
call**, ordered by priority tier then age. The loop naturally sequences one
sender per turn until the backlog is clear.

### Priority ordering

Within the pending backlog, senders are served in this order:

1. **Users** — channel messages (`channel_type != 'agent'`), oldest first
2. **Peer agents** — a2a messages from agent groups Lumen did not create,
   oldest first
3. **Subagents** — a2a messages from agent groups Lumen created (detectable
   via `agent_destinations` where Lumen is the creator), oldest first

Within each tier, oldest pending trigger message first.

### Concatenation within a sender's batch

Multiple messages from the same sender are concatenated into a single prompt
with a `---` markdown delimiter between them, preserving chronological order.

### System note

When a sender's batch was formed from messages that arrived while Lumen was
busy (i.e. accumulated during a turn rather than arriving to an idle loop), a
one-line note is prepended:

```
Message batch arrived while agent was already responding to earlier events.
```

This is a permanent fact about when the messages arrived — it remains accurate
on every future context load, unlike a label such as "unhandled" which rots
once Lumen processes them.

## Changes Required

| File | Change |
|------|--------|
| `container/agent-runner/src/poll-loop.ts` | Remove `query.push()` from follow-up poller; let messages stay pending |
| `container/agent-runner/src/db/messages-in.ts` | `getPendingMessages` returns only one sender's messages per call, respecting priority order |
| `container/agent-runner/src/formatter.ts` | `formatChatMessages` concatenates same-sender messages with `---`; prepends system note when batch was accumulated |

## Sender Identity

| Message kind | Sender key |
|---|---|
| `chat-sdk` / `chat` from channel | `channel_type + platform_id` |
| `chat` from peer agent | sending agent group id (from routing) |
| `chat` from subagent | sending agent group id (from routing) |
| `system` / CLI responses | ride along with current turn, excluded from batching |

Subagent vs peer agent is determined by checking whether the sending agent
group id appears as a target in Lumen's `agent_destinations` table with
`target_type = 'agent'` — i.e. Lumen has a named destination pointing to that
group, which is only created by `create_agent`.

## Non-goals

- No change to how single-sender, idle-Lumen turns work — common case is
  unchanged.
- No per-sender sub-agents or separate containers — this is purely a
  sequencing change within Lumen's existing poll loop.
- No change to `trigger=0` accumulate-context semantics — those still ride
  along with the next real trigger from the same sender.
