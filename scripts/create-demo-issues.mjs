// Creates the demo issues from scripts/demo-issues.json with the gh CLI.
// Preview:                node scripts/create-demo-issues.mjs
// Create, without labels: node scripts/create-demo-issues.mjs --yes
// Create and start all:   node scripts/create-demo-issues.mjs --yes --ready
//
// With --ready the issues get the ready label and the factory starts on all of them at once.
// gh must then be signed in as someone on the allow-list of the trigger workflow (Step 3.3).
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

const yes = process.argv.includes("--yes")
const ready = process.argv.includes("--ready")
const issues = JSON.parse(readFileSync(new URL("./demo-issues.json", import.meta.url), "utf8"))

// One issue per entry. Without --yes we only say what would happen.
for (const issue of issues) {
  if (!yes) {
    console.log(`Would create in ${issue.repo}: ${issue.title}${ready ? " [ready]" : ""}`)
    continue
  }
  const args = ["issue", "create", "--repo", issue.repo, "--title", issue.title, "--body", issue.body]
  if (ready) args.push("--label", "ready")
  const result = spawnSync("gh", args, { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr.trim())
  console.log(result.stdout.trim())
}

if (!yes) console.log(`\nPreview only. ${issues.length} issues would be created. Add --yes to create them.`)