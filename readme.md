<div align="center">

# owencode

opencode extensions by owenewans. local tools, remote machines and github.

<a href="https://count.owenewans.org/owenewans/owencode?theme=moebooru-h&notitle"><img src="https://count.owenewans.org/owenewans/owencode?theme=moebooru-h&notitle" alt="repository views"></a>

`node` `opencode` `ssh` `github` `camoufox` `playwright`


</div>

ssh tools:
- `ssh_read` - read files and list directories
- `ssh_glob` - find files with remote ripgrep
- `ssh_grep` - search file contents with remote ripgrep
- `ssh_bash` - execute commands
- `ssh_write` - atomically create or replace files
- `ssh_edit` - atomically replace exact text
- `ssh_apply_patch` - add, update, move and delete files with opencode patches

github tools:
- `gh` - run github cli commands with structured arguments and native approvals

browser mcp:
- persistent anti-detect Camoufox profile
- Playwright MCP accessibility snapshots and browser actions
- stable fingerprint across restarts
- virtual display by default with optional headed mode

the plugin uses the system `ssh` executable. `~/.ssh/config`, ssh-agent, `IdentityFile`, `ProxyJump`, `known_hosts` and control connections work without a second configuration format.

the github tool uses the local authenticated `gh` executable without a shell. `gh auth token` is blocked so credentials cannot be printed into model context.

the browser mcp launches `camoufox-js` directly and passes its persistent context to `@playwright/mcp` over stdio. it does not need python, uv, an open port or a websocket server.

requirements:
- opencode 1.18.15 or newer
- node.js 22 or newer
- openssh client and github cli locally
- xvfb for the default virtual display mode
- posix shell, `sha256sum`, `realpath`, `find` and `rg` on the remote host

install from source:
```sh
git clone https://github.com/owenewans/owencode
cd owencode
npm install
npm run build
npm run browser:fetch
```

add the built plugin to `~/.config/opencode/opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/owencode/dist/index.js",
      {
        "host": "dev",
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

the generated Camoufox identity is stored with mode `0600` inside the profile and reused across restarts. it is regenerated when fingerprint settings or the installed Camoufox version change. proxy credentials should be passed through an environment variable rather than committed to a shared config.

`host` is an alias from `~/.ssh/config`. `root` is an absolute directory on that host. structured file-tool paths and the initial `ssh_bash` working directory are confined to `root`. an approved `ssh_bash` command still has every permission of the remote ssh account and is not a sandbox.

options:
```json
{
  "host": "dev",
  "root": "/srv/project",
  "sshBinary": "ssh",
  "sshArgs": ["-o", "ConnectTimeout=10"],
  "ghBinary": "gh",
  "maxOutputBytes": 2097152
}
```

development:
```sh
npm run check
npm test
npm run build
```

session tools such as `task`, `question` and `todowrite` stay local because they orchestrate opencode itself rather than a filesystem. remote lsp is intentionally not emulated; run opencode on the remote host when the language server must be remote.

`ssh_apply_patch` validates every file before writing, but a multi-file patch is not a filesystem transaction. if the connection or remote disk fails during commit, already written files remain changed and the tool reports the failure.

browser pages are untrusted input. use a dedicated profile and do not keep unrelated personal sessions in it.
