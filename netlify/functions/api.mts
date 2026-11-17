// Names-only Timeful API as a Netlify Function.
//
// Mirrors the guest routes of the Go server (server/routes/events.go) and reads and writes MongoDB in
// the same shape, so data can move between the two. Nobody signs in: every respondent is a guest
// identified by the name they type.

import { randomInt } from "node:crypto"
import { MongoClient, ObjectId, type Db, type Document } from "mongodb"
import type { Config, Context } from "@netlify/functions"

export const config: Config = { path: "/api/*" }

const ZERO_ID = "000000000000000000000000"
const MAX_LIST = 5000 // dates, times or availability slots in one request
const MAX_NAME = 100

// ---------- Database ----------

let dbPromise: Promise<Db> | undefined

// Reused across warm invocations; a failed connect is retried on the next request
function getDb(): Promise<Db> {
  dbPromise ??= (async () => {
    const client = await MongoClient.connect(process.env.MONGODB_URI ?? "mongodb://localhost", {
      serverSelectionTimeoutMS: 10_000,
    })
    const db = client.db("schej-it")
    await Promise.all([
      db.collection("events").createIndex({ shortId: 1 }),
      db.collection("eventResponses").createIndex({ eventId: 1, userId: 1 }, { unique: true }),
    ]).catch((e) => console.error("Creating indexes failed", e))
    return db
  })().catch((e) => {
    dbPromise = undefined
    throw e
  })
  return dbPromise
}

const notDeleted = { $or: [{ isDeleted: { $exists: false } }, { isDeleted: false }] }
const isHexId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-fA-F]{24}$/.test(s)

async function findEvent(db: Db, id: string) {
  // Same rule as the Go server: ids of 10 characters or fewer are short ids
  if (id.length <= 10) return db.collection("events").findOne({ shortId: id, ...notDeleted })
  if (!isHexId(id)) return null
  return db.collection("events").findOne({ _id: new ObjectId(id), ...notDeleted })
}

async function newShortId(db: Db): Promise<string> {
  const letters = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz"
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = Array.from({ length: 6 }, () => letters[randomInt(letters.length)]).join("")
    if (!(await db.collection("events").findOne({ shortId: id }, { projection: { _id: 1 } }))) return id
  }
  throw new Error("Couldn't generate a unique short id")
}

// ---------- Requests and validation ----------

class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}
const bad = (code = "invalid-payload") => new HttpError(400, code)

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

async function readBody(req: Request): Promise<Record<string, any>> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw bad("invalid-json")
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("invalid-json")
  return body as Record<string, any>
}

function parseDate(v: unknown): Date {
  if (typeof v !== "string") throw bad()
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw bad()
  return d
}

function dateList(v: unknown, required = false): Date[] | undefined {
  if (v == null) {
    if (required) throw bad()
    return undefined
  }
  if (!Array.isArray(v) || v.length > MAX_LIST) throw bad()
  return v.map(parseDate)
}

function optBool(v: unknown): boolean | undefined {
  if (v == null) return undefined
  if (typeof v !== "boolean") throw bad()
  return v
}

function optNumber(v: unknown, integer = false): number | undefined {
  if (v == null) return undefined
  if (typeof v !== "number" || !Number.isFinite(v) || (integer && !Number.isInteger(v))) throw bad()
  return v
}

function optString(v: unknown, max: number): string | undefined {
  if (v == null) return undefined
  if (typeof v !== "string" || v.length > max) throw bad()
  return v
}

function requiredString(v: unknown, max: number): string {
  const s = optString(v, max)
  if (!s) throw bad()
  return s
}

// Guest names are map keys in Mongo, so they can't be empty or start with "$"
function guestName(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > MAX_NAME || v.startsWith("$")) throw bad("invalid-name")
  return v
}

function objectIdList(v: unknown): ObjectId[] | undefined {
  if (v == null) return undefined
  if (!Array.isArray(v) || v.length > MAX_LIST || !v.every(isHexId)) throw bad()
  return v.map((id) => new ObjectId(id))
}

function signUpBlocks(v: unknown): Document[] | undefined {
  if (v == null) return undefined
  if (!Array.isArray(v) || v.length > 500) throw bad()
  return v.map((b) => {
    if (!b || typeof b !== "object") throw bad()
    return clean({
      _id: isHexId(b._id) ? new ObjectId(b._id) : undefined,
      name: optString(b.name, 200),
      capacity: optNumber(b.capacity, true),
      startDate: b.startDate == null ? undefined : parseDate(b.startDate),
      endDate: b.endDate == null ? undefined : parseDate(b.endDate),
    })
  })
}

