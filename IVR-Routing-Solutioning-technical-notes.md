# IVR Routing Solutioning — Technical Notes

> **Companion to:** [IVR Call Routing — Proposed Solution](https://ashish-raj-wiom.github.io/IVR-Routing-Solutioning/)
>
> The HTML spec is the reader-friendly version for leadership review and stakeholder alignment. This MD captures the technical detail — implementation specifics, telemetry, decisions, trade-offs — that would otherwise crowd that document.

---

## Table of contents

1. [Architecture summary](#architecture-summary)
2. [Tables — full schemas](#tables--full-schemas)
3. [Exotel applet wiring](#exotel-applet-wiring)
4. [Telemetry events](#telemetry-events)
5. [CleverTap event schema](#clevertap-event-schema)
6. [Comms-layer dependencies](#comms-layer-dependencies)
7. [Design decisions log](#design-decisions-log)
8. [Trade-off log](#trade-off-log)
9. [Deferred / future work](#deferred--future-work)
10. [Open TBDs](#open-tbds)
11. [Pre-launch verification checklist](#pre-launch-verification-checklist)
12. [Glossary](#glossary)

---

## Architecture summary

The system is, at its core, an **authentication system** for masked phone calls between a CSP (Connection Service Provider / field technician) and a customer assigned to one of their active tickets.

The HTML spec uses four defined terms throughout — **Recognised, Authorised, Seamless, Graceful fallback** — see the [Glossary](#glossary) for definitions.

- **Table 1 hit** (in-app CTA + within TTL) → bridge directly. Seamless.
- **Table 1 miss** → call `user_identification(FROM)`. The response carries user type (`customer` / `csp` / `unknown`) + active-ticket count + (if count = 1) the counterparty's mobile.
  - **1 active ticket** → bridge directly to that counterparty. No PIN.
  - **2+ active tickets** → IVR asks for PIN; Table 2 disambiguates.
  - **0 tickets / unknown user** → graceful-fallback IVR (branched by user type).
- **PIN failure** (3 wrong tries) → same graceful-fallback IVR. The user type returned by the original `user_identification` call decides which message plays (customer → call-centre 88803 22222; otherwise → trust-line 78368 11111).
- **Single masked number** for both directions.

PIN is therefore an *exception path* — used only when the routing is genuinely ambiguous (multi-ticket caller) or the caller can't be identified at all.

### Identity store at a glance

| Element | Purpose |
|---|---|
| **Table 1** | Active call mapping (FROM → TO), short TTL, written on `initiateCall`. Existing today. |
| **Table 2** | Per-ticket PIN registry (PIN → other_party_mobile); two PINs per ticket, one per side, daily rotation. **New.** |
| **`user_identification` API** | Called on Table 1 miss. Returns user type (`customer` / `csp` / `unknown`), active-ticket count, and the counterparty mobile if exactly one ticket. Drives the entire post-Table-1 routing — direct bridge for single-ticket, PIN for multi-ticket or unknown, dead-end IVR for zero-tickets. **New (supersedes the old `is_customer`-at-dead-end design).** |
| **`sim_inventory`** | Existing CSP-SIM capture set; used inside `user_identification` to match a CSP user's FROM, and for PIN scoping. |

---

## Tables — full schemas

### Table 1 — Active call mapping (existing today, unchanged)

| Field | Type | Notes |
|---|---|---|
| `from_list` | Array<E164> | All FROM numbers for this session. CSP-side: `sim_inventory` SIMs + registered mobile. Customer-side: registered mobile only. |
| `to` | E164 | Other party's mobile. |
| `ticket_id` | UUID | The ticket this mapping belongs to. |
| `direction` | enum (`csp_to_customer`, `customer_to_csp`) | |
| `created_at` | timestamp | |
| `ttl_expires_at` | timestamp | `min(call_connected_at + buffer, created_at + 5 min)` — today's TTL logic preserved. |

**Lookup:** by any FROM number; return active (non-expired) entry. If multiple active entries match, pick most recent.

**GC:** TTL-based; existing behaviour.

### Table 2 — PIN registry (new)

| Field | Type | Notes |
|---|---|---|
| `pin` | 5-digit string | Globally unique among active entries (PIN generation enforces). |
| `ticket_id` | UUID | Which ticket this PIN belongs to. |
| `side` | enum (`customer`, `csp`) | Which party this PIN was issued to. |
| `other_party_mobile` | E164 | The number to bridge to when this PIN is entered. |
| `csp_id` | UUID (nullable) | Used for PIN scoping on CSP-side rows. |
| `created_at` | timestamp | |
| `rotated_at` | timestamp | Updated on daily rotation. |
| `expires_at` | timestamp | Set on ticket closure. |

**Lookup contract:**

- Input: `pin` (DTMF digits from IVR), optional `caller_from`.
- If `caller_from` is in `sim_inventory`: restrict to rows where `side = 'csp'` AND `csp_id` matches the calling CSP. (PIN scoping guardrail.)
- Otherwise: unrestricted lookup across active PINs.
- Return: `other_party_mobile` if exactly one match; null if no match or scoping rejected.

**Generation:**

- 5-digit numeric. Two PINs minted per ticket on `ticket_open` (one for each side).
- Customer-side PIN: dispatched via SMS / WhatsApp at ticket open.
- CSP-side PIN: surfaced on the ticket card in the CSP App (no SMS).
- **Daily rotation:** new PIN issued, fresh SMS to customer, ticket card auto-updates for CSP. Previous PIN invalidated on rotation.
- **Uniqueness:** generator checks Table 2 for collisions across all active PINs before persisting.

**GC:** soft-delete on ticket closure (`expires_at` set); hard-delete after retention window (TBD).

### Removed: Table 3 (Cx ↔ Technician resolver)

Earlier iterations of this design had a Table 3 — `customer_mobile → technician_mobile` — used to route customer-initiated calls without a PIN. **Dropped** when the customer-side PIN was added: the PIN now performs the routing function, so a separate resolver is redundant.

### user_identification API

Called on Table 1 miss. Input: `FROM` (E164). Response:

| Field | Type | Notes |
|---|---|---|
| `user_type` | enum: `customer` \| `csp` \| `unknown` | Whether the FROM matches a customer record, a CSP user (`sim_inventory` or registered mobile), or neither. |
| `active_ticket_count` | integer | Number of active tickets the user is associated with (customer's open tickets, or the CSP user's currently-assigned tickets). |
| `other_party_mobile` | E164 (nullable) | If `active_ticket_count == 1`, the counterparty mobile — the IVR can bridge directly. Else null. |

Routing decisions driven by this response:

| Response | Action |
|---|---|
| `active_ticket_count == 1` | Bridge directly to `other_party_mobile`. No PIN. |
| `active_ticket_count >= 2` | IVR prompts for PIN → Table 2 lookup → bridge. |
| `active_ticket_count == 0` OR `user_type == 'unknown'` | Skip PIN entirely → graceful-fallback IVR, branched by `user_type`. |
| PIN failure after 3 tries | Same graceful-fallback IVR, using the original `user_type` from the earlier `user_identification` call. |

**Latency budget:** < 200 ms p95 within Exotel's 5 s Primary URL window.

**Supersedes:** the old `is_customer` boolean check. `user_identification` is richer — it enables the no-PIN bypass for single-ticket cases and still provides the user-type information needed for dead-end branching.

---

## Exotel applet wiring

Built on Exotel's [Connect Applet with Dynamic URL](https://support.exotel.com/support/solutions/articles/3000096873-programmable-connect-working-with-connect-applet-dynamic-url-) pattern.

```
[Caller dials masked number]
        │
        ▼
┌──────────────────────────────────────────┐
│ Connect (Dynamic URL #1) — Table 1 check │
│ Backend receives FROM                    │
│   ├─ Table 1 hit?                        │
│   │    YES → return TO; bridge           │
│   │    NO  → branch to Gather            │
└──────────────────────────────────────────┘
        │ (if branched)
        ▼
┌──────────────────────────────────────────┐
│ Gather / IVR                             │
│ Play: "Enter your 5-digit PIN"           │
│ Collect DTMF (5 digits, 3 retries)       │
└──────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────┐
│ Connect (Dynamic URL #1.5) — Identify    │
│ Backend receives FROM, calls             │
│   user_identification(FROM)              │
│   ├─ active_ticket_count == 1:           │
│   │    return other_party; bridge        │
│   ├─ active_ticket_count >= 2:           │
│   │    branch to Gather (PIN flow)       │
│   └─ 0 / unknown:                        │
│        play dead-end IVR (by user_type)  │
└──────────────────────────────────────────┘
        │ (if PIN required)
        ▼
┌──────────────────────────────────────────┐
│ Connect (Dynamic URL #2) — Table 2 check │
│ Backend receives FROM + digits           │
│   ├─ Table 2 lookup (scoped if CSP)      │
│   │    HIT  → return other_party; bridge │
│   │    MISS / 3 fails → dead-end IVR     │
│   │      ├─ user_type == customer:       │
│   │      │     play "Call 88803 22222"   │
│   │      └─ user_type csp / unknown:     │
│   │            play "Call 78368 11111"   │
└──────────────────────────────────────────┘
        │ (if bridge initiated)
        ▼
┌──────────────────────────────────────────┐
│ Exotel disposition webhook               │
│ Outcome: answered / no_answer / busy /   │
│          failed                          │
│   ├─ answered → Connected ✓              │
│   └─ not_answered → fire CleverTap event │
│                     for missed-call alert│
└──────────────────────────────────────────┘
```

**Primary URL timeout:** 5 seconds. Backend lookup target: < 200 ms p95.

**Fallback URL:** configured for Exotel's 5xx / timeout / invalid-JSON cases — returns a graceful "service unavailable" voice message.

**Retry:** `fetch_after_attempt: true` so Exotel re-queries on failed dial attempts. (Exotel stops if two consecutive returns are identical.)

---

## Telemetry events

Every IVR branch emits a typed event for analytics and abuse monitoring. All events keyed by `call_id`, `from`, `masked_number`, `timestamp`.

| Event | When |
|---|---|
| `call_initiated_via_cta` | CSP/Customer taps in-app CTA; `initiateCall` writes to Table 1 |
| `dial_received` | Exotel webhook fires on Primary URL |
| `mapping_hit` | Table 1 lookup returns a destination |
| `pin_prompted` | Gather applet triggered |
| `pin_entered` | DTMF digits received (whether valid or not) |
| `pin_success` | Table 2 returns a destination |
| `pin_fail` | Table 2 returns no match |
| `pin_lockout` | Three wrong PINs in a single call |
| `pin_abandoned` | Caller hangs up during PIN prompt without entering anything |
| `user_identification_called` | Backend invoked `user_identification(FROM)` after a Table 1 miss; payload includes the returned user_type and active_ticket_count |
| `direct_bridge_single_ticket` | `user_identification` returned `active_ticket_count == 1` — bridged without PIN (Path 2) |
| `deadend_call_centre` | Dead-end IVR played for `is_customer = true` |
| `deadend_trust_line` | Dead-end IVR played for `is_customer = false` |
| `deadend_sms_sent` | Dead-end SMS fired to caller's FROM |
| `bridge_initiated` | Exotel begins the bridge leg |
| `bridge_answered` | Exotel disposition = `answered` |
| `bridge_not_answered` | Exotel disposition = `no_answer` / `busy` / `failed` |
| `clevertap_missed_call_fired` | Backend pushed `missed_call_*` event to CleverTap |
| `pin_rotated` | Daily PIN rotation fires for a ticket |
| `ticket_pin_issued` | Two PINs minted on ticket open |
| `ticket_pin_expired` | Both PINs soft-deleted on ticket closure |

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
  "call_attempt_id": "..."
}
```

Triggers a CleverTap campaign that sends SMS / WhatsApp to `customer_mobile` with a callback instruction.

### `missed_call_customer_to_csp`

Symmetric — fired when a customer-initiated bridge ends unanswered. Triggers an SMS / WA to the CSP via CSP-side campaign.

---

## Comms-layer dependencies

All outbound SMS / WhatsApp must land via:

- **DLT-registered templates** with the "Wiom" sender ID (recipients see "Wiom" instead of a generic 11444XXXX phone number).
- **WhatsApp BSP setup** with approved templates for any WA delivery.
- **Hindi as the default** language. Regional-language expansion based on CSP geography. Exact wording for every IVR prompt, SMS template, and notification is decided by the solutions team.

Messages that must ship before launch:

- Ticket-open SMS to customer (masked number + customer-side PIN + dial instruction).
- Daily PIN-rotation SMS to customer.
- Missed-call alert SMS (CSP-side and customer-side variants).
- Dead-end SMS to caller's FROM (call centre or trust line variant).
- IVR voice prompts (PIN entry, dead-end call-centre, dead-end trust-line).

---

## Design decisions log

| Decision | Rationale |
|---|---|
| **Single masked number** (not MN1/MN2) | Removes wrong-direction-dial failure. Today CSPs see MN1 in call log and try to dial back — drops because MN1 is one-way. |
| **PIN as the universal credential** for unrecognised callers | Routes off-CTA calls (dialer, callback, unregistered SIM, colleague forwarding) without needing per-call identity inference. |
| **`user_identification` at Table-1 miss (replaces `is_customer` at dead-end only)** | Earlier design called `is_customer` only at the dead-end. New design calls a richer `user_identification` earlier — recognises the caller AND counts active tickets. **One active ticket → bridge directly, no PIN.** Big friction reduction for customer callbacks (UC 07) and CSP technicians with a single live job (UC 05, UC 06 typical case). PIN drops to an exception path used only for multi-ticket disambiguation or genuinely unknown callers. |
| **Two PINs per ticket** (customer-side + CSP-side) | Symmetric authorisation; either party can authenticate when off-CTA. PIN encodes ticket + direction. |
| **Customer-side PIN via SMS; CSP-side via app ticket card only** | Customers are not app-engaged; SMS reaches them where they are. CSPs already see ticket details in app — no SMS noise. |
| **5-digit PIN** | Matches user expectation for IVR codes (OTP-like). 100K combos × 3-retry cap = 0.003% brute-force probability per call. |
| **Daily PIN rotation** | Limits exposure on multi-day jobs; a leaked PIN expires within 24 hours. |
| **PIN scoping for CSPs** (sim_inventory match → restricted lookup) | Prevents a CSP from guessing or reaching a customer who isn't theirs. |
| **3-retry cap** per call | Matches universal expectation (ATM, banking). |
| **Dead-end ALSO sends SMS, not just voice** | Voice is ephemeral on a Bharat-grade phone. SMS lets the caller act later. |
| **Truecaller whitelisting reuses one of MN1/MN2** | No fresh whitelisting work; verified status carries forward. |
| **`is_customer` is a binary lookup, not Table 3** | Table 3 (Cx → Tech) was needed when customer routing was via FROM. With the customer-side PIN now authorising routing, we don't need a customer-mobile→tech map. Table 3 removed. |
| **Calling eligibility scoped to Install / Restore / Pickup tickets** | No calling on closed or pre-booking tickets. Aligns the routing surface with operational reality. |
| **Missed-call notifications via CleverTap campaigns** | Reuses Wiom's existing campaign infrastructure. |
| **Hindi as default IVR language** | Voice-first Bharat user. English IVR is a hard blocker. |

---

## Trade-off log

| Trade-off | Resolution |
|---|---|
| Removing `is_customer` from main routing means customer callback from dialer now requires a PIN (it didn't before). | Accepted. Customer has the PIN via SMS from the same message that carried the masked number. The friction is one IVR step. |
| PIN possession = authorisation, regardless of who holds it (UC04 colleague forwarding). | Accepted. Usability ↔ security trade-off — the colleague case is a real CSP workflow and we don't want to block it. |
| Customer-side PIN lookup is unscoped (no equivalent to the CSP sim_inventory scoping). | Accepted. 3-retry cap + per-ticket PIN + 100K PIN space = acceptable risk. Scoping would require identifying the customer, which would re-introduce a Resolve-FROM step. |
| Daily PIN rotation adds SMS volume. | Accepted. SMS is cheap relative to a dropped call (NPS hit, retry truck-roll). |
| Dead-end can't distinguish "customer with closed ticket" from "stranger" without `is_customer`. | Resolved — `is_customer` is kept for exactly this purpose. |
| Multi-ticket customer dialing from registered number with no live Table 1 entry: routing would be ambiguous. | PIN disambiguates; we don't auto-route to most recent. |
| `is_customer` API call cost on every dead-end. | Negligible; dead-ends are rare relative to total call volume. |

---

## Deferred / future work

| Item | Why deferred |
|---|---|
| PIN reminder SMS on prompt abandonment | Can't determine which PIN to resend mid-call when a CSP has multiple tickets, or when the caller is unrecognised. Decision: don't try. |
| PIN expiry notification at ticket close | Not blocking. Can be added later if dead-end IVR traffic shows confused customers. |
| Auto-recognition of repeat unknown-SIM callers (the dropped "Table 4" idea) | Deferred to a future version. Would add an audit step before PIN that costs UX. Revisit once we have response-pattern data. |
| Per-FROM rate limiting (above the per-call 3-retry cap) | Not needed for v1. Brute-force economics are bad enough without it. Add later if abuse signals emerge. |
| Regional-language IVR expansion (post-Hindi) | Hindi first. Add per CSP geography in a follow-up. |
| WhatsApp BSP-fallback for SMS-undeliverable customers | Operational concern, handled by comms platform, not this spec. |
| IVR option to actively transfer caller to support (e.g., "press 1 to connect") | Today's dead-end gives a number to call but doesn't auto-connect. Could add later. |

---

## Open TBDs

| Item | Owner |
|---|---|
| PIN format (last 5 of ticket ID vs random 5-digit) | Solution team |
| Exact wording of every IVR prompt and SMS / WA template (Hindi-first) | Solution team |
| Final list of regional languages (post-Hindi) | Solution team |
| Daily PIN rotation time of day (avoid mid-rotation cutover) | Tech |
| TTL on Table 1 — confirm `min(call connected, 5 min)` is sufficient given typical field retry patterns | Tech |
| Missed-call CleverTap event payload schema — finalise fields before backend implementation | Tech + Solution team |
| DLT template registration for all SMS variants | Comms / Ops |
| WhatsApp BSP template approvals | Comms |
| Retention window for closed-ticket PIN rows (hard-delete) | Tech / Compliance |

---

## Pre-launch verification checklist

- [ ] **Truecaller:** verify the chosen masked number (one of MN1/MN2) shows the green verified banner with the Wiom name. *Operational check, not an assumption.*
- [ ] **DLT templates** approved for every outbound SMS variant (ticket-open, PIN rotation, missed-call alerts, dead-end SMS).
- [ ] **WhatsApp BSP** setup confirmed for SMS + WA variants.
- [ ] **IVR voice files** recorded in Hindi (PIN entry prompt, both dead-end messages, any missed-call return tone).
- [ ] **`is_customer` API** performance: p95 < 200 ms (called at dead-end junction within Exotel's 5 s budget).
- [ ] **Table 2 PIN-generation** collision check enforced in code (no two active PINs identical at any moment).
- [ ] **CleverTap events** `missed_call_csp_to_customer` and `missed_call_customer_to_csp` registered, with campaigns wired.
- [ ] **Disposition webhook** from Exotel terminating at the correct backend endpoint.
- [ ] **Telemetry events** firing for all branches above; dashboard ready.
- [ ] **Load test:** PIN lookups under expected peak (target QPS TBD).

---

## Glossary

| Term | Meaning |
|---|---|
| **Recognised** | The caller's identity can be resolved — their number is in an active mapping (Table 1), or they hold a valid PIN (Table 2). |
| **Authorised** | The connection is legitimate — the PIN entered (or the FROM matched) belongs to an active ticket for the party being reached. |
| **Seamless** | The call connects without the user opening an app, navigating UI, or understanding masked numbers. Zero friction in-app; survivable friction in fallback. |
| **Graceful fallback** | For unrecognised or unauthorised callers — the user understands why the call did not connect and has a clear, achievable next step. Not a dead-end. |
| **Masked number** | A virtual phone number provisioned by Exotel that routes via a dynamic lookup on our backend; replaces direct CSP ↔ customer number exchange. |
| **MN1 / MN2** | Today's two-masked-number scheme — one for each direction (Customer→CSP, CSP→Customer). To be retired. |
| **CSP** | Connection Service Provider — Wiom's field partner; the technician installing / fixing / picking up. |
| **PIN** | 5-digit numeric credential, issued per ticket per side, used as fallback authorisation when FROM isn't recognised. |
| **Table 1** | Active call mapping (FROM → TO), short-lived; a hit here means the caller is recognised and the bridge is seamless. |
| **Table 2** | PIN registry (PIN → other_party_mobile), per-ticket, per-side. |
| **`user_identification` API** | Called on Table 1 miss. Returns user_type + active_ticket_count + (if count = 1) the counterparty mobile. Replaces the earlier `is_customer` boolean. |
| **`sim_inventory`** | Existing CSP-SIM capture set; used for PIN scoping. |
| **Resolve-FROM** | Deprecated. Was the multi-classification API; replaced by Table 1 lookup + `is_customer` at dead-end. |
| **Dead-end IVR** | Terminal voice message when authorisation fails; routes to call centre (`is_customer = true`) or trust line (`is_customer = false`). |
| **Calling eligibility** | Calls only enabled on active Install / Restore / Pickup tickets. |
| **DLT** | Distributed Ledger Technology registration — India's regulatory requirement for transactional SMS. |
| **BSP** | Business Solution Provider — for WhatsApp Business API. |
