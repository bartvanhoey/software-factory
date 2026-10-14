// The pool of worker Boxes. Box labels are the shared state, because every run can read and write them through the Upstash API.
import { Box } from "@upstash/box"

// Settings: how many workers, and how long a run waits for a free one.
export const WORKER_COUNT = 2
export const NAME_PREFIX = "factory-worker-"
const WAIT_FOR_WORKER_MINUTES = 30

// The labels. A Box holds at most 5 labels of at most 20 characters each.
export const POOL_LABEL = "factory"
export const BUSY_LABEL = "busy"
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The names of the workers that should exist, and the Boxes that do exist. The prefix filter skips the Boxes of Steps 5 and 6.
export const workerNames = () => Array.from({ length: WORKER_COUNT }, (_, i) => `${NAME_PREFIX}${i + 1}`)
export const listWorkers = async () => (await Box.list({ label: POOL_LABEL })).filter((box) => box.name?.startsWith(NAME_PREFIX))

// Create one worker Box. The workers script pauses it right after.
export const createWorkerBox = (name) => Box.create({ name, labels: [POOL_LABEL], runtime: "node", browser: true, timeout: REQUEST_TIMEOUT_MS })

// Wait for a free worker and mark it as busy. Returns null when none became free in time.
export async function claimWorker(runId) {
  const runLabel = `run-${runId}`.slice(0, 20)
  const deadline = Date.now() + WAIT_FOR_WORKER_MINUTES * 60_000

  for (let attempt = 0; Date.now() < deadline; attempt++) {
    // Free means: not busy, and not broken or still being created.
    const free = (await listWorkers()).filter((w) => !["creating", "error", "deleted"].includes(w.status) && !w.labels?.includes(BUSY_LABEL))
    if (free.length === 0) {
      console.log("No free worker. Checking again in 30 seconds.")
      await sleep(30_000)
      continue
    }

    // Runs that start together would all pick the same worker, so the pick starts at an offset taken from the run id.
    const offset = Number(String(runId).replace(/\D/g, "").slice(-6)) + attempt
    const data = free[offset % free.length]
    const box = await Box.get(data.id, { timeout: REQUEST_TIMEOUT_MS })

    // Mark the worker as busy, and as ours. Failing to add a label also means that another run got there first.
    try {
      if ((await box.labels.list()).includes(BUSY_LABEL)) continue
      await box.labels.add(runLabel)
      await box.labels.add(BUSY_LABEL)
    } catch (error) {
      console.log(`Could not claim ${data.name} (${error.message}). Trying another.`)
      await box.labels.remove(runLabel).catch(() => {})
      await sleep(2_000 + Math.random() * 3_000)
      continue
    }

    // Give a rival run a moment to add its label, then look again. The lowest run label wins.
    await sleep(4_000)
    const rivals = (await box.labels.list()).filter((label) => label.startsWith("run-") && label !== runLabel)
    if (rivals.some((label) => label < runLabel)) {
      console.log(`${data.name} was claimed by another run at the same moment. Trying another.`)
      await box.labels.remove(runLabel)
      continue
    }

    // A paused worker has to be woken up before we run commands in it.
    if (data.status === "paused") await box.resume()
    return { box, name: data.name, runLabel }
  }
  return null
}

// Give the worker back: remove our labels, and let it sleep.
export async function releaseWorker({ box, name, runLabel }) {
  try {
    await box.labels.remove(runLabel)
    await box.labels.remove(BUSY_LABEL)
    await box.pause()
    console.log(`Released worker ${name} and paused its Box.`)
  } catch (error) {
    console.error(`Could not fully release worker ${name}: ${error.message}`)
  }
}