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

- **Recognised** — caller's number is in Table 1 OR matches a row in Table 2 (directly by FROM or via a valid PIN).
- **Authorised** — connection is legitimate (PIN or FROM belongs to an active ticket for the party being reached).
- **Seamless** — no app / no IVR / instant bridge (the Table 1 hit + single-counterparty paths).
- **Graceful fallback** — caller knows why the call didn't connect and has a clear next step (helpline number on voice + SMS).

### Service ownership

A **single new service** owns this entire system. Call it `ivr-routing-service` for now (final name TBD). It owns:

| Responsibility | Surface |
|---|---|
| **Table 1** — active call mapping | Internal DB |
| **Table 2** — PIN registry | Internal DB |
| **`sim_inventory`** — CSP SIM → csp_user_id map | Internal DB. Built **fresh** with proper audit logs. (The existing `es-ivr-calling-service` is being discarded as part of this redesign.) |
| **`user_identification` API** | `POST /internal/user-identification` — called only on Table 2 miss (count = 0) |
| **Exotel-facing endpoints** | `GET /ivr/resolve-caller`, `GET /ivr/resolve-pin`, `GET /audio/deadend`, `POST /log/disposition`, `POST /log/*` |
| **ES event listener** | Subscribes to `ES_INSTALL_TECHNICIAN_ASSIGNED`, `ES_RESTORE_TECHNICIAN_ASSIGNED`, `ES_NBREC_TASK_ASSIGNED` + terminal events. Drives Table 2 entry / mobile-update / exit. |
| **SMS dispatch** | Calls Gupshup (Wiom's SMS provider) for PIN delivery, missed-call alerts, dead-end SMS. |
| **CleverTap firing** | Pushes `missed_call_csp_to_customer` / `missed_call_customer_to_csp` events from the disposition webhook. |
| **`maskedCallAvailable` derivation** | Writes a boolean column on each ES candidate row on Table 2 row creation / soft-delete. ES drilldown serializers surface it on the DTO to CSP App + Technician App. |

Single service in v1 keeps deployment, ownership, and infra simple. Split is possible later if scale warrants it.

### Identity store at a glance

| Element | Purpose | New / existing |
|---|---|---|
| **Table 1** | Active call mapping (FROM → TO), short TTL, written when an in-app Call CTA is tapped. **Built fresh** as part of this service (the existing `es-ivr-calling-service` Redis cache is discarded). | **New.** |
| **Table 2** | Per-ticket PIN registry. Two rows per ticket (one per side). Three access patterns — **by FROM at Table 1 miss** (new primary lookup), by `pin` (PIN-prompt flow), by `(ticket_id, side)` (rare — listener writes). | **New.** |
| **`sim_inventory`** | CSP SIM → csp_user_id map. Used in Table 2 by-FROM lookup (to find CSP-side rows when the caller dials from any of their SIMs). | **New.** Built fresh with audit logs (every add / remove tracked). |
| **`user_identification` API** | Called **only when Table 2 returns 0 rows**. Returns user_type ∈ {customer, csp, unknown} + user_id. Result cached against `CallSid` in Redis for reuse at dead-end. | **New.** |
| **Disposition webhook** | Exotel POSTs after every call with outcome (answered / no_answer / busy / failed). Drives missed-call alerts. | New listener; Exotel side already supported. |

---

## The four resolution paths

Every successful call flows through exactly one path:

### Path 1 — Direct bridge (Table 1 hit)
**Trigger:** Caller used in-app CTA recently; Table 1 still has a live mapping for their FROM.
**Outcome:** Seamless bridge to the counterparty in `TO`.
**Covers:** UC 01, UC 02.

### Path 2 — Direct bridge (single counterparty identified by FROM)
**Trigger:** Table 1 miss → **Table 2 lookup by FROM** returns exactly 1 active row → bridge to `other_party_mobile` on that row.
**Outcome:** Seamless bridge, no PIN.
**Covers:** UC 03, UC 05, UC 07, UC 09.
**Note:** No `user_identification` call is made on this path. The Table 2 by-FROM query joins `customers.registered_mobile`, `csp_users.registered_mobile`, and `sim_inventory.mobile` in a single SQL — see Table 2 lookup contracts.

### Path 3 — PIN for multi-ticket disambiguation
**Trigger:** Table 1 miss → **Table 2 lookup by FROM** returns 2+ active rows → IVR asks for PIN → Table 2 lookup by PIN.
**Outcome:** Bridge to the counterparty identified by the PIN.
**Covers:** UC 04, UC 06, UC 08, UC 10.

### Path 4 — PIN for unknown caller
**Trigger:** Table 1 miss → **Table 2 lookup by FROM returns 0 rows** → `user_identification(FROM)` returns `user_type = unknown` → IVR asks for PIN (caller may hold a forwarded PIN, e.g., UC 13 colleague case) → Table 2 lookup by PIN.
**Outcome:** Bridge if PIN valid; dead-end after 3 wrong tries.
**Covers:** UC 11, UC 12, UC 13.

### Dead-end (terminal state, not a path)
**Two ways in:**
- **(a) Recognised user with 0 active tickets** — Table 2 by-FROM returns 0 rows, `user_identification` recognises FROM as customer or CSP → skip PIN entirely via backend directive in `/ivr/resolve-caller` response → Playback dead-end.
- **(b) PIN exhausted** — 3 wrong tries on Path 3 or Path 4 → Playback dead-end. user_type already cached against `CallSid` from the upstream `user_identification` call.

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
| `pin` | string(5) | 5-digit numeric. **Immutable** for the lifetime of the row. Globally unique among **active + cooldown** rows (generation enforces). |
| `ticket_id` | UUID | The ticket this PIN belongs to. |
| `side` | enum (`customer`, `csp`) | Which party this PIN was issued to. |
| `other_party_mobile` | E164 | The number to bridge to when this PIN is entered. **Mutable** — rewritten on technician reassignment (CSP-side row) without disturbing the PIN. |
| `csp_id` | UUID (nullable) | The CSP organisation id; populated on CSP-side rows only. Used for PIN scoping. Mutable on reassignment if the new technician sits under a different CSP org (rare). |
| `csp_user_id` | UUID (nullable) | The specific CSP user (technician) the ticket is assigned to. Mutable on reassignment. |
| `customer_mobile` | E164 (nullable) | The customer's registered mobile; populated on customer-side rows for audit / lookup convenience. |
| `created_at` | timestamp | When the row was created (ticket-open). |
| `expires_at` | timestamp (nullable) | Set on ticket closure (soft-delete). After this, the row is excluded from active lookups but the `pin` value stays reserved until `cooldown_until`. |
| `cooldown_until` | timestamp (nullable) | `expires_at + P_PIN_COOLDOWN_WINDOW` (default 90 days). The PIN value cannot be re-issued to another ticket until `now() > cooldown_until`. Protects against stale-PIN cross-pollination (technician remembers an old PIN, dials in, reaches a stranger's ticket). |

#### Three access patterns (same table, three indexes)

| Pattern | Used by | Lookup keys | Index |
|---|---|---|---|
| **By FROM** | Primary call-routing lookup at Table 1 miss (Paths 2, 3, 4 decision point) | `customer_mobile` OR `csp_user_id` (resolved from FROM via JOINs) | See lookup contract below — multiple covering indexes |
| **By PIN** | PIN-prompt flow (Paths 3, 4) | `pin` | Primary unique index on `pin` (active rows) |
| **By `(ticket_id, side)`** | Listener writes (entry, update, soft-delete) | `ticket_id`, `side` | Composite index on `(ticket_id, side)` |

#### Lookup contracts

**Primary lookup at Table 1 miss — by FROM:** Single combined query that joins identity resolution with Table 2. Handles both customer side (FROM = `customers.registered_mobile`) and CSP side (FROM = `csp_users.registered_mobile` OR FROM in `sim_inventory.mobile` for that csp_user).

```sql
-- Returns 0 / 1 / many active rows, plus the matched side for telemetry
SELECT t2.*, 'customer' AS matched_side
FROM table_2 t2
JOIN customers c ON t2.customer_mobile = c.registered_mobile
WHERE c.registered_mobile = :from
  AND t2.side = 'customer'
  AND t2.expires_at IS NULL
UNION ALL
SELECT t2.*, 'csp' AS matched_side
FROM table_2 t2
WHERE t2.csp_user_id IN (
    SELECT csp_user_id FROM csp_users  WHERE registered_mobile = :from
    UNION
    SELECT csp_user_id FROM sim_inventory WHERE mobile = :from
)
  AND t2.side = 'csp'
  AND t2.expires_at IS NULL;
```

```text
lookup_by_from(from):
  rows = <SQL above>
  branch on rows.count:
    1    → return rows[0].other_party_mobile  (Path 2)
    >= 2 → return 'PROMPT_PIN'                (Path 3)
    0    → return 'CALL_USER_IDENTIFICATION'  (Path 4 or dead-end)
```

**Required indexes for fast resolution:**
- `customers (registered_mobile)` — unique
- `csp_users (registered_mobile)` — unique
- `sim_inventory (mobile)` — non-unique (a single SIM number is registered to one csp_user but a defunct row may exist in audit history)
- `table_2 (customer_mobile)` partial WHERE side='customer' AND expires_at IS NULL
- `table_2 (csp_user_id)` partial WHERE side='csp' AND expires_at IS NULL

**By PIN** (PIN-prompt flow, after Gather):

```text
lookup_by_pin(pin, caller_from):
  rows = SELECT * FROM table_2 WHERE pin = ? AND expires_at IS NULL
  if caller_from is in sim_inventory OR matches a csp_users.registered_mobile:
    # CSP scoping — restrict to PIN rows belonging to a ticket of this caller's CSP org
    rows = rows WHERE side = 'csp' AND csp_id = (caller's resolved csp_id)
  if rows.count == 1: return rows[0].other_party_mobile
  else: return null  -- treated as invalid PIN by /ivr/resolve-pin
```

**By `(ticket_id, side)`** (listener writes only — entry, mobile-update, soft-delete):

```text
write_or_update(ticket_id, side, payload):
  UPSERT INTO table_2 (...)
  ON CONFLICT (ticket_id, side) DO UPDATE
    SET other_party_mobile = EXCLUDED.other_party_mobile,
        csp_user_id        = EXCLUDED.csp_user_id,
        csp_id             = EXCLUDED.csp_id
    -- PIN never updated. created_at never updated.
```

#### Lifecycle

The Call CTA in the CSP App and Technician App is gated by **technician assignment**. Table 2 entry must fire on the same signal that turns the CTA visible, so the PIN is in place the first time the user can tap Call. The exact ES event differs per ticket family — see the next subsection for the per-family wiring.

**Core principle — the PIN is immutable for the ticket's lifetime.** Once issued at ticket-open, the same `(pin, ticket_id, side)` row lives unchanged until ticket close. Reassignments change `other_party_mobile` (and `csp_user_id`) — they do **not** rotate the PIN, because both parties already hold their copy and re-issuing would invalidate everything they have. No daily rotation either; rotation buys little and creates SMS noise.

| Phase | Trigger | Action |
|---|---|---|
| **Generation (entry)** | Technician-assignment event from one of the three TAS ESs (Install / Restore / Pickup) — see per-family table below | Create 2 rows for this ticket — one with `side = 'customer'` and `other_party_mobile = technician_mobile`; one with `side = 'csp'` and `other_party_mobile = customer_mobile`. Generate unique 5-digit PINs (see PIN generation below). Fire customer-side SMS **once**. Surface CSP-side PIN on the ticket card. |
| **Update (reassignment) — mobile only** | Same technician-assignment event re-fired with a new `executor_id` (or ES candidate replaced via reassign signal — see per-family table) | Update both rows for this ticket: **rewrite `other_party_mobile` on the customer-side row** with the new technician's mobile; **rewrite `csp_user_id` (and `csp_id` if cross-org)** on the CSP-side row. **PIN is NOT rotated.** Both parties keep the PINs they already hold; the bridge target changes underneath. Fire PN to the new technician on the ticket card so they see the existing PIN. No new SMS to customer. |
| **Lookup (by FROM)** | Primary call-routing entry — fires on every Table 1 miss | See contract above. |
| **Lookup (by PIN)** | IVR PIN flow (Paths 3, 4) | See contract above. |
| **Soft-delete (exit)** | Ticket transitions to a **terminal state** in its ES — see per-family table below | Set `expires_at = now()`, `cooldown_until = now() + P_PIN_COOLDOWN_WINDOW` on both rows. Excluded from active lookups thereafter; PIN value stays reserved (not reissuable) until `cooldown_until`. |
| **Cooldown** | Row state where `expires_at < now() <= cooldown_until` | PIN value is **reserved** — generation algorithm must skip it. Row is NOT lookup-able (a caller entering this PIN gets "invalid PIN" → dead-end). Protects against the stale-PIN cross-pollination case (technician remembers old PIN, dials in, would otherwise be bridged to a stranger). |
| **Hard-delete** | Background retention job | Delete rows where `cooldown_until < now() - audit_retention_window` (audit retention TBD, suggest 1 year for compliance). After hard-delete the PIN value is freely available to the generation pool again. |

**Cooldown window (`P_PIN_COOLDOWN_WINDOW`) — default 90 days.** Sized against today's Wiom volume (~10k active tickets × 2 PINs = ~20k active; ~500 closing/day × 90 = ~45k cooldown; total ~65k of 100k pool — comfortable). If Wiom volume grows 3×+, escalate to 6-digit PINs (1M pool) — see Deferred work.

#### Per-ticket-family wiring (entry / update / exit signals)

The Call CTA is visible after technician assignment for **all three** TAS execution services. Subscribe to these CEF events on the event bus — Table 2's lifecycle manager (call it `pin-registry-service` or `ivr-pin-listener`) is a fan-in consumer.

| Family | ES (source of truth) | **Entry** — write 2 rows | **Update** — rewrite mobile + rotate PIN | **Exit** — soft-delete |
|---|---|---|---|---|
| **Install** | `es-installation-service-prd-v2.3.yaml` | `ES_INSTALL_TECHNICIAN_ASSIGNED` (state → `TECHNICIAN_ASSIGNED`; sets `executor_id`, `is_self_assigned`). Bridged to legacy RMQ wire_key `INSTALLATION_SLOT_ASSIGN` via `BookingInstallationEventBridge.onTechnicianAssigned` after commit — payload carries technician name + phone fetched from `csp-gateway-service GET /api/internal/csp-users/{id}`. | Same `ES_INSTALL_TECHNICIAN_ASSIGNED` event re-fires with a new `executor_id` when the CSP picks a different technician (state already `TECHNICIAN_ASSIGNED` → idempotent re-emit per `trigger_mutation_matrix.technician_assigned`). Listener compares stored `csp_user_id` vs payload; if different, **rewrite `other_party_mobile` + `csp_user_id` on both rows. PIN is NOT touched.** PN to new technician so they see the existing PIN on their ticket card; no new SMS to customer. | Any transition to terminal state: `INSTALLATION_REPORTED_FAILED`, `CONNECTION_ACTIVE`, `CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_UPSTREAM`, `INSTALLATION_CANCELLED_ONSITE`, `INSTALLATION_EXPIRED`. Soft-delete + set `cooldown_until`. Subscribe to the corresponding `ES_INSTALL_*` events. |
| **Restore** | `es-restore-prd-v1.4.yaml` | `ES_RESTORE_TECHNICIAN_ASSIGNED` (state `ASSIGNED_TECHNICIAN`, fired by CSP action `ASSIGN_TECHNICIAN`, sets `assigned_technician_id`). | `TASK_AUTO_REASSIGNED` upstream signal causes the original candidate to be `CANCELLED` and a new candidate to be inserted for the new executor — when the new CSP runs `ASSIGN_TECHNICIAN`, a fresh `ES_RESTORE_TECHNICIAN_ASSIGNED` fires. Listener treats this as **mobile-only update on the same `ticket_id`** — PIN survives the CSP swap. (Note: cross-CSP reassign is the one edge case where `csp_id` also changes.) | Terminal states: `COMPLETED`, `CANCELLED`. Driven by upstream `COMPLAINT_TASK_CLOSED` (SR OS `CLOSED`), `COMPLAINT_RESOLUTION_SIGNAL` (`UNRESOLVABLE`), `PLATFORM_TAKEOVER_INITIATED`, `COMPLAINT_RECLASSIFIED_TO_PLATFORM`. Soft-delete + set `cooldown_until`. |
| **Pickup (NetBox Recovery)** | `es-netbox-recovery-service-prd-v1.9.yaml` | Default executor is the **owning CSP** (auto-assigned at candidate creation from ACS signal — state `PENDING_PICKUP`, reason `RECOVERY_TASK_ASSIGNED`). When the CSP **delegates** to a team member (v1.9 M7 TASK_ASSIGNMENT), `ES_NBREC_TASK_ASSIGNED` fires with the team-member identity. Listener writes Table 2 rows on **both** signals — same entry semantics. | `ES_NBREC_TASK_ASSIGNED` re-fires when the CSP reassigns to a different team member, or unassigns (back to CSP-self). **Mobile-only update — rewrite `csp_user_id` and `other_party_mobile`. PIN unchanged.** | Terminal states: `COMPLETED`, `CANCELLED`, `FAILED`. Soft-delete + set `cooldown_until`. |

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
    # PIN is unavailable if any row holds it AND is either active OR still in cooldown
    if NOT EXISTS (
      SELECT 1 FROM table_2
      WHERE pin = candidate
        AND (expires_at IS NULL OR cooldown_until > now())
    ):
      return candidate
  raise PinExhaustionError  # 100k space; alert + escalate to 6-digit (see deferred)
```

**Note:** Some accounts may want the **last 5 digits of the ticket ID** as a memorable PIN. That's an alternative — but it sacrifices uniqueness guarantees (two tickets ending in same 5 digits → collision). For v1, recommend random with retry.

**Cooldown protects against stale-PIN reuse.** Without it, ticket A closes with PIN `12345`, ticket B opens later, the algorithm could reissue `12345`, and the technician from ticket A — who still remembers `12345` — would dial in and be bridged to ticket B's customer. The cooldown holds `12345` out of the pool until the technician's mental cache is stale (90 days is the v1 calibration).

#### Index recommendations

```sql
-- Active lookup (Path 3, Path 4)
CREATE UNIQUE INDEX idx_table2_pin_active
  ON table_2 (pin) WHERE expires_at IS NULL;

-- Single-counterparty bridge (Path 2)
CREATE INDEX idx_table2_ticket_side
  ON table_2 (ticket_id, side) WHERE expires_at IS NULL;

-- Generation algorithm: scan both active AND cooldown rows holding a given PIN
CREATE INDEX idx_table2_pin_reserved
  ON table_2 (pin) WHERE expires_at IS NULL OR cooldown_until > now();
-- (Postgres NOTE: predicate on now() is not immutable, so this should be a
--  plain index on (pin) and the WHERE clause moves into the generation query.
--  Listed here for intent; tech to finalise dialect-specific form.)

-- GC + cooldown release
CREATE INDEX idx_table2_cooldown_until
  ON table_2 (cooldown_until);
```

### `sim_inventory` table (new — built fresh)

The existing `es-ivr-calling-service` is being discarded as part of this redesign. `sim_inventory` is rebuilt from scratch inside `ivr-routing-service` with proper audit logs.

#### Schema

| Field | Type | Notes |
|---|---|---|
| `sim_id` | UUID | Primary key. |
| `mobile` | E164 | The SIM number. Non-unique on this column (a number can be replaced; old row stays in audit history with a non-null `removed_at`). |
| `csp_user_id` | UUID | The CSP user this SIM belongs to. |
| `csp_id` | UUID | Denormalised for fast lookup at PIN-scoping time. |
| `added_at` | timestamp | When the SIM was added to inventory. |
| `added_by_user_id` | UUID | Who added it (admin user or CSP user via self-service). |
| `removed_at` | timestamp (nullable) | When the SIM was removed from inventory. NULL = still active. |
| `removed_by_user_id` | UUID (nullable) | Who removed it. |
| `verification_status` | enum | `pending` / `verified` / `failed` — set after OTP verification (TBD: confirm verification flow with Ops). |

#### Indexes

```sql
CREATE INDEX idx_siminv_mobile_active
  ON sim_inventory (mobile) WHERE removed_at IS NULL;

CREATE INDEX idx_siminv_csp_user
  ON sim_inventory (csp_user_id) WHERE removed_at IS NULL;
```

#### Lifecycle

- **Add:** CSP user adds a SIM via self-service flow (or admin tool — TBD). Row inserted with `verification_status = pending`. Optional OTP verification step (TBD by Ops) flips to `verified`.
- **Remove:** Soft-delete via `removed_at`. Row stays for audit. **Removing a SIM does NOT change active Table 2 rows** — because Table 2 by-FROM uses JOIN-at-call-time on `sim_inventory WHERE removed_at IS NULL`, the next call from a removed SIM naturally falls through to PIN gather.
- **Audit log:** Every add / remove writes to a `sim_inventory_audit` table (or equivalent event-log stream). Captures: actor, action, mobile, csp_user_id, timestamp, source (self-service / admin / OTP-flow).

#### Lookup contract (used inside the Table 2 by-FROM JOIN)

```sql
-- Used as a subquery in the Table 2 by-FROM lookup
SELECT csp_user_id FROM sim_inventory
WHERE mobile = :from AND removed_at IS NULL
```

#### Open questions for Ops

- Verification flow: OTP at add time? Or trust the CSP user to declare?
- Self-service vs admin-only adds?
- Cap on number of active SIMs per CSP user?

### Removed: Table 3 (Cx ↔ Technician resolver)

Earlier iterations had a Table 3 — `customer_mobile → technician_mobile` — for customer-side routing without PIN. **Dropped** when the customer-side PIN was added and Table 2 by-FROM lookup was extended to return the counterparty mobile directly. One fewer table to maintain.

---

## user_identification API

### Purpose

Called **only when Table 2 by-FROM lookup returns 0 rows**. Answers a narrow question: *is this FROM a Wiom customer, a Wiom CSP, or completely unknown?* The result drives two decisions:

1. **Skip PIN or not.** If `user_type ∈ {customer, csp}` and Table 2 by-FROM was 0, the caller has no active ticket — there is no live PIN they could possibly enter. Skip Gather, route directly to dead-end with the right helpline message.
2. **Which dead-end message to play.** `customer` → call centre 88803 22222; `csp` or `unknown` → trust line 78368 11111.

**Not on the hot path.** Most calls (Table 1 hit, or Table 2 by-FROM returns 1 or many) never invoke this API. Only the 0-row case touches it.

### Endpoint

`POST /internal/user-identification`
- **Internal-only**, exposed by the same `ivr-routing-service` that owns Table 1 + Table 2.
- **Auth:** internal mTLS between Exotel-facing layer and identity layer of the same service (intra-process call in practice; exposed as a logical API for clarity + future split).
- **Latency budget:** p95 < 100 ms — it runs inside Exotel's already-shrunk window (after the by-FROM lookup has consumed some of the 5 s budget).
- **Idempotency:** safe — pure read.

### Request

```json
{
  "from": "+91XXXXXXXXXX",
  "call_id": "exotel-call-sid"  // for telemetry correlation + Redis cache key
}
```

### Response

```json
{
  "user_type": "customer" | "csp" | "unknown",
  "user_id": "uuid" | null   // customer_id or csp_user_id; null when user_type == "unknown"
}
```

**No active-ticket-count.** That answer is already known (= 0) because this API is only called after Table 2 by-FROM returned 0 rows. No need to recompute.

### Internal logic

```text
user_identification(from):
  if from matches customers.registered_mobile:
    return { user_type: "customer", user_id: customer.id }
  elif from matches csp_users.registered_mobile:
    return { user_type: "csp", user_id: csp_user.id }
  elif from matches sim_inventory.mobile:
    csp_user_id = sim_inventory.lookup(from).csp_user_id
    return { user_type: "csp", user_id: csp_user_id }
  else:
    return { user_type: "unknown", user_id: null }
```

**Multi-match enforcement (HTML assumption).** A FROM that matches both a customer AND a CSP record is forbidden by data-model invariant (HTML assumptions). The API should `LOG.error` + return `user_type = "customer"` (customer takes precedence as the more user-visible case). Operational dashboard surfaces these for cleanup.

### Caching

Result is stashed in Redis keyed on `call_id`:
- **Key:** `ivr:user_type:{call_id}`
- **TTL:** 10 minutes (covers any reasonable call duration + PIN flow + disposition webhook)
- **Why:** if the caller hits PIN gather (Path 4: unknown + has-forwarded-PIN) and then fails 3 times, dead-end needs `user_type` again. Re-resolution wastes a DB call.

### Routing decisions driven by the response

Given Table 2 by-FROM already returned 0 rows:

| `user_type` | Action | Path |
|---|---|---|
| `customer` | **Skip PIN.** `/ivr/resolve-caller` response sets `action: "playback"` with the call-centre dead-end audio URL. | Direct → Dead-end (customer) |
| `csp` | **Skip PIN.** `/ivr/resolve-caller` response sets `action: "playback"` with the trust-line dead-end audio URL. | Direct → Dead-end (csp) |
| `unknown` | **Prompt for PIN.** `/ivr/resolve-caller` response sets `action: "gather"` — caller may hold a forwarded PIN (UC 13). On 3 failed attempts, dead-end → trust line. | Path 4 |

---

## Backend endpoint contracts

All Exotel-facing endpoints are exposed by `ivr-routing-service`. **Auth for every Exotel-originated request: signed-payload via shared secret** (Exotel-supported). Backend rejects any request whose `X-Exotel-Signature` header does not match HMAC-SHA256(shared_secret, request_body). Shared secret rotated quarterly.

### `/ivr/resolve-caller` (called by Exotel Connect #1)

`GET /ivr/resolve-caller?From=<E164>&CallSid=<exotel_sid>&To=<masked_number>`

**Logic:**
1. Log `dial_received_backend`.
2. **Table 1 lookup** by `From`. If hit → return `action: "connect"` with destination.
3. **Else Table 2 by-FROM lookup** (the JOIN-at-call-time SQL). Branch on row count:
   - **1 row** → return `action: "connect"` with destination = `rows[0].other_party_mobile`. Cache `user_type` (from the matched_side column) against `CallSid`. (Path 2)
   - **>= 2 rows** → return `action: "gather"`. Cache `user_type` against `CallSid` for dead-end use. (Path 3)
   - **0 rows** → call `user_identification(From, CallSid)`. Cache the result. Then:
     - `user_type == "customer"` → return `action: "playback"` with `audio_url: /audio/deadend?call_id={CallSid}` (customer dead-end → call centre)
     - `user_type == "csp"` → return `action: "playback"` with `audio_url: /audio/deadend?call_id={CallSid}` (csp dead-end → trust line)
     - `user_type == "unknown"` → return `action: "gather"` (Path 4 — caller may hold a forwarded PIN)

**Response schema:**
```json
{
  "action": "connect" | "gather" | "playback",
  // when action == "connect"
  "destination": { "numbers": ["+919812345678"] },
  "outgoing_phone_number": "<masked_number>",
  "record": true,
  "max_ringing_duration": 30,
  // when action == "playback"
  "audio_url": "https://ivr-routing-service.../audio/deadend?call_id=...",
  // optional metadata for telemetry correlation
  "resolution_reason": "table1_hit" | "table2_single" | "table2_multi" | "recognised_no_ticket" | "unknown_caller"
}
```

**Exotel applet interpretation:**
- `action: "connect"` → Exotel's Connect-applet dials the destination, masking with `outgoing_phone_number`.
- `action: "gather"` → Connect returns "no destination" → Exotel flow advances to the next applet (Gather → PIN prompt).
- `action: "playback"` → Exotel honours a redirect to the Playback applet via the dynamic-URL response. **Confirm with Exotel:** that Connect applets support a `playback` directive response. If not, fallback is **(b)** from §Open TBDs — add a branching Passthru applet between Connect-1 and Gather to read the resolution decision.

**Timeout / error:** Exotel falls back to the Fallback URL configured on the applet. Backend SLO: p95 < 200 ms.

**Idempotency:** Safe — read-only. Same input always produces same output for the lifetime of Table 1 / Table 2 state.

### `/ivr/resolve-pin` (called by Exotel Connect #2)

`GET /ivr/resolve-pin?From=<E164>&CallSid=<exotel_sid>&digits=<5_digits>`

**Logic:**
1. Log `pin_attempted` (with attempt number, digits length only — not the digits themselves).
2. Table 2 lookup by PIN, with scoping:
   - If `From` matches `csp_users.registered_mobile` OR is in `sim_inventory` → scope to `side = 'csp' AND csp_id = matched_csp_id` (matched at `/resolve-caller` time, available in Redis).
   - Else → unrestricted (handles unknown FROM + customer multi-ticket cases).
3. If single match → return `action: "connect"` with destination. Log `pin_attempt_valid`.
4. If no match → return `action: "gather_retry"` if attempt < 3, else `action: "playback"` with deadend audio URL. Log `pin_attempt_invalid` (with reason: `no_match` or `cooldown_row` or `pin_format`).

**Response shape:**
```json
{
  "action": "connect" | "gather_retry" | "playback",
  // when "connect"
  "destination": { "numbers": ["..."] },
  "outgoing_phone_number": "<masked_number>",
  "record": true,
  // when "playback" (after 3 fails)
  "audio_url": "https://.../audio/deadend?call_id=...",
  "resolution_reason": "pin_match" | "pin_invalid" | "pin_exhausted"
}
```

**Idempotency:** the PIN attempt counter is keyed against `CallSid` in Redis (TTL 10 min). Duplicate webhook fires for the same `(CallSid, digits, attempt)` return the same response.

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
- Two PINs minted on the technician-assignment event (one per side). See per-family wiring for the exact ES event.
- 5-digit numeric, generated by the random-with-retry algorithm above.
- Globally unique among **active + cooldown rows** (enforced by the generation query, not by a simple unique index — see Index recommendations).
- **PIN is immutable for the row's lifetime.** No rotation, ever.

### Distribution (fires once, at row creation)

| Recipient | Channel | Trigger |
|---|---|---|
| **Customer (registered mobile)** | SMS + WhatsApp at technician-assignment. Same message carries the masked number to dial. | Listener consumes the family-specific assignment event |
| **CSP user (assigned technician)** | Shown on the **ticket card** in the CSP App. **PIN must be visually prominent so screenshots include it.** | App fetches via existing ticket API |
| **Colleague (no app, UC 13)** | The CSP user forwards their SMS / WhatsApp message, OR shares a screenshot of the ticket card. | Manual (out of system scope) |

### Reassignment (mobile-only update)
When the assigned technician changes:
- **PIN is NOT rotated.** Both parties keep their copies.
- Customer-side row: rewrite `other_party_mobile` to the new technician's phone. **No new SMS** — customer's existing PIN still works; the bridge target silently re-routes.
- CSP-side row: rewrite `csp_user_id` (and `csp_id` if cross-org). Old technician's ticket card disappears (ticket no longer in their queue). New technician sees the existing PIN on their ticket card.
- Trigger: same `ES_*_TECHNICIAN_ASSIGNED` event re-fired with a new executor — see per-family wiring.

### Expiry, cooldown, GC
- **Soft-delete** on ticket-close (terminal state in the ES): set `expires_at = now()`, `cooldown_until = now() + 90 days`. Row no longer lookup-able.
- **Cooldown** (`expires_at < now() <= cooldown_until`): row is invisible to callers (entering the PIN → "invalid" → dead-end) AND its PIN value is held out of the generation pool. Prevents stale-PIN cross-pollination — a technician remembering an old job's PIN cannot be misrouted to a stranger's ticket that has been reissued the same PIN.
- **Hard-delete:** background job removes rows where `cooldown_until < now() - audit_retention_window` (audit retention ~ 1 year for compliance).

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
| **Table 2 by-FROM is the primary lookup at Table 1 miss** (not user_identification) | Table 2 itself encodes everything we need: caller identity (matches `customer_mobile` / `csp_user_id` via JOIN with sim_inventory + registered_mobile) AND counterparty (`other_party_mobile` on the row). No separate identity API on the hot path. Single SQL with JOINs returns 0/1/many rows, branching the entire flow. (Earlier draft had `user_identification` called on every Table-1 miss — that was over-engineered.) |
| **`user_identification` API fires ONLY when Table 2 by-FROM returns 0 rows** | A 0-row result means either (a) recognised user with no active ticket, or (b) unknown FROM. Distinguishing the two requires identity resolution. user_identification answers that narrow question — and skips PIN entirely for the (a) case (saving ~25 s of doomed PIN entry). Not called on bridging or PIN-prompt paths — they already know the user from Table 2 rows. |
| **Single `ivr-routing-service` owns the entire system** | Tables 1+2, sim_inventory, user_identification, Exotel surface, ES listener, SMS dispatch, CleverTap firing, maskedCallAvailable derivation. Avoids cross-service latency on the hot path; one team, one DB, one deployment. Split later if scale demands it. |
| **Discard `es-ivr-calling-service`, build sim_inventory fresh** | Existing service was a thin wrapper around the IVR microservice with no audit logging. Starting fresh inside `ivr-routing-service` gives us proper add/remove audit, consistent ownership, and removes the integration ambiguity entirely. |
| **Skip-Gather via backend directive** in `/ivr/resolve-caller` response | When user_identification says "recognised, 0 tickets", the resolve-caller response is `action: "playback"` — Exotel honours it and routes directly to the dead-end Playback applet. Cleaner than configuring a separate branching Passthru applet. **Depends on Exotel Connect-applet supporting `action: playback` in dynamic-URL responses — confirm with Exotel before locking.** |
| **Unknown FROM routes to PIN gather (not direct to dead-end)** | Critical for UC 13 (colleague forwarding) — colleague isn't recognised but holds a forwarded PIN. Giving up immediately on unknown FROM would block this case. |
| **Two PINs per ticket** (customer-side + CSP-side) | Symmetric authorisation; either party can authenticate when off-CTA. PIN encodes ticket + direction. |
| **Customer-side PIN via SMS; CSP-side via app ticket card only** | Customers are not app-engaged; SMS reaches them. CSPs see ticket details in app — no SMS noise. |
| **5-digit PIN, random with uniqueness retry** | Matches OTP expectation. 100K combos × 3-retry cap = 0.003% brute-force probability per call. |
| **PIN is immutable for the row's lifetime — no rotation, ever** | PIN is shared with both parties at ticket-open (customer via SMS, CSP via ticket card). Rotating invalidates what they hold and forces re-distribution. Rotation buys little — the PIN is already short, scoped, and 3-retry-capped. Prefer simplicity. |
| **Reassignment rewrites mobile only, leaves PIN untouched** | Both parties keep the PINs they already have. Only the bridge target (`other_party_mobile`) changes underneath. Avoids the "which PIN is current" failure mode. |
| **PIN cooldown after ticket close (90 days)** | Once a ticket closes, its PIN value is reserved (excluded from generation) for 90 days. Protects against stale-PIN cross-pollination: a technician remembering an old PIN cannot be misrouted to a stranger's ticket that has been reissued the same PIN. 90-day window matches today's pool-vs-volume math. |
| **PIN scoping for CSPs (sim_inventory match → restricted lookup)** | Prevents a CSP from guessing or reaching a customer who isn't theirs. Also a partial backstop on the stale-PIN risk on the CSP side — even if cooldown were bypassed, the cross-CSP lookup would still fail. |
| **3-retry cap per call** | Matches universal expectation (ATM, banking). |
| **Dead-end ALSO sends SMS, not just voice** | Voice is ephemeral; SMS lets the caller act later. |
| **One bidirectional DID, not a pool** | Single masked number replaces MN1/MN2. Truecaller / VLT verification applied to this one number. No pool-picking algorithm. Simpler routing, simpler trust-layer ops. |
| **Truecaller whitelisting reuses one of MN1/MN2** | No fresh whitelisting work; verified status carries forward. The other number (the one not chosen) is eventually decommissioned. |
| **VLT whitelisting added** | Telco-level trust mark complements Truecaller; together they directly address DNP. |
| **Table 2 triple access pattern (by FROM, by PIN, by ticket+side)** | Same physical table serves three lookup patterns. By FROM is the hot path (every call). By PIN is the gather flow. By (ticket+side) is listener writes only. No need for a third table. |
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
| Immutable PIN means a leaked PIN stays leaked for the ticket's lifetime. | Accepted. The blast radius is one ticket × one direction. PIN possession = authorisation by design (UC 13 colleague forwarding requires this). For tickets with very long lifetimes, the ES state machine will close them on the terminal events listed in the per-family wiring — at which point cooldown takes over. |
| PIN pool is finite (100K for 5-digit) — cooldown reservation can pressure the pool at scale. | At today's Wiom volume (~10k active × 2 PINs + ~500 closing/day × 90-day cooldown = ~65k of 100k pool), fine. At ~3× growth, escalate to **6-digit PINs (1M pool)** — see Deferred work. Generation should alert at retry-count threshold so we get warning. |
| Dead-end can't distinguish "customer with closed ticket" from "stranger" without `user_type`. | Resolved — `user_identification` is called on the Table 2 0-row branch, returns `user_type`, drives dead-end branching. Result cached against `CallSid` for the PIN-failure path too. |
| Multi-ticket customer dialing from registered number with no live Table 1 entry: routing would be ambiguous. | PIN disambiguates; no auto-route to most recent. |
| Table 2 by-FROM JOIN cost on every Table-1-miss call. | Acceptable. JOIN against three indexed tables (customers, csp_users, sim_inventory). Target p95 < 50 ms on the JOIN; well within Exotel's 5 s window. Cache `user_type` against `CallSid` so downstream applets reuse it. |
| Skip-Gather depends on Exotel supporting `action: playback` in Connect-applet response. | If unsupported, fallback is a Passthru applet between Connect-1 and Gather that reads a backend-set flag and branches. Adds one applet hop. Confirm with Exotel before locking. |

---

## Deferred / future work

| Item | Why deferred |
|---|---|
| PIN reminder SMS on prompt abandonment | Can't determine which PIN to resend mid-call when a CSP has multiple tickets, or when caller is unrecognised. |
| **6-digit PIN escalation (1M pool)** | Triggered when generation algorithm's average retry count exceeds threshold (e.g., > 3 attempts) or when active+cooldown reservation approaches 70% of pool. At ~3× current Wiom volume, expect to need this. Migration: add new column, generate 6-digit for new rows, leave existing 5-digit rows alone (they expire naturally). |
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
| PIN cooldown window length (default 90 days) | Tech + Solution team — validate against actual technician-recall behaviour after a couple of months in prod |
| Audit retention window after cooldown ends (suggest 1 year) | Compliance |
| PIN-pool monitoring + alert threshold (retry count, % reservation) | Tech |
| Missed-call CleverTap payload schema — finalise fields | Tech + Solution team |
| DLT template registration for all SMS variants | Comms / Ops |
| WhatsApp BSP template approvals | Comms |
| Retention window for closed-ticket PIN rows (hard-delete) | Tech / Compliance — recommend 90 days |
| Confirm Exotel Connect-applet supports `action: playback` in dynamic-URL response (skip-Gather mechanism) | Tech + Exotel |
| Confirm Exotel Playback applet supports dynamic audio URL | Tech + Exotel |
| `sim_inventory` verification flow — OTP at add time vs trust-declare? Self-service or admin-only? Cap on SIMs per CSP? | Ops + Tech |
| Decide v1 dead-end IVR audio strategy: dynamic URL vs branched Playbacks vs universal message | Solution team + Tech |
| Exotel shared-secret rotation cadence (default quarterly) | Tech + Security |
| **HTML update**: redraw end-to-end flowchart for Table-2-first logic; remove daily-rotation language | PM (Ashis) |

---

## Pre-launch verification checklist

- [ ] **Truecaller:** verify the chosen masked number (one of MN1/MN2) shows the green verified banner with the Wiom name.
- [ ] **VLT:** verify the masked number is registered with the telcos as a legitimate business caller.
- [ ] **DLT templates** approved for every outbound SMS variant.
- [ ] **WhatsApp BSP** setup confirmed for SMS + WA variants.
- [ ] **IVR voice files** recorded in Hindi (PIN entry prompt, both dead-end messages, any missed-call return tone).
- [ ] **Single `ivr-routing-service`** deployed with Tables 1+2, sim_inventory, user_identification, Exotel endpoints, ES listener, SMS dispatch, CleverTap firing all owned in one place.
- [ ] **`es-ivr-calling-service` decommission plan** — old service stopped + old Redis cache discarded + cutover dated.
- [ ] **Table 2 by-FROM JOIN** load-tested: p95 < 50 ms with indexes on `customers.registered_mobile`, `csp_users.registered_mobile`, `sim_inventory.mobile` (partial WHERE removed_at IS NULL), `table_2 (customer_mobile)` partial, `table_2 (csp_user_id)` partial.
- [ ] **`user_identification` API** performance: p95 < 100 ms on the 0-row branch; load-tested at expected peak.
- [ ] **`sim_inventory` audit log** populated for every add / remove operation in staging.
- [ ] **`sim_inventory` verification flow** decided + implemented (OTP / trust-declare / admin-only).
- [ ] **Exotel signed-payload auth** verified end-to-end for all 5 backend endpoints; shared secret stored in vault; rotation runbook documented.
- [ ] **Skip-Gather mechanism** verified — confirm Exotel honours `action: "playback"` in `/ivr/resolve-caller` response. If unsupported, branching-Passthru fallback wired and tested.
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
- [ ] **Idempotency check:** repeated technician-assignment events for the same `(ticket_id, side)` produce upserts, not duplicate rows; PIN value never changes.
- [ ] **Reassignment test:** reassigning a technician on an Install / Restore / NBREC ticket rewrites `other_party_mobile` + `csp_user_id` only. **PIN is unchanged.** No new SMS to customer. PN fires to the new technician.
- [ ] **PIN cooldown test:** close a ticket, verify its PIN is excluded from the generation pool. Verify the same PIN cannot be re-issued for 90 days. Verify entering the expired PIN routes to dead-end (not a wrong-ticket bridge).
- [ ] **PIN-pool monitoring:** generation retry count + active+cooldown reservation % surfaced on a dashboard; alert when retries > threshold (signal to escalate to 6-digit).
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
