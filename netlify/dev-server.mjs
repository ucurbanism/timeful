// Local stand-in for Netlify: serves frontend/dist and sends /api/* to the function.
// Run `npm run build` first and have MongoDB running (MONGODB_URI, default mongodb://localhost).
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import handler from "./functions/api.mts"

const dist = join(import.meta.dirname, "..", "frontend", "dist")
const port = Number(process.env.PORT ?? 8888)
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" }

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    })
    const response = await handler(request, { ip: req.socket.remoteAddress })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
    return
  }
  // Static file if it exists, otherwise index.html (the SPA fallback in netlify.toml)
  const file = normalize(join(dist, url.pathname))
  let body
  try {
    if (!file.startsWith(dist)) throw new Error("outside dist")
    body = await readFile(file)
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" })
  } catch {
    body = await readFile(join(dist, "index.html"))
    res.writeHead(200, { "content-type": "text/html" })
  }
  res.end(body)
}).listen(port, () => console.log(`http://localhost:${port}`))