// Drops what the Go structs' `omitempty` drops: missing values and empty lists
function clean(doc: Record<string, unknown>): Document {
  return Object.fromEntries(
    Object.entries(doc).filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0))
  )
}

// The event fields both create and edit accept. Groups and anything that needs an owner account or
// email (reminders, notifications, collected emails, hidden results) are not part of this build.
function eventFields(p: Record<string, any>) {
  if (p.type === "group") throw bad("groups-disabled")
  if (p.type !== "specific_dates" && p.type !== "dow") throw bad()
  const duration = optNumber(p.duration)
  if (duration === undefined) throw bad()
  return {
    name: requiredString(p.name, 200),
    duration,
    dates: dateList(p.dates, true),
    type: p.type as string,
    hasSpecificTimes: optBool(p.hasSpecificTimes),
    times: dateList(p.times),
    signUpBlocks: signUpBlocks(p.signUpBlocks),
    startOnMonday: optBool(p.startOnMonday),
    daysOnly: optBool(p.daysOnly),
    timezone: optString(p.timezone, 100),
  }
}

// ---------- JSON output, matching what the Go server returns ----------

// Go prints times as RFC 3339 without trailing zero milliseconds ("2026-11-18T14:00:00Z")
const goTime = (d: Date) => d.toISOString().replace(/\.(\d*?)0*Z$/, (_m, f) => (f ? `.${f}Z` : "Z"))
const times = (v: Date[] | null | undefined) => (v == null ? null : v.map(goTime))
const hex = (id: ObjectId | null | undefined) => (id ? id.toHexString() : ZERO_ID)
const orNull = <T>(v: T | undefined) => (v === undefined ? null : v)

const guestUser = (name: string) => ({
  timezoneOffset: 0,
  _id: ZERO_ID,
  email: "",
  firstName: name,
  lastName: "",
  picture: "",
  hasCustomName: null,
  calendarAccounts: null,
  primaryAccountKey: null,
  calendarOptions: null,
  numEventsCreated: 0,
})

function responseJson(r: Document, user: unknown) {
  return {
    name: r.name ?? "",
    email: "", // never shown: this build doesn't collect emails
    userId: hex(r.userId),
    user,
    availability: times(r.availability),
    ifNeeded: times(r.ifNeeded),
    manualAvailability: null as unknown,
    useCalendarAvailability: orNull(r.useCalendarAvailability),
    enabledCalendars: orNull(r.enabledCalendars),
    calendarOptions: orNull(r.calendarOptions),
  }
}

function signUpResponsesJson(map: Record<string, Document> | null | undefined) {
  if (map == null) return null
  const out: Record<string, unknown> = {}
  for (const r of Object.values(map)) {
    if (!r?.name) continue
    out[r.name] = {
      signUpBlockIds: r.signUpBlockIds == null ? null : r.signUpBlockIds.map(hex),
      name: r.name,
      email: "",
      userId: hex(r.userId),
      user: guestUser(r.name),
    }
  }
  return out
}

function eventJson(ev: Document, responses: Record<string, unknown>): Record<string, unknown> {
  return {
    _id: hex(ev._id),
    shortId: orNull(ev.shortId),
    ownerId: hex(ev.ownerId),
    name: ev.name ?? "",
    description: orNull(ev.description),
    isArchived: orNull(ev.isArchived),
    isDeleted: orNull(ev.isDeleted),
    duration: orNull(ev.duration),
    dates: times(ev.dates),
    notificationsEnabled: orNull(ev.notificationsEnabled),
    sendEmailAfterXResponses: orNull(ev.sendEmailAfterXResponses),
    when2meetHref: orNull(ev.when2meetHref),
    collectEmails: orNull(ev.collectEmails),
    timeIncrement: orNull(ev.timeIncrement),
    hasSpecificTimes: orNull(ev.hasSpecificTimes),
    times: times(ev.times),
    type: ev.type ?? "",
    creatorPosthogId: orNull(ev.creatorPosthogId),
    isSignUpForm: orNull(ev.isSignUpForm),
    signUpBlocks:
      ev.signUpBlocks == null
        ? null
        : ev.signUpBlocks.map((b: Document) => ({
            _id: hex(b._id),
            name: b.name ?? "",
            capacity: orNull(b.capacity),
            startDate: b.startDate ? goTime(b.startDate) : null,
            endDate: b.endDate ? goTime(b.endDate) : null,
          })),
    signUpResponses: signUpResponsesJson(ev.signUpResponses),
    startOnMonday: orNull(ev.startOnMonday),
    timezone: orNull(ev.timezone),
    blindAvailabilityEnabled: orNull(ev.blindAvailabilityEnabled),
    daysOnly: orNull(ev.daysOnly),
    responses,
    numResponses: orNull(ev.numResponses),
    scheduledEvent: orNull(ev.scheduledEvent),
    calendarEventId: ev.calendarEventId ?? "",
    remindees:
      ev.remindees == null
        ? null
        : ev.remindees.map((r: Document) => ({ email: r.email ?? "", responded: orNull(r.responded) })),
    attendees: null,
    hasResponded: null,
  }
}

