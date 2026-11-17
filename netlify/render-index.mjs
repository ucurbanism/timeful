// frontend/public/index.html holds Go template tags that the Go server fills in per request (page
// title, link-preview tags). Netlify serves the file as-is, so bake in the defaults after the build.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const file = join(import.meta.dirname, "..", "frontend", "dist", "index.html")
let html = readFileSync(file, "utf8")

// {{ $defaultTitle := "Timeful - Find a time to meet" }}
const defaults = {}
html = html.replace(/[ \t]*\{\{\s*\$(\w+)\s*:=\s*"([^"]*)"\s*\}\}\n?/g, (_m, name, value) => {
  defaults[name] = value
  return ""
})
// {{ or .title $defaultTitle }}
html = html.replace(/\{\{\s*or\s+\.\w+\s+\$(\w+)\s*\}\}/g, (m, name) => {
  if (!(name in defaults)) throw new Error(`index.html uses undefined template default ${m}`)
  return defaults[name]
})

if (html.includes("{{")) throw new Error("index.html still has Go template tags the Netlify build can't fill in")
writeFileSync(file, html)
console.log(`Filled in ${Object.keys(defaults).length} template defaults in dist/index.html`)
