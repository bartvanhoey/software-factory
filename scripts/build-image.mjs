// Builds the worker image: runs worker/setup.sh in one worker's Box, cleans the Box, and takes a snapshot of it.
// Preview: node --env-file=.env scripts/build-image.mjs <worker name>
// Build:   node --env-file=.env scripts/build-image.mjs <worker name> --yes
import { readFileSync } from "node:fs"
import { Box } from "@upstash/box"
import { BUSY_LABEL, listWorkers } from "../src/pool.mjs"

// Settings: where the package files of the app come from, and what the image is called.
const APP_REPO = "bartvanhoey/software-factory-demo-app"
const BASE_BRANCH = "main"
const SNAPSHOT_NAME = `factory-worker-${new Date().toISOString().slice(0, 10)}`
const BUILD_TIMEOUT_MINUTES = 30

// Places in the Box, and text that gives away a secret.
const HOME = "/workspace/home"
const BUILD_DIR = `${HOME}/.image-build`
const SECRET_PATTERNS = ["github_pat_", "ghp_", "gho_", "sk-ant-", '"refresh_token"']

const [workerName] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
const yes = process.argv.includes("--yes")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

// Run a short shell command in the Box, and throw on a non-zero exit code 
// (the helper from Step 5).
async function sh(box, command, { allowFailure = false } = {}) {
  const run = await box.exec.command(`( ${command} ) 2>&1; echo "__EXIT__$?"`)
  const match = /__EXIT__(\d+)\s*$/.exec(run.result ?? "")
  const code = match ? Number(match[1]) : 1
  const output = (run.result ?? "").replace(/__EXIT__\d+\s*$/, "").trimEnd()
  if (code !== 0 && !allowFailure) throw new Error(`Command failed with exit code ${code}:\n${output.slice(-2000)}`)
  return { code, output }
}

// Run a longer bash script in the Box in the background and poll until it ends 
// (the helper from Step 6).
async function runScript(box, name, lines, timeoutMinutes) {
  const base = `${BUILD_DIR}/${name}`
  await box.files.write({ path: `${base}.sh`, content: ["#!/bin/bash", `exec > ${base}.log 2>&1`, "set -e", ...lines, ""].join("\n") })
  await sh(box, `rm -f ${base}.exit && nohup setsid bash -lc ${q(`bash ${base}.sh; echo $? > ${base}.exit`)} > /dev/null 2>&1 & echo started`)
  const started = Date.now()
  while (Date.now() - started < timeoutMinutes * 60_000) {
    await sleep(10_000)
    const { output } = await sh(box, `cat ${base}.exit 2>/dev/null || echo running`)
    if (output.trim() !== "running") {
      const log = (await sh(box, `tail -n 80 ${base}.log`, { allowFailure: true })).output
      return { passed: output.trim() === "0", log }
    }
    console.log(`  ${name} is still running...`)
  }
  throw new Error(`"${name}" did not finish within ${timeoutMinutes} minutes.`)
}

// Read one file of the app from GitHub, with the factory token from Step 4.2. 
// The token stays on this machine.
async function fetchAppFile(path) {
  const response = await fetch(`https://api.github.com/repos/${APP_REPO}/contents/${path}?ref=${BASE_BRANCH}`, {
    headers: { Authorization: `Bearer ${process.env.FACTORY_GITHUB_TOKEN}`, Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28" },
  })
  if (!response.ok) throw new Error(`GitHub GET ${path} failed: ${response.status}`)
  return response.text()
}

async function main() {
  // Pick the worker to build in. It must exist, and it must not be working on an issue.
  const workers = await listWorkers()
  const worker = workers.find((w) => w.name === workerName)
  if (!worker) throw new Error(`Usage: build-image.mjs <worker name> [--yes]. Workers: ${workers.map((w) => w.name).join(", ") || "none yet"}`)
  if (worker.labels?.includes(BUSY_LABEL)) throw new Error(`${worker.name} is busy. Pick a free worker.`)

  // Say what we are about to do, and create nothing until --yes is given.
  console.log(`Image name:   ${SNAPSHOT_NAME}`)
  console.log(`Built in:     ${worker.name} (${worker.id})`)
  console.log(`Setup script: worker/setup.sh, with the package files of ${APP_REPO}`)
  if (!yes) {
    console.log("\nPreview only. Add --yes to build. It takes a few minutes.")
    return
  }

  // Mark the worker as busy, so that no run starts in it while we build.
  const box = await Box.get(worker.id, { timeout: 15 * 60 * 1000 })
  await box.labels.add(BUSY_LABEL)
  try {
    if (worker.status === "paused") await box.resume()

    // An image passes on the browser access of the Box it was built in, so check it before we build.
    await box.browser.listTabs().catch((error) => {
      if (/not enabled/i.test(error.message)) throw new Error(`${worker.name} has no browser access, and every worker made from the image would have none. Browser access cannot be added to an existing Box. Delete the workers and create them again first.`)
      throw error
    })

    // Put the setup script and the package files of the app in the Box, and run the script.
    await sh(box, `rm -rf ${BUILD_DIR} && mkdir -p ${BUILD_DIR}/app`)
    await box.files.write({ path: `${BUILD_DIR}/app/package.json`, content: await fetchAppFile("package.json") })
    await box.files.write({ path: `${BUILD_DIR}/app/package-lock.json`, content: await fetchAppFile("package-lock.json") })
    await box.files.write({ path: `${BUILD_DIR}/setup.sh`, content: readFileSync(new URL("../worker/setup.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n") })
    const result = await runScript(box, "build", [`bash ${BUILD_DIR}/setup.sh`], BUILD_TIMEOUT_MINUTES)
    console.log(result.log)
    if (!result.passed) throw new Error("worker/setup.sh failed, so no snapshot was taken.")

    // Remove everything that belongs to a job and not to the image: 
    // sign-in files, clones, transcripts of old agent runs.
    await sh(box, `cd ${HOME} && rm -rf .image-build work job .factory .claude/projects ~/.git-credentials /tmp/.npm-cache/_logs`)
    console.log("\nRemoved sign-in files, old workspaces and the build folder.")

    // Last line of defence: refuse to snapshot when anything that looks like a secret 
    // is still on the disk.
    const leaks = await sh(box, `grep -rIlE --exclude-dir=node_modules --exclude-dir=_cacache '${SECRET_PATTERNS.join("|")}' /home/boxuser ${HOME} /tmp/.npm-cache 2>/dev/null | head -n 10`, { allowFailure: true })
    if (leaks.output.trim()) throw new Error(`These files still hold something that looks like a secret, so no snapshot was taken:\n${leaks.output}`)
    console.log("Secret scan clean.")

    // Take the snapshot. This waits until it is ready.
    const snapshot = await box.snapshot({ name: SNAPSHOT_NAME })
    console.log(`\nSnapshot ${snapshot.name} is ready.\nSnapshot id: ${snapshot.id}\nPaste this id into SNAPSHOT_ID in src/pool.mjs.`)
  } finally {
    // Give the worker back.
    await box.labels.remove(BUSY_LABEL).catch(() => {})
    await box.pause().catch(() => {})
    console.log("Worker released and paused.")
  }
}

// Do not call process.exit() after fetch: on Windows it can crash Node. 
// Set the exit code instead.
try {
  await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}