// ---------- Rate limit on event lookups that miss ----------

// Same budget as the Go middleware: a burst of 60 misses per IP, then 20 a minute.
// shortcut: per function instance, not shared across instances; use Netlify rate limiting if abused.
const misses = new Map<string, { tokens: number; at: number }>()
function missBucket(ip: string) {
  const now = Date.now()
  if (misses.size > 10_000) misses.clear()
  let b = misses.get(ip)
  if (!b) {
    b = { tokens: 60, at: now }
    misses.set(ip, b)
  }
  b.tokens = Math.min(60, b.tokens + ((now - b.at) * 20) / 60_000)
  b.at = now
  return b
}

// ---------- Routes ----------

async function createEvent(db: Db, req: Request) {
  const p = await readBody(req)
  const fields = eventFields(p)
  const doc = clean({
    _id: new ObjectId(),
    shortId: await newShortId(db),
    ...fields,
    creatorPosthogId: optString(p.creatorPosthogId, 200),
    isSignUpForm: optBool(p.isSignUpForm),
    when2meetHref: optString(p.when2meetHref, 500),
    timeIncrement: optNumber(p.timeIncrement, true),
    signUpResponses: {},
    numResponses: 0,
  })
  await db.collection("events").insertOne(doc)
  return json(201, { eventId: hex(doc._id), shortId: doc.shortId })
}

async function editEvent(db: Db, req: Request, ev: Document) {
  const p = await readBody(req)
  // Events made by signed-in users on another Timeful install keep their owner-only editing
  if (hex(ev.ownerId) !== ZERO_ID) return json(403, { error: "user-not-event-owner" })
  // Missing fields keep their stored value, like the Go server's $set of its struct
  const set = clean({ ...eventFields(p), description: optString(p.description, 5000) })
  await db.collection("events").updateOne({ _id: ev._id }, { $set: set })
  return new Response(null, { status: 200 })
}

async function getEvent(db: Db, ev: Document, guestNameParam: string | null) {
  const rows = await db.collection("eventResponses").find({ eventId: ev._id }).toArray()
  const responses: Record<string, unknown> = {}
  for (const row of rows) {
    const r = row.response ?? {}
    if (!r.name) continue
    responses[r.name] = { ...responseJson(r, guestUser(r.name)), availability: null, ifNeeded: null }
  }
  const out = eventJson(ev, responses)

  // "Hide responses" can't be turned on in this build, but older events may have it. Nobody can be
  // the owner without accounts, so show at most the requesting guest's own response.
  if (ev.blindAvailabilityEnabled) {
    delete out.numResponses
    if (guestNameParam) {
      out.responses = guestNameParam in responses ? { [guestNameParam]: responses[guestNameParam] } : {}
    } else {
      delete out.responses
      delete out.remindees
    }
  }
  return json(200, out)
}

async function getResponses(db: Db, ev: Document, params: URLSearchParams) {
  let timeMin: Date, timeMax: Date
  try {
    timeMin = parseDate(params.get("timeMin"))
    timeMax = parseDate(params.get("timeMax"))
  } catch {
    throw bad("invalid-time-range")
  }
  const within = (d: Date) => d >= timeMin && d <= timeMax
  const rows = await db.collection("eventResponses").find({ eventId: ev._id }).toArray()
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    const r = row.response ?? {}
    out[row.userId] = {
      ...responseJson(r, null),
      availability: (r.availability ?? []).filter(within).map(goTime),
      ifNeeded: (r.ifNeeded ?? []).filter(within).map(goTime),
      manualAvailability: {},
    }
  }

  if (ev.blindAvailabilityEnabled) {
    const name = params.get("guestName")
    return json(200, name && name in out ? { [name]: out[name] } : {})
  }
  return json(200, out)
}

