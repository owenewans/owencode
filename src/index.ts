import path from "node:path"
import { createTwoFilesPatch } from "diff"
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import { parseOptions, remotePath } from "./config.js"
import { applyChunks, parsePatch, type PatchOperation } from "./patch.js"
import { shellQuote, sha256, SshClient } from "./ssh.js"

type Change = {
  operation: PatchOperation
  sourcePath: string
  targetPath: string
  oldContent: string
  newContent: string
  expectedHash: string
}

function display(root: string, filePath: string) {
  return path.posix.relative(root, filePath) || "."
}

function diff(filePath: string, oldContent: string, newContent: string) {
  return createTwoFilesPatch(filePath, filePath, oldContent, newContent, "remote", "remote")
}

async function approve(ctx: ToolContext, permission: string, pattern: string, metadata: Record<string, unknown>) {
  await ctx.ask({ permission, patterns: [pattern], always: [pattern], metadata })
}

const Sshopencode = (async (_input, rawOptions) => {
  const options = parseOptions(rawOptions)
  const ssh = new SshClient(options)
  const scoped = (value: string) => remotePath(options.root, value)
  const permissionPath = (value: string) => `${options.host}:${display(options.root, value)}`

  return {
    tool: {
      ssh_read: tool({
        description: "Read a UTF-8 file or list a directory on the configured SSH host. Paths are remote and confined to the configured root.",
        args: {
          filePath: tool.schema.string().describe("Absolute remote path or path relative to the configured root"),
          offset: tool.schema.number().int().nonnegative().optional().describe("One-based line to start from"),
          limit: tool.schema.number().int().positive().optional().describe("Maximum number of lines, default 2000"),
        },
        async execute(args, ctx) {
          const filePath = scoped(args.filePath)
          await approve(ctx, "ssh_read", permissionPath(filePath), { host: options.host, filePath })
          const result = await ssh.script(
            [
              'root=$(realpath -m -- "$1")',
              'target=$(realpath -m -- "$2")',
              'case "$root" in /) ;; *) case "$target" in "$root"|"$root"/*) ;; *) echo "remote path resolves outside configured root" >&2; exit 77;; esac;; esac',
              'if [ -d "$2" ]; then',
              '  printf "D\\0"',
              '  find "$2" -mindepth 1 -maxdepth 1 -printf "%f\\n" | LC_ALL=C sort',
              'elif [ -f "$2" ]; then',
              '  printf "F\\0"',
              "  awk -v start=\"$3\" -v limit=\"$4\" 'NR >= start { printf \"%d: %s\\n\", NR, $0; count++ } count >= limit { exit }' \"$2\"",
              'else printf "path not found: %s\\n" "$2" >&2; exit 44',
              "fi",
            ].join("\n"),
            [options.root, filePath, String(Math.max(1, args.offset ?? 1)), String(args.limit ?? 2000)],
            { signal: ctx.abort },
          )
          if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `failed to read ${filePath}`)
          const type = result.stdout.subarray(0, 2).toString("utf8")
          const content = result.stdout.subarray(2).toString("utf8").trimEnd()
          if (type === "D\0") {
            const entries = content
            return { title: `${options.host}:${display(options.root, filePath)}`, output: entries || "(empty directory)" }
          }
          if (type !== "F\0") throw new Error("invalid response from remote read")
          return {
            title: `${options.host}:${display(options.root, filePath)}`,
            output: content || "(empty file)",
            metadata: { host: options.host, filePath },
          }
        },
      }),

      ssh_glob: tool({
        description: "Find files by glob on the configured SSH host using remote ripgrep. Paths are confined to the configured root.",
        args: {
          pattern: tool.schema.string().min(1).describe("Glob pattern, for example **/*.ts"),
          path: tool.schema.string().optional().describe("Remote directory, default configured root"),
        },
        async execute(args, ctx) {
          const base = scoped(args.path ?? ".")
          await ssh.guardPath(options.root, base, ctx.abort)
          const pattern = `${permissionPath(base)}:${args.pattern}`
          await approve(ctx, "ssh_glob", pattern, { host: options.host, path: base, glob: args.pattern })
          const script = [
            'root=$(realpath -m -- "$1")',
            'target=$(realpath -m -- "$2")',
            'case "$root" in /) ;; *) case "$target" in "$root"|"$root"/*) ;; *) exit 77;; esac;; esac',
            'cd -- "$2" && command rg --files --hidden -g "$3" -g "!.git" | LC_ALL=C sort',
          ].join("\n")
          const result = await ssh.script(script, [options.root, base, args.pattern], { signal: ctx.abort })
          if (result.exitCode > 1) throw new Error(result.stderr.trim() || "remote glob failed")
          const files = result.stdout
            .toString("utf8")
            .trimEnd()
            .split("\n")
            .filter(Boolean)
            .map((item) => path.posix.join(base, item))
          return { title: `${options.host}: ${args.pattern}`, output: files.join("\n") || "No files found" }
        },
      }),

      ssh_grep: tool({
        description: "Search remote file contents with ripgrep. Paths are confined to the configured root.",
        args: {
          pattern: tool.schema.string().min(1).describe("Regular expression to search for"),
          path: tool.schema.string().optional().describe("Remote file or directory, default configured root"),
          include: tool.schema.string().optional().describe("Optional file glob such as *.ts"),
        },
        async execute(args, ctx) {
          const target = scoped(args.path ?? ".")
          await ssh.guardPath(options.root, target, ctx.abort)
          const permission = `${permissionPath(target)}:${args.pattern}`
          await approve(ctx, "ssh_grep", permission, { host: options.host, path: target, pattern: args.pattern })
          const script = [
            'root=$(realpath -m -- "$1")',
            'target=$(realpath -m -- "$2")',
            'case "$root" in /) ;; *) case "$target" in "$root"|"$root"/*) ;; *) exit 77;; esac;; esac',
            'if [ -n "$4" ]; then command rg --line-number --no-heading --color never --hidden -g "!.git" -g "$4" -- "$3" "$2"',
            'else command rg --line-number --no-heading --color never --hidden -g "!.git" -- "$3" "$2"; fi',
          ].join("\n")
          const result = await ssh.script(script, [options.root, target, args.pattern, args.include ?? ""], { signal: ctx.abort })
          if (result.exitCode > 1) throw new Error(result.stderr.trim() || "remote grep failed")
          return { title: `${options.host}: ${args.pattern}`, output: result.stdout.toString("utf8").trimEnd() || "No matches found" }
        },
      }),

      ssh_bash: tool({
        description: "Execute a non-interactive shell command on the configured SSH host. The working directory is confined to the configured root.",
        args: {
          command: tool.schema.string().min(1).describe("Shell command to execute remotely"),
          timeout: tool.schema.number().int().positive().optional().describe("Timeout in milliseconds"),
          workdir: tool.schema.string().optional().describe("Remote working directory, default configured root"),
        },
        async execute(args, ctx) {
          const workdir = scoped(args.workdir ?? ".")
          await ssh.guardPath(options.root, workdir, ctx.abort)
          const pattern = `${options.host}:${args.command}`
          await approve(ctx, "ssh_bash", pattern, { host: options.host, command: args.command, workdir })
          const script = [
            'root=$(realpath -m -- "$1")',
            'target=$(realpath -m -- "$2")',
            'case "$root" in /) ;; *) case "$target" in "$root"|"$root"/*) ;; *) exit 77;; esac;; esac',
            'cd -- "$2" && exec sh -c "$3"',
          ].join("\n")
          const result = await ssh.script(script, [options.root, workdir, args.command], {
            signal: ctx.abort,
            timeout: args.timeout,
          })
          const stdout = result.stdout.toString("utf8")
          const output = [stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n") || "(no output)"
          return {
            title: `${options.host}: ${args.command}`,
            output,
            metadata: { host: options.host, workdir, exitCode: result.exitCode },
          }
        },
      }),

      ssh_write: tool({
        description: "Create or replace a UTF-8 file atomically on the configured SSH host.",
        args: {
          filePath: tool.schema.string().describe("Absolute remote path or path relative to the configured root"),
          content: tool.schema.string().describe("Complete file content"),
        },
        async execute(args, ctx) {
          const filePath = scoped(args.filePath)
          await ssh.guardPath(options.root, filePath, ctx.abort)
          let oldContent = ""
          let expected = "missing"
          try {
            oldContent = await ssh.textFile(filePath, ctx.abort)
            expected = sha256(oldContent)
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("not a regular file")) throw error
          }
          const patch = diff(filePath, oldContent, args.content)
          await approve(ctx, "ssh_write", permissionPath(filePath), { host: options.host, filePath, diff: patch })
          await ssh.writeFile(filePath, args.content, expected, ctx.abort)
          return { title: `${options.host}:${display(options.root, filePath)}`, output: "File written successfully.", metadata: { diff: patch } }
        },
      }),

      ssh_edit: tool({
        description: "Replace exact text in a UTF-8 file atomically on the configured SSH host.",
        args: {
          filePath: tool.schema.string().describe("Absolute remote path or path relative to the configured root"),
          oldString: tool.schema.string().describe("Exact text to replace"),
          newString: tool.schema.string().describe("Replacement text"),
          replaceAll: tool.schema.boolean().optional().describe("Replace all occurrences, default false"),
        },
        async execute(args, ctx) {
          if (args.oldString === args.newString) throw new Error("oldString and newString are identical")
          const filePath = scoped(args.filePath)
          await ssh.guardPath(options.root, filePath, ctx.abort)
          const oldContent = await ssh.textFile(filePath, ctx.abort)
          const count = oldContent.split(args.oldString).length - 1
          if (count === 0) throw new Error("oldString was not found in the remote file")
          if (!args.replaceAll && count !== 1) throw new Error("oldString occurs multiple times; provide more context or set replaceAll")
          const newContent = args.replaceAll
            ? oldContent.replaceAll(args.oldString, args.newString)
            : oldContent.replace(args.oldString, args.newString)
          const patch = diff(filePath, oldContent, newContent)
          await approve(ctx, "ssh_edit", permissionPath(filePath), { host: options.host, filePath, diff: patch })
          await ssh.writeFile(filePath, newContent, sha256(oldContent), ctx.abort)
          return { title: `${options.host}:${display(options.root, filePath)}`, output: "Edit applied successfully.", metadata: { diff: patch } }
        },
      }),

      ssh_apply_patch: tool({
        description: "Apply an OpenCode-style patch to one or more UTF-8 files on the configured SSH host. Supports add, update, move and delete.",
        args: {
          patchText: tool.schema.string().min(1).describe("Patch enclosed by *** Begin Patch and *** End Patch"),
        },
        async execute(args, ctx) {
          const operations = parsePatch(args.patchText)
          const changes: Change[] = []
          const touched = new Set<string>()
          for (const operation of operations) {
            const sourcePath = scoped(operation.path)
            await ssh.guardPath(options.root, sourcePath, ctx.abort)
            const operationPaths = [sourcePath]
            if (operation.type === "update" && operation.movePath) operationPaths.push(scoped(operation.movePath))
            if (operationPaths.some((item) => touched.has(item))) {
              throw new Error(`patch contains conflicting operations for ${operation.path}`)
            }
            operationPaths.forEach((item) => touched.add(item))
            if (operation.type === "add") {
              changes.push({ operation, sourcePath, targetPath: sourcePath, oldContent: "", newContent: operation.content, expectedHash: "missing" })
              continue
            }
            const oldContent = await ssh.textFile(sourcePath, ctx.abort)
            if (operation.type === "delete") {
              changes.push({ operation, sourcePath, targetPath: sourcePath, oldContent, newContent: "", expectedHash: sha256(oldContent) })
              continue
            }
            const targetPath = operation.movePath ? scoped(operation.movePath) : sourcePath
            await ssh.guardPath(options.root, targetPath, ctx.abort)
            changes.push({
              operation,
              sourcePath,
              targetPath,
              oldContent,
              newContent: applyChunks(oldContent, operation.chunks),
              expectedHash: sha256(oldContent),
            })
          }

          const patches = changes.map((item) => diff(item.targetPath, item.oldContent, item.newContent)).join("\n")
          const patterns = [...new Set(changes.flatMap((item) => [item.sourcePath, item.targetPath]).map(permissionPath))]
          await ctx.ask({
            permission: "ssh_apply_patch",
            patterns,
            always: patterns,
            metadata: { host: options.host, files: patterns, diff: patches },
          })

          for (const change of changes) {
            if (change.operation.type === "delete") {
              await ssh.deleteFile(change.sourcePath, change.expectedHash, ctx.abort)
              continue
            }
            const expected = change.operation.type === "add" || change.operation.movePath ? "missing" : change.expectedHash
            await ssh.writeFile(change.targetPath, change.newContent, expected, ctx.abort)
            if (change.operation.type === "update" && change.operation.movePath) {
              await ssh.deleteFile(change.sourcePath, change.expectedHash, ctx.abort)
            }
          }
          const summary = changes.map((item) => `${item.operation.type[0].toUpperCase()} ${display(options.root, item.targetPath)}`).join("\n")
          return { title: `${options.host}: patch applied`, output: `Success. Updated remote files:\n${summary}`, metadata: { diff: patches } }
        },
      }),
    },
  }
}) satisfies Plugin

export default Sshopencode
