# DoubleTick WhatsApp API — working reference

What we actually know about DoubleTick's API, as opposed to what its documentation
claims. Written for JM Looks (WABA `918178788820`), but nothing here is store-specific
except the examples.

Two sources feed this: a prior session that reverse-engineered the inbox endpoints by
probing, and BadgeHQ's own Automated Replies integration. **Every endpoint below was
re-verified against the live account on 2026-07-20.** Where something is unverified or
was only read in documentation, it says so.

The reason this file exists: DoubleTick's public docs are incomplete in places and
**wrong** in at least three that cost real debugging time. Those are called out under
[Gotchas](#gotchas), which is the part worth reading first.

---

## Basics

Base URL is `https://public.doubletick.io`. Internally it routes under `/v2/p/...` —
you can see this leak in any 404:

```json
{"message":"Cannot GET /v2/p/definitely-not-real","error":"Not Found","statusCode":404}
```

Auth is the API key **raw in the `Authorization` header, with no scheme prefix**:

```
Authorization: key_FYfUEF...
```

Not `Bearer`, not `Basic`. (Interakt, the other provider BadgeHQ supports, uses
`Basic <base64>` — easy to conflate if you work on both.)

### Reading status codes while probing

Undocumented endpoints are found by guessing paths and reading the response. The
distinction that matters:

| Code | Means |
|---|---|
| `404` | Endpoint doesn't exist — wrong guess, move on |
| `400` | **Endpoint exists**, payload is wrong — right path, fix the body |
| `422` | Endpoint exists, a specific value is invalid (e.g. bad phone) |
| `200` | Works |

A `400` is good news. That is exactly how the free-text send endpoint was found: empty
`content` returned `400 "content should not be empty"` while every neighbouring path
returned `404`.

Probe with empty or fake values so discovery can't reach a real customer. Note that a
syntactically valid phone number will pass validation and **actually send** — use an
obviously invalid one until you're sure of the shape.

---

## Endpoints

### Send free-form text — `POST /whatsapp/message/text`

Only works inside the 24-hour service window (see [below](#the-24-hour-window)).

```json
{
  "to": "+919354991605",
  "from": "+918178788820",
  "content": { "text": "your message" }
}
```

Returns `{"recipient":"919354991605","status":"SENT","messageId":"ce468385-..."}`.

**A single object, not an array.** The template endpoint wraps its payload in
`messages: [...]`; this one does not. Passing the array shape here returns the
misleading `"content should not be empty"`, because the validator never finds `content`
at the level it expects.

`messageId` is optional (UUID v4, exactly 36 chars) and generated if omitted.

### Send an approved template — `POST /whatsapp/message/template`

Works outside the 24-hour window. Requires a Meta-approved template.

```json
{
  "messages": [{
    "to": "+919354991605",
    "from": "+918178788820",
    "content": {
      "templateName": "back_in_stock",
      "language": "en",
      "templateData": {
        "header": { "type": "IMAGE", "mediaUrl": "https://..." },
        "body": { "placeholders": ["Product name"] },
        "buttons": [{ "type": "URL", "parameter": "products/handle" }]
      }
    }
  }]
}
```

**This one does use `messages: [...]`.** Meta rejects a send whose body placeholders are
empty strings, so callers must supply non-empty values. A URL button parameter is the
**suffix** appended to the template's fixed prefix, not a whole URL.

A `2xx` can still carry a per-message failure — check `messages[0].status` for something
other than `SENT`/`QUEUED`/`ACCEPTED`.

### List the inbox — `GET /chats?limit=50`

Page size up to 50. Response is `{chats: [...], paginationOptions: {...}}`.

Per-chat fields:

```
chatType, name, phoneNumber, imageUrl, customFields, optIn, unreadCount,
isDone, chatUpdatedTime, lastMessageTime, assignedUserName, lastMessage,
eligibleMessageTypes, latestIntegration, isSlaActive, slaBreachLevel,
openChats, isReminderTriggered, providerType, dateCreated, wabaNumber,
wabaPhoneName, wabaDisplayName, assignedUserNumber, tagNames
```

The three that matter:

- **`isDone: false`** — this *is* the "Awaiting reply" filter in the web inbox
- **`unreadCount`** — how many messages they sent that nobody has read
- **`eligibleMessageTypes`** — `["ANY"]` = inside the 24h window, free-form allowed;
  `["TEMPLATE"]` = outside it, template only

Paginate with `paginationOptions.nextChatId` + `nextChatTimestamp` fed back as query
params, until `hasMoreChats` is false.

**Server-side filters are silently ignored.** `?isDone=false` returns the same unfiltered
page as no param at all, and `?phoneNumber=X` returns somebody else entirely. Filter
client-side. `?limit=` is the only query param observed to work.

### Read a full conversation — `GET /chat-messages`

```
GET /chat-messages?wabaNumber=918178788820&customerNumber=919354991605
    &startDate=19-07-2026&endDate=21-07-2026
```

Dates are `DD-MM-YYYY`. Returns `{messages: [...]}`, each with `messageOriginType`
(`CUSTOMER` or `USER`) and `messageTime`. **Sort by `messageTime` — order is not
guaranteed.**

Text lives at `message.text`; template bodies at
`message.templateMessage.body.data[0].text`.

This endpoint matters more than it looks. `/chats` only exposes the *last* message, and
a last message of "Hi" routinely hides the real question three messages earlier. One
example from the transcript: a customer whose last message was "Hi" had actually asked
"I want to create an account" — invisible without the full thread.

### Check the 24-hour window — `GET /chat/status`

```
GET /chat/status?customerPhoneNumber=919354991605&wabaNumber=918178788820
→ {"customerPhoneNumber":"919354991605","wabaNumber":"918178788820","isOpen":true}
```

`isOpen: true` means free-form text is allowed. Usually redundant, since `/chats` already
returns `eligibleMessageTypes`, but useful when you have a phone number and no chat
object.

### List channels — `GET /organization/channel/profile`

Returns connected WABA numbers with `channelId`, `wabaNumber`, `displayName`, `status`
(`CONNECTED`), and profile details. **The quickest way to check whether a key is valid**
and which sender numbers it can use.

### Webhooks — `GET /v2/webhooks`, `POST /v2/webhook/register`

Registration:

```json
{
  "name": "BadgeHQ Automated Replies",
  "url": "https://your-app/webhooks/doubletick/<token>",
  "method": "POST",
  "bodyFormat": "JSON",
  "retryOnTimeout": false,
  "authorization": { "type": "BEARER", "payload": "..." },
  "webhookEvents": ["MESSAGE_RECEIVED"],
  "wabaNumbers": ["918178788820"]
}
```

Event types include `MESSAGE_RECEIVED`, `MESSAGE_STATUS_UPDATE`, `TEMPLATE_UPDATE`,
`ADD_TAG`, `REMOVE_TAG`, `CHAT_ASSIGNED_TO_AGENT`, `NEW_LEAD`, and others (~16 total,
read from docs, not individually verified).

Inbound `MESSAGE_RECEIVED` payload:

```json
{
  "to": "918178788820",
  "from": "919354991605",
  "messageId": "HBgMOTE3NjAwNzI4MjU0FQIAEhgU...",
  "dtMessageId": "3bf23c11-6c34-4c1e-b259-12a0e518d3cd",
  "receivedAt": "2026-07-20T10:27:00.000Z",
  "contact": { "name": "Contact Name" },
  "integrationType": "WHATSAPP",
  "status": "received",
  "message": { "type": "TEXT", "text": "Ok", "context": {} }
}
```

`from` is the customer, `to` is your business number. **Direction is marked by
`status: "received"`**, not by an event-type field — outbound echoes arrive as
`sent`/`delivered`/`read` on the same webhook. Filtering on that is what stops a bot
replying to itself in a loop.

Prefer `dtMessageId` (DoubleTick's UUID) over `messageId` (Meta's) as an idempotency
key — it's present on every event and it's what their dashboard displays.

### Not found: mark-as-done

Probed repeatedly across two sessions (`/chats/done`, `/chat/done`, `/v2/chat/done`,
`/chats/mark-done`, `/chat/resolve` — all `404`). Closing a chat still requires the web
inbox. Also no working DELETE for webhooks: five plausible paths all 404'd, so removing
one means using their dashboard.

---

## The 24-hour window

This is a **WhatsApp platform rule, not a DoubleTick quirk**, and it governs everything.

When a customer messages you, a 24-hour window opens. Inside it you may send anything —
free-form text, any wording — and those messages are free. Once 24 hours pass with no
message from them, the window shuts and only **Meta-approved templates** get through.

| | Inside 24h | Outside 24h |
|---|---|---|
| `eligibleMessageTypes` | `["ANY"]` | `["TEMPLATE"]` |
| Endpoint | `/whatsapp/message/text` | `/whatsapp/message/template` |
| Cost | Free | Paid |
| Approval | None | Meta pre-approval required |

Practical consequences:

- **Replying to inbound chat is always free** — the customer just messaged, so the window
  is open by definition. This is why BadgeHQ's AI replies cost nothing to deliver.
- **Proactive sends need templates.** Back-in-stock alerts, refund notices, anything the
  customer didn't just ask for.
- **Never fall back from text to template on failure.** An `outside-window` rejection is
  the system working correctly; auto-retrying as a template spends money the merchant
  didn't authorise.

---

## Gotchas

Things the documentation gets wrong or omits. Each cost real debugging time.

### 1. Registration appends, it does not replace

`POST /v2/webhook/register` creates a **new** webhook every call. It does not update by
URL. Three saves left three identical `MESSAGE_RECEIVED` webhooks on the same URL, each
delivering every message.

Downstream idempotency kept this from double-replying, but it burns a request per
duplicate and grows without bound. **Register once and store a marker**; re-register only
when the sender number changes. Duplicates must be deleted from the dashboard, since no
DELETE path was found.

### 2. The `authorization` block is silently discarded

Registration accepts `authorization: {type: "BEARER", payload: "..."}` and the docs
present it as the way to authenticate your endpoint. **It is not stored and never sent.**
The webhook record returned by `GET /v2/webhooks` contains no such field, and deliveries
arrive with **no `Authorization` header at all**.

This broke BadgeHQ's inbound path completely: the route required a bearer token, so every
genuine message got `401`. Verified twice — once by reading back the stored record, once
by observing real messages fail.

**DoubleTick provides no way to authenticate its webhooks.** No HMAC, no signature, no
usable shared secret. The only defence is an unguessable URL, which means possession of
the URL is possession of the credential. Treat it as one: 24+ random bytes in the path,
never displayed, TLS only, strict payload validation, and rate limiting behind it.

If webhook authenticity genuinely matters, Interakt is the stronger provider — it
HMAC-SHA256s the raw body with a per-merchant secret.

### 3. Two different payload shapes for sending

`/whatsapp/message/text` takes a **single object**. `/whatsapp/message/template` takes
`{messages: [...]}`. Using the array shape on the text endpoint produces
`"content should not be empty"`, which points at the wrong problem entirely and cost the
prior session several rounds of guessing at `content.body`, `content.message`,
`content.text.body` and others — none of which was the actual issue.

### 4. Undocumented timeout and retry behaviour

Nothing published about how long your endpoint may take, whether non-2xx is retried, or
whether repeated failures disable a webhook. Interakt documents 3 seconds and disables
after 5 failures in 10 minutes; DoubleTick says nothing.

Assume the strict case: **respond fast and queue the real work.** BadgeHQ's webhook
records the message and returns immediately; a cron does the LLM call and the send.
`retryOnTimeout` is left `false` — with a fast-return design, a timeout means something
is broken badly enough that a retry would duplicate rather than fix.

### 5. Server-side filters are ignored

`?isDone=false` and `?phoneNumber=` on `/chats` are accepted and disregarded — the latter
returns a different customer's chat. Filter client-side and don't trust a query param
until you've verified it changes the response.

---

## How BadgeHQ uses this

Automated Replies (`aiProvider` × `waProvider` are independent settings):

```
Customer sends WhatsApp
  → DoubleTick POSTs /webhooks/doubletick/<token>
  → verify URL token, confirm status:"received" (loop guard)
  → check opt-out keywords, rate limit (20/shopper/hour)
  → queue WhatsAppReplyJob, return 200 immediately
  → cron (60s) → LLM answers from merchant knowledge
  → POST /whatsapp/message/text  (free: inside 24h window)
```

Relevant files:

- [`app/utils/whatsapp.server.ts`](app/utils/whatsapp.server.ts) — send clients, both providers
- [`app/utils/whatsapp-ai.server.ts`](app/utils/whatsapp-ai.server.ts) — payload parsing, webhook registration
- [`app/routes/webhooks.doubletick.$token.tsx`](app/routes/webhooks.doubletick.$token.tsx) — inbound route
- [`app/routes/api.cron.whatsapp-replies.tsx`](app/routes/api.cron.whatsapp-replies.tsx) — the drain

Back in Stock uses `/whatsapp/message/template` instead, since a restock alert is
proactive and almost always lands outside the window.

---

## Support-workflow notes

From the earlier session that used these endpoints to work the inbox. Included because
they're operational lessons, not API facts.

**Read the full thread before replying.** `/chats` gives you the last message only, and
"Hi" or "Ok" frequently hides the real question. Always `/chat-messages` first.

**Check eligibility before composing.** Drafting a warm free-form reply is wasted effort
if the chat is `TEMPLATE`-only.

**Verify one send before any batch.** Confirm a real `messageId` comes back, then
throttle (~600ms) and log every response to a `.jsonl`. Messages cannot be unsent.

**"Customer wrote last" is the real queue.** Of 114 `isDone: false` chats, only 21 had the
customer writing last. The other 93 were waiting on the customer, not on you.