async function saveResponse(db: Db, req: Request, ev: Document) {
  const p = await readBody(req)
  if (typeof p.guest !== "boolean") throw bad()
  if (!p.guest) return json(401, { error: "not-signed-in" })
  const name = guestName(p.name)

  if (ev.isSignUpForm) {
    const signUpResponses = { ...(ev.signUpResponses ?? {}) }
    signUpResponses[name] = clean({ signUpBlockIds: objectIdList(p.signUpBlockIds), name })
    await db.collection("events").updateOne({ _id: ev._id }, { $set: { signUpResponses } })
    return json(200, {})
  }

  const response = {
    name,
    availability: dateList(p.availability) ?? null,
    ifNeeded: dateList(p.ifNeeded) ?? null,
  }
  const filter = { eventId: ev._id, userId: name }
  let inserted = false
  try {
    const r = await db.collection("eventResponses").updateOne(filter, { $set: { response } }, { upsert: true })
    inserted = r.upsertedCount === 1
  } catch (e: any) {
    // Two first saves under the same name raced; the other one inserted, so this one updates
    if (e?.code !== 11000) throw e
    await db.collection("eventResponses").updateOne(filter, { $set: { response } })
  }
  if (inserted) await db.collection("events").updateOne({ _id: ev._id }, { $inc: { numResponses: 1 } })
  return json(200, {})
}

async function deleteResponse(db: Db, req: Request, ev: Document) {
  const p = await readBody(req)
  if (typeof p.guest !== "boolean") throw bad()
  if (!p.guest) return json(401, { error: "not-signed-in" })
  if (typeof p.name !== "string") throw bad()

  if (ev.isSignUpForm) {
    const signUpResponses = { ...(ev.signUpResponses ?? {}) }
    delete signUpResponses[p.name]
    await db.collection("events").updateOne({ _id: ev._id }, { $set: { signUpResponses } })
  } else {
    const r = await db.collection("eventResponses").deleteOne({ eventId: ev._id, "response.name": p.name })
    if (r.deletedCount) await db.collection("events").updateOne({ _id: ev._id }, { $inc: { numResponses: -1 } })
  }
  return json(200, {})
}

async function renameUser(db: Db, req: Request, ev: Document) {
  const p = await readBody(req)
  if (typeof p.oldName !== "string") throw bad()
  const newName = guestName(p.newName)
  const responses = db.collection("eventResponses")
  if (newName !== p.oldName && (await responses.findOne({ eventId: ev._id, userId: newName }))) {
    return json(400, { error: "A guest with this name already exists for this event" })
  }
  await responses.updateOne(
    { eventId: ev._id, userId: p.oldName },
    { $set: { userId: newName, "response.name": newName } }
  )
  return json(200, {})
}

async function route(req: Request, context: Context): Promise<Response> {
  const url = new URL(req.url)
  const seg = url.pathname
    .replace(/^\/api(?=\/|$)/, "")
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        throw new HttpError(404, "not-found")
      }
    })
  const method = req.method

  if (seg.length === 1 && seg[0] === "health" && method === "GET") return json(200, { ok: true })
  if (seg[0] !== "events" || seg.length > 3) return json(404, { error: "not-found" })

  const db = await getDb()
  if (seg.length === 1) return method === "POST" ? createEvent(db, req) : json(404, { error: "not-found" })

  const action = seg[2] ?? ""
  const isLookup = method === "GET" && ["", "ids", "responses"].includes(action)
  const known =
    isLookup ||
    (method === "PUT" && action === "") ||
    (method === "POST" && (action === "response" || action === "rename-user")) ||
    (method === "DELETE" && action === "response")
  if (!known) return json(404, { error: "not-found" })

  const bucket = isLookup ? missBucket(context.ip || "unknown") : undefined
  if (bucket && bucket.tokens < 1) return json(429, { error: "too-many-requests" })

  const ev = await findEvent(db, seg[1])
  if (!ev) {
    if (bucket) bucket.tokens -= 1
    return json(404, { error: "event-not-found" })
  }

  if (method === "GET" && action === "") return getEvent(db, ev, url.searchParams.get("guestName"))
  if (method === "GET" && action === "ids") return json(200, { shortId: ev.shortId ?? "", longId: hex(ev._id) })
  if (method === "GET") return getResponses(db, ev, url.searchParams)
  if (method === "PUT") return editEvent(db, req, ev)
  if (method === "DELETE") return deleteResponse(db, req, ev)
  if (action === "response") return saveResponse(db, req, ev)
  return renameUser(db, req, ev)
}

export default async (req: Request, context: Context) => {
  try {
    return await route(req, context)
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.code })
    console.error(e)
    return json(500, { error: "server-error" })
  }
}
