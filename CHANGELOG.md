# Changelog

All notable changes to GPTTool will be documented in this file. The format is based on Keep a Changelog and the project uses semantic versioning while it is in public preview.

## [Unreleased]

### Added

- Require private CDP rule collection to pass end-to-end composer, task, model, effort, speed, usage, send, reply and restore checks before publication.
- Show rule upload time, last edit time and detailed validation results in the administrator console, with JSON import and editing controls.

### Fixed

- Reject unverified, wrong-platform or post-validation modified CDP rules at both token and administrator upload endpoints.
- Confirm that a newly uploaded highest-priority rule is actually available from the public distribution endpoint before the collector reports success.

### Changed

- Split Web portals and API relay into independent `frontend` and `backend` packages, builds and development processes.
- Serve production Web assets independently through Nginx; API-only is the backend default, with an explicit legacy static-hosting opt-in.
- Reuse the frontend build in desktop installers, document migration and preserve session/Origin/device authorization.
- Add split-deployment HTTP/WebSocket regression coverage and separate CI build artifacts.

## [0.2.10] - 2026-09-03

### Changed

- Separate model settings from approval and compatibility settings into two dialogs.
- Apply model, reasoning effort and speed from one button through a serialized operation, with duplicate-submit protection and explicit partial-failure reporting.

## [0.2.9] - 2026-09-03

### Added

- Open model, reasoning-effort and response-speed settings directly from the header model badge.
- Read and apply official response-speed options, including the compact Fast-mode checkbox, with confirmation after changes.
- Clearly disable unavailable speed settings in standalone and external-provider modes; refresh speed choices after a model change.

### Fixed

- Support the updated official compact model radio list and read the exact reasoning-slider steps without guessing their order or entering locked options.

## [0.2.8] - 2026-09-03

### Fixed

- Read directory listings on the local host without waiting for the official filesystem RPC.
- Preserve the remote directory boundary and exclude symlinks from folder entries.
- Show optional compatibility notices in task settings instead of repeated chat toasts.

## [0.2.7] - 2026-09-03

### Fixed

- Bound retained rollout history by a 32 MiB estimated-memory budget as well as entry count.
- Avoid cloning oversized histories into the shared cache.

### Added

- Bounded local numeric memory diagnostics for investigating long-running native crashes.

## [0.2.6] - 2026-09-02

### Fixed

- Restore the administrator login shell so its HTML, JavaScript and styles are always deployed as one compatible set.
- Keep the administrator page directly reachable while continuing to protect every administrator API with role-based authentication.
- Add a regression test that prevents a stale administrator page from disabling all dashboard interactions.

## [0.2.5] - 2026-09-01

### Fixed

- Follow the official client's project assignments for handoff and legacy projectless tasks, so tasks such as “闪电兔” remain grouped under their assigned local project.
- Preserve Codex worktree paths and their visual marker while reconciling official project membership.

## [0.2.4] - 2026-09-01

### Fixed

- Read rollout history for user-visible worktree tasks that newer official clients label as subagents.
- Keep internal subagent sessions hidden unless the exact task identity is present in the official app-server or renderer list.

## [0.2.3] - 2026-09-01

### Fixed

- Group Codex worktree tasks under their canonical project instead of exposing temporary worktree paths as separate projects.
- Exclude temporary Codex worktree paths from the new-task project directory picker.

### Changed

- Match the official client project ordering by each project's latest task activity.
- Show the official-style worktree marker beside worktree tasks.

## [0.2.2] - 2026-09-01

### Fixed

- Reconcile the task drawer continuously against the official renderer and the complete app-server index.
- Keep renderer-visible tasks when the app-server index temporarily lags after an official client update.
- Stop treating a delayed first user item in an active turn as a queued follow-up.

### Changed

- Request app-server task pages in official recency order and refresh long-open Web sessions every ten seconds.

## [0.2.0] - 2026-08-13

### Added

- PostgreSQL-backed administrator dashboard for live usage, accounts, CDP compatibility rules and runtime configuration.
- Protected system administrator role and account/device status controls.
- Search-engine and LLM crawler metadata for the separately deployed official website.

### Changed

- Registration, pairing lifetime, login lifetime and device limits can be changed without restarting the relay.
- Installer delivery now supports byte ranges, long-lived immutable assets and optimized Nginx file serving.

### Added

- Public self-hosting documentation and deployment templates.
- PolyForm Noncommercial 1.0.0 licensing and clean-room provenance policy.
- CI, contribution, security and issue-reporting templates.

### Changed

- Production relay, update and deployment endpoints are now environment-driven.
- Generated installers, update feeds, databases and production configuration are excluded from source control.

## [0.1.5] - 2026-08-11

- Current desktop, remote Web UI, relay and PostgreSQL baseline prepared for public review.
