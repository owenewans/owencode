<div align="center">

# owencode

opencode extensions: local tools, remote machines and github.

<a href="https://count.owenewans.org/owenewans/owencode?theme=moebooru-h&notitle"><img src="https://count.owenewans.org/owenewans/owencode?theme=moebooru-h&notitle" alt="repository views"></a>

`typescript` `developer-tools` `cli`

</div>

## features

ssh tools:
- `ssh_read` - read files and list directories
- `ssh_glob` - find files with remote ripgrep
- `ssh_grep` - search file contents with remote ripgrep
- `ssh_bash` - execute commands
- `ssh_write` - atomically create or replace files
- `ssh_edit` - atomically replace exact text
- `ssh_apply_patch` - add, update, move and delete files with opencode patches
- `ssh_transfer` - stream binaries and directory trees to and from the host
- `ssh_tunnel` - open, list and close local, remote and dynamic port forwards

git tools:
- `gh` - run parsed github cli command strings with native approvals and no shell
- `git` - run parsed local git command strings without a shell

node tools:
- `node_run` - execute multiline TypeScript locally via Node's type stripping
- `ssh_node_run` - execute the same TypeScript program on the configured SSH host

search tools:
- `web_search` - query Startpage, DuckDuckGo Lite, Brave Search and Marginalia and merge the results

browser mcp:
- persistent anti-detect Camoufox profile
- Playwright MCP accessibility snapshots and browser actions
- stable fingerprint across restarts
- virtual display by default with optional headed mode

owenloop for OpenCode 2:
- durable per-session goals backed by native plugin storage
- automatic continuation on `session.idle`
- goal reinjection into normal and compaction model context
- explicit progress, completion and blocker tools

## install

Requires:
- opencode 1.18.15 or newer
- Node.js 22.6 or newer
- openssh client, git and github cli locally
- Node.js on the SSH host for `ssh_node_run`
- `tar` locally and on the SSH host for recursive `ssh_transfer`
- a local socks proxy on `127.0.0.1:1080` for `web_search`, or `searchProxy: false`
- xvfb for the default virtual display mode
- posix shell, `sha256sum`, `realpath`, `find` and `rg` on the remote host

```sh
git clone https://github.com/owenewans/owencode
cd owencode
npm install
npm run build
npm run browser:fetch
```

## usage

The tools appear in opencode once the plugin is registered. Every ssh tool
takes `host` per call as `user@host` with an optional `port` (default 22),
for example `marou@2.26.179.6`, so one plugin serves any number of machines.
`root` is the directory relative paths resolve against on every host.

Work that outlives the client's request timeout belongs in
`browser_job_start`, which returns a job id immediately; poll it with
`browser_job_wait`. `browser_session_status` reports whether the window is
up and where the action log lives.

The browser starts on the first tool call rather than with opencode, so an
idle session puts no window on the screen. Closing the window is not fatal;
the next call relaunches it.

Start a durable goal with `/goal <objective>`. Use `/goal status`, `/goal
pause`, `/goal resume` and `/goal stop` to control it. The loop continues
until `owenloop_complete`, `owenloop_blocked` or an explicit stop changes its
durable state; a service restart resubmits the same fenced continuation.

## configuration

OpenCode 2 discovers JavaScript entrypoints in
`~/.config/opencode/plugins/`. Point a thin wrapper at the built owenloop
entrypoint:

```js
export { default } from "file:///absolute/path/to/owencode/dist/owenloop.js"
```

Save it as `~/.config/opencode/plugins/owenloop.js`. If the default permission
policy asks for every tool, allow `owenloop_progress`, `owenloop_complete` and
`owenloop_blocked` so the loop does not wait for manual approval to update its
own state.

