# IVR Routing Solutioning — Technical Notes

> **Companion to:** [IVR Call Routing — Proposed Solution](https://ashish-raj-wiom.github.io/IVR-Routing-Solutioning/)
>
> The HTML spec is the leadership-facing version. This MD is **the tech-implementation document** — schemas, lifecycle rules, endpoint contracts, telemetry events, edge cases, and decisions. Read this top-to-bottom before scoping the build.

---

## Table of contents

1. [Architecture summary](#architecture-summary)
2. [The four resolution paths](#the-four-resolution-paths)
3. [Tables — full schemas + lifecycle](#tables--full-schemas--lifecycle)
4. [user_identification API](#user_identification-api)
5. [Backend endpoint contracts](#backend-endpoint-contracts)
6. [Exotel applet wiring](#exotel-applet-wiring)
7. [PIN lifecycle](#pin-lifecycle)
8. [Logging / telemetry catalog](#logging--telemetry-catalog)
9. [CleverTap event schema](#clevertap-event-schema)
10. [Comms-layer dependencies](#comms-layer-dependencies)
11. [Use cases (13) with implementation notes](#use-cases-13-with-implementation-notes)
12. [Design decisions log](#design-decisions-log)
13. [Trade-off log](#trade-off-log)
14. [Deferred / future work](#deferred--future-work)
15. [Open TBDs](#open-tbds)
16. [Pre-launch verification checklist](#pre-launch-verification-checklist)
17. [Glossary](#glossary)

---

## Architecture summary

The system is, at its core, an **authentication + routing system** for masked phone calls between a CSP (Connection Service Provider / field technician) and a customer assigned to one of their active tickets.

### Four key terms (used throughout)

- **Recognised** — caller's number is in Table 1 OR in Table 2 via a valid PIN.
- **Authorised** — connection is legitimate (PIN or FROM belongs to an active ticket for the party being reached).
- **Seamless** — no app / no IVR / instant bridge (the Table 1 hit + single-counterparty paths).
- **Graceful fallback** — caller knows why the call didn't connect and has a clear next step (helpline number on voice + SMS).

### Identity store at a glance

| Element | Purpose | New / existing |
|---|---|---|
| **Table 1** | Active call mapping (FROM → TO), short TTL, written on `initiateCall`. | Existing today, kept unchanged. |
| **Table 2** | Per-ticket PIN registry. Two rows per ticket (one per side). Stores `PIN → other_party_mobile`. Has two access patterns — by `pin`, by `(ticket_id, side)`. | **New.** |
| **`user_identification` API** | Called on Table 1 miss. Returns user type + active-ticket count + (if count = 1) the counterparty mobile. Drives the entire post-Table-1 routing. | **New.** |
| **`sim_inventory`** | Existing CSP-SIM capture set. Used inside `user_identification` to match a CSP user's FROM, and for PIN-scoping. | Existing. |
| **Disposition webhook** | Exotel POSTs after every call with outcome (answered / no_answer / busy / failed). Drives missed-call alerts. | New listener; Exotel side already supported. |

---

## The four resolution paths

Every successful call flows through exactly one path:

### Path 1 — Direct bridge (Table 1 hit)
**Trigger:** Caller used in-app CTA recently; Table 1 still has a live mapping for their FROM.
**Outcome:** Seamless bridge to the counterparty in `TO`.
**Covers:** UC 01, UC 02.

### Path 2 — Direct bridge (single counterparty identified)
**Trigger:** Table 1 miss → `user_identification(FROM)` recognises the caller AND finds exactly 1 active ticket → fetches counterparty from Table 2 by `(ticket_id, side)`.
**Outcome:** Seamless bridge, no PIN.
**Covers:** UC 03, UC 05, UC 07, UC 09.

### Path 3 — PIN for multi-ticket disambiguation
**Trigger:** Table 1 miss → caller recognised but has 2+ active tickets → IVR asks for PIN → Table 2 lookup by PIN.
**Outcome:** Bridge to the counterparty identified by the PIN.
**Covers:** UC 04, UC 06, UC 08, UC 10.

### Path 4 — PIN for unknown caller
**Trigger:** Table 1 miss → `user_identification(FROM)` doesn't recognise the FROM → IVR asks for PIN (caller may hold a forwarded PIN, e.g., UC 13 colleague case) → Table 2 lookup by PIN.
**Outcome:** Bridge if PIN valid; dead-end after 3 wrong tries.
**Covers:** UC 11, UC 12, UC 13.

### Dead-end (terminal state, not a path)
**Trigger:** Either (a) recognised user with 0 active tickets — skip PIN entirely; or (b) PIN exhausted (3 wrong tries on Path 3 or Path 4).
**Outcome:** Graceful-fallback IVR + dead-end SMS:
- `user_type == 'customer'` → call centre **88803 22222**.
- `user_type ∈ {csp, unknown}` → trust line **78368 11111**.

---

## Tables — full schemas + lifecycle

### Table 1 — Active call mapping (existing, kept)

#### Schema

| Field | Type | Notes |
|---|---|---|
| `mapping_id` | UUID | Primary key. |
| `from_list` | Array<E164> | All FROM numbers for this session. CSP-side: every SIM in `sim_inventory` for that CSP user + their registered mobile. Customer-side: registered mobile only. |
| `to` | E164 | Other party's mobile. |
| `ticket_id` | UUID | The ticket this mapping belongs to. |
| `direction` | enum (`csp_to_customer`, `customer_to_csp`) | Which side initiated. |
| `created_at` | timestamp | When the mapping was written. |
| `ttl_expires_at` | timestamp | `min(call_connected_at + buffer, created_at + 5 min)` — today's logic preserved. |

#### Lifecycle

| Phase | Trigger | Action |
|---|---|---|
| **Write** | `initiateCall` API received from CSP App or Customer App | Insert row with `from_list`, `to`, `ticket_id`, `direction`, `created_at`. Compute `ttl_expires_at`. Return masked number to the app. |
| **Lookup** | Exotel webhook arrives on Connect #1 (`/resolve-caller`) | Query: `SELECT to FROM table_1 WHERE ? = ANY(from_list) AND ttl_expires_at > now()`. If multiple matches, pick most recent. |
| **GC** | Background job (or lazy at lookup) | Delete rows where `ttl_expires_at < now() - retention_buffer`. |

#### Index
- B-tree / GIN index on `from_list` (so the `= ANY()` lookup is fast).
- Index on `ttl_expires_at` for GC.

### Table 2 — PIN registry (new)

#### Schema

| Field | Type | Notes |
|---|---|---|
| `pin_id` | UUID | Primary key. |
| `pin` | string(5) | 5-digit numeric. Globally unique among active rows (generation enforces). |
| `ticket_id` | UUID | The ticket this PIN belongs to. |
| `side` | enum (`customer`, `csp`) | Which party this PIN was issued to. |
| `other_party_mobile` | E164 | The number to bridge to when this PIN is entered. |
| `csp_id` | UUID (nullable) | The CSP organisation id; populated on CSP-side rows only. Used for PIN scoping. |
| `csp_user_id` | UUID (nullable) | The specific CSP user (technician) the ticket is assigned to. |
| `customer_mobile` | E164 (nullable) | The customer's registered mobile; populated on customer-side rows for audit / lookup convenience. |
| `created_at` | timestamp | When the row was created. |
| `rotated_at` | timestamp | When the row's `pin` last rotated. |
| `expires_at` | timestamp (nullable) | Set on ticket closure (soft-delete). |

#### Two access patterns (same table, two indexes)

| Pattern | Used by | Lookup keys | Index |
|---|---|---|---|
| **By PIN** | PIN-prompt flow (Path 3, Path 4) | `pin` | Primary unique index on `pin` (over active rows). |
| **By `(ticket_id, side)`** | `user_identification` single-counterparty bridge (Path 2) | `ticket_id`, `side` | Secondary composite index on `(ticket_id, side)`. |

#### Lookup contracts

```text
lookup_by_pin(pin, caller_from):
  rows = SELECT * FROM table_2 WHERE pin = ? AND expires_at IS NULL
  if caller_from is in sim_inventory:                # PIN scoping
    rows = rows WHERE side = 'csp' AND csp_id = caller's csp_id
  if rows.count == 1: return rows[0].other_party_mobile
  else: return null
```

```text
lookup_by_ticket_and_side(ticket_id, side):
  row = SELECT * FROM table_2
        WHERE ticket_id = ? AND side = ? AND expires_at IS NULL
  return row.other_party_mobile (or null)
```

#### Lifecycle

The Call CTA in the CSP App and Technician App is gated by **technician assignment**. Table 2 entry must fire on the same signal that turns the CTA visible, so the PIN is in place the first time the user can tap Call. The exact ES event differs per ticket family — see the next subsection for the per-family wiring.

| Phase | Trigger | Action |
|---|---|---|
| **Generation (entry)** | Technician-assignment event from one of the three TAS ESs (Install / Restore / Pickup) — see per-family table below | Create 2 rows for this ticket — one with `side = 'customer'` and `other_party_mobile = technician_mobile`; one with `side = 'csp'` and `other_party_mobile = customer_mobile`. Generate unique 5-digit PINs (see PIN generation below). Fire customer-side SMS. Surface CSP-side PIN on the ticket card. |
| **Update (reassignment)** | Same technician-assignment event re-fired with a new `executor_id` (or ES candidate replaced via reassign signal — see per-family table) | Update both rows for this ticket: rewrite `other_party_mobile` on the customer-side row with the new technician's mobile; rewrite `csp_user_id` on the CSP-side row. Rotate PINs and re-distribute (SMS customer; PN to new technician on the ticket card). |
| **Lookup (by PIN)** | IVR PIN flow | See contract above. |
| **Lookup (by ticket+side)** | `user_identification` single-counterparty path | See contract above. |
| **Rotation** | Daily cron at a fixed time (TBD — recommend 03:00 IST low-traffic) | For every active ticket, generate a new PIN for each side. Update `pin` and `rotated_at`. Fire SMS to customer with the new PIN. |
| **Soft-delete (exit)** | Ticket transitions to a **terminal state** in its ES — see per-family table below | Set `expires_at = now()` on both rows for this ticket. Excluded from active lookups thereafter. |
| **Hard-delete** | Background retention job | Delete rows where `expires_at < now() - retention_window` (retention TBD, suggest 90 days for audit). |

#### Per-ticket-family wiring (entry / update / exit signals)

The Call CTA is visible after technician assignment for **all three** TAS execution services. Subscribe to these CEF events on the event bus — Table 2's lifecycle manager (call it `pin-registry-service` or `ivr-pin-listener`) is a fan-in consumer.

| Family | ES (source of truth) | **Entry** — write 2 rows | **Update** — rewrite mobile + rotate PIN | **Exit** — soft-delete |
|---|---|---|---|---|
| **Install** | `es-installation-service-prd-v2.3.yaml` | `ES_INSTALL_TECHNICIAN_ASSIGNED` (state → `TECHNICIAN_ASSIGNED`; sets `executor_id`, `is_self_assigned`). Bridged to legacy RMQ wire_key `INSTALLATION_SLOT_ASSIGN` via `BookingInstallationEventBridge.onTechnicianAssigned` after commit — payload carries technician name + phone fetched from `csp-gateway-service GET /api/internal/csp-users/{id}`. | Same `ES_INSTALL_TECHNICIAN_ASSIGNED` event re-fires with a new `executor_id` when the CSP picks a different technician (state already `TECHNICIAN_ASSIGNED` → idempotent re-emit per `trigger_mutation_matrix.technician_assigned`). Listener compares stored `csp_user_id` vs payload — if different, treat as update. | Any transition to terminal state: `INSTALLATION_REPORTED_FAILED`, `CONNECTION_ACTIVE`, `CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_UPSTREAM`, `INSTALLATION_CANCELLED_ONSITE`, `INSTALLATION_EXPIRED`. Subscribe to the corresponding `ES_INSTALL_*` events. |
| **Restore** | `es-restore-prd-v1.4.yaml` | `ES_RESTORE_TECHNICIAN_ASSIGNED` (state `ASSIGNED_TECHNICIAN`, fired by CSP action `ASSIGN_TECHNICIAN`, sets `assigned_technician_id`). | `TASK_AUTO_REASSIGNED` upstream signal causes the original candidate to be `CANCELLED` and a new candidate to be inserted for the new executor — when the new CSP runs `ASSIGN_TECHNICIAN`, a fresh `ES_RESTORE_TECHNICIAN_ASSIGNED` fires for the new ticket-side identifier (treat as update on the same `ticket_id`). | Terminal states: `COMPLETED`, `CANCELLED`. Driven by upstream `COMPLAINT_TASK_CLOSED` (SR OS `CLOSED`), `COMPLAINT_RESOLUTION_SIGNAL` (`UNRESOLVABLE`), `PLATFORM_TAKEOVER_INITIATED`, `COMPLAINT_RECLASSIFIED_TO_PLATFORM`. |
| **Pickup (NetBox Recovery)** | `es-netbox-recovery-service-prd-v1.9.yaml` | Default executor is the **owning CSP** (auto-assigned at candidate creation from ACS signal — state `PENDING_PICKUP`, reason `RECOVERY_TASK_ASSIGNED`). When the CSP **delegates** to a team member (v1.9 M7 TASK_ASSIGNMENT), `ES_NBREC_TASK_ASSIGNED` fires with the team-member identity. Listener should write Table 2 rows on **both** signals — same entry semantics. | `ES_NBREC_TASK_ASSIGNED` re-fires when the CSP reassigns to a different team member, or unassigns (back to CSP-self). Treat as update — rewrite `csp_user_id` and (on customer-side row) `other_party_mobile`. | Terminal states: `COMPLETED`, `CANCELLED`, `FAILED`. |

**Implementation notes for the listener:**

- All three ESs use **transactional outbox → bus** delivery, so the listener gets at-least-once semantics. Make Table 2 writes **idempotent** (key on `ticket_id` + `side` — upsert, not insert).
- When the executor is the **CSP themselves** (`is_self_assigned = true` in Install ES; `executor.isSelf = true` in CSP App), the Call CTA is **hidden** in app (see CSP App: `canCallExecutor = executorAssigned && exec?.isSelf != true && !isClosureState`). The listener should still write the rows — backend-side `user_identification` still needs them for the customer-side path. But the CSP-side row's `other_party_mobile` should resolve to the customer (it always does in this design).
- For Install, the listener should also receive `BookingInstallationEventBridge`'s legacy `INSTALLATION_SLOT_ASSIGN` wire if subscribing to the bus is not yet possible — the payload is equivalent.

#### CTA visibility — app-side gating (for context)

This is **app behaviour**, not Table 2 logic — included so engineers verify the lifecycle window aligns. The CTA must be visible iff the row exists and is active in Table 2.

| App | File | Gate expression |
|---|---|---|
| CSP App | `feature/home/ui/drilldowns/install/InstallDrilldownContent.kt:386` | `executorAssigned && exec?.isSelf != true && !isClosureState` |
| CSP App | `feature/home/ui/drilldowns/restore/RestoreDrilldownContent.kt:287` | `executorAssigned && exec?.isSelf != true && !isClosureRestore` |
| CSP App | `feature/home/ui/drilldowns/netbox_recovery/NbrecDrilldownContent.kt:222` | `executorAssigned && …` (same pattern) |
| Technician App | `core/model/TaskDetail.kt:61` | Backend-driven: `maskedCallAvailable: Boolean` on the drilldown DTO. Backend should derive this from Table-2 presence (active row exists for this ticket × side). |

**Backend deriving `maskedCallAvailable` from Table 2** is the cleanest contract — it removes per-app state-string checks and centralises the gate in one place. Recommended.

#### PIN generation algorithm

```text
generate_pin():
  for attempt in 1..N:
    candidate = random 5-digit string ("00000".."99999")
    if NOT EXISTS (SELECT 1 FROM table_2 WHERE pin = candidate AND expires_at IS NULL):
      return candidate
  raise PinExhaustionError  # 100k space; statistically impossible at our volume
```

**Note:** Some accounts may want the **last 5 digits of the ticket ID** as a memorable PIN. That's an alternative — but it sacrifices uniqueness guarantees (two tickets ending in same 5 digits → collision). For v1, recommend random with retry.

#### Index recommendations

```sql
CREATE UNIQUE INDEX idx_table2_pin_active
  ON table_2 (pin) WHERE expires_at IS NULL;

CREATE INDEX idx_table2_ticket_side
  ON table_2 (ticket_id, side) WHERE expires_at IS NULL;

CREATE INDEX idx_table2_expires_at
  ON table_2 (expires_at);  -- for GC
```

### Removed: Table 3 (Cx ↔ Technician resolver)

Earlier iterations had a Table 3 — `customer_mobile → technician_mobile` — for customer-side routing without PIN. **Dropped** when the customer-side PIN was added and `user_identification` was extended to return the counterparty mobile by looking up Table 2 directly. One fewer table to maintain.

---

## user_identification API

### Purpose

Called on Table 1 miss. Resolves who the caller is and what they want, in one round-trip.

### Endpoint

`POST /internal/user-identification`
- Internal-only (between IVR backend and customer-service / TAS).
- Latency budget: **p95 < 200 ms** within Exotel's 5 s Primary URL window.

### Request

```json
{
  "from": "+91XXXXXXXXXX",
  "call_id": "exotel-call-sid"  // for telemetry correlation
}
```

### Response

```json
{
  "user_type": "customer" | "csp" | "unknown",
  "active_ticket_count": 0 | 1 | 2 | ...,
  "other_party_mobile": "+91XXXXXXXXXX",  // present iff active_ticket_count == 1
  "ticket_id": "uuid",                    // present iff active_ticket_count == 1
  "csp_id": "uuid"                        // present iff user_type == "csp"
}
```

### Internal logic

```text
user_identification(from):
  # Step 1: identify the user
  if from matches a customer record:
    user_type = "customer"
    user_ref = customer_mobile = from
  elif from is in sim_inventory OR matches a CSP user's registered mobile:
    user_type = "csp"
    user_ref = csp_user_id
  else:
    user_type = "unknown"
    return { user_type: "unknown", active_ticket_count: 0 }

  # Step 2: count active tickets for this user
  if user_type == "customer":
    tickets = active tickets where ticket.customer_mobile == from
  else:  # csp
    tickets = active tickets where ticket.assigned_csp_user_id == user_ref

  count = len(tickets)

  if count == 1:
    # Step 3: fetch counterparty mobile from Table 2 by (ticket_id, side)
    ticket = tickets[0]
    side = "customer" if user_type == "customer" else "csp"
    counterparty = table_2.lookup_by_ticket_and_side(ticket.id, side)
    return {
      user_type, active_ticket_count: 1,
      other_party_mobile: counterparty,
      ticket_id: ticket.id,
      csp_id: ticket.csp_id  // if applicable
    }

  return { user_type, active_ticket_count: count }
```

### Routing decisions driven by the response

| `user_type` | `active_ticket_count` | Action |
|---|---|---|
| `customer` or `csp` | `1` | Bridge directly to `other_party_mobile` (Path 2). |
| `customer` or `csp` | `>= 2` | IVR prompts for PIN → Table 2 lookup by PIN (Path 3). |
| `unknown` | `0` | IVR prompts for PIN (caller may hold a forwarded PIN, UC 13) → Table 2 lookup by PIN (Path 4). |
| `customer` or `csp` | `0` | Skip PIN → dead-end IVR (no PIN exists in Table 2 for this user). |

---

## Backend endpoint contracts

All endpoints exposed by the IVR routing service. Auth: internal mTLS or API key in header.

### `/ivr/resolve-caller` (called by Exotel Connect #1)

`GET /ivr/resolve-caller?From=<E164>&CallSid=<exotel_sid>&To=<masked_number>`

**Logic:**
1. Log `dial_received_backend`.
2. Table 1 lookup by `From`. If hit → return destination JSON.
3. Else call `user_identification(From, CallSid)`.
4. Branch on response (per routing table above):
   - `count == 1` → return destination JSON (bridge to `other_party_mobile`).
   - `count >= 2` or `user_type == unknown` → return empty destination → falls through to Gather.
   - `user_type ∈ {customer, csp}` AND `count == 0` → return a Playback redirect if Exotel account supports it, else return empty destination AND cache "skip-pin = true" against `CallSid` so subsequent applets know to skip Gather. (Implementation note: simplest v1 is to let it fall through to Gather, PIN will fail, dead-end fires.)

**Cache** the `user_type` against `CallSid` (Redis, 10-min TTL) — needed later by `/audio/deadend` and `/log/disposition`.

**Response (bridging):**
```json
{
  "destination": { "numbers": ["+919812345678"] },
  "outgoing_phone_number": "<masked_number>",
  "record": true,
  "max_ringing_duration": 30
}
```

**Response (no bridge):** HTTP 200 with `{ "destination": { "numbers": [] } }` OR empty `destination` — triggers Exotel's no-answer branch.

**Timeout / error:** Exotel falls back to the Fallback URL configured on the applet.

### `/ivr/resolve-pin` (called by Exotel Connect #2)

`GET /ivr/resolve-pin?From=<E164>&CallSid=<exotel_sid>&digits=<5_digits>`

**Logic:**
1. Log `pin_attempted` (with attempt number).
2. Table 2 lookup by PIN, with scoping if applicable:
   - If `From` is in `sim_inventory` → scope to `side = 'csp' AND csp_id = matched_csp_id`.
   - Else → unrestricted (handles unknown FROM + multi-ticket customer cases).
3. If single match → return destination JSON. Log `pin_attempt_valid`.
4. If no match → return empty destination. Log `pin_attempt_invalid`. Exotel will re-prompt (up to 3 tries) OR fall through to dead-end after exhaustion.

**Response shape:** same as `/resolve-caller`.

### `/audio/deadend` (called by Exotel Playback if dynamic audio URL is supported)

`GET /audio/deadend?call_id=<exotel_sid>`

**Logic:**
1. Look up `user_type` from the Redis cache (stamped by `/resolve-caller`).
2. Stream / 302-redirect to the right audio file:
   - `user_type == 'customer'` → `customer-deadend.mp3` (call centre 88803 22222 voice).
   - else → `non-customer-deadend.mp3` (trust line 78368 11111 voice).
3. Log `deadend_call_centre_played` or `deadend_trust_line_played`.

**Response:** audio stream (MP3 or WAV) OR a 302 to a CDN URL.

**Fallback (if Playback applet does not support dynamic URL):** v1 plays the universal "open the app or call X / Y" message; backend logs which branch *would* have fired for analytics.

### `/log/disposition` (Exotel disposition webhook)

`POST /log/disposition`

**Body** (Exotel-supplied):
```json
{
  "CallSid": "...",
  "From": "+91XXXXXXXXXX",
  "To": "<masked_number>",
  "DialCallStatus": "completed | no-answer | busy | failed | canceled",
  "DialCallDuration": 42,
  "RecordingUrl": "...",
  "StartTime": "ISO-8601",
  "EndTime": "ISO-8601",
  "BridgedTo": "+91XXXXXXXXXX"  // if applicable
}
```

**Logic:**
1. Log `disposition_webhook_received`.
2. If `DialCallStatus == "completed"` → log `bridge_answered`. Done.
3. Else → log `bridge_not_answered` AND determine direction:
   - If the FROM was a CSP user → fire `missed_call_csp_to_customer` CleverTap event (recipient = customer who didn't answer).
   - If the FROM was a customer → fire `missed_call_customer_to_csp` CleverTap event (recipient = CSP).
4. CleverTap campaign triggers the SMS / WhatsApp / push to the missed party.

### Logging endpoints (Passthru targets) — minimal v1 set

| Endpoint | Method | What it logs |
|---|---|---|
| `/log/dial_received` | GET | Exotel registered the call on the masked number. |
| `/log/pin_prompted` | GET | Gather applet fired. |
| `/log/pin_entered` | GET | Digits collected (length + attempt #, not the digits themselves). |
| `/log/pin_lockout` | GET | 3 wrong PIN attempts. |
| `/log/deadend_played` | GET | Playback completed. |

All these are fire-and-forget; backend returns 200 quickly and writes to the event stream asynchronously.

---

## Exotel applet wiring

Built on Exotel's [Connect Applet with Dynamic URL](https://support.exotel.com/support/solutions/articles/3000096873-programmable-connect-working-with-connect-applet-dynamic-url-) pattern.

```
[Caller dials masked number]
        │
        ▼
┌──────────────────────────────────────────┐
│ Connect #1 — Dynamic URL                 │
│   GET /ivr/resolve-caller                │
│                                          │
│ Backend logic:                           │
│   • Table 1 lookup                       │
│   • If miss → user_identification(FROM)  │
│   • Decide:                              │
│       - count == 1 → return destination  │
│       - count >= 2 → empty (→ Gather)    │
│       - unknown → empty (→ Gather)       │
│       - count == 0 → empty (→ Gather,    │
│         which will fail → dead-end)      │
└──────────────────────────────────────────┘
        │ (if destination returned: bridge)
        │ (else: no-answer branch)
        ▼
┌──────────────────────────────────────────┐
│ Gather / IVR                             │
│   Prompt audio (Hindi)                   │
│   5 digits | 3 retries | 5s per attempt  │
└──────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────┐
│ Connect #2 — Dynamic URL                 │
│   GET /ivr/resolve-pin?digits={digits}   │
│                                          │
│ Backend logic:                           │
│   • Table 2 lookup by PIN                │
│   • Apply CSP scoping if applicable      │
│   • Return destination if match,         │
│     empty if no match                    │
└──────────────────────────────────────────┘
        │ (if destination: bridge)
        │ (else / 3 fails: no-answer branch)
        ▼
┌──────────────────────────────────────────┐
│ Playback — Dynamic audio URL             │
│   GET /audio/deadend?call_id={call_id}   │
│                                          │
│ Backend serves:                          │
│   • customer audio if user_type=customer │
│   • non-customer audio otherwise         │
└──────────────────────────────────────────┘
        │
        ▼
   End call

──── Account-level webhook (outside the flow) ────

Disposition webhook → POST /log/disposition
  Fires for every call regardless of path.
  Backend ingests outcome and fires CleverTap
  missed-call event if not answered.
```

**Primary URL timeout:** 5s. Backend target: < 200 ms p95.
**Fallback URL:** configured per applet — returns a graceful "service unavailable" voice prompt.
**Retry:** `fetch_after_attempt: true` so Exotel re-queries on failed dial attempts.

---

## PIN lifecycle

### Generation
- Two PINs minted on `ticket_open` (one per side).
- 5-digit numeric, generated by the random-with-retry algorithm above.
- Globally unique among active rows (enforced by unique index on `pin WHERE expires_at IS NULL`).

### Distribution

| Recipient | Channel | Trigger |
|---|---|---|
| **Customer (registered mobile)** | SMS + WhatsApp at ticket creation. Same message carries the masked number to dial. | `ticket_open` |
| **CSP user (assigned technician)** | Shown on the **ticket card** in the CSP App. **PIN must be visually prominent so screenshots include it.** | `ticket_open` (app polls / fetches via existing ticket API) |
| **Colleague (no app, UC 13)** | The CSP user forwards their SMS / WhatsApp message, OR shares a screenshot of the ticket card. | Manual (out of system scope) |

### Rotation
- **Schedule:** daily, fixed time (recommended 03:00 IST).
- **Action:** for every active ticket, generate a new PIN for each side. Update `pin` and `rotated_at`. Old PIN is replaced — no overlap window.
- **Customer side:** new SMS / WhatsApp fired with the rotated PIN.
- **CSP side:** ticket card auto-updates on next view.

### Expiry / GC
- `ticket_close` → set `expires_at = now()` on both rows for the ticket. Excluded from all active lookups thereafter.
- Background hard-delete job removes rows where `expires_at < now() - retention_window` (TBD, suggest 90 days).

### Scoping (CSP-side guardrail)

When `lookup_by_pin` is called and `caller_from` is in `sim_inventory`:
- The lookup is restricted to rows where `side = 'csp' AND csp_id = matched_csp_id`.
- A PIN that belongs to another CSP's customer is treated as invalid — prevents cross-CSP guessing.

Customer-side lookups are unscoped (3-retry cap + per-ticket PIN issuance is sufficient protection at the customer end).

---

## Logging / telemetry catalog

Every decision point, API call, and state transition emits a typed event. All events keyed by `call_id` (where applicable), `from`, `masked_number`, `ticket_id`, `timestamp`.

### Call entry & in-app CTA

| Event | When |
|---|---|
| `cta_tapped` | Call CTA tapped in CSP App or Customer App |
| `initiate_call_received` | Backend received the `initiateCall` request |
| `table_1_write` | Table 1 mapping persisted |
| `masked_number_returned` | Masked number returned to the app |

### Dial routing (per call)

| Event | When |
|---|---|
| `dial_received` | Exotel webhook arrived on Primary URL |
| `table_1_lookup` | Lookup performed (result: hit / miss, latency) |
| `mapping_hit` | Table 1 returned a destination → Path 1 |
| `user_identification_called` | API invoked with FROM |
| `user_identification_response` | API returned (user_type, active_ticket_count, latency) |
| `direct_bridge_single_ticket` | Path 2 fires (no PIN) |
| `pin_prompted` | Gather applet triggered |
| `pin_entered` | Digits received (attempt_number, length) |
| `pin_attempt_valid` / `pin_attempt_invalid` | PIN check result |
| `pin_lockout` | 3 wrong attempts exhausted |
| `pin_abandoned` | Caller hung up during prompt without entering anything |
| `table_2_lookup_by_pin` | Path 3 / Path 4 access pattern |
| `table_2_lookup_by_ticket` | Path 2 access pattern (via `user_identification`) |
| `pin_scoping_rejected` | PIN matched but CSP scope check failed |

### Bridge & disposition

| Event | When |
|---|---|
| `bridge_initiated` | Exotel begins bridging to the destination |
| `bridge_answered` | Disposition = answered |
| `bridge_not_answered` | Disposition = no_answer / busy / failed |
| `disposition_webhook_received` | Exotel disposition webhook arrived |

### Dead-end

| Event | When |
|---|---|
| `deadend_call_centre_played` | IVR played call-centre message (`user_type = customer`) |
| `deadend_trust_line_played` | IVR played trust-line message |
| `deadend_sms_sent` | Dead-end SMS fired to caller's FROM |

### Post-call notifications

| Event | When |
|---|---|
| `clevertap_missed_call_fired` | Backend pushed `missed_call_*` event |
| `missed_call_alert_delivered` | CleverTap campaign delivery confirmed |

### PIN lifecycle

| Event | When |
|---|---|
| `ticket_pin_issued` | Two PINs minted on ticket open |
| `pin_sms_sent` | PIN SMS dispatched to customer |
| `pin_sms_delivered` / `pin_sms_failed` | Delivery receipts (DLR) |
| `pin_rotated` | Daily rotation fired |
| `ticket_pin_expired` | Both PINs soft-deleted on ticket closure |

### System health

| Event | When |
|---|---|
| `user_identification_api_timeout` / `user_identification_api_error` | API problems |
| `exotel_primary_url_5xx` | Backend returned non-200 to Exotel |
| `exotel_disposition_webhook_failed` | Disposition POST didn't reach backend |
| `table_2_pin_collision_detected` | PIN generator hit a collision and retried |

---

## CleverTap event schema

Missed-call alerts piggyback on Wiom's existing CleverTap campaign infrastructure — no new SMS-delivery system to build.

### `missed_call_csp_to_customer`

Fired when a CSP-initiated bridge ends with the customer not picking up.

```json
{
  "event": "missed_call_csp_to_customer",
  "customer_mobile": "+91XXXXXXXXXX",
  "csp_user_mobile": "+91XXXXXXXXXX",
  "csp_user_name": "...",
  "ticket_id": "uuid",
  "ticket_type": "Install | Restore | Pickup",
  "masked_number": "+91XXXXXXXXXX",
  "disposition": "no_answer | busy | failed",
  "call_initiated_at": "ISO-8601",
  "call_attempt_id": "exotel_call_sid"
}
```

Triggers a CleverTap campaign that sends SMS / WhatsApp to `customer_mobile` with a callback instruction.

### `missed_call_customer_to_csp`

Symmetric — fired when a customer-initiated bridge ends unanswered. Triggers SMS / WhatsApp / push to the CSP.

---

## Comms-layer dependencies

All outbound SMS / WhatsApp must land via:

- **DLT-registered templates** with the "Wiom" sender ID (so recipients see "Wiom" instead of a generic 11444XXXX phone number).
- **WhatsApp BSP setup** with approved templates for any WA delivery.
- **Hindi as the default** language. Regional-language expansion based on CSP geography. Exact wording for every IVR prompt and notification is decided by the solutions team.

### Trust layer (recipient-side pickup)

Two whitelisting layers are in place so the masked number doesn't get treated as spam — directly addressing the DNP (Did-Not-Pick) issue:

- **Truecaller whitelisting** — the masked number shows with a green verified banner and the Wiom name in Truecaller (most Bharat users have it installed).
- **VLT whitelisting** — telco-level verified-logo trust mark; the number is flagged at the network layer as a legitimate business caller.

Both layers are independent and complementary — Truecaller covers app-side identification, VLT covers network-side identification.

### Messages that must ship before launch

- Ticket-open SMS / WhatsApp to customer (masked number + customer-side PIN + dial instruction).
- Daily PIN-rotation SMS / WhatsApp to customer.
- Missed-call alert SMS / WhatsApp (CSP-side and customer-side variants).
- Dead-end SMS to caller's FROM (call centre or trust line variant).
- IVR voice prompts (PIN entry, dead-end call-centre, dead-end trust-line).

---

## Use cases (13) with implementation notes

Grouped by whether the caller is identified by their FROM, then by how they're calling.

### Caller identified (FROM is a registered mobile or in `sim_inventory`)

#### Calling from the app

**UC 01 — CSP dials from the CSP App via registered SIM** — Path 1
- *Test:* CSP taps Call CTA, dials masked number within TTL.
- *Expected:* Table 1 hit. Bridges directly. No PIN.

**UC 02 — Customer dials from the Customer App via registered SIM** — Path 1
- *Test:* Customer taps Call CTA, dials masked number within TTL.
- *Expected:* Table 1 hit. Bridges directly. No PIN.

#### Calling from the dialer (CSP user)

**UC 03 — CSP dials a previously-used masked number, single ticket** — Path 2
- *Test:* CSP user with 1 active ticket dials masked number from call log / saved contact.
- *Expected:* Table 1 miss → `user_identification` returns count=1 → bridge.

**UC 04 — CSP dials a previously-used masked number, multi-ticket** — Path 3
- *Test:* CSP user with 2+ active tickets dials masked number.
- *Expected:* Table 1 miss → `user_identification` returns count≥2 → PIN prompt → bridge on valid.

**UC 05 — CSP callback on customer-initiated MN, single ticket** — Path 2
- *Test:* Customer initiates call, CSP misses, CSP taps missed-call entry to dial back.
- *Expected:* Table 1 has customer's FROM, not CSP's → miss → `user_identification` returns count=1 → bridge.

**UC 06 — CSP callback on customer-initiated MN, multi-ticket** — Path 3
- *Test:* Same as UC 05, but CSP has 2+ active tickets.
- *Expected:* PIN prompt → bridge on valid PIN.

#### Calling from the dialer (Customer)

**UC 07 — Customer dials a previously-used masked number, single ticket (~99%)** — Path 2
- *Test:* Customer with 1 active ticket dials masked number from call log.
- *Expected:* `user_identification` returns count=1 → bridge to technician.

**UC 08 — Customer dials a previously-used masked number, multi-ticket (~1%)** — Path 3
- *Test:* Customer with 2 active tickets (e.g., Restore + Pickup) dials masked number.
- *Expected:* PIN prompt → PIN identifies which ticket → bridge to right technician.

**UC 09 — Customer callback on CSP-initiated MN (after missed call), single ticket (~99%)** — Path 2
- *Test:* CSP calls customer, customer misses, customer taps missed-call entry to dial back.
- *Expected:* `user_identification` recognises customer + 1 ticket → bridge.

**UC 10 — Customer callback on CSP-initiated MN, multi-ticket (~1%)** — Path 3
- *Test:* Same as UC 09 but customer has 2 tickets.
- *Expected:* PIN prompt → bridge on valid.

### Caller not identified (FROM is an unregistered SIM)

**UC 11 — Customer dials from an unregistered SIM (relative's phone, secondary SIM)** — Path 4
- *Test:* Customer dials masked number from a SIM that's not their registered mobile.
- *Expected:* `user_identification` returns `user_type = unknown` → PIN prompt → if customer remembers PIN from their SMS, bridges; else dead-end after 3 wrong tries (trust-line message, since user_type was unknown).

**UC 12 — CSP user dials from an unregistered SIM** — Path 4
- *Test:* CSP user dials masked number from a SIM not in `sim_inventory`.
- *Expected:* `user_identification` returns `user_type = unknown` → PIN prompt → CSP enters PIN from app ticket card → bridge.

**UC 13 — CSP forwards the masked number to a colleague (colleague's phone is unregistered)** — Path 4
- *Test:* CSP forwards the ticket SMS / screenshot to a colleague; colleague dials masked number.
- *Expected:* `user_identification` returns `user_type = unknown` → PIN prompt → colleague enters PIN from the forwarded message → bridge.
- *Implementation note:* PIN must be visible on the ticket-card screenshot. UI requirement.

### Edge cases (terminal states, not standalone UCs)

- **Recognised user, 0 active tickets** (e.g., customer with closed ticket dialling back) → skip PIN entirely → dead-end IVR.
- **3 wrong PIN attempts on any path** → dead-end IVR (using `user_type` from the earlier `user_identification` call).

---

## Design decisions log

| Decision | Rationale |
|---|---|
| **Single masked number** (not MN1/MN2) | Removes wrong-direction-dial failure. Today CSPs see MN1 in call log and try to dial back — drops because MN1 is one-way. |
| **`user_identification` at Table-1 miss (replaces is_customer-at-dead-end)** | Earlier design called `is_customer` only at dead-end. New design calls richer `user_identification` earlier — recognises caller AND counts active tickets. **One active ticket → bridge directly, no PIN.** Big friction reduction for customer callbacks and CSP technicians with a single live job. PIN drops to an exception path. |
| **Unknown FROM routes to PIN gather (not direct to dead-end)** | Critical for UC 13 (colleague forwarding) — colleague isn't recognised but holds a forwarded PIN. Giving up immediately on unknown FROM would block this case. |
| **Two PINs per ticket** (customer-side + CSP-side) | Symmetric authorisation; either party can authenticate when off-CTA. PIN encodes ticket + direction. |
| **Customer-side PIN via SMS; CSP-side via app ticket card only** | Customers are not app-engaged; SMS reaches them. CSPs see ticket details in app — no SMS noise. |
| **5-digit PIN, random with uniqueness retry** | Matches OTP expectation. 100K combos × 3-retry cap = 0.003% brute-force probability per call. |
| **Daily PIN rotation** | Limits exposure on multi-day jobs; a leaked PIN expires within 24 hours. |
| **PIN scoping for CSPs (sim_inventory match → restricted lookup)** | Prevents a CSP from guessing or reaching a customer who isn't theirs. |
| **3-retry cap per call** | Matches universal expectation (ATM, banking). |
| **Dead-end ALSO sends SMS, not just voice** | Voice is ephemeral; SMS lets the caller act later. |
| **Truecaller whitelisting reuses one of MN1/MN2** | No fresh whitelisting work; verified status carries forward. |
| **VLT whitelisting added** | Telco-level trust mark complements Truecaller; together they directly address DNP. |
| **Table 2 dual access pattern (by PIN, by ticket_id+side)** | Same physical table serves PIN-prompt flow and single-counterparty bridge. No need for a third table. |
| **`user_identification` is the single API call on Table 1 miss** | One round-trip resolves identity + counterparty (if 1 ticket). Encapsulates the user/customer/ticket joins. |
| **Calling eligibility scoped to Install / Restore / Pickup tickets** | No calling on closed or pre-booking tickets. Aligns the routing surface with operational reality. |
| **Table 2 entry on technician-assignment event, not on ticket-open** | The Call CTA in the CSP App and Technician App becomes visible **only after technician assignment** (CSP App: `executorAssigned && !isSelf && !isClosure`; Technician App: backend-driven `maskedCallAvailable`). PINs should exist exactly when the CTA can be tapped — no earlier (wasted rows + SMS), no later (failed first tap). Three ES events drive entry: `ES_INSTALL_TECHNICIAN_ASSIGNED`, `ES_RESTORE_TECHNICIAN_ASSIGNED`, `ES_NBREC_TASK_ASSIGNED` (plus the auto-self-assignment at NBREC candidate creation). |
| **Table 2 exit on ES terminal-state transition, not on a generic ticket_close event** | Each of the three ESs has its own terminal states. Subscribing to the family-specific terminal events keeps Table 2 in lockstep with the ES state machines and avoids relying on a derived "ticket closed" facade. |
| **`pin-registry-service` as the listener owning Table 2 lifecycle** | Single fan-in consumer subscribed to all three ESs (Install / Restore / Pickup). Upsert on `(ticket_id, side)` makes the listener idempotent under at-least-once outbox delivery. Centralises the gate that backend uses to derive `maskedCallAvailable`. |
| **Missed-call notifications via CleverTap campaigns** | Reuses Wiom's existing campaign infrastructure. |
| **Hindi as default IVR language** | Voice-first Bharat user. English IVR is a hard blocker. |

---

## Trade-off log

| Trade-off | Resolution |
|---|---|
| Removing `is_customer` from main routing means customer callback from dialer now requires a PIN in multi-ticket case (it didn't before). | Accepted. Customer has the PIN via SMS from ticket-open. The friction is one IVR step. |
| PIN possession = authorisation, regardless of who holds it (UC 13 colleague forwarding). | Accepted. Usability ↔ security trade-off — the colleague case is a real CSP workflow. |
| Customer-side PIN lookup is unscoped (no equivalent to CSP `sim_inventory` scoping). | Accepted. 3-retry cap + per-ticket PIN + 100K PIN space = acceptable risk. Scoping would require identifying the customer, which would re-introduce a Resolve-FROM step. |
| Daily PIN rotation adds SMS volume. | Accepted. SMS is cheap relative to a dropped call (NPS hit, retry truck-roll). |
| Dead-end can't distinguish "customer with closed ticket" from "stranger" without `user_type`. | Resolved — `user_identification` returns `user_type` even when count=0, used for dead-end branching. |
| Multi-ticket customer dialing from registered number with no live Table 1 entry: routing would be ambiguous. | PIN disambiguates; no auto-route to most recent. |
| `user_identification` API call cost on every Table-1-miss call. | Negligible if implemented well (< 200 ms p95). Cached against `CallSid` for downstream applets. |
| For "0 active tickets, recognised user" — Exotel flow may not natively support skipping the Gather applet. v1 implementation may route through Gather (which will fail) → dead-end. | Acceptable v1 trade-off. Slight UX wart (20s of pointless PIN entry) before dead-end. Optimise later if data shows it matters. |

---

## Deferred / future work

| Item | Why deferred |
|---|---|
| PIN reminder SMS on prompt abandonment | Can't determine which PIN to resend mid-call when a CSP has multiple tickets, or when caller is unrecognised. |
| PIN expiry notification at ticket close | Not blocking. Add later if dead-end IVR traffic shows confused customers. |
| Auto-recognition of repeat unknown-SIM callers ("Table 4" idea) | Deferred — would add an audit step before PIN that costs UX. Revisit with response-pattern data. |
| Per-FROM rate limiting (beyond per-call 3-retry cap) | Not needed for v1; brute-force economics are bad enough without it. |
| Regional-language IVR expansion (post-Hindi) | Hindi first. Add per CSP geography in a follow-up. |
| WhatsApp BSP-fallback for SMS-undeliverable customers | Operational concern, handled by comms platform. |
| IVR option to actively transfer caller to support ("press 1 to connect") | Today's dead-end gives a number to call but doesn't auto-connect. Could add later. |
| Branched dead-end Playbacks (separate applets for customer vs non-customer) if dynamic audio URL unsupported | v1 falls back to a universal message if Playback can't take a dynamic URL. |

---

## Open TBDs

| Item | Owner |
|---|---|
| PIN format (random 5-digit vs last 5 of ticket ID) | Solution team — recommend random for uniqueness guarantees |
| Exact wording of every IVR prompt and SMS / WA template (Hindi-first) | Solution team |
| Final list of regional languages (post-Hindi) | Solution team |
| Daily PIN rotation time of day | Tech — recommend 03:00 IST (low traffic) |
| Missed-call CleverTap payload schema — finalise fields | Tech + Solution team |
| DLT template registration for all SMS variants | Comms / Ops |
| WhatsApp BSP template approvals | Comms |
| Retention window for closed-ticket PIN rows (hard-delete) | Tech / Compliance — recommend 90 days |
| Confirm Exotel Playback applet supports dynamic audio URL | Tech + Exotel |
| Confirm `user_identification` API SLOs and infra | Tech |
| Decide v1 dead-end IVR audio strategy: dynamic URL vs branched Playbacks vs universal message | Solution team + Tech |

---

## Pre-launch verification checklist

- [ ] **Truecaller:** verify the chosen masked number (one of MN1/MN2) shows the green verified banner with the Wiom name.
- [ ] **VLT:** verify the masked number is registered with the telcos as a legitimate business caller.
- [ ] **DLT templates** approved for every outbound SMS variant.
- [ ] **WhatsApp BSP** setup confirmed for SMS + WA variants.
- [ ] **IVR voice files** recorded in Hindi (PIN entry prompt, both dead-end messages, any missed-call return tone).
- [ ] **`user_identification` API** performance: p95 < 200 ms; load-tested at expected peak.
- [ ] **Table 2 PIN generation** collision check enforced in code (unique index on `pin` for active rows).
- [ ] **Table 2 secondary index** on `(ticket_id, side)` created and warmed.
- [ ] **CleverTap events** `missed_call_csp_to_customer` and `missed_call_customer_to_csp` registered, with campaigns wired.
- [ ] **Disposition webhook** from Exotel terminating at the correct backend endpoint; auth verified.
- [ ] **Telemetry events** firing for all branches; dashboard ready.
- [ ] **Exotel Playback applet** verified to support dynamic audio URL (or fallback strategy locked in).
- [ ] **Redis cache** (or equivalent) provisioned for `CallSid → user_type` short-TTL stash.
- [ ] **Load test:** PIN lookups + `user_identification` under expected peak (target QPS TBD).
- [ ] **End-to-end test** for each of the 13 use cases passes in staging.
- [ ] **Table 2 listener** (`pin-registry-service`) subscribed to all three ESs: `ES_INSTALL_TECHNICIAN_ASSIGNED`, `ES_RESTORE_TECHNICIAN_ASSIGNED`, `ES_NBREC_TASK_ASSIGNED` (plus NBREC `RECOVERY_TASK_ASSIGNED` candidate-creation hook).
- [ ] **Table 2 listener** subscribed to terminal events for each family (Install: `INSTALLATION_REPORTED_FAILED` / `CONNECTION_ACTIVE` / `CANCELLED_BY_CUSTOMER` / `CANCELLED_BY_UPSTREAM` / `INSTALLATION_CANCELLED_ONSITE` / `INSTALLATION_EXPIRED`; Restore: `COMPLETED` / `CANCELLED`; NBREC: `COMPLETED` / `CANCELLED` / `FAILED`).
- [ ] **Idempotency check:** repeated technician-assignment events for the same `(ticket_id, side)` produce upserts, not duplicate rows.
- [ ] **Reassignment test:** reassigning a technician on an Install / Restore / NBREC ticket rewrites `other_party_mobile` + rotates PIN + re-delivers SMS to customer.
- [ ] **Backend `maskedCallAvailable`** derived from active Table 2 row existence (not from per-app state-string parsing).

---

## Glossary

| Term | Meaning |
|---|---|
| **Recognised** | The caller's identity can be resolved — their number is in an active Table 1 mapping, or they hold a valid PIN in Table 2. |
| **Authorised** | The connection is legitimate — the PIN entered (or the FROM matched) belongs to an active ticket for the party being reached. |
| **Seamless** | The call connects without the user opening an app, navigating UI, or understanding masked numbers. |
| **Graceful fallback** | For unrecognised or unauthorised callers — the user understands why the call did not connect and has a clear, achievable next step. |
| **Masked number** | A virtual phone number provisioned by Exotel that routes via a dynamic lookup on our backend; replaces direct CSP ↔ customer number exchange. |
| **MN1 / MN2** | Today's two-masked-number scheme (Customer→CSP and CSP→Customer). To be retired. |
| **CSP** | Connection Service Provider — Wiom's field partner; the technician installing / fixing / picking up. |
| **PIN** | 5-digit numeric credential, issued per ticket per side, used as fallback authorisation when FROM isn't recognised. |
| **Table 1** | Active call mapping (FROM → TO), short-lived; a hit means caller is recognised and bridge is seamless. |
| **Table 2** | PIN registry (PIN → other_party_mobile), per-ticket, per-side. Two access patterns: by PIN, by `(ticket_id, side)`. |
| **`user_identification` API** | Called on Table 1 miss. Returns user_type + active_ticket_count + (if count = 1) the counterparty mobile. |
| **`sim_inventory`** | Existing CSP-SIM capture set; used inside `user_identification` and for PIN scoping. |
| **Resolve-FROM** | Deprecated. Was the multi-classification API; superseded by `user_identification`. |
| **Dead-end IVR** | Terminal voice message when authorisation fails; routes to call centre (recognised customer) or trust line (everyone else). |
| **Calling eligibility** | Calls only enabled on active Install / Restore / Pickup tickets. |
| **DNP** | Did-Not-Pick. The recipient sees the call but doesn't answer (treated as spam, unknown number, etc.). Truecaller + VLT whitelisting mitigate this. |
| **DLT** | India's regulatory framework for transactional SMS. Templates must be pre-registered. |
| **VLT** | Verified Logo Trustmark — telco-level verified-business-caller flag, distinct from Truecaller. |
| **BSP** | Business Solution Provider — for WhatsApp Business API. |
| **TAS** | Wiom's ticket assignment service — source of truth for active tickets and CSP user assignments. |
