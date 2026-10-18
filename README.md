# Browser Bridge MCP

Let any local MCP client drive your own Chromium or Chrome, with no cloud account and no login.
A small Manifest V3 extension talks to a local MCP server over a token-protected loopback WebSocket.
Because it uses your real browser profile, it works on sites where you are already signed in.

```
MCP client  <--stdio-->  server/server.js  <--ws://127.0.0.1:17333-->  extension (service worker)
```

## Features

- 23 tools: tabs, navigation, page reading with stable element refs, text extraction, screenshots
  (viewport or full page), click, hover, drag, typing, key chords, scroll, form fill, JavaScript,
  console and network capture, waiting, file upload, window resize.
- Real input events through the Chrome debugger API (trusted clicks and keystrokes), so it works on
  apps that ignore synthetic DOM events.
- Several client sessions can share one browser: the first server owns the port, later ones join it.
- Built-in guard rails: loopback only, secret token, web-page origins refused, per-site block list,
  master off switch.

## Requirements

- Node.js 18 or newer
- Chromium or Chrome (any Chromium-based browser that supports Manifest V3)

## Install

```bash
git clone https://github.com/himaldahal/browser-bridge-mcp.git
cd browser-bridge-mcp/server && npm install
node server.js --token        # prints your secret token
```

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, select the `extension/` folder.
2. Click the extension icon to open settings. Paste the token, tick **Allow remote control of this browser**, Save.
3. Register the server with your MCP client as a stdio server. The command is:

   ```
   node /absolute/path/to/browser-bridge-mcp/server/server.js
   ```

4. Start the client. The extension badge shows **ON** when the bridge is connected.

Optional: set `CBB_PORT` (server environment) and the same port in the extension settings to change the default 17333.

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Check bridge and extension connection |
| `tabs_list`, `tab_create`, `tab_close`, `tab_activate` | Manage tabs |
| `navigate` | Open a URL, or `back`, `forward`, `reload` |
| `read_page` | Interactive elements as `[ref_N] role "name"`; `filter: all` adds text; `query` narrows |
| `get_text` | Visible page text |
| `screenshot` | Viewport or full-page JPEG; coordinates match click space |
| `click`, `hover`, `drag` | Mouse input by ref or x,y |
| `type`, `key` | Text entry and key chords such as `ctrl+a`, `shift+Enter` |
| `scroll` | Scroll a page or element, or bring a ref into view |
| `form_input` | Set text, select option or checkbox |
| `eval_js` | Run JavaScript in the page |
| `console_logs`, `network_requests` | Captured since the tab was first used, regex filters |
| `wait_for` | Wait for text to appear |
| `upload_file` | Attach local files to a file input |
| `resize_window`, `detach` | Window size; release the debugger |

## Security model

This tool gives a program full control of your browser, including tabs you are logged in to. Treat it that way.

- The server binds to `127.0.0.1` only. A random 192-bit token is created at `~/.browser-bridge/token` (mode 600).
- The WebSocket rejects any connection with a web-page `Origin`, so a website cannot talk to it.
- The settings page has a **Blocked sites** list (subdomains included). Blocked sites are refused by every tool.
  Add banks, email and admin panels before you start.
- Untick the master switch to cut access immediately.
- Chrome shows a "started debugging this browser" bar while the extension is attached to a tab. This is built into
  the debugger API. The extension detaches from tabs idle for 10 minutes.
- Review what your MCP client is allowed to do before approving actions on logged-in sites.

## Limitations

- Element refs do not reach into iframes; use `eval_js` or x,y clicks there.
- Console and network capture start when a tab is first used.
- Snap-packaged Chromium can only read uploads from non-hidden folders under your home directory.
- Browser internal pages (`chrome://`, the web store) cannot be controlled.

## Project layout

```
extension/   Manifest V3 extension (background.js, options page)
server/      MCP server and WebSocket hub (server.js)
```

## License

MIT
