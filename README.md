# Swarm Chat Aggregator

The chat server for [swarm-chat-js](https://github.com/Solar-Punk-Ltd/swarm-chat-js) 7. Browsers send chat
messages as GSOC writes to one inbox address. This server listens on that inbox, checks every message, and
publishes each accepted one into its chat's Swarm feed, which browsers read. The browser only ever talks to
Swarm, through a gateway or its own Bee node.

## How it works

1. **Listening.** The server subscribes to the GSOC inbox on the listening node, the Bee node in the inbox
   address's neighbourhood. Every chat arrives through this one inbox, and the message's own `topic` says
   which chat it belongs to.
2. **Checking.** Each payload is checked by the library's message module (`@solarpunkltd/swarm-chat-js/message`):
   at most 2,048 bytes, UTF-8 JSON of the version 7 shape, and a signature that recovers the sender's `addr`.
   Then the server checks that the chat is allowed, that the sender's clock `ts` is within a day of its own,
   that the message is not a duplicate of one it already took (by `addr` and `id`), and that the chat and the
   sender are within their rates. Every drop is counted by its reason.
3. **Publishing.** Each chat has its own queue and publishes one message per feed slot, at indices 0, 1, 2 and
   on, under the server's feed key and `Topic.fromString(topic)`. Chats publish in parallel.
4. **History.** Each chat keeps its current history file in memory and saves a new copy after each publish.
   Every feed entry links the newest saved file, so a viewer opening the chat reads that file plus the entries
   after it.
5. **Slot notes.** Once a time slot of `NOTE_SLOT_MS` ends in which a message landed, and at least every
   `NOTE_HEARTBEAT_MS` while a chat is active, the server writes a small note naming the chat's newest feed slot.
   Viewers read only the notes of slots that are over and only the entries a note named, so nobody asks Bee for
   an entry before it exists.

### The feed entry

Written to slot `seq` of the chat's feed, always under 4,096 bytes so Bee never wraps it:

| Field     | Meaning                                                                          |
| :-------- | :------------------------------------------------------------------------------- |
| `v`       | `7`                                                                              |
| `seq`     | the message's number in this chat, equal to the feed index                       |
| `at`      | the server's receive time in milliseconds, the time a viewer shows               |
| `msg`     | the message exactly as received and verified                                     |
| `history` | `{ref, toSeq}` of the newest saved history file, or `null` before the first save |

The link trails by however many messages were published while the previous save was running.

### The history file

An ordinary Swarm upload of JSON: `{v: 7, topic, fromSeq, toSeq, messages: [{seq, at, msg}], prev}`. One save
runs at a time per chat, and messages published meanwhile ride the next save, so a burst costs at most two
saves, and a busy chat saves at most once per `HISTORY_SAVE_INTERVAL_MS`, so history uploads do not crowd out
the feed writes on the same node. A file closes at 1,000 messages or 512 KB, and the next one starts with `prev` pointing at it. Files are
uploaded at the `INSANE` redundancy level.

A file that cannot be downloaded when a chat resumes, as when its stamp has expired, is retried with the resume,
and after `PUBLISH_ATTEMPTS` failures in a row the chat starts a fresh file whose `prev` points at the lost one.
The chat keeps publishing, the loss is logged as an error, and `/health` names the lost file as `historyLost`.

What history costs grows with the square of the chat's length, because each save uploads the whole current
file again: with messages of about 400 bytes a chat of N messages uploads about 400 × N² / 2 bytes of history
over its life, about 20 MB at 300 messages and about 200 MB at 1,000, before redundancy.

### Slot notes

Bee answers a request for a chunk it cannot find by skipping each peer it asked for that address for a minute.
Viewers that asked for the next feed slot before it was written therefore made every new message about forty
seconds late, measured on 2026-10-01: a chunk nobody asked for early was readable in 1.0 to 1.5 seconds, the
same chunk after 20 seconds of asking took 40 to 42. Notes keep every read on Swarm and every read on an address
that is written or never will be.

- **The note.** Time slot `s` covers `[s * NOTE_SLOT_MS, (s + 1) * NOTE_SLOT_MS)` of Unix time. Its note is a
  single owner chunk under the feed key at the identifier keccak256(`<topic>/note/<NOTE_SLOT_MS>/<s>`), holding
  `{"v":1,"newest":<the newest confirmed feed slot>,"writtenAt":<the server's clock>}`. The library's message
  module defines it, and this server imports it.
- **When.** Once a slot ends, its note is written when a slot was confirmed since the last note written, or when
  `NOTE_HEARTBEAT_MS` has passed since that note. Only confirmed slots are named, so an entry's write has finished
  before any note names it.
- **A failed note** is never written again at its address, where a viewer may already have been refused. The
  next slot's note carries the same news, and so does every following slot's until one is written.
- **Active** means the chat's publisher is loaded and ready, and not stopped, blocked or evicted. A chat in
  `CHAT_TOPICS` is opened when the server starts, so it is active from then on and writes notes before any
  message, `newest` -1 while it has none. A chat matched only by `CHAT_TOPIC_PATTERN` is opened by its first
  message since the start, and until then its viewers find no note and follow it by polling.
- **What it costs.** One chunk of the feed stamp per note. A quiet active chat writes one every
  `NOTE_HEARTBEAT_MS`, 2,880 a day at the default, and a chat busy in every slot one every `NOTE_SLOT_MS`, at most
  43,200 a day. `/health` gives each chat's notes written, failed, the last one's time and the last error.

### Restarts and one writer

- **Checkpoints, written ahead.** Each chat has a small file in `CHECKPOINT_DIR`: the last slot confirmed in
  order, the entries in flight with their exact bytes, the newest history link and the rows published after it.
  An entry is recorded there before its slot is first written, and the file is replaced atomically, written to a
  temporary file, flushed to disk and renamed. A restart continues exactly where the checkpoint says, resends
  every entry in flight with its own bytes, and reads nothing else from the feed. A damaged checkpoint, including
  a list of entries that does not run on slot by slot from the last confirmed one, stops that chat on the health
  check and never starts it again at slot 0.
- **Several slots in flight, confirmed in order.** Up to `PUBLISH_WINDOW` slots of one chat are written at once,
  so a burst is not paced by one write at a time. Slots can land in any order, and a slot counts as confirmed
  only once every slot before it has landed, so the checkpoint's last confirmed slot only ever moves forward over
  slots that all hold their entries. A viewer may see a later slot a moment before an earlier one fills in.
- **One entry per slot, and a stall rather than a gap.** Only a slot's recorded entry is ever written to it, and
  it is resent unchanged, with a delay doubling up to 30 seconds, until one write succeeds, for as long as that
  takes. Messages past the window queue behind it, and past `QUEUE_LIMIT` they are dropped and logged as dead
  letters with their ids. So a Bee that refuses writes pauses the chat instead of forking it or leaving a hole,
  and `/health` names the first stuck slot, how long it has been stuck and how many attempts it took.
- **A chat without a checkpoint** asks Bee's head lookup and walks forward from there. A 404 from the lookup is
  not taken as a new chat on its own, because Bee answers 404 for a failed lookup too. A chat is new only when
  the lookup answered 404, slot 0 reads as absent twice `READ_RECHECK_MS` apart, the writing node answers ready
  with at least `MIN_CONNECTED_PEERS` connected peers, and one read on the listening node cannot find slot 0
  either. A node that cannot reach its peers reads every chunk as absent, which is why the absent answer needs
  that proof. Any other outcome leaves the chat unpublished and retried later, and a chat that does start this way
  says so in its log and on `/health`.
- **What these checks cost, and when.** They run only when a chat's first message arrives and the chat has no
  checkpoint, which in normal operation means once in the chat's life. A restart or an evicted chat resumes from
  its checkpoint without them, and a message in a running chat pays no read at all. A fresh start waits out one `READ_RECHECK_MS`, 1 second by default, plus about eight Bee requests:
  measured at 1.07 to 1.09 seconds against the test suite's fake Bee, and on a real node plus however long that
  node takes to answer a lookup and a read for a chunk it does not have.
- **A slot is absent** only when two reads, `READ_RECHECK_MS` apart, both answer 404 or 500, since Bee answers a
  chunk it could not find either way depending on its version. Timeouts and gateway errors are failed reads,
  retried and never taken as absent. Only where absence decides where a chat starts is it read twice.
- **Reading a slot before writing it** happens where it protects the feed: before the first writes after a
  chat resumes, every entry the checkpoint held in flight included, until a slot is confirmed, and before every
  attempt after a write that failed. Absent means it writes. Its own bytes there mean an earlier attempt landed.
  Anything else means the slot is taken, so the server stops publishing that chat and says so on the health
  check. That is what a checkpoint behind the feed meets, which the server stops at rather than overwrite. A
  running chat writes its next slot without reading it, since a read of an address not yet written makes Bee
  skip its peers for that address for a minute, and the lock keeps this server the feed's only writer.
- **The lock.** On start the server locks `CHECKPOINT_DIR` with a lock file holding a random instance id,
  refreshed every `LOCK_REFRESH_MS`. A start waits while a live holder keeps it fresh and then refuses. A lock
  older than `LOCK_STALE_MS` is taken over, which is how a restart after a kill gets in.

### Staying able to hear

A websocket dropped by a proxy never reports a close, so the server resubscribes whenever no frame has arrived
for `RESUBSCRIBE_IDLE_MS`, opening the new subscription before closing the old one. It also sends itself a
heartbeat every `HEARTBEAT_INTERVAL_MS` through the heartbeat node, which must be a different node from the
listening one. Heartbeats are `{v: 7, type: "heartbeat", nonce}`, recognised before any chat message, matched
against the nonces the server sent, counted, and never published.

### Health

`GET /health` on `HEALTH_PORT` answers 200 when all is well and 503 when no frame arrived, no heartbeat was
sent or none came back within `HEARTBEAT_STALE_MS`, or a chat cannot publish. Its JSON body carries the
seconds since the last frame, since the last heartbeat sent and received, the last send and subscribe errors,
each chat's state, next slot, queue depth, last publish and any stalled slot, and the counts of received,
published and dropped messages by reason.

Its `observations` block gives, per chat, the p50, p90 and maximum of each stage of its last 500 publishes: the
read before the write, zero in a running chat, the two checkpoint writes, the feed write, and the whole time from receipt to the entry
landing. They are measured and reported, never asserted, and never change what the server does.

After a restart, look at each chat's `historyLost`. It is the one thing that goes wrong without turning `/health`
red: it names a history file the chat could not download, so viewers loading older messages stop at that file,
while the chat itself keeps publishing. A chat that works should not read 503 for the rest of the process, which
is why it is a field and not a problem.

### Shutdown

On `SIGTERM` or `SIGINT` the server stops taking messages and spends up to `SHUTDOWN_DEADLINE_MS` publishing
what is queued and finishing the history saves. At the deadline it drops what is still queued, logged as dead
letters, then waits for any Bee request already sent to answer, which `REQUEST_TIMEOUT_MS` bounds, so the
checkpoint records whatever landed before it releases the lock and exits. The deadline therefore bounds the
publishing, not the whole stop, which can take up to about `SHUTDOWN_DEADLINE_MS` plus `REQUEST_TIMEOUT_MS`. An
entry still unwritten stays recorded in the checkpoint and is sent first after the restart.

A stop that is cut short, by a kill or a crash, loses what was queued without a dead-letter line, and never the
feed's consistency, which the checkpoint keeps.

## Settings

Environment variables, read once at start. A missing or malformed one stops the server with exit code 2 and
its name. A `.env` file in the working directory is read when it is there.

| Variable                   | Default         | Meaning                                                                                                                             |
| :------------------------- | :-------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| `LISTEN_BEE_URL`           | required        | the Bee node the server subscribes on, in the inbox address's neighbourhood                                                         |
| `WRITE_BEE_URL`            | required        | the Bee node that uploads feed entries and history files                                                                            |
| `HEARTBEAT_BEE_URL`        | required        | a different Bee node that heartbeats are sent through, the one browsers send through                                                |
| `WRITE_STAMP`              | required        | the postage batch id of the writing node, 64 hex characters                                                                         |
| `HEARTBEAT_STAMP`          | required        | a batch id the heartbeat node accepts                                                                                               |
| `FEED_KEY`                 | required        | the private key the chat feeds are written under, 64 hex characters                                                                 |
| `GSOC_KEY`                 | required        | the inbox's private key, public by design since every browser signs with it                                                         |
| `GSOC_IDENTIFIER`          | required        | the inbox's identifier string                                                                                                       |
| `CHAT_TOPICS`              | one of the two  | the allowed chats, a comma-separated list of topics                                                                                 |
| `CHAT_TOPIC_PATTERN`       | one of the two  | the allowed chats, a regular expression matched against the whole topic                                                             |
| `MAX_ACTIVE_CHATS`         | `50`            | how many chats outside `CHAT_TOPICS` the server publishes at once, listed chats are not counted                                     |
| `CHAT_IDLE_EVICT_MS`       | `600000`        | how long a chat outside `CHAT_TOPICS` must be quiet before it may be evicted to make room at the cap                                |
| `RATE_WINDOW_MS`           | `60000`         | the window the two rates count in                                                                                                   |
| `RATE_PER_CHAT`            | `600`           | messages per window in one chat                                                                                                     |
| `RATE_PER_SENDER`          | `30`            | messages per window from one sender in one chat                                                                                     |
| `QUEUE_LIMIT`              | `500`           | messages waiting per chat, past which more are dropped                                                                              |
| `PUBLISH_WINDOW`           | `8`             | how many slots of one chat may be in flight at once, each with its own entry, confirmed in slot order                               |
| `RESUBSCRIBE_IDLE_MS`      | `180000`        | the silence after which the server resubscribes                                                                                     |
| `HEARTBEAT_INTERVAL_MS`    | `60000`         | how often a heartbeat is sent                                                                                                       |
| `HEARTBEAT_STALE_MS`       | `180000`        | how long without a frame or a heartbeat before health answers 503, over the interval                                                |
| `READ_RECHECK_MS`          | `1000`          | the gap between the two reads that confirm an empty slot, paid only where absence decides where a chat starts                       |
| `REQUEST_TIMEOUT_MS`       | `30000`         | the longest any one Bee request may take                                                                                            |
| `HISTORY_TIMEOUT_MS`       | `180000`        | the longest a history file's upload or download may take, a whole file with its parity rather than one chunk                        |
| `HISTORY_TRAIL_LIMIT`      | `500`           | rows published since the last saved history file past which `/health` warns, since each one is in the checkpoint until a save lands |
| `HISTORY_SAVE_INTERVAL_MS` | `5000`          | the least time between two history uploads of one chat while it is busy, a quiet chat saves at once                                 |
| `RESUME_RETRY_MS`          | `30000`         | how long a chat whose head is unknown waits before trying again                                                                     |
| `PUBLISH_ATTEMPTS`         | `6`             | attempts per history save, and feed-write attempts before a stalled slot turns health red                                           |
| `RETRY_BASE_MS`            | `1000`          | the first retry delay, doubling up to 30 seconds                                                                                    |
| `SHUTDOWN_DEADLINE_MS`     | `20000`         | how long a shutdown may spend publishing what is queued                                                                             |
| `LOCK_REFRESH_MS`          | `5000`          | how often the lock holder refreshes the lock                                                                                        |
| `LOCK_STALE_MS`            | `60000`         | how old a lock must be before a new start takes it over, over twice the refresh                                                     |
| `MIN_CONNECTED_PEERS`      | `8`             | connected peers the writing node needs before a chat with no checkpoint starts at slot 0, 1 on a two-node test cluster              |
| `CROSS_CHECK_TIMEOUT_MS`   | `10000`         | the timeout of the second node's read of slot 0 for a chat with no checkpoint                                                       |
| `CHECKPOINT_DIR`           | `./checkpoints` | where the checkpoints and the lock live, a volume in a container                                                                    |
| `NOTE_SLOT_MS`             | `2000`          | the length of a slot note's time slot, part of every note's address, so viewers must use the same value                             |
| `NOTE_HEARTBEAT_MS`        | `30000`         | the longest an active chat goes without a note, at least `NOTE_SLOT_MS`, which bounds what a lost note costs a viewer               |
| `HEALTH_PORT`              | `3000`          | the port of `GET /health`                                                                                                           |

Seven settings replace variables of the 6.x server, which are no longer read:

- `LISTEN_BEE_URL` replaces `GSOC_BEE_URL`.
- `WRITE_BEE_URL` replaces `CHAT_BEE_URL`.
- `FEED_KEY` replaces `CHAT_KEY`.
- `WRITE_STAMP` replaces `CHAT_STAMP`.
- `GSOC_KEY` replaces `GSOC_RESOURCE_ID`.
- `GSOC_IDENTIFIER` replaces `GSOC_TOPIC`.
- `HEALTH_PORT` replaces `PORT`.

A known limit, accepted by the owner: if a chat's checkpoint is lost and, during its next start, both nodes
answer 500 for slot 0 because of a fault in front of Bee while the writing node still reports ready with peers,
the chat starts again at slot 0 and overwrites its old entries.

A known limit: with `CHAT_TOPIC_PATTERN`, anybody can open chats under invented topics until `MAX_ACTIVE_CHATS`
is reached. A quiet one is evicted to make room for the next chat, but a flood fast enough to fill the cap within
`CHAT_IDLE_EVICT_MS` holds new chats out until the invented ones go quiet, and `/health` says so. Chats listed in
`CHAT_TOPICS` are never held out, so listing the event's chats closes it.

The per-sender rate is weak, because a key costs nothing. The per-chat rate and the writing gateway's own
per-IP limit are the real brakes.

A known limit, recorded for a later fix: `GET /health` listens on every interface, since no setting names the
address it binds. A container on the host's network is therefore reachable at `HEALTH_PORT` from outside unless
the firewall closes it, so keep that port closed on the public interface. The body carries counts and state,
never a secret. A `HEALTH_HOST` setting would bind it to loopback.

## Mining the inbox key

The inbox key must place the inbox address in the listening node's neighbourhood. After `pnpm build`:

```bash
pnpm mine --overlay <the listening node's overlay address> --identifier <GSOC_IDENTIFIER> --proximity 12
```

It prints the `GSOC_KEY` and `GSOC_IDENTIFIER` to set.

## Running

Node 24 and pnpm 12, which corepack takes from `packageManager`:

```bash
pnpm install
pnpm build
pnpm start
```

With Docker:

```bash
docker build -t swarm-chat-aggregator .
docker run -d --name swarm-chat-aggregator --env-file .env -v aggregator-checkpoints:/app/checkpoints \
  --stop-timeout 60 --restart unless-stopped swarm-chat-aggregator
```

Docker kills a container 10 seconds after `docker stop` unless told otherwise, which is shorter than a drain. Set
`--stop-timeout`, or `stop_grace_period` in Compose, above `SHUTDOWN_DEADLINE_MS` plus `REQUEST_TIMEOUT_MS`,
which is 50 seconds with the defaults, so 60 above. Keep one container per feed key, with its checkpoint volume,
and give it at least `LOCK_STALE_MS` to start after a kill.

## Development

`pnpm lint`, `pnpm format`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` and `pnpm build`. The tests run
the whole server against a fake Bee over HTTP and a websocket, in `test/helpers/fakeBee.ts`.

The message library is `@solarpunkltd/swarm-chat-js` 7.0.0 from npm, exempt from the one-week release age in
`pnpm-workspace.yaml` because it is our own package.

## Live test bed

`pnpm test:docker` runs the chat against real Bee nodes on a local test chain, so no real BZZ is spent. It needs a Docker daemon it can reach as a sibling container.

- **The cluster** is fdp-play's local chain and three full Bee nodes, made from fdp-play's own node images, whose keys that chain funded. The server listens on one node and writes through another.
- **The scenarios** are B1 to B4: many senders at once, a server restart, a listening connection that dies without a close, and a malformed and a forged message. Each passes only when the chat feed holds every valid message exactly once, overwrites no slot and holds nothing else. Timings are printed and never asserted.
- **Bee 2.8.2 is built from source here, not taken from the released image.** The bed builds Bee v2.8.2 at commit `7e703f49` with `REACHABILITY_OVERRIDE_PUBLIC=true`, the setting fdp-play uses for its own local clusters. A released Bee never counts itself reachable on a private network, so it never stores a chunk pushed to it and every push loops between the nodes until it gives up. The source is pinned by commit and the Go image by digest.
- **Bee 2.6.0 runs as the released image**, the control that shows that failure.
- **What a run keeps:** every node's whole log, and each node's status, peer statuses and topology, go into `test-results/`, which git ignores.

## Further reading

- [Feeds](https://docs.ethswarm.org/docs/develop/tools-and-features/feeds#what-are-feeds)
- [GSOC](https://docs.ethswarm.org/docs/develop/tools-and-features/gsoc/#introduction)
- [swarm-chat-js](https://github.com/Solar-Punk-Ltd/swarm-chat-js)
