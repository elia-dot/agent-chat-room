# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in `agent-chat-room`, please do not open a public
issue with vulnerability details. Use [GitHub private vulnerability reporting](https://github.com/elia-dot/agent-chat-room/security/advisories/new).
If that option is unavailable, open an issue asking for a private reporting channel without
disclosing the vulnerability.

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
   `~/.config/agent-chat-room/server.token` and exchanged via an HTTP redirect for an
   `HttpOnly; SameSite=Strict` cookie. Requests without that cookie or a valid bearer token
   are rejected. Tabs on the same origin share cookies; processes running as the same local
   user can read files permitted to that user.
4. **Repository Setup & Test Hooks**: Commands defined in `.acr.json` (`setup`, `testCommand`)
   execute in the worktree using the local user shell. Inspect untrusted repositories before
   opening rooms.
5. **Worktrees by default**: Rooms use isolated git worktrees
   (`~/.config/agent-chat-room/worktrees/`). Disabling isolation edits the original checkout;
   additional writable folders are always accessed in place. Runtime permissions differ
   by adapter and are not a uniform OS sandbox.
6. **Agent authentication**: Agent CLIs manage their own credentials. ACR checks for
   credential-file presence and maintains its own local server capability token.
7. **Network use**: Agent providers, Git remotes, model discovery, user tools and repository
   hooks can use the network. The web UI loads Google Fonts. Local storage and a loopback
   listener do not mean the application is offline.
