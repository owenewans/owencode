export function parseCommand(command: string, binary: string, label: string) {
  if (/\0|\r|\n/.test(command)) throw new Error(`${label} command cannot contain control characters`)
  const args: string[] = []
  let value = ""
  let quote: "single" | "double" | undefined
  let escaped = false
  let started = false

  const flush = () => {
    if (!started) return
    args.push(value)
    value = ""
    started = false
  }
  for (const character of command.trim()) {
    if (escaped) {
      value += character
      escaped = false
      started = true
      continue
    }
    if (character === "\\" && quote !== "single") {
      escaped = true
      started = true
      continue
    }
    if (quote === "single") {
      if (character === "'") quote = undefined
      else value += character
      continue
    }
    if (quote === "double") {
      if (character === '"') quote = undefined
      else value += character
      continue
    }
    if (character === "'") {
      quote = "single"
      started = true
    } else if (character === '"') {
      quote = "double"
      started = true
    } else if (/\s/.test(character)) flush()
    else {
      value += character
      started = true
    }
  }
  if (escaped || quote) throw new Error(`${label} command contains an unterminated quote or escape`)
  flush()
  if (args[0] === binary) throw new Error(`pass ${binary} arguments without the leading ${binary}`)
  return args
}

export function renderCommand(binary: string, args: string[]) {
  return `${binary} ${args.map((arg) => (/\s|'|"|\\/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`
}
