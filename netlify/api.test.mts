// Exercises the API function the way Netlify calls it. Needs a MongoDB you don't mind writing test
// polls to: MONGODB_URI (default mongodb://localhost). Run with `npm test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import handler from "./functions/api.mts"

async function call(method: string, path: string, body?: unknown, ip = "203.0.113.1") {
  const res = await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    { ip } as any
  )
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const poll = {
  name: "Club meeting",
  duration: 8,
  dates: ["2026-11-18T14:00:00.000Z", "2026-11-19T14:00:00.000Z"],
  type: "specific_dates",
  timezone: "America/New_York",
}

test("health and unknown routes", async () => {
  assert.deepEqual(await call("GET", "/api/health"), { status: 200, body: { ok: true } })
  assert.equal((await call("GET", "/api/user/profile")).status, 404)
  assert.equal((await call("POST", "/api/auth/otp/send", { email: "a@b.c" })).status, 404)
  assert.equal((await call("DELETE", "/api/events/abc123")).status, 404) // deleting polls needs an account
})

test("create validates input and rejects groups and account-only options", async () => {
  assert.deepEqual((await call("POST", "/api/events", { ...poll, type: "group" })).body, { error: "groups-disabled" })
  assert.equal((await call("POST", "/api/events", { ...poll, name: "" })).status, 400)
  assert.equal((await call("POST", "/api/events", { ...poll, dates: ["not a date"] })).status, 400)
  assert.equal((await call("POST", "/api/events", "{not json")).status, 400)

  const created = await call("POST", "/api/events", { ...poll, remindees: ["x@y.z"], collectEmails: true, blindAvailabilityEnabled: true })
  assert.equal(created.status, 201)
  const ev = (await call("GET", `/api/events/${created.body.shortId}`)).body
  assert.equal(ev.remindees, null)
  assert.equal(ev.collectEmails, null)
  assert.equal(ev.blindAvailabilityEnabled, null)
})

test("guest responds by name, renames, and deletes", async () => {
  const created = await call("POST", "/api/events", poll)
  assert.equal(created.status, 201)
  const { eventId, shortId } = created.body
  assert.match(shortId, /^[2-9A-HJ-NP-Za-hj-km-np-z]{6}$/)

  assert.deepEqual((await call("GET", `/api/events/${shortId}/ids`)).body, { shortId, longId: eventId })

  let ev = (await call("GET", `/api/events/${shortId}`)).body
  assert.equal(ev._id, eventId)
  assert.equal(ev.ownerId, "000000000000000000000000")
  assert.deepEqual(ev.dates, ["2026-11-18T14:00:00Z", "2026-11-19T14:00:00Z"])
  assert.deepEqual(ev.responses, {})
  assert.equal(ev.numResponses, 0)
  assert.deepEqual(ev.signUpResponses, {})

  // Signing in doesn't exist, and a guest must give a name
  assert.equal((await call("POST", `/api/events/${eventId}/response`, { guest: false, availability: [] })).status, 401)
  assert.equal((await call("POST", `/api/events/${eventId}/response`, { guest: true, name: "  " })).status, 400)

  const slots = ["2026-11-18T15:00:00.000Z", "2026-11-18T15:15:00.000Z", "2026-11-25T15:00:00.000Z"]
  const save = { guest: true, name: "Alex", email: "alex@example.com", availability: slots, ifNeeded: [] }
  assert.equal((await call("POST", `/api/events/${eventId}/response`, save)).status, 200)
  assert.equal((await call("POST", `/api/events/${eventId}/response`, save)).status, 200) // editing doesn't double count

  ev = (await call("GET", `/api/events/${shortId}`)).body
  assert.equal(ev.numResponses, 1)
  assert.equal(ev.responses.Alex.user.firstName, "Alex")
  assert.equal(ev.responses.Alex.email, "")
  assert.equal(ev.responses.Alex.availability, null) // availability comes from /responses

  const range = "timeMin=2026-11-18T14:00:00.000Z&timeMax=2026-11-20T14:00:00.000Z"
  const responses = (await call("GET", `/api/events/${eventId}/responses?${range}`)).body
  assert.deepEqual(responses.Alex.availability, ["2026-11-18T15:00:00Z", "2026-11-18T15:15:00Z"])
  assert.equal(responses.Alex.email, "")
  assert.equal((await call("GET", `/api/events/${eventId}/responses`)).status, 400)

  await call("POST", `/api/events/${eventId}/response`, { ...save, name: "Sam" })
  assert.equal((await call("POST", `/api/events/${eventId}/rename-user`, { oldName: "Alex", newName: "Sam" })).status, 400)
  assert.equal((await call("POST", `/api/events/${eventId}/rename-user`, { oldName: "Alex", newName: "Alexandra" })).status, 200)
  ev = (await call("GET", `/api/events/${shortId}`)).body
  assert.deepEqual(Object.keys(ev.responses).sort(), ["Alexandra", "Sam"])

  assert.equal((await call("DELETE", `/api/events/${eventId}/response`, { guest: true, name: "Sam" })).status, 200)
  ev = (await call("GET", `/api/events/${shortId}`)).body
  assert.deepEqual(Object.keys(ev.responses), ["Alexandra"])
  assert.equal(ev.numResponses, 1)
})

test("edit keeps fields that aren't sent", async () => {
  const { eventId, shortId } = (await call("POST", "/api/events", poll)).body
  const edit = { ...poll, name: "Renamed", description: "Bring snacks", timezone: undefined }
  assert.equal((await call("PUT", `/api/events/${eventId}`, edit)).status, 200)
  const ev = (await call("GET", `/api/events/${shortId}`)).body
  assert.equal(ev.name, "Renamed")
  assert.equal(ev.description, "Bring snacks")
  assert.equal(ev.timezone, "America/New_York")
  assert.equal((await call("PUT", `/api/events/${eventId}`, { ...poll, type: "group" })).status, 400)
})

test("sign-up form responses by name", async () => {
  const block = "6650f0f0f0f0f0f0f0f0f0f0"
  const { eventId, shortId } = (await call("POST", "/api/events", {
    ...poll,
    isSignUpForm: true,
    signUpBlocks: [{ _id: block, name: "Setup", capacity: 2, startDate: poll.dates[0], endDate: poll.dates[1] }],
  })).body
  await call("POST", `/api/events/${eventId}/response`, { guest: true, name: "Alex", signUpBlockIds: [block] })
  let ev = (await call("GET", `/api/events/${shortId}`)).body
  assert.deepEqual(ev.signUpBlocks[0], { _id: block, name: "Setup", capacity: 2, startDate: "2026-11-18T14:00:00Z", endDate: "2026-11-19T14:00:00Z" })
  assert.deepEqual(ev.signUpResponses.Alex.signUpBlockIds, [block])
  await call("DELETE", `/api/events/${eventId}/response`, { guest: true, name: "Alex" })
  ev = (await call("GET", `/api/events/${shortId}`)).body
  assert.deepEqual(ev.signUpResponses, {})
})

test("repeated misses on event lookups are rate limited per IP", async () => {
  const ip = "198.51.100.7"
  let status = 0
  for (let i = 0; i < 61 && status !== 429; i++) status = (await call("GET", "/api/events/nope42", undefined, ip)).status
  assert.equal(status, 429)
  assert.equal((await call("GET", "/api/health", undefined, ip)).status, 200)
})

test.after(() => setTimeout(() => process.exit(0), 50)) // the cached Mongo client keeps the process alive