The remaining tools use the OpenCode 1 plugin API. Add that built plugin to
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/owencode/dist/index.js",
      {
        "root": "/srv/project",
        "ghBinary": "/usr/bin/gh"
      }
    ]
  ],
  "mcp": {
    "owencode_browser": {
      "type": "local",
      "command": [
        "/usr/bin/node",
        "/absolute/path/to/owencode/dist/browser/server.js"
      ],
      "environment": {
        "OWENCODE_BROWSER_PROFILE": "~/.local/share/owencode/browser-profile",
        "OWENCODE_BROWSER_DISPLAY": "virtual",
        "OWENCODE_BROWSER_HUMANIZE": "true",
        "OWENCODE_BROWSER_GEOIP": "false",
        "OWENCODE_BROWSER_CAPABILITIES": "core"
      },
      "enabled": true
    }
  },
  "permission": {
    "ssh_read": "allow",
    "ssh_glob": "allow",
    "ssh_grep": "allow",
    "ssh_bash": "ask",
    "ssh_write": "ask",
    "ssh_edit": "ask",
    "ssh_apply_patch": "ask",
    "ssh_transfer": "ask",
    "ssh_tunnel": "ask",
    "node_run": "ask",
    "ssh_node_run": "ask",
    "web_search": "allow",
    "git": {
      "*": "ask",
      "git status*": "allow",
      "git diff*": "allow",
      "git log*": "allow",
      "git show*": "allow",
      "git branch": "allow",
      "git remote -v": "allow"
    },
    "gh": {
      "*": "ask",
      "gh repo view*": "allow",
      "gh pr view*": "allow",
      "gh pr list*": "allow",
      "gh issue view*": "allow",
      "gh issue list*": "allow",
      "gh release view*": "allow",
      "gh release list*": "allow",
      "gh search *": "allow",
      "gh status*": "allow"
    }
  }
}
```

plugin options:

```json
{
  "root": "/srv/project",
  "sshBinary": "ssh",
  "sshArgs": ["-o", "ConnectTimeout=10"],
  "nodeBinary": "/usr/bin/node",
  "sshNodeBinary": "node",
  "ghBinary": "gh",
  "gitBinary": "git",
  "tarBinary": "tar",
  "maxOutputBytes": 2097152,
  "maxTransferBytes": 268435456,
  "controlMaster": true,
  "controlPersist": "60s",
  "maxSessions": 8
}
```

search options:

```json
{
  "searchProxy": "socks5h://127.0.0.1:1080",
  "searchEngines": ["startpage", "duckduckgo", "brave", "marginalia"],
  "searchTimeout": 30000,
  "searchMaxResults": 10,
  "searchMaxBytes": 4194304
}
```

`searchProxy` accepts a socks or http url, and `false` disables the proxy.
`socks5h` resolves dns through the proxy. `OWENCODE_SEARCH_PROXY` overrides
it. `searchEngines` sets the order used by `auto` and the set used by `all`.

browser environment:
- `OWENCODE_BROWSER_PROFILE` - persistent Firefox profile directory
- `OWENCODE_BROWSER_DISPLAY` - `virtual` or `headed`
- `OWENCODE_BROWSER_PROXY` - HTTP, HTTPS or SOCKS proxy URL
- `OWENCODE_BROWSER_GEOIP` - `true` or `false`
- `OWENCODE_BROWSER_OS` - comma-separated `windows`, `macos`, `linux`
- `OWENCODE_BROWSER_LOCALE` - comma-separated locales
- `OWENCODE_BROWSER_HUMANIZE` - `true`, `false` or maximum cursor duration
- `OWENCODE_BROWSER_CAPABILITIES` - Playwright MCP capabilities
- `OWENCODE_BROWSER_OUTPUT_DIR` - screenshots, traces and downloads
- `OWENCODE_BROWSER_TIMEOUT_MS` - Playwright action and navigation deadline
- `OWENCODE_BROWSER_JOB_TIMEOUT_MS` - ceiling for a background job
- `OWENCODE_BROWSER_LOG` - append every tool call to `actions-<date>.jsonl`

`controlMaster: false` turns ssh multiplexing off, which is worth doing if
the remote sshd forbids it. `maxSessions` must stay at or below the server's
`MaxSessions`.

`root` is where relative paths resolve, not a sandbox: every call runs with
the full permissions of the remote ssh account, and the approval prompt is
the boundary. Set the mutating tools to `ask`. Browser pages and search
results are untrusted input, so use a dedicated browser profile.
