# Changelog

All notable changes to agent-chat-room are documented here.

## [0.1.1] - 2026-09-15

### Added

- Added an explicit **new session** control for each participant. It discards that runtime's
  saved conversation and sends the complete room transcript on its next turn, while ordinary
  model and role changes continue to preserve the session.

### Fixed

- Count a complete, parseable reviewer verdict when a runtime reports a trailing transport
  error after producing its response, while retaining the error in the turn history.
- Preserve a brainstorm room's worktree preference when promoting its proposal into a build
  room, so a non-isolated brainstorm no longer becomes isolated without being asked.

## [0.1.0] - 2026-09-11

- Initial public release.

[0.1.1]: https://github.com/elia-dot/agent-chat-room/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/elia-dot/agent-chat-room/releases/tag/v0.1.0
