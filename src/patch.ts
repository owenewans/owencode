export type PatchOperation =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: PatchChunk[] }

export type PatchChunk = { oldText: string; newText: string; anchor?: string }

export function parsePatch(text: string): PatchOperation[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  if (lines.shift() !== "*** Begin Patch") throw new Error("patch must start with *** Begin Patch")
  if (lines.at(-1) === "") lines.pop()
  if (lines.pop() !== "*** End Patch") throw new Error("patch must end with *** End Patch")

  const operations: PatchOperation[] = []
  let index = 0
  while (index < lines.length) {
    const header = lines[index++]
    const match = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(header)
    if (!match) throw new Error(`invalid patch header: ${header}`)
    const [, kind, filePath] = match

    if (kind === "Add") {
      const content: string[] = []
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const line = lines[index++]
        if (!line.startsWith("+")) throw new Error(`added file line must start with +: ${line}`)
        content.push(line.slice(1))
      }
      operations.push({ type: "add", path: filePath, content: content.length === 0 ? "" : `${content.join("\n")}\n` })
      continue
    }
    if (kind === "Delete") {
      operations.push({ type: "delete", path: filePath })
      continue
    }

    let movePath: string | undefined
    if (lines[index]?.startsWith("*** Move to: ")) movePath = lines[index++].slice("*** Move to: ".length)
    const chunks: PatchChunk[] = []
    let oldLines: string[] = []
    let newLines: string[] = []
    let anchor: string | undefined
    const flush = () => {
      if (oldLines.length === 0 && newLines.length === 0) return
      chunks.push({ oldText: oldLines.join("\n"), newText: newLines.join("\n"), anchor })
      oldLines = []
      newLines = []
    }
    while (index < lines.length && !lines[index].startsWith("*** ")) {
      const line = lines[index++]
      if (line.startsWith("@@")) {
        flush()
        anchor = line.slice(2).trim() || undefined
        continue
      }
      if (line.startsWith(" ")) {
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      } else if (line.startsWith("-")) oldLines.push(line.slice(1))
      else if (line.startsWith("+")) newLines.push(line.slice(1))
      else throw new Error(`invalid update line: ${line}`)
    }
    flush()
    if (chunks.length === 0) throw new Error(`update contains no chunks: ${filePath}`)
    operations.push({ type: "update", path: filePath, movePath, chunks })
  }
  if (operations.length === 0) throw new Error("patch contains no file operations")
  return operations
}

export function applyChunks(content: string, chunks: PatchChunk[]): string {
  let output = content
  for (const chunk of chunks) {
    const start = chunk.anchor ? output.indexOf(chunk.anchor) : 0
    if (start < 0) throw new Error(`patch anchor was not found in remote file: ${chunk.anchor}`)
    const candidates = chunk.oldText.endsWith("\n") ? [chunk.oldText] : [chunk.oldText, `${chunk.oldText}\n`]
    const matches = candidates
      .map((candidate) => ({ candidate, first: output.indexOf(candidate, start), last: output.lastIndexOf(candidate) }))
      .filter((item) => item.first >= 0)
    if (matches.length === 0) throw new Error("patch context was not found in remote file")
    const match = matches[0]
    if (match.first !== match.last) throw new Error("patch context is ambiguous in remote file")
    const replacement = match.candidate.endsWith("\n") && !chunk.newText.endsWith("\n") ? `${chunk.newText}\n` : chunk.newText
    output = output.slice(0, match.first) + replacement + output.slice(match.first + match.candidate.length)
  }
  return output
}
