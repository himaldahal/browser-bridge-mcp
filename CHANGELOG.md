# Changelog

## 3.0.0

Added
- Popup control panel with Pause, Resume, Step and an emergency Stop, live "running now" list and recent activity.
- On-page pill on controlled tabs with Pause and Stop. Keyboard shortcuts `Alt+Shift+P` and `Alt+Shift+X`.
- Permissions per category (read, navigate, click and type, run scripts) with Allow, Ask and Block.
- Reach setting to limit the agent to tabs it opened, with a per-tab share switch.
- Allow-list of sites, blocked-list, scheme restrictions, `file://` off by default, action-per-minute limit.
- Activity log in the extension (JSON and CSV export) and a server audit log at `~/.browser-bridge/audit.log`.
- Redesigned settings page with settings export and import.
- New tools `extract` and `emulate`. `screenshot` can capture one element. `wait_for` accepts a selector or URL and can wait for removal.
- Live monitor page and realtime updates in the popup and settings; `node server.js --follow` and `CBB_LOG=1` on the server.
- Agent tabs are collected in a purple "Bridge" tab group (orange while paused); the toolbar badge counts controlled tabs; the popup lists them with Show and Release.
- Foldable settings sidebar (icon rail, remembered, `[` shortcut).
- New logo.

Security
- Mutual HMAC-SHA256 handshake. The token is no longer sent over the connection.
- Host header check (DNS rebinding), extension pinning, failed-attempt throttling, token rotation, token file permission check.
- Approval prompts and the pill cannot be operated by keyboard, and prompts show the full code to run.
- `upload_file` refuses relative paths and credential files. Tabs the person opens are never adopted by the agent.
- Commands from a server that did not prove the token are ignored. Pause and Stop are re-checked just before a command runs and after any prompt.
- Prompts are hit-tested in an isolated world, pinned with inline styles in the top layer, serialized per tab and bounded in time.
- `fetch_url` and friends refuse private addresses by default. Blocklist matching ignores trailing dots and ports. `window_close`, `events` and `downloads_list` respect scope and the site lists.
- The pill and prompts are recognised by node identity, so a page that strips their `id` gains nothing. The server cancels calls the caller gave up on, and a Stop ends a running command at its next step.
- Pages whose address the bridge cannot see, `data:` and `view-source:` tabs fail closed; redirects onto blocked sites reset the tab; released tabs stay off limits for five minutes.
- Prompts ignore clicks for 600 ms, have bounded text and fall back to "deny" on pages that cannot show one. The event timeline respects Pause, Read=Block and the site lists.
- Filters (`console_logs`, `network_requests`) no longer use a regex engine. Server log lines have control characters stripped, and URLs are logged without their query strings.
- Enter on a risky form and Ctrl+V need approval. Key presses and dialog text are never logged. Agent regexes cannot freeze the worker.

Changed
- The connection protocol changed: update the extension and the server together.
