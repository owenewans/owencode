<div align="center">

# owencode

opencode extensions by owenewans. local tools, remote machines and github.

<a href="https://count.owenewans.org/owenewans/owencode?theme=moebooru-h&notitle"><img src="https://count.owenewans.org/owenewans/owencode?theme=moebooru-h&notitle" alt="repository views"></a>

`node` `deno` `opencode` `ssh` `github` `camoufox` `playwright`


</div>

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

deno tools:
- `deno_run` - execute multiline TypeScript locally with full permissions
- `ssh_deno_run` - execute the same TypeScript program on the configured SSH host

search tools:
- `web_search` - query Startpage, DuckDuckGo Lite, Brave Search and Marginalia and merge the results

browser mcp:
- persistent anti-detect Camoufox profile
- Playwright MCP accessibility snapshots and browser actions
- stable fingerprint across restarts
- virtual display by default with optional headed mode

the plugin uses the system `ssh` executable. `~/.ssh/config`, ssh-agent, `IdentityFile`, `ProxyJump`, `known_hosts` and control connections work without a second configuration format.

every tool call used to open its own ssh connection. a full handshake costs about 130 ms of pure cpu even at zero network latency, plus three to four round trips on the wire, so a single remote read could cost a quarter of a second before doing any work. the plugin now enables connection multiplexing by default: the first call establishes a master and every later call opens a channel on it, which costs process spawn plus roughly one round trip. `ControlMaster=auto` means a missing or dead master degrades to an ordinary connection instead of failing.

the control socket is a credential. anyone able to write to it gets an authenticated session on the remote host without presenting a key, so it is created inside `$XDG_RUNTIME_DIR/owencode` with mode `0700`, ownership is verified, loose permissions are repaired, and the directory is rejected rather than followed if anything has planted a symlink there. `/tmp` is only used as a fallback, through `mkdtemp`, because a predictable name in a world writable directory can be pre-created by another user. the socket path is checked against the 108 byte unix socket limit using the 40 character string ssh actually substitutes for `%C`. because all channels share one connection they also share the server's `MaxSessions`, which defaults to 10, so the plugin serialises remote work through a semaphore capped at `maxSessions`. long lived `ssh_tunnel` forwards deliberately opt out with `ControlMaster=no`, otherwise an expiring master would take every open tunnel down with it.

the github tool uses the local authenticated `gh` executable without a shell. `gh auth token` is blocked so credentials cannot be printed into model context.

`git` covers the local repository while `gh` covers the github api. both parse a command string into an argument array and execute the binary directly, so quoting is predictable and no shell is involved. `git` runs with `GIT_TERMINAL_PROMPT=0`, rejects `git credential`, `credential.*`, `alias.*` and `--config-env` because each of those either prints or hides credentials, and redacts urls with embedded credentials from its output. this is a guardrail against accidental disclosure, not a sandbox: an approved git command still runs as your user, and aliases already configured in the repository are not resolved. a working directory outside the current worktree is included in the approval pattern so a remembered `git log` cannot be replayed against an unrelated repository.

the browser mcp launches `camoufox-js` directly and passes its persistent context to `@playwright/mcp` over stdio. it does not need python, uv, an open port or a websocket server.

