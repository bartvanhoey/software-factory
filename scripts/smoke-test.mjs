import { Box } from "@upstash/box"

const HOME = "/workspace/home"
const ENV_FILE = `${HOME}/.factory/env`

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!token) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN is not set. Run this with: node --env-file=.env scripts/smoke-test.mjs --yes")
  process.exit(1)
}

console.log("Box to create: factory-smoke-claude (stock Upstash image, Node runtime, browser access on)")
if (!process.argv.includes("--yes")) {
  console.log("\nPreview only. Add --yes to run the test. It uses one Box slot and a little of your Claude quota.")
  process.exit(0)
}

// Runs a short shell command in the Box. The Box runs plain `sh`, so we append
// the exit code to the output to be sure that a failure is never silent.
async function sh(box, command, { allowFailure = false } = {}) {
  const run = await box.exec.command(`( ${command} ) 2>&1; echo "__EXIT__$?"`)
  const match = /__EXIT__(\d+)\s*$/.exec(run.result ?? "")
  const code = match ? Number(match[1]) : 1
  const output = (run.result ?? "").replace(/__EXIT__\d+\s*$/, "").trimEnd()
  if (code !== 0 && !allowFailure) throw new Error(`Command failed with exit code ${code}:\n${output.slice(-2000)}`)
  return { code, output }
}

const box = await Box.create({
  name: "factory-smoke-claude",
  labels: ["factory", "smoke-test"],
  runtime: "node",
  browser: true,
})

console.log(`Created Box ${box.id}`)

let passed = false

try {
  // What does a stock Box contain?
  const facts = await sh(box, 'echo "user=$(whoami) arch=$(uname -m)"; for t in node npm git python3 claude; do printf "%s: " $t; ($t --version 2>/dev/null || echo "not installed") | head -n 1; done')
  console.log(facts.output)

  // Browser access can only be switched on when a Box is created.
  await box.browser.listTabs()
  console.log("browser access: yes")

  // Sign in: the token goes in a file that only this user can read.
  await sh(box, `mkdir -p ${HOME}/.factory && chmod 700 ${HOME}/.factory`)
  await box.files.write({ path: ENV_FILE, content: `export CLAUDE_CODE_OAUTH_TOKEN='${token}'\n` })
  await sh(box, `chmod 600 ${ENV_FILE}`)

  // Headless Claude Code. No permission prompts, because nobody can answer one in a Box.
  const answer = await sh(
    box,
    `. ${ENV_FILE} && export PATH=$HOME/.local/bin:$PATH && cd ${HOME} && claude -p "Reply with exactly: BOX OK" --dangerously-skip-permissions --output-format text`,
    { allowFailure: true },
  )
  console.log(`Exit code ${answer.code}\nClaude said: ${answer.output}`)
  passed = answer.code === 0 && answer.output.includes("BOX OK")
} catch (error) {
  console.error(`\n${error.message}`)
} finally {
  // Remove the token, then the Box. It was created seconds ago and holds nothing.
  await sh(box, `rm -rf ${HOME}/.factory`, { allowFailure: true }).catch(() => {})
  await box.delete()
  console.log(`\nDeleted Box ${box.id}.`)
}

console.log(passed ? "\nPASS: Claude Code answered from inside a Box." : "\nFAIL: see the output above.")
process.exitCode = passed ? 0 : 1