# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in `agent-chat-room`, please do not open a public
issue. Instead, report it privately to the maintainers or via GitHub Security Advisories.

Please include:

- A description of the issue and reproduction steps.
- The environment details (OS, Node version, agent CLIs).
- Any potential impact.

## Architecture & Security Boundary

`agent-chat-room` is designed with a strict local-first security boundary:

1. **Localhost only**: The HTTP and WebSocket server binds strictly to `127.0.0.1`.
2. **Origin and Host Verification**: Every API request must carry a loopback `Host`
   (`localhost`, `127.0.0.1`, `[::1]`) and, when present, a loopback `Origin`. The `Host`
   check is what defeats DNS rebinding: a page whose name is re-pointed at 127.0.0.1 still
   addresses the server by that name.
3. **Capability Token Boundary**: Every API route except `/api/health`, and every WebSocket
   connection, requires the session capability token. The token is generated with `0600` permissions in
   `~/.config/agent-chat-room/server.token` and redeemed via a one-time HTTP redirect into an
   `HttpOnly; SameSite=Strict` cookie, isolating browser tabs and unauthenticated network
   processes. (Processes running as the same local user UID share user file permissions.)
4. **Repository Setup & Test Hooks**: Commands defined in `.acr.json` (`setup`, `testCommand`)
   execute in the worktree using the local user shell. Inspect untrusted repositories before
   opening rooms.
5. **Isolated Worktrees**: Agent modifications take place in isolated git worktrees
   (`~/.config/agent-chat-room/worktrees/`) rather than the user's working checkout.
6. **No Credential Access**: `acr` never touches or reads user API keys, passwords, or
   authentication tokens. All agent CLIs manage their own authentications independently.
