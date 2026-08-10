import { describe, expect, it } from "vitest"
import { applyChunks, parsePatch } from "../src/patch.js"

describe("patches", () => {
  it("parses add, update, move and delete operations", () => {
    const operations = parsePatch(`*** Begin Patch
*** Add File: new.txt
+new
*** Update File: old.txt
*** Move to: moved.txt
@@
-old
+changed
*** Delete File: gone.txt
*** End Patch`)
    expect(operations.map((item) => item.type)).toEqual(["add", "update", "delete"])
    expect(operations[1]).toMatchObject({ movePath: "moved.txt" })
  })

  it("applies exact chunks and preserves a trailing newline", () => {
    expect(applyChunks("before\nold\nafter\n", [{ oldText: "old", newText: "new" }])).toBe("before\nnew\nafter\n")
  })

  it("rejects ambiguous context", () => {
    expect(() => applyChunks("same\nsame\n", [{ oldText: "same", newText: "new" }])).toThrow("ambiguous")
  })
})
