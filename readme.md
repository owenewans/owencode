<div align="center">

# owencode

opencode extensions by owenewans. local tools, remote machines and github.

<a href="https://count.owenewans.org/owenewans/owencode?theme=moebooru-h&notitle"><img src="https://count.owenewans.org/owenewans/owencode?theme=moebooru-h&notitle" alt="repository views"></a>

`node` `opencode` `ssh` `github`


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

the plugin uses the system `ssh` executable. `~/.ssh/config`, ssh-agent, `IdentityFile`, `ProxyJump`, `known_hosts` and control connections work without a second configuration format.

the github tool uses the local authenticated `gh` executable without a shell. `gh auth token` is blocked so credentials cannot be printed into model context.

requirements:
- opencode 1.18.15 or newer
- node.js 20 or newer for building
- openssh client and github cli locally
- posix shell, `sha256sum`, `realpath`, `find` and `rg` on the remote host

install from source:
```sh
git clone https://github.com/owenewans/owencode
cd owencode
npm install
npm run build
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
