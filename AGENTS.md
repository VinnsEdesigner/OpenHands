# Repository Notes

## Cloud mode through the relay proxy (no OAuth) — investigation notes

When running the Canvas with a custom relay (`scripts/relay/cloud-proxy-relay.mjs`)
pointing at the closed/managed agent server at all-hands.dev, conversations can be
created in either frontend mode:

- **Local mode** (`kind: "local"`): talks to all-hands.dev's **runtime agent-server API**
  (`/api/conversations/...`). Events are stored on the **runtime sandbox only**
  (ephemeral). The cloud App API has no copy. Opening such a conversation in the
  cloud SaaS canvas shows the row (via orgID scoping) but **empty events** +
  "archived, read-only" once the sandbox sleeps — because cloud mode reads event
  history from the **App API** (`/api/v1/conversation/{id}/events/search`), which
  was never populated. The sandbox sleeping does NOT delete it (curl wakes it),
  so the root cause is the **read-path/store mismatch**, not sandbox death.
- **Cloud mode** (`kind: "cloud"`): talks to all-hands.dev's **App API**
  (`/api/v1/app-conversations`, `/api/v1/conversation/{id}/events/search`).
  Events persist in the App API DB and survive sandbox sleep → readable later.

### Key routing fact (`@openhands/typescript-client` CloudClient.request)
`hostOverride ? requestThroughProxy : requestDirect`. Calls WITHOUT hostOverride
(conversation creation, event history, health probe) go **direct** from the browser
to `backend.host` with `Authorization: Bearer ${backend.apiKey}`. Only runtime
live-events calls (with `hostOverride`) use the `/api/cloud-proxy` envelope.

So for cloud mode to flow through the relay, `backend.host` MUST be the relay
origin (so "direct" hits the relay), and the relay must reverse-proxy `/api/*` to
all-hands.dev injecting Bearer. In pure-cloud mode (`AGENT_SERVER_URL=""`), the
relay's `proxyToCloud` already does this for ALL `/api/*` (including `/api/v1/...`
App API paths and `/api/keys/current` health probe). `forwardToCloud` handles the
`/api/cloud-proxy` envelope path. **The relay needs no code change for this.**

### The blocker was frontend-only (now fixed)
The "Add Backend" settings modal (`AddBackendChooser`) hardcoded
`ManualConnectionColumn` with `fixedKind="local"` + `showKindSelector={false}`,
so you could not register a `kind: "cloud"` backend without OAuth. The onboarding
flow (`BackendConnectionOptions`) already allowed manual cloud registration. Fix
in `src/components/features/backends/backend-form-modal.tsx`: removed
`fixedKind="local"`/`showKindSelector={false}` from the AddBackendChooser manual
column so the Local/Cloud kind selector is visible there too.

### How to use cloud mode through the relay without OAuth
1. Run the relay in pure-cloud mode, serving the Canvas build same-origin:
   `CLOUD_API_KEY=<key> STATIC_DIR=build AGENT_SERVER_URL="" PORT=18080 node scripts/relay/cloud-proxy-relay.mjs`
   (omit `CLOUD_ORG_ID` and the relay auto-derives it from the key via
   `GET /api/keys/current`). `STATIC_DIR=build` serves the built frontend from
   the same origin as the API, so there is no CORS and no separate Vite dev
   server to keep running.
2. The relay now injects a tiny bootstrap `<script>` into the served
   `index.html` that pre-seeds `localStorage` (`openhands-onboarded=1` plus a
   `kind: "cloud"` backend pointing at the relay origin, placeholder key)
   **before** React mounts. Because the built Canvas is NOT locked to cloud
   (no `VITE_LOCK_TO_CLOUD` baked in), `openhands-onboarded=1` is trusted, so
   the first-run wizard / OAuth device flow is skipped entirely — no manual
   Add-Backend form, no OAuth. Navigating straight to
   `http://localhost:18080/conversations/<id>` opens the conversation.
