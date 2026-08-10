<div align="center">

# sshopencode

native ssh counterparts for opencode tools. local opencode, remote files and commands.

<a href="https://count.owenewans.org/owenewans/sshopencode?theme=moebooru-h&notitle"><img src="https://count.owenewans.org/owenewans/sshopencode?theme=moebooru-h&notitle" alt="repository views"></a>

`node` `opencode` `ssh` 


</div>

tools:
- `ssh_read` - read files and list directories
- `ssh_glob` - find files with remote ripgrep
- `ssh_grep` - search file contents with remote ripgrep
- `ssh_bash` - execute commands
- `ssh_write` - atomically create or replace files
- `ssh_edit` - atomically replace exact text
- `ssh_apply_patch` - add, update, move and delete files with opencode patches

the plugin uses the system `ssh` executable. `~/.ssh/config`, ssh-agent, `IdentityFile`, `ProxyJump`, `known_hosts` and control connections work without a second configuration format.

requirements:
- opencode 1.18.16 or newer
- node.js 20 or newer for building
- openssh client locally
- posix shell, `sha256sum`, `realpath`, `find` and `rg` on the remote host

install from source:
```sh
git clone https://github.com/owenewans/sshopencode
cd sshopencode
npm install
npm run build
```

add the built plugin to `~/.config/opencode/opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/sshopencode/dist/index.js",
      {
        "host": "dev",
        "root": "/srv/project"
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
    "ssh_apply_patch": "ask"
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
