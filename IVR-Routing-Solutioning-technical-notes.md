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
| **`user_identification` API** | `GET /ivr/identify-caller` — called by a Passthru Sync applet only after Connect-applet returns empty destination. Returns `{"select": "customer" | "csp" | "unknown"}` with `Content-Type: text/plain` for Switch Case branching. |
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
| **Disposition webhook** | Exotel POSTs after every call with outcome (answered / no_answer / busy / failed). Captured for analytics; **does not** fire missed-call alerts (those fire from Passthru-Async-on-DNP). | New listener; Exotel side already supported. |

---

## Engineering deliverables — what tech needs to build

This section is a build-ready summary. Engineers can implement from this; the deeper sections fill in nuance.

### Single new service: `ivr-routing-service`

One service owns all of this. Deployment, DB, ownership in one place.

### Three Exotel-facing APIs (all HTTP GET — Exotel does not support POST on applet webhooks)

| API | Endpoint | Caller (Exotel applet) | Response format | What it does |
|---|---|---|---|---|
| **API 1** | `GET /ivr/resolve-caller` | First **Connect** applet (Dynamic URL) | JSON `{destination, outgoing_phone_number, record, ...}` per [Connect docs](https://support.exotel.com/support/solutions/articles/3000096873). Empty `numbers` array on no-bridge. | Table 1 lookup → if miss, Table 2 by-FROM JOIN with customers / csp_users / sim_inventory. Returns destination if exactly 1 row matches; empty destination otherwise (flow then routes to Passthru Sync). On 0-row case, also pre-calls API 2 logic to cache user_type for the next applet. |
| **API 2** | `GET /ivr/identify-caller` | **Passthru Sync** applet | `Content-Type: text/plain` body: `{"select": "customer" \| "csp" \| "unknown"}` per [Switch Case docs](https://support.exotel.com/support/solutions/articles/3000052018). HTTP 200 always. | Pure identity resolution. Matches FROM against `customers.registered_mobile`, `csp_users.registered_mobile`, `sim_inventory.mobile` (WHERE removed_at IS NULL). Caches result in Redis keyed on `CallSid` for the second invocation after PIN exhaustion. |
| **API 3** | `GET /ivr/resolve-pin` | PIN-validating **Connect** applet (×2 — attempt 1 and attempt 2) | Same JSON shape as API 1. Empty `numbers` if PIN invalid. | **MUST `strip('"')` from `digits`** (Exotel wraps it). Table 2 lookup by PIN, with scoping per cached `user_type`. Returns destination on single match; empty otherwise. Stateless — no attempt counter (flow structure caps at 2). |

### Five data structures the service owns

| Store | Purpose | New / fresh |
|---|---|---|
| **Table 1 — active call mapping** | FROM → TO, short TTL (call duration + buffer, max 5 min). Written by in-app Call CTA flow; read by API 1. | New (replaces existing Redis cache in old `es-ivr-calling-service`). |
| **Table 2 — PIN registry** | Per-ticket PIN registry. Two rows per ticket (customer side + csp side). Immutable PIN per ticket; mobile-only on reassign; 90-day cooldown after ticket close. Three access patterns (by FROM, by PIN, by ticket+side). | New. |
| **`sim_inventory`** | CSP SIM → csp_user_id map. Used inside the Table 2 by-FROM resolution. Has an audit trail tracking every add / remove. | New (built fresh; old `es-ivr-calling-service` discarded). |
| **Call audit log** | Every Passthru hit writes here. ~30 typed event categories (see §Logging catalog). | New. |
| **PIN audit log** | Every PIN attempt logged (attempt #, outcome, reason — NOT the digits). | New. |

### One ES event listener

Subscribes to **three execution-service event streams** (one fan-in consumer):
- `ES_INSTALL_TECHNICIAN_ASSIGNED` (from `es-installation-service`)
- `ES_RESTORE_TECHNICIAN_ASSIGNED` (from `es-restore`)
- `ES_NBREC_TASK_ASSIGNED` (from `es-netbox-recovery`)

Plus the corresponding **terminal-state events** for each family (Install: 6 terminal states; Restore: 2; NBREC: 3 — see §Per-ticket-family wiring).

**Listener actions:**
- On `*_TECHNICIAN_ASSIGNED` (entry / reassignment): upsert 2 rows in Table 2 keyed on `(ticket_id, side)`. PIN is generated once on first insert; subsequent re-fires rewrite `other_party_mobile` + `csp_user_id` only.
- On terminal state: soft-delete (`expires_at = now()`, `cooldown_until = now() + 90 days`).
- Also writes `masked_call_available: true|false` boolean on each ES candidate row so drilldown serializers can surface it on `TaskDetail.maskedCallAvailable` for the apps.

### Outbound integrations

- **Gupshup** — SMS for PIN delivery at ticket-open; missed-call alerts via CleverTap campaign.
- **CleverTap** — fired from Passthru-Async-on-DNP with `missed_call_csp_to_customer` / `missed_call_customer_to_csp` events.

### Definition of "fully functional"

For tech to call the API "ready":

1. All 5 data structures stood up per the requirements in §Tables.
2. All 3 APIs return the EXACT response formats specified above (no `action:` field, no JSON for Switch Case in `application/json`).
3. ES listener consuming from all 3 streams in staging, with upsert idempotency confirmed (re-firing same event = same row state).
4. `sim_inventory` add/remove flow working with audit log writes.
5. PIN generation excluding cooldown rows (verified by closing a ticket, checking PIN is not re-issued for 90 days).
6. Reassignment test: technician reassigned → `other_party_mobile` rewritten, PIN unchanged, no new SMS to customer.
7. End-to-end test: live Exotel staging account → all 13 use cases pass.
8. `maskedCallAvailable` boolean surfaced correctly on CSP App + Technician App drilldown DTOs.

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
**Outcome:** Bridge if PIN valid; dead-end after 2 failed attempts.
**Covers:** UC 11, UC 12, UC 13.

### Dead-end (terminal state, not a path)
**Two ways in:**
- **(a) Recognised user with 0 active tickets** — Table 2 by-FROM returns 0 rows, `user_identification` recognises FROM as customer or CSP → skip PIN entirely via backend directive in `/ivr/resolve-caller` response → Playback dead-end.
- **(b) PIN exhausted** — 2 failed attempts on Path 3 or Path 4 → Playback dead-end. user_type already cached against `CallSid` from the upstream `user_identification` call.

**Outcome:** Graceful-fallback IVR + dead-end SMS:
- `user_type == 'customer'` → call centre **88803 22222**.
- `user_type ∈ {csp, unknown}` → trust line **78368 11111**.

---

## Tables — full schemas + lifecycle

### Table 1 — Active call mapping (existing, kept)

#### Fields

| Field | Notes |
|---|---|
| `mapping_id` | Primary key. |
| `from_list` | All FROM numbers for this session. CSP-side: every SIM in `sim_inventory` for that CSP user + their registered mobile. Customer-side: registered mobile only. |
| `to` | Other party's mobile. |
| `ticket_id` | The ticket this mapping belongs to. |
| `direction` | `csp_to_customer` or `customer_to_csp` — which side initiated. |
| `created_at` | When the mapping was written. |
| `ttl_expires_at` | `min(call_connected_at + buffer, created_at + 5 min)` — today's logic preserved. |

#### Lifecycle

| Phase | Trigger | Action |
|---|---|---|
| **Write** | `initiateCall` API received from CSP App or Customer App | Insert row with `from_list`, `to`, `ticket_id`, `direction`, `created_at`. Compute `ttl_expires_at`. Return masked number to the app. |
| **Lookup** | Exotel webhook arrives on Connect #1 (`/resolve-caller`) | Find the active row whose `from_list` contains the incoming `From`. If multiple matches, pick most recent. |
| **GC** | Background job (or lazy at lookup) | Remove rows past `ttl_expires_at + retention_buffer`. |

### Table 2 — PIN registry (new)

#### Fields

| Field | Notes |
|---|---|
| `pin_id` | Primary key. |
| `pin` | 5-digit numeric. **Immutable** for the lifetime of the row. Globally unique among **active + cooldown** rows. |
| `ticket_id` | The ticket this PIN belongs to. |
| `side` | `customer` or `csp` — which party this PIN was issued to. |
| `other_party_mobile` | The number to bridge to when this PIN is entered. **Mutable** — rewritten on technician reassignment (CSP-side row) without disturbing the PIN. |
| `csp_id` | The CSP organisation id; populated on CSP-side rows only. Used for PIN scoping. Mutable on reassignment if the new technician sits under a different CSP org (rare). |
| `csp_user_id` | The specific CSP user (technician) the ticket is assigned to. Mutable on reassignment. |
| `customer_mobile` | The customer's registered mobile; populated on customer-side rows for audit / lookup convenience. |
| `created_at` | When the row was created (ticket-open). |
| `expires_at` | Set on ticket closure (soft-delete). After this, the row is excluded from active lookups but the `pin` value stays reserved until `cooldown_until`. |
| `cooldown_until` | `expires_at + P_PIN_COOLDOWN_WINDOW` (default 90 days). The PIN value cannot be re-issued to another ticket until `now() > cooldown_until`. Protects against stale-PIN cross-pollination (technician remembers an old PIN, dials in, reaches a stranger's ticket). |

#### Three access patterns

| Pattern | Used by | Lookup keys |
|---|---|---|
| **By FROM** | Primary call-routing lookup at Table 1 miss (Paths 2, 3, 4 decision point) | `customer_mobile` OR `csp_user_id` (resolved from FROM via identity tables) |
| **By PIN** | PIN-prompt flow (Paths 3, 4) | `pin` |
| **By `(ticket_id, side)`** | Listener writes (entry, update, soft-delete) | `ticket_id`, `side` |

#### Lookup behaviour (requirements)

- **By FROM (Table 1 miss):** Resolve the caller's identity (against customers, CSP users, and the SIM inventory) and find any active Table 2 rows where this caller is on either side. Return 0 / 1 / many rows. Branch the flow accordingly: 1 row → bridge to `other_party_mobile`; ≥ 2 rows → prompt for PIN; 0 rows → call `user_identification`.
- **By PIN (after Gather):** Find an active Table 2 row matching the entered PIN. **Apply scoping per caller type:**
  - Known CSP: restrict to PINs belonging to a ticket of the caller's CSP org.
  - Known customer (Path 3): restrict to PINs of the caller's own tickets.
  - Unknown FROM: no scoping (UC 13 colleague forwarding requires this).
- **By `(ticket_id, side)` (listener writes only):** Upsert keyed on `(ticket_id, side)`. Reassignment rewrites `other_party_mobile`, `csp_user_id`, `csp_id` only — PIN and `created_at` are never updated.

Tech owns the query shapes, joins, and index strategy.

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

#### CTA visibility — app-side gating

**Requirement:** The Call CTA in the CSP App and Technician App must be visible if and only if an active Table 2 row exists for the relevant `(ticket_id, side)`. PINs should exist exactly when the CTA can be tapped — no earlier (wasted rows + SMS), no later (failed first tap).

**Backend deriving `maskedCallAvailable` from Table 2** is the cleanest contract — it removes per-app state-string checks and centralises the gate in one place. Recommended.

#### PIN generation — requirement

- 5-digit numeric.
- Globally unique among **active + cooldown** rows. (Generation strategy is tech's choice; collision-retry recommended.)
- Recommend random; "last 5 of ticket ID" sacrifices uniqueness guarantees and is not recommended for v1.

**Why cooldown matters (rationale):** Without it, ticket A closes with PIN `12345`, ticket B opens later and could be reissued `12345`, and the technician from ticket A — who still remembers `12345` — would dial in and be bridged to ticket B's customer. Cooldown holds `12345` out of the pool until the technician's mental cache is stale (90 days is the v1 calibration).

### `sim_inventory` table (new — built fresh)

The existing `es-ivr-calling-service` is being discarded as part of this redesign. `sim_inventory` is rebuilt from scratch inside `ivr-routing-service` with proper audit logs.

#### Fields

| Field | Notes |
|---|---|
| `sim_id` | Primary key. |
| `mobile` | The SIM number. A number can be replaced; the old row stays in audit history with a non-null `removed_at`. |
| `csp_user_id` | The CSP user this SIM belongs to. |
| `csp_id` | The CSP org id (denormalised for fast PIN-scoping lookups). |
| `added_at` | When the SIM was added to inventory. |
| `added_by_user_id` | Who added it (admin user or CSP user via self-service). |
| `removed_at` | When the SIM was removed from inventory. NULL = still active. |
| `removed_by_user_id` | Who removed it. |
| `verification_status` | `pending` / `verified` / `failed` — set after OTP verification (TBD: confirm verification flow with Ops). |

#### Lifecycle

- **Add:** CSP user adds a SIM via self-service flow (or admin tool — TBD). Row inserted with `verification_status = pending`. Optional OTP verification step (TBD by Ops) flips to `verified`.
- **Remove:** Soft-delete via `removed_at`. Row stays for audit. **Removing a SIM does NOT change active Table 2 rows** — because Table 2 by-FROM uses JOIN-at-call-time on `sim_inventory WHERE removed_at IS NULL`, the next call from a removed SIM naturally falls through to PIN gather.
- **Audit log:** Every add / remove writes to a `sim_inventory_audit` table (or equivalent event-log stream). Captures: actor, action, mobile, csp_user_id, timestamp, source (self-service / admin / OTP-flow).

#### Lookup behaviour

Used inside the Table 2 by-FROM resolution: given a FROM, return the `csp_user_id` for any non-removed SIM matching that number.

#### Open questions for Ops

- Verification flow: OTP at add time? Or trust the CSP user to declare?
- Self-service vs admin-only adds?
- Cap on number of active SIMs per CSP user?

### Removed: Table 3 (Cx ↔ Technician resolver)

Earlier iterations had a Table 3 — `customer_mobile → technician_mobile` — for customer-side routing without PIN. **Dropped** when the customer-side PIN was added and Table 2 by-FROM lookup was extended to return the counterparty mobile directly. One fewer table to maintain.

---

## API 2 — `GET /ivr/identify-caller` (called by Passthru Sync applet)

### Purpose

Called by a **Passthru Sync** applet whenever the upstream Connect applet returned an empty destination (`"We didn't dial anyone"`). The next applet (Switch Case) reads this API's response body to branch into Customer / CSP / Unknown dead-end flows OR into PIN Gather (Unknown path).

**Fires twice in the flow:**
1. After the initial Connect (API 1) returned empty destination — drives the first Switch Case.
2. After both PIN-validating Connect attempts (API 3) failed — drives the final Switch Case at the dead-end.

### Why this isn't called on every Table-1-miss

Most Table-1-miss calls already determine user_type during the Table 2 by-FROM JOIN (the `matched_side` column from API 1). API 2 fires only when API 1 could NOT determine user_type — i.e., the 0-row case — or when the Redis cache has expired between PIN attempts.

### Endpoint

`GET /ivr/identify-caller` — **GET, not POST.** Exotel's Passthru applet [docs](https://support.exotel.com/support/solutions/articles/48283) state: *"It makes a GET request to the URL with the call details as URL-encoded HTTP query parameters."* POST is not supported.

**Internal-only?** No — this endpoint is exposed publicly to receive Exotel's Passthru call. Signed-payload auth (HMAC) applies if Exotel supports it (verify with Exotel — open TBD).

**Exotel-sent query parameters** (verbatim from Passthru docs):

| Parameter | Notes |
|---|---|
| `CallSid` | Use as Redis cache key for `ivr:user_type:{CallSid}`. |
| `From` | The caller's number. **Primary input for identity resolution.** |
| `To`, `CallFrom`, `CallTo` | Standard. |
| `Direction`, `CallStatus`, `DialCallStatus` | Standard. |
| `digits` | **Present only on the second invocation** (after PIN-failure). Not used for identification. |
| (plus standard call metadata: `Created`, `StartTime`, `EndTime`, etc.) | |

### Response — for Switch Case branching

Switch Case applet's [docs](https://support.exotel.com/support/solutions/articles/3000052018) specify the exact mechanism:

- **Status code:** `200`
- **Content-Type:** `text/plain` (verbatim from Switch Case docs)
- **Body:** `{"select": "<branch_name>"}`

Switch Case in App Bazaar must be configured with **three case names matching exactly** (lowercase, exact string match):
- `customer`
- `csp`
- `unknown`

**Response body shape:**
```http
HTTP/1.1 200 OK
Content-Type: text/plain

{"select": "customer"}
```

(or `{"select": "csp"}` or `{"select": "unknown"}`)

### Backend behaviour

- On first invocation: match `From` against `customers.registered_mobile`, `csp_users.registered_mobile`, and `sim_inventory.mobile` (active rows only). Set `user_type` to `customer`, `csp`, or `unknown` accordingly.
- Cache the result against `CallSid` (~10 min TTL) so the second invocation (after PIN exhaustion) is a sub-ms read.
- Return the Switch Case response (see Response section above).

### Error handling

On unrecoverable backend error (DB down, etc.), return:
```http
HTTP/1.1 200 OK
Content-Type: text/plain

{"select": "unknown"}
```

**Why 200 + unknown, not 5xx:** Exotel's Passthru fallback behaviour on 5xx is not documented; the safe path is to always return 200 and route the caller to the most generic dead-end (trust line) rather than risk a flow abort.

### Multi-match enforcement

A FROM that matches both a customer AND a CSP record is forbidden by data-model invariant (HTML assumptions). The API should `LOG.error` + return `{"select": "customer"}` (customer takes precedence as the more user-visible case). Operational dashboard surfaces these for cleanup.

### Caching

Result stashed in Redis keyed on `CallSid`:
- **Key:** `ivr:user_type:{CallSid}`
- **TTL:** 10 minutes
- **Why:** the second invocation (after PIN exhaustion) reads from cache, sub-millisecond.

### Timeout & fallback

- **Backend SLO:** p95 < 300 ms (Passthru timeout not documented by Exotel; treat as 5s conservatively).
- **Fallback URL:** Not documented for Passthru. Verify with Exotel before launch.

---

## Exotel data-flow rules (verified against Exotel docs)

Before reading the API contracts below, every engineer should internalise these rules. They come directly from Exotel's applet docs (linked) and are non-negotiable — they constrain what our backend can and can't do.

### Rule 1 — Connect, Passthru, and Gather applets all use HTTP **GET**

Per [Connect docs](https://support.exotel.com/support/solutions/articles/3000096873) and [Passthru docs](https://support.exotel.com/support/solutions/articles/48283), Exotel sends call details as **URL-encoded query parameters on a GET request**. POST is not supported on the Exotel-facing surface. All three of our APIs accept GET.

### Rule 2 — `digits` from Gather is **wrapped in literal double-quotes**

Per [Gather docs](https://support.exotel.com/support/solutions/articles/3000084635): *"This parameter comes with a double quote (") before and after the number. You'll have to trim() this parameter for double quotes (") to get the actual digits."*

**Every backend handler that consumes `digits` MUST `strip('"')` first.** Affected: API 3, the second invocation of API 2.

### Rule 3 — Connect responses cannot redirect the flow

The Connect applet's response shapes the dial (`destination`, `outgoing_phone_number`, `record`, etc.). It **cannot** include an `action: "playback"` / `action: "gather"` directive that re-routes the flow to a different applet. The next applet is chosen by App Bazaar transition wiring on the three Connect outcomes.

Branching between "bridge" / "PIN gather" / "dead-end" is achieved via:
1. **Empty destination response** → triggers the `"We didn't dial anyone"` transition → flow advances to a Passthru Sync → Switch Case.
2. **Switch Case** reads the Passthru Sync's `{"select": "..."}` body and branches by exact string match.

### Rule 4 — Connect's three documented outcomes (App Bazaar transition labels)

| Exotel doc label | Our shorthand | Trigger |
|---|---|---|
| `"After the call conversation ends"` | **Connected** | Dialed AND conversation occurred |
| `"If nobody answers"` | **DNP** (Did Not Pick) | Dialed but no conversation (ring-no-answer / busy / declined) |
| `"We didn't dial anyone"` | **Did not Dial** | Backend returned empty destination OR timed out OR non-200 OR invalid response |

**App Bazaar transition wiring** uses these three Exotel labels — engineers configuring App Bazaar should know both the labels and our shorthand.

### Rule 5 — Switch Case branches on `{"select": "<value>"}` body, not status code

Per [Switch Case docs](https://support.exotel.com/support/solutions/articles/3000052018): the upstream Passthru Sync returns a body of `Content-Type: text/plain` containing `{"select": "<branch_name>"}`. Switch Case reads the `select` field and exact-string-matches it against configured case names.

**Status codes are NOT the branching signal.** API 2 must return **200 always** with the discriminator in the body.

Our Switch Case applet config in App Bazaar requires three exact branch names (lowercase): **`customer`**, **`csp`**, **`unknown`**.

### Rule 6 — `fetch_after_attempt: false` on all Connect responses

[Connect docs](https://support.exotel.com/support/solutions/articles/3000096873) describe `fetch_after_attempt` as a response field. When `true`, Exotel re-fetches the same Dynamic URL on each unsuccessful dial attempt (DNP / busy / failed). We do NOT want this — DNP is a legitimate end-state captured by the Passthru-Async-on-DNP hop in our flow. **Set explicitly to `false`** on every Connect response (API 1 and API 3).

### Rule 7 — `outgoing_phone_number` in response overrides App Bazaar Caller ID

The Connect applet response field `outgoing_phone_number` overrides the configured Caller ID per call. Our backend always sets this to the `To` value Exotel sent us (the same masked DID the caller dialled). Both mechanisms exist (App Bazaar default + response override); we use the response override exclusively.

### Rule 8 — Greeting audio file specs

Per [Greeting docs](https://support.exotel.com/support/solutions/articles/3000100184):
- Formats: `.wav` or `.mp3`
- Max size: `< 2 MB`
- Bit resolution: `8-bit`
- Sampling rate: `8000 Hz`
- Channel: Mono

Note: Connect's `start_call_playback.audio_url` field has DIFFERENT specs (16-bit, 128 kbps, mono WAV). Our flow uses Greeting applets for dead-end audio (not `start_call_playback`), so the 8-bit-mono-8kHz spec applies. **Audio file owner: Solutions team.**

### Rule 9 — Standard call parameters present on every Exotel webhook

Every Exotel webhook to our APIs carries these query parameters (verbatim casing):
`CallSid`, `From`, `To`, `CallFrom`, `CallTo`, `Direction`, `Created`, `StartTime`, `EndTime`, `CurrentTime`, `CallType`, `flow_id`, `DialCallDuration`, `DialWhomNumber`

Conditional fields: `DialCallStatus`, `digits`, `CustomField`, `RecordingUrl`, `CallStatus`.

### Rule 10 — No authentication header from Exotel out of the box

Per the five Exotel applet docs, **no auth header is documented** beyond `Exotel-Version: 1.0`. Any HMAC / signed-payload / shared-secret scheme is on the engineering team to design and confirm with Exotel support. **Open TBD.** Until then, treat the Exotel-facing endpoints as IP-allowlist-protected (Exotel publishes their egress IP range).

---

## Backend endpoint contracts

All Exotel-facing endpoints are exposed by `ivr-routing-service`. **Auth:** see Rule 10 above — IP allowlist for v1; HMAC signed-payload pending Exotel confirmation.

### API 1 — `GET /ivr/resolve-caller` (called by initial Connect applet)

Called by the **first Connect applet** in the App Bazaar flow on Dynamic URL mode. Per Exotel's [Connect Dynamic URL docs](https://support.exotel.com/support/solutions/articles/3000096873), the applet sends a GET with standard call parameters and expects a JSON response shaping the dial.

**Exotel-sent query parameters** (verbatim from Exotel docs, casing-sensitive):

| Parameter | Meaning |
|---|---|
| `CallSid` | Unique call ID assigned by Exotel. Use as cache key + correlation ID for all logs. |
| `From` | The caller's phone number, E.164 with `+`. **This is what we look up against Table 1 / Table 2 / sim_inventory.** |
| `To` | The masked DID the caller dialled (one bidirectional number in our design). |
| `CallFrom`, `CallTo` | Same as From / To for inbound calls. |
| `Direction` | `incoming` for our flow. |
| `flow_id`, `Created`, `StartTime`, `EndTime`, `CurrentTime`, `CallType`, `DialCallDuration`, `DialWhomNumber` | Standard call metadata. |

**Exotel header:** `Exotel-Version: 1.0`. No auth header from Exotel out of the box — if HMAC signing is added, that's our scheme (open TBD — confirm Exotel HMAC support before launch).

**Backend logic:**
1. Log `dial_received` (CallSid, From, To).
2. **Table 1 lookup** by `From`. If active row found → return bridge response with destination = Table 1's `to`. Done.
3. **Table 2 by-FROM lookup** (the JOIN-at-call-time SQL). Branch on row count:
   - **1 row** → cache `user_type` + `csp_id` (if csp) against `CallSid`. Return bridge response with destination = `rows[0].other_party_mobile`. (Path 2)
   - **≥ 2 rows** → cache `user_type` + `csp_id` against `CallSid`. Return **empty destination**. (Path 3 — flow proceeds to Passthru Sync → Switch Case → Gather)
   - **0 rows** → call `user_identification(From)`, cache the result, return **empty destination**. (Switch Case on the next applet decides the dead-end branch or Gather)

**Response — bridge case** (Table 1 hit OR Table 2 by-FROM = 1):
```json
{
  "destination": { "numbers": ["+919812345678"] },
  "outgoing_phone_number": "+91<masked_did>",
  "record": true,
  "recording_channels": "dual",
  "max_ringing_duration": 30,
  "fetch_after_attempt": false
}
```

**Response — no bridge** (Table 2 by-FROM count ≥ 2 OR count = 0):
```json
{ "destination": { "numbers": [] } }
```
Empty `numbers` array triggers Exotel's `"We didn't dial anyone"` transition. The App Bazaar flow routes this to the **Passthru Sync (API 2)**, which returns the user_type for Switch Case to branch on.

**Status code:** Always **200**. Non-200 makes Exotel fall to the Fallback URL (a static "service unavailable" greeting) — we want to keep the flow on the happy path even on backend errors, so return 200 with empty destination on internal failures.

**Critical Exotel notes:**
- **No `action:` directive exists.** Exotel's Connect applet response schema does NOT include an `action` field. There is no documented way for the response to redirect the flow to a Playback or Gather applet. The next applet is chosen by App Bazaar transition wiring on the three Connect outcomes (`After the call conversation ends` / `If nobody answers` / `We didn't dial anyone`). All branching between bridge / PIN gather / dead-end happens via the **Passthru Sync → Switch Case** pattern downstream.
- **`fetch_after_attempt: false`** — set explicitly. If `true`, Exotel re-fetches the URL on each unsuccessful dial attempt, which would cause double-billing and confusing telemetry.
- **`outgoing_phone_number`** overrides the App Bazaar-configured Caller ID per call. Both mechanisms work; the response field is used dynamically per call so we always know what masked DID was used.

**Timeout:** 5s (Exotel). Backend SLO: p95 < 200 ms.
**Fallback URL:** Configure as a static greeting in App Bazaar — fired on backend timeout / non-200 / invalid response.
**Idempotency:** Safe — pure read. Same input always produces same output for the lifetime of Table 1 / Table 2 state.

### API 3 — `GET /ivr/resolve-pin` (called by PIN-validating Connect applet)

Called by both PIN-validating Connect applets (attempt 1 and attempt 2) in the App Bazaar flow. Both use the same endpoint — the flow structure enforces the 2-attempt cap.

**Exotel-sent query parameters** — standard set (same as API 1) PLUS:

| Parameter | Notes |
|---|---|
| `digits` | The 5 digits the caller entered on the upstream Gather applet. **⚠ CRITICAL: this value is wrapped in literal double-quotes by Exotel.** Per Gather docs: *"This parameter comes with a double quote (") before and after the number. You'll have to trim() this parameter for double quotes (") to get the actual digits."* Backend MUST strip `"` before validating. |

**Backend behaviour:**

1. **Strip the literal double-quotes** Exotel wraps around `digits` (Rule 2). Validate format (5 digits, numeric); reject otherwise.
2. Read cached `user_type` + `csp_id` from API 1's stash against `CallSid`.
3. Look up the active Table 2 row matching the PIN, applying scoping per `user_type` (see "PIN scoping rules" table below).
4. If exactly 1 row matches → bridge to `other_party_mobile`. Otherwise → empty destination (Exotel routes to retry or dead-end per flow position).

**Response — bridge case** (PIN matched, scoping passed):
```json
{
  "destination": { "numbers": ["+919812345678"] },
  "outgoing_phone_number": "+91<masked_did>",
  "record": true,
  "recording_channels": "dual",
  "max_ringing_duration": 30,
  "fetch_after_attempt": false
}
```

**Response — no bridge** (PIN invalid, scoping rejected, or format wrong):
```json
{ "destination": { "numbers": [] } }
```
Empty `numbers` list triggers Exotel's `"We didn't dial anyone"` transition. App Bazaar routes this to attempt 2's Gather or, on second failure, to the final Passthru Sync → Switch Case → dead-end Greeting.

**`fetch_after_attempt`:** MUST be `false` (or omitted). With `true`, Exotel would re-fetch this URL on DNP, which we don't want — DNP is a legitimate end-state captured by the Passthru-Async-on-DNP hop.

**Idempotency:** Stateless. Same `(From, CallSid, digits)` always produces the same response. No attempt counter in backend; flow structure caps at 2 attempts.

**PIN scoping rules (per G6):**

| Scenario | Scoping query |
|---|---|
| **Unknown FROM** (no identity match at API 1; UC 13 colleague case) | No scoping. `WHERE pin = :pin AND expires_at IS NULL`. Single match → bridge. |
| **Known CSP user** (FROM matched at API 1; `csp_id` in Redis) | Scope to that CSP's tickets: `WHERE pin = :pin AND side = 'csp' AND csp_id = :csp_id AND expires_at IS NULL`. Prevents cross-CSP PIN guessing. |
| **Known customer** (Path 3 — customer entered PIN after Table 2 returned ≥2 rows for their mobile) | Scope to that customer's tickets: `WHERE pin = :pin AND side = 'customer' AND customer_mobile = :From AND expires_at IS NULL`. |

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

**Logic (analytics-grade logging only — missed-call alerts fire from Passthru-Async-on-DNP, not from here):**
1. Log `disposition_webhook_received` to `call_audit_logs`.
2. Capture full disposition payload (duration, recording URL, bridge target, end status) for analytics reporting.

**Why this endpoint does NOT fire missed-call alerts:**
- DNP events are already captured by the Passthru-Async-on-DNP applet inside the App Bazaar flow (fires within seconds, not after end-of-call).
- Disposition webhook may arrive several seconds after Passthru — duplicate firing would either spam recipients or require deduplication keyed on `CallSid`.
- Single source of truth: missed-call alerts fire **only** from Passthru-Async-on-DNP.

### Logging endpoints (Passthru targets) — minimal v1 set

| Endpoint | Method | What it logs |
|---|---|---|
| `/log/dial_received` | GET | Exotel registered the call on the masked number. |
| `/log/pin_prompted` | GET | Gather applet fired. |
| `/log/pin_entered` | GET | Digits collected (length + attempt #, not the digits themselves). |
| `/log/pin_lockout` | GET | PIN attempts exhausted (1 original + 1 retry both failed). |
| `/log/deadend_played` | GET | Playback completed. |

All these are fire-and-forget; backend returns 200 quickly and writes to the event stream asynchronously.

---

## Exotel applet wiring (App Bazaar canonical flow)

Built on three Exotel applet primitives:
1. **Connect** with Dynamic URL — dials based on backend response. Three native outcomes: **Connected** / **DNP** (Did Not Pick) / **Did not Dial** (empty destination).
2. **Passthru** — fires an HTTP call mid-flow. **Async** = fire-and-forget (logging, DB writes, CleverTap fires). **Sync** = blocking call that returns 200/404 driving the next applet via Switch Case.
3. **Gather** — captures DTMF digits. Two outcomes per [Exotel's Gather applet docs](https://support.exotel.com/support/solutions/articles/3000084635-working-with-gather-applet): "Caller entered one or more digits" → next applet (Passthru → Connect for PIN check); "Caller didn't enter anything" → next applet (Greeting → Hangup).

### Canonical flow (matches PNG: `exotel-app-bazaar-flow.png`)

```
[Caller dials masked number]
        │
        ▼
┌──────────────────────────────────────────────────┐
│ Connect — API 1                                  │
│   GET /ivr/resolve-caller                        │
│                                                  │
│ Backend (single combined lookup):                │
│   • Table 1 by FROM                              │
│   • Table 2 by-FROM (JOIN customers / csp_users  │
│     / sim_inventory)                             │
│   • If either returns 1 → destination            │
│   • Else → empty destination (Did not Dial)      │
└──────────────────────────────────────────────────┘
   │ Connected            │ DNP                    │ Did not Dial
   ▼                      ▼                        ▼
[Passthru Async]      [Passthru Async]      [Passthru Sync — API 2]
   /log/connected        /log/dnp +              GET /ivr/identify-caller
   → save to DB         missed-call alert            (200 → Switch Case,
                        → save to DB                  404 → fall to Gather)
                                                ▼
                                       ┌─ Customer ─→ Greeting (call 88803 22222) → Hangup
                                       ├─ CSP       ─→ Greeting (call 78368 11111) → Hangup
                                       └─ Unknown   ─→ Gather (PIN attempt 1)
                                                       │
                                                       ▼ entered → [Connect — API 3]
                                                       │           GET /ivr/resolve-pin
                                                       │           • Table 2 by PIN
                                                       │           • Scoped if known CSP
                                                       │
                                                       │ Connected → Passthru Async → DB
                                                       │ DNP       → Passthru Async + missed-call → DB
                                                       │ Did not Dial → Gather (PIN attempt 2)
                                                       │                 │
                                                       │                 ▼ entered → Connect — API 3 again
                                                       │                              │
                                                       │                              │ Connected → Passthru Async → DB
                                                       │                              │ DNP       → Passthru Async + missed-call → DB
                                                       │                              │ Did not Dial → Passthru Sync (API 2 again)
                                                       │                              │                ▼
                                                       │                              │            Switch Case
                                                       │                              │              ├─ Customer → Greeting (Open app or call 88803 22222) → Hangup
                                                       │                              │              ├─ CSP      → Greeting (Open app or call 78368 11111) → Hangup
                                                       │                              │              └─ Unknown  → Greeting (call 78368 11111) → Hangup
                                                       │                 (no entry → Hangup)
                                                       (no entry → Greeting + Hangup)
```

### The three backend APIs (only three needed)

| API | Method | Endpoint | Called by | Returns |
|---|---|---|---|---|
| **API 1** | GET | `/ivr/resolve-caller` | Initial Connect applet | Destination if Table 1 hits OR Table 2 by-FROM returns exactly 1 row; empty otherwise. Stashes `user_type` + `csp_id` against `CallSid` in Redis for downstream applets. |
| **API 2** | POST | `/internal/user-identification` | Passthru Sync on "Did not Dial" + on PIN-exhausted dead-end | `{user_type, user_id}`. 200 on customer / csp / unknown match (Switch Case routes on `user_type`); 404 only on a hard backend error (then App Bazaar falls through to Gather as a graceful fallback). |
| **API 3** | GET | `/ivr/resolve-pin` | Each PIN-validation Connect applet | Destination if PIN matches an active Table 2 row (and CSP scoping passes when applicable); empty otherwise. |

### Connect applet config (all 3 Connect instances)

| App Bazaar field | Value |
|---|---|
| Mode | Dynamic URL |
| Primary URL | Backend endpoint (API 1 or API 3) |
| Fallback URL | Static greeting MP3 ("service unavailable, please try again later") |
| Caller ID | The single bidirectional masked DID (overridden per-call by `outgoing_phone_number` in response — Rule 7) |
| Timeout | 5s — Exotel default. Backend target p95 < 200 ms. |

**`fetch_after_attempt`** is a response-field, NOT an App Bazaar config field — backend sets it to `false` (Rule 6).

**Three transition outcomes** to wire in App Bazaar (Rule 4):
- `"After the call conversation ends"` → Passthru Async (logs `bridge_connected`)
- `"If nobody answers"` → Passthru Async (logs `bridge_dnp` + fires CleverTap missed-call)
- `"We didn't dial anyone"` → next applet per flow (Passthru Sync after initial Connect; Gather attempt 2 after first PIN Connect; Passthru Sync after second PIN Connect)

### Gather applet config (per Exotel docs + the App Bazaar screenshots)

| App Bazaar UI label | Exotel API param | Value |
|---|---|---|
| Configure params via | — | Flow builder (NOT dynamic URL) |
| Gather prompt | `gather_prompt` | Static Hindi audio: *"Please enter your 5-digit PIN"* |
| Finish Key | `finish_on_key` | `#` |
| Maximum Number of Digits | `max_input_digits` | `5` |
| Input timeout | `input_timeout` | `5` seconds (Exotel default) |
| Repeat the menu | `repeat_menu` | `2` times (default is 0 — we override) |
| Repeat prompt | `repeat_gather_prompt` | Hindi: *"We did not receive any valid response. Please reshare the PIN"* |
| When caller entered ≥1 digit | (transition) | → **Passthru Async** (logs `pin_entered`) → **Connect** (API 3) |
| When caller didn't enter anything | (transition) | → **Greeting** (`pin-no-entry.mp3`) → hangup |

**Important nuance:** Gather does NOT validate the PIN. It only collects digits. **PIN validation happens at the next Connect (API 3)** which queries Table 2. If invalid, Connect returns empty destination → "We didn't dial anyone" → next Gather (attempt 2) or final dead-end Switch Case.

**`digits` parameter is quote-wrapped** (Rule 2). API 3 backend MUST `strip('"')`.

**Important nuance on Gather:** Gather does NOT validate the PIN. It only collects digits. **PIN validation happens at the next Connect (API 3)** which checks Table 2. If invalid, Connect's "Did not Dial" branch fires, routing to the next Gather (attempt 2) or to the final dead-end Switch Case.

### Greeting applet config

Static audio files (one per dead-end variant — Hindi):

| Greeting | Audio content | When played |
|---|---|---|
| `customer-no-active-ticket.mp3` | "You do not have any active ticket. To reach our customer care, please call 88803 22222." | After first Passthru Sync, Switch Case = Customer |
| `csp-no-active-ticket.mp3` | "You do not have any active ticket. To reach Wiom partner support, please call 78368 11111." | After first Passthru Sync, Switch Case = CSP |
| `pin-no-entry.mp3` | "We did not receive any input. Goodbye." | When Gather → "no entry" path |
| `customer-pin-exhausted.mp3` | "Please open the Wiom app or call 88803 22222." | After PIN attempts exhausted, Switch Case = Customer |
| `csp-pin-exhausted.mp3` | "Please open the Wiom partner app or call 78368 11111." | After PIN attempts exhausted, Switch Case = CSP |
| `unknown-pin-exhausted.mp3` | "Please call 78368 11111 for assistance." | After PIN attempts exhausted, Switch Case = Unknown |

All audio files hosted on a CDN URL. The **exact wording is owned by the Solutions team** (see Open TBDs).

### Passthru Async config (logging endpoints)

Async = backend response is ignored; flow proceeds immediately. Used for:

| Passthru point | URL | What gets logged |
|---|---|---|
| Connected (API 1) | `POST /log/bridge_connected` | Successful bridge, CallSid, FROM, TO, ticket_id (if known) |
| DNP (API 1) | `POST /log/bridge_dnp_initial` | Bridge attempted, recipient didn't pick. **Also fires CleverTap `missed_call_*` event** with direction inferred from cached `user_type` |
| Connected (API 3, attempt 1) | `POST /log/bridge_connected_pin` | Successful bridge after PIN entry |
| DNP (API 3, attempt 1) | `POST /log/bridge_dnp_pin` | Same as above; CleverTap fires |
| Connected (API 3, attempt 2) | `POST /log/bridge_connected_pin_retry` | Successful bridge after retry |
| DNP (API 3, attempt 2) | `POST /log/bridge_dnp_pin_retry` | Same; CleverTap fires |

Each endpoint writes one row to `call_audit_logs` (the new audit table) AND fires the missed-call CleverTap event on DNP. **DB save and CleverTap fire are atomic** (transactional outbox pattern recommended).

### Passthru Sync config (decision endpoints)

Sync = backend response determines next applet via Switch Case. Used twice in the flow:

| Passthru Sync point | URL | Switch Case branches |
|---|---|---|
| After initial Connect "Did not Dial" | `GET /ivr/identify-caller` | Customer / CSP / Unknown (Unknown routes to Gather) |
| After both PIN attempts fail | `GET /ivr/identify-caller` | Customer / CSP / Unknown (all three route to Greeting → Hangup) |

**Implementation note:** The same `/internal/user-identification` endpoint serves both calls. Result is cached against `CallSid` in Redis on first call; second call is a Redis read (sub-ms).

### Account-level disposition webhook

Exotel fires its standard disposition webhook **at end-of-call**, regardless of how the flow ended. This is captured at `POST /log/disposition` for analytics-grade logging only — **the missed-call alert is NOT fired from here** (it already fired from the Passthru-Async-on-DNP, which is faster and more reliable).

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

Customer-side lookups are unscoped (2-attempt cap + per-ticket PIN issuance is sufficient protection at the customer end).

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
| `pin_lockout` | PIN attempts exhausted (1 original + 1 retry both failed) |
| `pin_abandoned` | Caller hung up during prompt without entering anything |
| `table_2_lookup_by_pin` | Path 3 / Path 4 access pattern |
| `table_2_lookup_by_from` | Path 2 / Path 3 access pattern (primary hot-path lookup) |
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
- *Expected:* `user_identification` returns `user_type = unknown` → PIN prompt → if customer remembers PIN from their SMS, bridges; else dead-end after 2 failed attempts (trust-line message, since user_type was unknown).

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
| **5-digit PIN, random with uniqueness retry** | Matches OTP expectation. 100K combos × 2-attempt cap = 0.002% brute-force probability per call. |
| **PIN is immutable for the row's lifetime — no rotation, ever** | PIN is shared with both parties at ticket-open (customer via SMS, CSP via ticket card). Rotating invalidates what they hold and forces re-distribution. Rotation buys little — the PIN is already short, scoped, and 2-attempt-capped. Prefer simplicity. |
| **Reassignment rewrites mobile only, leaves PIN untouched** | Both parties keep the PINs they already have. Only the bridge target (`other_party_mobile`) changes underneath. Avoids the "which PIN is current" failure mode. |
| **PIN cooldown after ticket close (90 days)** | Once a ticket closes, its PIN value is reserved (excluded from generation) for 90 days. Protects against stale-PIN cross-pollination: a technician remembering an old PIN cannot be misrouted to a stranger's ticket that has been reissued the same PIN. 90-day window matches today's pool-vs-volume math. |
| **PIN scoping for CSPs (sim_inventory match → restricted lookup)** | Prevents a CSP from guessing or reaching a customer who isn't theirs. Also a partial backstop on the stale-PIN risk on the CSP side — even if cooldown were bypassed, the cross-CSP lookup would still fail. |
| **2-attempt cap per call (1 original + 1 retry)** | App Bazaar flow constraint — adding more retries doubles the applet count per attempt. Two attempts is enough for typos / mis-keys without dragging the flow out. Brute-force odds at 2 attempts × 100K PIN space = 0.002% per call. |
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
| Customer-side PIN lookup is unscoped (no equivalent to CSP `sim_inventory` scoping). | Accepted. 2-attempt cap + per-ticket PIN + 100K PIN space = acceptable risk. Scoping would require identifying the customer, which would re-introduce a Resolve-FROM step. |
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
| **6-digit PIN escalation (1M pool)** | Triggered when generation algorithm's average retry count exceeds threshold (e.g., > 5 collisions per generation) or when active+cooldown reservation approaches 70% of pool. At ~3× current Wiom volume, expect to need this. Migration: add new column, generate 6-digit for new rows, leave existing 5-digit rows alone (they expire naturally). |
| PIN expiry notification at ticket close | Not blocking. Add later if dead-end IVR traffic shows confused customers. |
| Auto-recognition of repeat unknown-SIM callers ("Table 4" idea) | Deferred — would add an audit step before PIN that costs UX. Revisit with response-pattern data. |
| Per-FROM rate limiting (beyond per-call 2-attempt cap) | Not needed for v1; brute-force economics are bad enough without it. |
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
| **Exotel Auth mechanism** — does Exotel support HMAC signed-payload on outbound webhooks? Header name? Signing algorithm? Until confirmed, fall back to IP allowlist (Exotel publishes their egress IP range). | Tech + Exotel |
| **Passthru applet timeout** — not documented by Exotel; assume 5s but confirm | Tech + Exotel |
| **Passthru applet retry behaviour on 5xx** — not documented | Tech + Exotel |
| **Passthru applet fallback URL** — not documented; configure a static greeting just in case | Tech + Exotel |
| **Switch Case default/fallback branch** — what happens if no case matches the `select` value? Not documented. | Tech + Exotel |
| **Disposition webhook contract** — body shape not in any of the 5 applet docs; confirm with Exotel before relying on field names like `BridgedTo` | Tech + Exotel |
| `sim_inventory` verification flow — OTP at add time vs trust-declare? Self-service or admin-only? Cap on SIMs per CSP? | Ops + Tech |
| Audio file owner — record / commission / store the 6 Greeting MP3s (Hindi, 8-bit / 8000 Hz / mono / < 2 MB per Exotel Greeting docs) | Solution team |
| Exact wording of every Greeting + Gather prompt (Hindi-first) | Solution team |
| **HTML update**: regenerate end-to-end flowchart (already done in repo); remove daily-rotation language (already done) | PM (Ashis) — done |

---

## Pre-launch verification checklist

- [ ] **Truecaller:** verify the chosen masked number (one of MN1/MN2) shows the green verified banner with the Wiom name.
- [ ] **VLT:** verify the masked number is registered with the telcos as a legitimate business caller.
- [ ] **DLT templates** approved for every outbound SMS variant.
- [ ] **WhatsApp BSP** setup confirmed for SMS + WA variants.
- [ ] **IVR voice files** recorded in Hindi (PIN entry prompt, both dead-end messages, any missed-call return tone).
- [ ] **`es-ivr-calling-service` decommission plan** — old service stopped + old cache discarded + cutover dated.
- [ ] **`sim_inventory` verification flow** decided + implemented (OTP / trust-declare / admin-only).
- [ ] **`sim_inventory` audit trail** populated for every add / remove operation in staging.
- [ ] **Skip-Gather mechanism** verified — confirm Exotel honours `action: "playback"` in `/ivr/resolve-caller` response. If unsupported, branching-Passthru fallback wired and tested.
- [ ] **Exotel signed-payload auth** verified end-to-end for all 5 backend endpoints (or IP-allowlist fallback agreed).
- [ ] **CleverTap events** `missed_call_csp_to_customer` and `missed_call_customer_to_csp` registered, with campaigns wired.
- [ ] **Disposition webhook** from Exotel terminating at the correct backend endpoint; auth verified.
- [ ] **Telemetry events** firing for all branches; dashboard ready.
- [ ] **Exotel Playback applet** verified to support dynamic audio URL (or fallback strategy locked in).
- [ ] **End-to-end test** for each of the 13 use cases passes in staging.
- [ ] **Table 2 listener** subscribed to all three ESs: `ES_INSTALL_TECHNICIAN_ASSIGNED`, `ES_RESTORE_TECHNICIAN_ASSIGNED`, `ES_NBREC_TASK_ASSIGNED` (plus NBREC `RECOVERY_TASK_ASSIGNED` candidate-creation hook).
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