3. Verified end-to-end (browser): conversation history loaded via the
   runtime-first `POST /api/cloud-proxy` path (Fix #1), 29/29 `proxyToCloud`
   calls `200`, zero timeouts, zero 429s, zero "Disconnected" toasts. The App
   API events path (the old default) timed out at ~110s — that is the bug;
   the runtime-first path returns in ~0.02s.


## General

- This repository is the OpenHands Agent Canvas React/TypeScript frontend.

## i18n workflow
- After editing `src/i18n/translation.json`, run `npm run make-i18n` to
  regenerate `src/i18n/declaration.ts` (gitignored, auto-generated) and
  `scripts/check-translation-completeness.cjs` to confirm full locale coverage.
- Removing an i18n key: delete the whole locale block from translation.json,
  then `make-i18n`, then remove any test-mock entries (tests inline a
  `translations` map in the `useTranslation` vi.mock).

## Commit messages
- The persistent shell can garble long multi-line `commit -m` bodies (echo
  loop corrupts the stored message). Use `git commit -F <file>` with a
  written temp file instead of `-m` for any non-trivial message.

- Primary verification commands are `npm run lint`, `npm test`, `npm run build`, and `npm run build:lib`.
- Direct dependencies and dev dependencies are exact-pinned. Use the committed `package-lock.json` with `npm ci`, and update `package.json` and `package-lock.json` together through npm.
- Public skills come from `@openhands/extensions`; project-specific contributor guidance lives under `.agents/skills/`.
- Default working-directory behavior must reuse `DEFAULT_WORKING_DIR` from `src/api/agent-server-config.ts` rather than hardcoding `/workspace/project`.
- All pull requests must comply with [`.agents/skills/custom-codereview-guide.md`](.agents/skills/custom-codereview-guide.md), in addition to the general contribution requirements and CI checks.

## Repository Ownership

Before adding code, confirm that the change belongs in this repository.

| Repository | Owns | Add code there when… |
|---|---|---|
| [`OpenHands/OpenHands`](https://github.com/OpenHands/OpenHands) | Agent Canvas UI, frontend state, backend selection, frontend service integration, and local-stack orchestration. | Changing UI, frontend state, or how Canvas consumes an existing API. |
| [`OpenHands/software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk) | Python SDK, Agent Server, agents/tools, conversations, events, canonical REST/WebSocket API, and `clients/typescript/`. | Adding or changing backend behavior, endpoints, wire contracts, or typed client access. |
| [`OpenHands/extensions`](https://github.com/OpenHands/extensions) | Reusable public skills, automations, plugins, and integrations. | Adding or editing reusable extension content rather than Canvas behavior. |
| [`OpenHands/automation`](https://github.com/OpenHands/automation) | Automation definitions, scheduling, webhooks, run history, and dispatch. | Changing when automations run or their scheduling/webhook lifecycle. |

The normal dependency direction is Agent Server contract → TypeScript client → Agent Canvas. Do not reimplement Agent Server endpoints or contracts in Canvas.

## Shared Frontend Change Checklist

Before changing a shared adapter, conversation builder, setting, state selector, or presentation helper:

- Raise `compatibility.minimumAgentServer` in `config/defaults.json` when Canvas begins requiring a new Agent Server endpoint, field, schema, or behavior.
- Enumerate affected consumers across Local and Cloud backends, OpenHands and ACP agents, standard/planning/delegated conversations, and standalone and embedded Canvas. Test every path with distinct control or data flow without testing an irrelevant Cartesian product.
- Give durable frontend state one named owner and one obvious writer. Handle existing-state hydration or migration and all supported create, update, delete, default, and active-item transitions. Leave destructive transitions in a deterministic valid state or an explicit empty state handled by the UI.

## PR Description Human Check

The `HUMAN:` section in PR descriptions is reserved for human contributors only. AI agents must not add to, edit, move, or remove it. If validation fails because it is missing or empty, stop and ask the human user to update it in their own words. If a human already updated it, report the exact validator error rather than editing it.

## Functionality-Specific Skills

Detailed contributor knowledge is split into skills so it loads only for relevant work. Invoke every applicable skill before changing that area; cross-cutting changes may require several skills.

| Skill | Use for |
|---|---|
| [`telemetry-analytics`](.agents/skills/telemetry-analytics/SKILL.md) | PostHog, telemetry consent/identity, typed tracking events, Cloud funnel observability, and onboarding instrumentation. |
| [`e2e-testing`](.agents/skills/e2e-testing/SKILL.md) | Live or mock-LLM Playwright suites, Docker E2E, E2E CI/reporting, artifacts, and failure diagnosis. |
| [`frontend-api-contracts`](.agents/skills/frontend-api-contracts/SKILL.md) | `src/api`, typed Agent Server calls, Cloud/runtime transport, compatibility, backends, settings, secrets, auth, and conversation contracts. |
| [`local-stack-runtime`](.agents/skills/local-stack-runtime/SKILL.md) | Dev launchers, runtime-services metadata, ingress, automation startup, process shutdown, centralized versions, and Docker. |
| [`desktop-electron`](.agents/skills/desktop-electron/SKILL.md) | Electron startup, branding, packaging, bundled Node/uv, universal macOS builds, and desktop CI. |
| [`frontend-development`](.agents/skills/frontend-development/SKILL.md) | React/UI work, i18n, named identifiers, MSW mock mode, lazy loading, bundle performance, and feature-specific UI invariants. |
| [`pr-design-doc`](.agents/skills/pr-design-doc/SKILL.md) | Writing the PR design document stored in the PR body. |
| [`release`](.agents/skills/release.md) | Cutting and verifying an `@openhands/agent-canvas` release. |
| [`verify-openhands`](.agents/skills/verify-openhands/SKILL.md) | Driving the real app like a user with `control-openhands`, the feature map of every user-facing behavior, and creating or maintaining that map. |

The detailed rules live in each skill's `references/guide.md`; do not copy them back into this file. Update the owning skill whenever an invariant changes.

## Testing Baseline

Create TDD tests for behavioral changes. Keep tests focused on user behavior and real code paths:

- Use Arrange, Act, Assert structure and clear test data.
- Avoid duplicate cases and duplicate assertions.
- Mock an underlying service rather than the hook that consumes it.
- Extend an existing test file when it is a natural home; create a new file only when necessary.
- Avoid brittle presentation-only assertions. Test functional CSS contracts directly when they are behavior.
- Do not mirror literal source, fixture, translation, or class-string definitions in tests. Assert consumer behavior or an actual build/runtime contract instead, and do not export internals solely to make them testable. Preserve coverage for routing, accessibility, async behavior, behavioral contracts, and functional CSS/build contracts.
- Use the minimum number of cases that fully cover the intended behavior and edge cases.

Use the `e2e-testing` skill for suite selection and E2E-specific requirements.

## Specifications and Releases

- Cloud conversation resume gating: when a cloud conversation is closed from the UI (`pauseCloudSandbox` is called), the conversation's `conversation_url` is NOT cleared -- it still points to the old sandbox host. `WebSocketProviderWrapper` must suppress the URL (pass `null` to `ConversationWebSocketProvider`) while `sandbox_status === "PAUSED"`, otherwise the WebSocket immediately tries the stale URL before the sandbox wakes. Symmetrically, `useActiveConversation`'s refetch interval must fast-poll (3 s) on both `!conversation_url` AND `sandbox_status === "PAUSED"` -- checking only the missing URL would leave the hook on the 30 s interval while the sandbox is resuming. The resume sequence: navigate -> sandbox PAUSED detected -> `resumeCloudSandbox` called (in `conversation.tsx`) -> fast-poll detects RUNNING -> `conversationUrl` unblocked -> WebSocket connects.

- Cloud conversation empty-render bug (429 rate-limit cascade): when opening a finished cloud conversation, the Canvas fires ~15 concurrent `/api/v1/*` requests at once (history, sidebar, git/changes, sandboxes, settings). The cloud host rate-limits the burst with HTTP 429. The critical path is `EventService.searchEvents` (`src/api/event-service/event-service.api.ts`): its cloud-path catch block used to degrade ANY error (including 429) to an empty page `{items:[], next_page_id:null}` when filter params were present but no timestamp filters (the initial-history-load case, sortOrder only). React Query cached that empty resolution, so the conversation rendered blank even though events existed. Worse, the user `MessageEvent` lands on page 2 because a finished conversation persists ~45 `StreamingDeltaEvent`s that bloat page 1 (limit=50); the `loadOlder` (`src/hooks/use-load-older-events.ts`) request for page 2 also 429'd and degraded to empty, so the user message never loaded. Fix has three parts: (1) `searchEvents` now treats 429 and 5xx as transient and rethrows instead of degrading to empty, so React Query retries and the conversation eventually renders; only the #14399 500-on-timestamp-filters case still degrades. NOTE (2026-08-14): the #14399 server bug has since been FIXED and is live on app.all-hands.dev — verified via direct `curl` that `timestamp__lt` and `timestamp__gte` now return HTTP 200 with correctly filtered results (earlier/older events fetch correctly). The frontend timestamp-filter retry is kept as a safety net against regression but is no longer hit on the happy path. (2) `loadOlder` catches transient errors silently (stops pagination, no error banner) since it is best-effort background loading. (3) The relay (`scripts/relay/cloud-proxy-relay.mjs`) caps concurrent upstream requests (`CLOUD_MAX_CONCURRENCY`, default 3) via a counting semaphore so the open burst is paced under the cloud limit, and retries 429s with exponential backoff (honoring `Retry-After`). Both `forwardToCloud` (POST `/api/cloud-proxy`) and `proxyToCloud` (reverse-proxy `/api/v1/*` in pure-cloud mode) route through `fetchWithRetry`. The `handleEventForUI` reconcile logic (`src/utils/handle-event-for-ui.ts`) correctly collapses the 45 streaming deltas into the terminal `ActionEvent` via `finalizeStreamingDeltasInPlace`, so the code renders once the events load.

- Remaining-429 handling (sandboxes / git/changes / git repositories / installations): the cloud's conversation-open burst also 429'd the non-critical sections, and they degraded in two distinct ways. (1) `useUnifiedGetGitChanges` (`src/hooks/query/use-unified-get-git-changes.ts`) had `retry: false` + `meta: { disableToast: true }`, so a 429 failed immediately with no retry and no visible error — the git-changes section silently rendered empty even when changes existed (same class of bug as the events/search empty-render). (2) `useCloudSandbox`, `useGitRepositories`, `useSearchRepositories`, `useAppInstallations` relied on React Query's default `retry: 3`, which retries ALL errors (including 404/400, pointlessly) and then toasts; after the relay's own retries exhausted the rate-limit window they'd surface a noisy 429 error. Fix: shared helper `src/utils/react-query-retry.ts` — `getHttpErrorStatus` (reads status off both SDK `HttpError` and axios `AxiosError`), `isTransientHttpError` (429 or 5xx), and `retryOnTransient(failureCount, error, maxRetries=5)` (retries 429/5xx up to 5x, retries genuine network drops (an `AxiosError` with no response — local-mode only) up to 3x, fails fast on plain `Error`s and non-429 4xx). Applied `retry: retryOnTransient` to all five hooks above (replacing `retry: false` in git-changes and the implicit default elsewhere) so transient failures retry with backoff instead of failing the section, while real errors (404 missing endpoint, 400 bad path) still fail fast. The relay (`scripts/relay/cloud-proxy-relay.mjs`) `fetchWithRetry` was also hardened: it now retries transient network errors (ECONNRESET/ETIMEDOUT/EPIPE/EAI_AGAIN/UND_ERR_*/socket timeout) AND 5xx upstream responses in addition to 429, with 5 retries, exponential backoff 0.5s/1s/2s/4s/8s capped at 8s (was 3 retries of 429 only, 0.4/0.8/1.6 capped at 2s), and honors `Retry-After` up to 10s (was 5s) — so a blip on the cloud host or the Render↔cloud link is absorbed at the proxy and never surfaces as a failed REST call. The pure retry decision logic is extracted to `scripts/relay/retry-helpers.mjs` for unit testing. Verified E2E: opening the previously-degraded conversation now produces ZERO 429s (was 3+ "persisted after retries" warnings), all of sandboxes/git-changes/git-repositories/installations return 200, and the conversation renders with the git files/diff panels populated.

- Self-hosted Render deploy: `VinnsEdesigner/OpenHands` fork runs the pure-cloud relay on Render as `agent-canvas-p0ny.onrender.com` (service `srv-d9ut5ae417fc7393au70`, `render.yaml` blueprint). Env: `STATIC_DIR=build`, `AGENT_SERVER_URL=""` (pure-cloud), `CLOUD_API_KEY` + `CLOUD_ORG_ID=d14b4bf7-…` set in the dashboard. `healthCheckPath: /healthz`; the `/healthz` handler now returns 503 until `build/index.html` is readable (commit `8f07bceff`), so Render no longer marks the service "live" before the SPA is servable — this was the root cause of the `{"error":"not_found"}` JSON on first deploy. `autoDeploy: yes` on `main`, so every push to the fork's `main` triggers a rebuild + redeploy. Local customizations ahead of upstream `OpenHands/OpenHands:main`: the cloud-proxy relay, streaming/rendering hardening, StreamingDeltaEvent batching (`fdf0ab5bc`), and the `/healthz` static-build guard.

- Upstream fork sync automation: keeps `VinnsEdesigner/OpenHands:main` rebased on `OpenHands/OpenHands:main`. Automation id `422e571e-b871-4803-a73e-d01094cdaeec`, cron `0 3 * * *` UTC, preset/prompt endpoint, secret `GITHUB_PERSONAL_ACCESS_TOKEN`. Each run clones the fork, adds `upstream`, `git rebase upstream/main` (conflicts favor local relay/streaming changes; abort if unresolvable), gates on `npm ci && npm run build` emitting `build/index.html`, then `git push --force-with-lease origin main` (triggers Render auto-deploy). Fail-safe: no push on build failure or unresolvable conflict; idempotent no-op when upstream is unchanged. Run history lives in the Automations page; sidebar automation convos are hidden via the conversation-panel filter `hide-automations` (`automationFilterMode` in `conversation-panel-preferences-store.ts`).

- Self-host toast / blank-conversation / older-events spinner fixes (three intertwined bugs observed on the Render pure-cloud deploy). Architecture principle: **REST is the resilient source of truth for event history; the WebSocket stays a live-only transport and NEVER falls back to `resend_mode='all'`** (that mode replays every stored event over the socket one-by-one, re-rendering from the first message — the bug the user explicitly wants to avoid). Two layers carry the resilience: the relay proxy is the primary network-handling layer, and the frontend query retry is the second line of defense.
  (1) **Spurious "Disconnected (check URL or network)" toast on conversation open.** This toast is REST-driven (not WebSocket): the global `QueryCache.onError` in `src/query-client-config.ts` calls `displayErrorToast` → `retrieveAxiosErrorMessage` → `getUserFacingConnectionErrorMessage`, which maps ANY network/CORS/"Failed to fetch" error to `CORS_OR_NETWORK_ERROR_MESSAGE` (`src/utils/user-facing-error.ts`). `useConversationHistory` (`src/hooks/query/use-conversation-history.ts`) runs with `refetchOnMount: "always"` on every conversation open, so a transient upstream blip re-fired and re-toasted. **Primary fix (relay-level network handling, per user's ask):** `scripts/relay/cloud-proxy-relay.mjs` `fetchWithRetry` now retries transient network errors (ECONNRESET/ETIMEDOUT/EPIPE/EAI_AGAIN/UND_ERR_*/socket timeout) AND 5xx upstream responses in addition to 429, with exponential backoff (0.5s/1s/2s/4s/8s capped at 8s, honoring `Retry-After` up to 10s) up to 5 attempts — so a momentary blip on the cloud host or the Render↔cloud link is absorbed at the proxy and never surfaces to the browser as a failed REST call. The pure retry decision logic is extracted to `scripts/relay/retry-helpers.mjs` (`isRetriableStatus`, `isTransientNetworkError`, `isTransientFetchError`, `backoffDelay`) so it can be unit-tested (`__tests__/relay/retry-helpers.test.mjs`) without importing the relay (which starts an HTTP server on load). **Secondary fix (defense in depth):** added `meta: { disableToast: true }` to `useConversationHistory`, `useUserConversation` (`src/hooks/query/use-user-conversation.ts`), and `useSubConversations` (`src/hooks/query/use-sub-conversations.ts`) — all background conversation-open metadata fetches; the route already surfaces a genuine "conversation not available" error itself. Lengthened the `shownErrors` dedup from 3s → 30s in `query-client-config.ts`. Even a hardened relay can't make a 100%-down cloud never toast, so the suppression stays as a final guard.
  (2) **Status "connecting → running → done" but events never load.** Status (`execution_status` in `conversation-state-store.ts`) is driven purely by WS `ConversationStateUpdateEvent`, fully decoupled from the REST-seeded event store. The relay commit `da890eb77` removed the `resend_mode='all'` WS fallback so the WS opens live-only; when REST fails the store is never seeded and the chat renders blank. **Fix: make REST actually succeed instead of recovering via a WS replay.** (a) The relay's hardened `fetchWithRetry` (above) retries the transient failures (429/5xx/network) that caused the empty/degraded pages. (b) `useConversationHistory` now sets `retry: retryOnTransient` (`src/utils/react-query-retry.ts`) so a transient failure that does reach the query is retried with backoff rather than cached as a blank page. (c) `retryOnTransient` was updated so it retries confirmed 429/5xx HTTP statuses (up to 5×) and genuine network drops (an `AxiosError` with no response — local-mode only, since cloud-mode goes through the relay) up to 3×, but **fails fast on plain `Error`s** (a validation error or a fetch `TypeError` surfacing past the relay must not be retried for seconds). The WebSocket, in `conversation-websocket-context.tsx` `mainWebsocketOptions`, subscribes with `resend_mode='since'` + `after_timestamp` when REST yielded a tail, and with **no resend params (live-only)** when REST yielded nothing — it never uses `resend_mode='all'`. The contract is locked by `conversation-websocket-context.test.tsx` ("never uses resend_mode='all', even when REST returns no events").
  (3) **"Load older events" spinner stuck forever; previous events never open.** When the cloud `#14399` bug 500s on `timestamp__lt`, `event-service.api.ts` retried WITHOUT the timestamp filter but kept `sort_order` + `page_id`, returning the *most recent page again* (all dupes). `addEvents` dedups them all → nothing prepended, but `exhausted = !next_page_id || items.length < 50` was false (full page + live `next_page_id`) → `hasMore` stayed true → the short-content auto-load effect in `chat-interface.tsx` re-fired `maybeLoadOlder` forever. Fix (two layers): (a) `event-service.api.ts` timestamp-filter retry now forces `next_page_id: null` so pagination stops after the degradation instead of handing back a live cursor for the same newest page; (b) `use-load-older-events.ts` snapshots the store length before/after `addEvents` and treats "nothing new prepended (all dupes)" as `exhausted` (`hasMore=false`), so even a future degradation path that returns a full dupe page with a live cursor can't loop. **UPDATE (2026-08-14): the #14399 server bug has been FIXED and is live on app.all-hands.dev — verified via direct `curl` of `events/search` with `timestamp__lt`/`timestamp__gte`: both return HTTP 200 with correctly filtered older/newer events (chained pagination confirmed across multiple pages). "Load older events" now works server-side; the frontend (a)/(b) guards remain as a defensive net.** Tests added: `event-service.test.ts` ("forces next_page_id=null on a successful timestamp-filter retry"), `use-load-older-events.test.tsx` ("stops paginating when a full page is all duplicates"), `conversation-websocket-context.test.tsx` ("never uses resend_mode='all', even when REST returns no events"), `react-query-retry.test.ts` (retryOnTransient fails fast on plain Errors, retries 429/5xx + network-drop axios), and `__tests__/relay/retry-helpers.test.mjs` (relay retry decision logic).

- Touch + pointer swipe gestures to open/close panels (no icon tap required): a reusable `useSwipeGesture` hook (`src/hooks/use-swipe-gesture.ts`) is built on **Pointer Events** (`pointerdown`/`pointermove`/`pointerup`/`pointercancel`) — NOT legacy TouchEvents — so it works uniformly for finger (touch), pen, AND mouse/trackpad. It fires `onSwipe("left"|"right")` only when the gesture is (a) dominantly horizontal (vertical scrolls are never hijacked — axis-locked once movement exceeds an 8px slop), (b) travels past a 45px threshold, and (c) — for *opening* gestures — begins within a 36px screen-edge zone (`startEdge: "left"|"right"`). `preventDefault` is called at axis-lock time and again at commit, so taps and in-progress scrolls are not disrupted and the trailing click is suppressed. **Pointer-type handling:** OPEN gestures (document-level, edge-triggered) accept ALL pointer types (mouse/touch/pen) so a desktop trackpad/mouse drag from a screen edge opens the panel too; CLOSE gestures (`targetRef`-scoped to a panel body) accept touch/pen only — a mouse drag inside a panel would otherwise hijack desktop text selection/clicks. Scoped close gestures call `setPointerCapture` at pointerdown so a fast swipe that exits the panel still reaches the threshold; document-level open gestures deliberately do NOT capture (document already receives every bubbled pointermove, and capturing a touch before its axis is known can interfere with vertical-scroll handling on some mobile browsers). CRITICAL for TOUCH pointers: the touched surface must have `touch-action: pan-y` (or `none`) or the browser consumes the horizontal pan and no `pointermove` fires — the `.conversation-gesture-host` class + `[data-testid="chat-scroll-container"]` rule in `index.css` applies `pan-y pinch-zoom` to all gesture surfaces including the chat scroller. Mouse/pen pointers are unaffected by `touch-action`. **Root cause of the prior "swiping doesn't work at all" bug:** the hook was previously TouchEvent-only and explicitly excluded mouse/pointer events, so on a desktop browser no swipe ever fired; on touch it was also flaky because TouchEvent delivery + `preventDefault` timing raced the browser's pan commitment on some devices. Pointer Events with axis-lock-early + `setPointerCapture` (scoped) is the robust, industry-standard fix. Wiring: `ConversationMain` — left-edge swipe-right opens the mobile sidebar drawer (`useSidebarMobileNav().open()`), right-edge swipe-left opens the right panel (desktop side-drawer via store setters; mobile via `navigate("/conversations/:id/panel")`), and swipe-right on the desktop panel body closes it. `sidebar.tsx` — swipe-left on the mobile drawer closes it (`closeMobileNav()`). `conversation-mobile-panel-page.tsx` — swipe-right navigates back to the conversation. The open gestures are enabled only when the target panel is closed (and vice-versa), and the sidebar open gesture is gated on `isSidebarRailHidden` (mobile-only — on desktop the rail is always visible so there is nothing to open). Test: `__tests__/hooks/use-swipe-gesture.test.tsx` (17 tests — edge-zone, threshold, direction filter, vertical-scroll non-interference, target scoping, mouse-excluded-from-close, mouse-accepted-on-open, listener cleanup, single-fire, axis-lock drift tolerance).
- Spec files live under `specs/`. Keep spec IDs stable and mark deprecated specs with strikethrough rather than renumbering them.
- Tag implementation code and tests with `// @spec BM-002 — Short title` comments immediately above the relevant block so coverage remains grep-able.
- Follow `.agents/skills/release.md` for release automation. Never hand-edit a release-please branch.

## DigitalOcean Managed Agents

Before changing `scripts/mars-*` / `scripts/tunnel-*`, `src/api/mars/`, the Managed Agents UI (`src/components/features/backends/managed-agents/`) or the MARS hooks, read `src/api/mars/AGENTS.md`.
