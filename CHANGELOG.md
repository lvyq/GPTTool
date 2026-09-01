# Changelog

All notable changes to GPTTool will be documented in this file. The format is based on Keep a Changelog and the project uses semantic versioning while it is in public preview.

## [Unreleased]

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