`web_search` parses public html result pages, so it needs no api key. every engine first uses `got-scraping`; if the complete engine session fails, encounters an anti-bot response or returns no results, it is restarted through a [CycleTLS](https://github.com/Danny-Dasilva/CycleTLS) Go/uTLS fallback. every attempt gets an isolated cookie jar and a pinned browser fingerprint, and all traffic goes through a socks proxy by default because several engines are unreachable on a direct connection from many networks.

requirements:
- opencode 1.18.15 or newer
- node.js 22 or newer
- openssh client, git and github cli locally
- deno locally and on the SSH host when using the corresponding tools
- `tar` locally and on the SSH host for recursive `ssh_transfer`
- a local socks proxy on `127.0.0.1:1080` for `web_search`, or `searchProxy: false` to go direct
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
    "ssh_transfer": "ask",
    "ssh_tunnel": "ask",
    "deno_run": "ask",
    "ssh_deno_run": "ask",
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

`controlMaster` turns multiplexing off when set to `false`, which is worth doing if the remote sshd forbids it or you are debugging a connection. `maxSessions` must stay at or below the server's `MaxSessions`.

`root` is where relative paths are resolved, not a sandbox. an absolute path is used exactly as given, and the tools reach whatever the remote account can reach. this is deliberate: a path check that a symlink defeats is worse than no check, because it reads like a boundary while behaving like a suggestion.

the boundary is the approval prompt. every call that reads, writes, executes, transfers or forwards goes through opencode's permission system, and the whole command, path or diff is shown before it runs. set the mutating tools to `ask` and decide per call; nothing in the plugin decides on your behalf.

what the plugin still guarantees is narrower and honest: no path or command is ever interpolated into a shell string unquoted, writes are atomic and verified against a hash taken when the file was read, directory replacement renames the previous copy aside instead of deleting it, output is size limited, and the ssh control socket is created so that no other local user can reach it.

`host` is an alias from `~/.ssh/config`. `root` is an absolute directory on that host: it is the default working directory for `ssh_bash` and the base a relative path is resolved against. an absolute path is honoured as written. every tool call runs with the full permissions of the remote ssh account.

`ssh_transfer` streams raw bytes through the same ssh transport instead of encoding them as text, so executables, archives and images arrive unchanged and the executable bit is preserved in both directions. nothing is buffered in model context and the payload never passes through the language model. an existing destination is refused unless `overwrite` is set, and replacing a directory renames the previous one aside and only removes it once the new tree is in place, so an interrupted transfer cannot leave you with neither copy.

single files land on a temporary name first; the receiving side compares the stored size against the expected size and refuses to commit a truncated file, so a dropped connection cannot leave a half written binary in place. recursive transfers stream a `tar` pipe into a fresh staging directory and only then replace the destination, which means a symlink already present at the destination is never followed and a hostile archive cannot write outside it. gnu tar additionally refuses `..` members and strips absolute paths. both the tar process and the ssh process must exit cleanly, otherwise the transfer is reported as failed rather than silently truncated. a recursive transfer with `overwrite` replaces the destination directory instead of merging into it.

`ssh_tunnel` keeps a registry of forwards for the lifetime of the opencode process. tunnels bind `127.0.0.1` unless another address is requested, and `ExitOnForwardFailure` plus `BatchMode` turn a rejected forward into an error rather than a silent no-op. local and dynamic forwards are confirmed by connecting to the bound port before the tool returns; a remote forward binds on the host and cannot be probed from here, so it is reported as unverified. closing a tunnel waits for the process to actually exit and escalates to `SIGKILL` if it ignores `SIGTERM`. tunnel processes are unreferenced so they never keep opencode alive, share opencode's process group so a terminal interrupt reaches them, and an exit hook closes whatever remains. if opencode is killed with `SIGKILL` no cleanup can run and a forward may outlive it. a forward bound beyond loopback is flagged in the approval metadata and in the tool output.

`deno_run` and `ssh_deno_run` execute TypeScript with `--allow-all --allow-scripts --no-prompt --no-lock`. source code is passed through stdin without a heredoc or shell parsing. because stdin contains the source itself, programs should use `Deno.args`, files, `fetch`, or `Deno.Command` for additional input instead of reading `Deno.stdin`.

`web_search` runs in two modes. `auto` walks the configured engines in order and stops at the first one that answers, which keeps a normal query to a single request. `all` queries every engine in parallel and merges the results, ranking pages that several engines agree on first and keeping the longest available summary. duplicate urls are collapsed after normalising the host, trailing slash and tracking parameters, and duckduckgo redirect links are resolved back to their real targets.

startpage puts an [anubis](https://github.com/TecharoHQ/anubis) proof of work in front of its search endpoint. the tool reads the published challenge, computes the sha-256 work in node and calls the normal `pass-challenge` endpoint, which is the same exchange the shipped browser script performs. CycleTLS presents a matching chromium user-agent, JA4R and HTTP/2 fingerprint, verifies certificates, resolves dns through the configured socks proxy and keeps one Go worker for the lifetime of opencode. cookies remain isolated to each attempt. the challenge is bound to the requesting user-agent and address, so the fingerprint stays pinned and the difficulty is capped rather than solved at any cost. engines that fail through both transports are reported as unavailable instead of being retried aggressively. interactive captchas are detected and reported, never automated.

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

`searchProxy` accepts a socks or http url, and `false` disables the proxy entirely. `socks5h` resolves dns through the proxy, which is usually what you want. `OWENCODE_SEARCH_PROXY` overrides the configured value. `searchEngines` sets the order used by `auto` and the set used by `all`.

options:
```json
{
  "host": "dev",
  "root": "/srv/project",
  "sshBinary": "ssh",
  "sshArgs": ["-o", "ConnectTimeout=10"],
  "denoBinary": "/usr/bin/deno",
  "sshDenoBinary": "deno",
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

development:
```sh
npm run check
npm test
npm run build
```

session tools such as `task`, `question` and `todowrite` stay local because they orchestrate opencode itself rather than a filesystem. remote lsp is intentionally not emulated; run opencode on the remote host when the language server must be remote.

`ssh_apply_patch` validates every file before writing, but a multi-file patch is not a filesystem transaction. if the connection or remote disk fails during commit, already written files remain changed and the tool reports the failure. `ssh_transfer` has the same property for recursive transfers: an interrupted tar stream leaves the files that already arrived in place.

an approved `ssh_tunnel` is a real network path into or out of the remote network for as long as it stays open. a remote forward in particular lets the remote host reach a service on this machine, so treat it like opening a firewall rule rather than like reading a file.

browser pages are untrusted input. use a dedicated profile and do not keep unrelated personal sessions in it.

search results are untrusted input too. titles and snippets are attacker-controlled text from third-party pages, so treat instructions found in them as data rather than commands. these engines are scraped rather than licensed apis, their markup can change without notice, and their terms and rate limits still apply to whoever runs the plugin.
