# Create your own Software Factory step by step

## What are we building

A small system with one job: you put a **ready label** on a GitHub issue, a **Coding Agent** implements the issue, and a **Pull Request** comes back for you to **Review and Merge**.

Four hand-offs make up the whole thing:

- Trigger. Someone adds the ready label to an issue and a GitHub Actions workflow starts.
  
- Workspace. The workflow gets a place to run the agent (first the Actions runner itself, later an isolated sandbox).

- Agent. It checks out the repo, hands a coding agent the issue text in headless mode, and lets it edit files.

- Result. It runs the repo's checks, pushes a factory/issue-N branch, opens a PR that closes the issue, and updates labels.

The goal of this step-by-step guide is to understand each of these mechanics, so we build every piece ourselves and add no ready-made framework.

## Prerequisites

- node.js installed on your machine
- Git installed on your machine
- A GitHub account
- GitHub CLI installed on your machine
- A Vercel account (only needed because the demo app deploys previews).
- An Upstash account with a Box API key (Part 3).
- A Claude Pro, Max, Team or Enterprise subscription for the agent's sign-in (Part 3).

## Step-by-step instructions

### Step 1: Create 2 private GitHub repositories, one for the **Software Factory** and one for the **Demo application**

| Repo | Role |
|------|------|
| `software-factory` | The factory: workflow, scripts, config, and this step-by-step guide. |
| `software-factory-demo-app` | The app the factory works on. Its only factory-related file will be a small trigger workflow. |

Clone both repositories to your local machine.

### Step 2: Create a new Next.js application

Create and run a new **Next.js application** with recommended default settings

```bash
    npx create-next-app@latest software-factory-demo-app
```

When the app is created, navigate to the app folder and run the development server using the following commands:

```bash
    cd software-factory-demo-app
    npm run dev
```

Navigate to `http://localhost:3000` in your browser to see the app running.

Navigate to Vercel and create a new project. Connect your GitHub account and select the `software-factory-demo-app` repository.
Deploy the app to Vercel. Make sure to specify Nextjs in Settings > Build and Deployment > Framework Preset.
After the deployment is complete, you will get a URL for your deployed app.

Push the app to your GitHub repository using the following commands:

```bash
    git add .
    git commit -m "Initial commit"
    git push -u origin main
```

### Step 3: Wire the trigger and prove it with a dry run

In this step we build the first hand-off: adding the **ready label** to an issue in the demo app starts a workflow in the factory repo. No agent runs yet. The factory workflow only prints which issue it received, and the GitHub Actions runner is our temporary workspace.

#### 3.1 Create the trigger token

The factory uses **two fine-grained GitHub tokens**, each with the least access it needs:

| Token | Secret name | Stored in | Repository access | Permissions |
|-------|-------------|-----------|-------------------|-------------|
| Trigger token | `FACTORY_TRIGGER_TOKEN` | Demo app | `software-factory` only | Actions: Read and write |
| Factory token | `FACTORY_GITHUB_TOKEN` | Factory repo | `software-factory-demo-app` only | Contents, Pull requests, Issues: Read and write |

The reason for two: the agent will later push branches to the demo app, so every secret stored there is within reach of the agent (and of the issue text it reads). The trigger token can do nothing except start a workflow in the factory repo. It cannot read or change any code. The factory token never leaves the factory repo.

In this step we only need the trigger token. The factory token comes in the next step, when the agent starts working.

1. Go to GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens > **Generate new token**.
2. Token name: `software-factory-trigger`.
3. Resource owner: your account.
4. Repository access: **Only select repositories** > `software-factory`.
5. Repository permissions: **Actions** set to **Read and write**. Leave everything else on No access.
6. Generate the token and copy it. You will not see it again.

Store it as a secret in the **demo app** repo:

```bash
    gh secret set FACTORY_TRIGGER_TOKEN --repo YOUR-USERNAME/software-factory-demo-app
```

Paste the token when asked.

#### 3.2 Create the labels

Create the ready label and the three labels that show the state of an issue. Run this from any folder:

```bash
    gh label create ready --color 0E8A16 --description "Start the factory" --repo YOUR-USERNAME/software-factory-demo-app
    gh label create "factory:running" --color FBCA04 --description "An agent is working on this" --repo YOUR-USERNAME/software-factory-demo-app
    gh label create "factory:review" --color 1D76DB --description "A pull request is waiting for review" --repo YOUR-USERNAME/software-factory-demo-app
    gh label create "factory:needs-attention" --color D93F0B --description "The factory could not finish" --repo YOUR-USERNAME/software-factory-demo-app
```

Only `ready` is used in this step. The other three are used once the agent runs.

#### 3.3 Add the trigger workflow to the demo app

Create the file `.github/workflows/factory-ready.yml` locally in VS Code, in your clone of the **demo app** repo (`software-factory-demo-app`, not `software-factory`).

Then open the folder in VS Code, create `factory-ready.yml` inside `.github/workflows` and paste in the following:

```yaml
name: Send ready issue to factory

on:
  issues:
    types: [labeled]

permissions:
  contents: read

jobs:
  notify:
    # Only people on this list may start the factory.
    if: >-
      github.event.label.name == 'ready' &&
      github.event.issue.state == 'open' &&
      contains(fromJSON('["YOUR-USERNAME"]'), github.actor)
    runs-on: ubuntu-latest
    steps:
      - name: Start the factory
        env:
          GH_TOKEN: ${{ secrets.FACTORY_TRIGGER_TOKEN }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
        run: |
          gh workflow run factory.yml \
            --repo YOUR-USERNAME/software-factory \
            --ref main \
            -f repo="$GITHUB_REPOSITORY" \
            -f issue="$ISSUE_NUMBER"
```

Replace `YOUR-USERNAME` (two places) with your GitHub username.

A few things worth knowing:

- `--ref main` is needed. Without it, `gh` first asks GitHub which branch is the default, and the trigger token is not allowed to ask that (it only has the Actions permission). The run then fails with `Resource not accessible by personal access token (repository.defaultBranchRef)`. If your factory repo's default branch is not called `main`, use its name.
- Only the `labeled` event is used. Listening to `opened` as well would start the factory twice for an issue that is created with the label already on it.
- The `contains(...)` line is the allow-list. A run later spends your agent subscription, so only the people listed may start it. Anyone else who adds the label is ignored.
- GitHub only runs issue workflows from the **default branch**, so this file must be on `main`.

```bash
    git add .github/workflows/factory-ready.yml
    git commit -m "Add factory trigger workflow"
    git push
```

#### 3.4 Add the factory workflow to the factory repo

Create the file `.github/workflows/factory.yml` in the **software-factory** repo:

```yaml
name: Factory

on:
  workflow_dispatch:
    inputs:
      repo:
        description: App repo, for example owner/name
        required: true
      issue:
        description: Issue number
        required: true

permissions:
  contents: read

run-name: "${{ inputs.repo }} #${{ inputs.issue }}"

jobs:
  work:
    runs-on: ubuntu-latest
    steps:
      - name: Show what we received
        env:
          FACTORY_REPO: ${{ inputs.repo }}
          FACTORY_ISSUE: ${{ inputs.issue }}
        run: |
          echo "Repo:  $FACTORY_REPO"
          echo "Issue: $FACTORY_ISSUE"
```

```bash
    cd software-factory
    git add .github/workflows/factory.yml
    git commit -m "Add factory workflow"
    git push
```

The factory workflow is started with `workflow_dispatch`, and the workflow file has to exist on the default branch of the factory repo before it can be started. The inputs go through `env` variables instead of straight into the script, so that text in an input can never be run as a command. You can also start this workflow by hand from the Actions tab, which is handy for testing.

#### 3.5 Test it

1. In the demo app repo, create an issue, for example "Change the homepage title".
2. Add the `ready` label to it.
3. Open the **Actions** tab of the `software-factory` repo. Exactly one **Factory** run should appear, named after your repo and issue number, and its log shows the repo and issue number you sent.

If no run appears, check in this order:

1. The trigger workflow is on the default branch of the demo app.
2. You are the person listed in the allow-list.
3. The demo app has the secret `FACTORY_TRIGGER_TOKEN`.
4. The trigger token has access to the `software-factory` repo with Actions set to Read and write, and has not expired.
5. GitHub Actions are enabled in both repos.

When the run shows up, the trigger works. Remove the `ready` label from the test issue so it does not fire again by accident. In the next step we set up the accounts the agent needs.

### Step 4: Create the factory token and the agent accounts

The agent needs three secrets, and all three live in the **factory repo**, never in the demo app:

| Secret | What it is | Used for |
|--------|------------|----------|
| `FACTORY_GITHUB_TOKEN` | Fine-grained GitHub token (the second token from Step 3.1) | Reading the issue, pushing the branch and opening the pull request in the demo app |
| `UPSTASH_BOX_API_KEY` | Upstash Box API key | Creating and running the sandboxes the agent works in |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude sign-in token | Letting Claude Code run in the sandbox on your Claude subscription |

You also keep a copy of each in a local `.env` file in the factory repo, because the scripts we write later run on your machine.

#### 4.1 Prepare the local `.env` file

In the **software-factory** repo, check that `.env` is ignored by git before anything secret goes in it:

```bash
    cd software-factory
    echo .env >> .gitignore
    git check-ignore .env
```

The last command must print `.env`. If it prints nothing, stop and fix `.gitignore` first. Then create the file `.env` in VS Code with this content, and fill in the values as you create them in the next steps:

```bash
    FACTORY_GITHUB_TOKEN=
    UPSTASH_BOX_API_KEY=
    CLAUDE_CODE_OAUTH_TOKEN=
```

#### 4.2 Create the factory token

1. Go to GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens > **Generate new token**
2. Token name: `software-factory-agent`.
3. Resource owner: your account.
4. Repository access: **Only select repositories** > `software-factory-demo-app`. Do **not** add `software-factory`.
5. Repository permissions: **Contents**, **Pull requests** and **Issues**, all set to **Read and write**. Leave everything else on No access.
6. Generate the token and copy it. You will not see it again.

Paste it into `.env` as `FACTORY_GITHUB_TOKEN`.

The agent only ever works in the demo app, so that is the only repo this token can touch. It cannot change the factory repo, and it cannot see the Upstash key or the Claude token.

#### 4.3 Create the Upstash Box API key

1. Sign in to the [Upstash console](https://console.upstash.com) and open the **Box** section. Create an account first if you do not have one.
2. Create a new **Box API key** and copy it.
3. Paste it into `.env` as `UPSTASH_BOX_API_KEY`.

Check the Box limit of your Upstash plan while you are there. Each worker is one Box, and paused Boxes count too. On the free plan the limit was 10 Boxes in total.

#### 4.4 Sign Claude Code in

Claude Code runs in a sandbox where nobody can open a browser, so it signs in with a long-lived token made from your Claude subscription (Pro, Max, Team or Enterprise).

1. Open a **real terminal** (the VS Code terminal works) and run:

```bash
    claude setup-token
```

2. A browser window opens. Sign in with your Claude account and approve.
3. The terminal prints a token that lasts a year. It is not saved anywhere, so copy it right away.
4. Paste it into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`.

Check that your plan's terms allow automated, unattended use. All workers share the rate limits of this one subscription. If you prefer to pay per token instead, create an Anthropic API key with a spending limit for this project, and use `ANTHROPIC_API_KEY` in place of `CLAUDE_CODE_OAUTH_TOKEN`.

#### 4.5 Store the secrets in the factory repo

Load the values from `.env` into the repo secrets, so nothing is typed or shown on screen. Run these commands in **Git Bash**, and not in cmd or PowerShell. Those two do not expand `$FACTORY_GITHUB_TOKEN`, they pass it on as literal text, and the secret then holds the words `$FACTORY_GITHUB_TOKEN` instead of your token. Nothing warns you about it, and later GitHub answers `401 Bad credentials`. Git Bash shows `MINGW64` in its prompt.

```bash
    cd software-factory
    set -a; source <(tr -d '\r' < .env); set +a
    gh secret set FACTORY_GITHUB_TOKEN --repo YOUR-USERNAME/software-factory --body "$FACTORY_GITHUB_TOKEN"
    gh secret set UPSTASH_BOX_API_KEY --repo YOUR-USERNAME/software-factory --body "$UPSTASH_BOX_API_KEY"
    gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo YOUR-USERNAME/software-factory --body "$CLAUDE_CODE_OAUTH_TOKEN"
```

Replace `YOUR-USERNAME` (three places) with your GitHub username.

Check that all three exist in the Software Factory repo (GitHub never shows their values):

```bash
    gh secret list --repo YOUR-USERNAME/software-factory
```

You should see `FACTORY_GITHUB_TOKEN`, `UPSTASH_BOX_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`.

The demo app should only have `FACTORY_TRIGGER_TOKEN`. You can check that with the same command:

```bash
    gh secret list --repo YOUR-USERNAME/software-factory-demo-app
```

A few things worth knowing:

- `tr -d '\r'` removes the invisible carriage return that Windows editors such as VS Code add to the end of each line of `.env`. Without it, every secret is stored with a `\r` at the end, and GitHub later rejects the token with `401 Bad credentials`. Node's `--env-file` ignores the `\r`, so the scripts on your own machine keep working and hide the problem.
- Never paste a token into a chat, an issue or a commit. If one leaks, delete or regenerate it right away.
- Fine-grained tokens expire (you choose the date when you create them), and the Claude token lasts a year. Write down the dates, and put a reminder in your calendar.
- When you finish the project, rotate or delete all four secrets.
- In the next step we create one sandbox and prove that the agent can sign in and answer.

### Step 5: Smoke-test one sandbox in Upstash

In this step we build the second hand-off: the **workspace**. We create one Upstash **Box** (a sandbox) from a script on your machine, sign Claude Code in inside it, ask it to reply `BOX OK`, and delete the Box again.

No repo is touched and no issue is involved. If this works, the Box key, the Claude CLI and the sign-in token are all proven, and everything later builds on that.

#### What are we proving

Until now the factory workflow ran on the GitHub Actions runner, which was only a temporary workspace. The real agent will run inside a Box, so before building on it we check the three things it depends on, with a one-line question instead of a real issue:

1. **The Box key.** Can your machine create a Box on your Upstash account?
2. **Claude Code in the Box.** Is the `claude` CLI there, and does it run?
3. **The Claude token.** Can Claude Code sign in inside the Box, where nobody can open a browser, and answer?

Finding out now is much cheaper than finding out later, mixed in with GitHub tokens, branches and pull requests. The smoke test is also a small rehearsal of the real job: create a Box, put the token in, run `claude -p`, collect the answer. Only the prompt will differ.

#### 5.1 Set up the project

In the **software-factory** repo, create a `package.json`, install the Box SDK, and make sure `node_modules` is ignored by git:

```bash
    cd software-factory
    npm init -y
    npm pkg set type=module
    npm install @upstash/box
    echo node_modules >> .gitignore
```

`"type": "module"` lets us use `import` in our scripts. The SDK reads your key from the environment variable `UPSTASH_BOX_API_KEY`, and we pass `.env` to Node with `--env-file`, so you need Node 20.6 or newer.

#### 5.2 Write the smoke test

Create the file `scripts/smoke-test.mjs` in the **software-factory** repo and paste in the following:

```js
// The Box SDK, and the folder and file inside the Box where the token will live.
import { Box } from "@upstash/box"

const HOME = "/workspace/home"
const ENV_FILE = `${HOME}/.factory/env`

// Stop early if the Claude token is missing, before anything is created.
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!token) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN is not set. Run this with: node --env-file=.env scripts/smoke-test.mjs --yes")
  process.exit(1)
}

// Preview mode: say what would happen and create nothing until --yes is given.
console.log("Box to create: factory-smoke-claude (stock Upstash image, Node runtime, browser access on)")
if (!process.argv.includes("--yes")) {
  console.log("\nPreview only. Add --yes to run the test. It uses one Box slot and a little of your Claude quota.")
  process.exit(0)
}

// sh is a helper function that runs a shell command in the Box and throws on a non-zero exit code, so a failure is never silent.
async function sh(box, command, { allowFailure = false } = {}) {
  const run = await box.exec.command(`( ${command} ) 2>&1; echo "__EXIT__$?"`)
  const match = /__EXIT__(\d+)\s*$/.exec(run.result ?? "")
  const code = match ? Number(match[1]) : 1
  const output = (run.result ?? "").replace(/__EXIT__\d+\s*$/, "").trimEnd()
  if (code !== 0 && !allowFailure) throw new Error(`Command failed with exit code ${code}:\n${output.slice(-2000)}`)
  return { code, output }
}

// Create the sandbox. Browser access can only be switched on here, at creation.
const box = await Box.create({
  name: "factory-smoke-claude",
  labels: ["factory", "smoke-test"],
  runtime: "node",
  browser: true,
})
console.log(`Created Box ${box.id}`)

// Everything below runs inside try, so that finally always cleans up.
let passed = false
try {
  // What does a stock Box contain?
  const facts = await sh(box, 'echo "user=$(whoami) arch=$(uname -m)"; for t in node npm git python3 claude; do printf "%s: " $t; ($t --version 2>/dev/null || echo "not installed") | head -n 1; done')
  console.log(facts.output)

  // Check that the Box really has browser access (this throws if it does not).
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

// Report the verdict, and set the exit code so that scripts and CI can tell pass from fail.
console.log(passed ? "\nPASS: Claude Code answered from inside a Box." : "\nFAIL: see the output above.")
process.exitCode = passed ? 0 : 1
```

What the script does, in order:

- `Box.create` makes the sandbox. `runtime: "node"` picks the Node image, and `browser: true` gives it a Chromium that Upstash runs for us.
- The first command lists which tools the Box has. The Box is Linux on ARM64, the user is `boxuser`, and `sudo` works without a password.
- `box.browser.listTabs()` fails with "browser is not enabled for this box" if the Box has no browser access.
- The token is written to `/workspace/home/.factory/env`, readable only by its owner, and loaded into the shell for just the one `claude` command.
- `claude -p` is Claude Code's headless mode: it answers once and exits. `--dangerously-skip-permissions` switches off the permission questions, which is acceptable here because the Box itself is the sandbox.
- The `finally` block deletes the token file and the Box, whether the test passed or failed.

#### 5.3 Run it

First the preview, which creates nothing:

```bash
    node --env-file=.env scripts/smoke-test.mjs
```

Then the real run:

```bash
    node --env-file=.env scripts/smoke-test.mjs --yes
```

It takes about a minute. The end of the output should look like this:

```text
browser access: yes
Exit code 0
Claude said: BOX OK

Deleted Box ...

PASS: Claude Code answered from inside a Box.
```

If it fails, check in this order:

1. `Box limit` or quota error when creating the Box: your Upstash plan is full. Paused Boxes count too. Delete old ones in the Upstash console.
2. `apiKey is required` or an authorization error: `UPSTASH_BOX_API_KEY` in `.env` is empty or wrong.
3. `claude: not installed` in the tools list: the stock image of your SDK version has no Claude Code. It then has to be installed in a worker image, which we do not cover in this step.
4. `browser is not enabled for this box`: the Box was created without `browser: true`. Browser access cannot be added to a Box that exists, so delete it and run the script again.
5. A "not logged in", "invalid token" or "expired" message from Claude: regenerate the token with `claude setup-token` (Step 4.4) and update `.env`.
6. Claude answers, but not with `BOX OK`: read the printed text, it usually explains what is wrong.

If a run is interrupted before the `finally` block ran, a Box called `factory-smoke-claude` is left behind. Delete it in the Upstash console before you run the script again.

#### 5.4 Optional: choose the model and effort

By default Claude Code picks its own model and reasoning effort. The factory does not pass these as flags. They are stored **in the Box**, in Claude Code's user settings file, so a Box (and later an image made from it) is a fast worker or a deep-thinking worker from the moment it exists. To try it, add this to the script right after the sign-in, before the `claude -p` command:

```js
  await sh(box, `mkdir -p ${HOME}/.claude`)
  await box.files.write({
    path: `${HOME}/.claude/settings.json`,
    content: JSON.stringify({ model: "haiku", effortLevel: "low" }, null, 2) + "\n",
  })
```

`model` takes an alias (`haiku`, `sonnet`, `opus`) or a full model name. `effortLevel` takes `low`, `medium`, `high`, `xhigh` or `max`, depending on the model. Bigger models and higher effort use up your subscription limits faster, and parallel workers multiply that. Decide this before the factory creates its first real Box.

A few things worth knowing:

- Do not add `--bare` to the `claude` command. Bare mode never reads `CLAUDE_CODE_OAUTH_TOKEN`, so it would fail to sign in.
- The Box runs commands with plain `sh`, and a command holds one HTTP request open until it ends. That is fine for this one-line question. A real agent run takes many minutes, so later we start it in the background and poll for the result.
- The token only lives in the Box for the length of the test, and the script deletes it at the end. Never print it in your own debugging output.
- In the next step we let the agent work on a real issue.

### Step 6: Let the agent work on a real issue

In this step we build the last two hand-offs: the **agent** and the **result**.

A script in the factory repo takes one issue of the demo app from start to pull request, and the factory workflow from Step 3 runs that script instead of only printing the issue number.

For one issue, the script does this, in order:

1. Reads the issue and stops unless it is open and carries the `ready` label.
2. Swaps the label `ready` for `factory:running` and comments that work has started.
3. Creates a Box, clones the demo app into it on a new branch `factory/issue-N`, and runs the install command.
4. Signs Claude Code in and gives it the issue text in headless mode. Claude edits the files.
5. Runs the app's checks (here: the build). If they fail, nobody gets a pull request, the issue gets `factory:needs-attention` and a comment with the log.
6. Commits, pushes the branch, opens a pull request that says `Closes #N`, and swaps `factory:running` for `factory:review`.
7. Always, at the end: removes the sign-in file and deletes the Box.

One rule decides the shape of the script: **the agent never gets the GitHub token.** The agent only edits files. The script does all the git work. That way an issue text that tries to talk the agent into pushing somewhere else has nothing to push with.

#### 6.1 Collect your settings

The script has a small settings block at the top. You need four values:

| Setting | Value for the demo app |
|---------|------------------------|
| `APP_REPO` | `YOUR-USERNAME/software-factory-demo-app` |
| `SETUP` | `npm ci`. Installs the dependencies in the Box. |
| `CHECKS` | `npm run build`. Must pass before a pull request is opened. |
| `GIT_AUTHOR` | Your name, and your GitHub **noreply** email address. |

Get your noreply address with:

```bash
    gh api user --jq "\"\(.id)+\(.login)@users.noreply.github.com\""
```

It prints something like `12345678+YOUR-USERNAME@users.noreply.github.com`.

Do not invent an email address for `GIT_AUTHOR`. The demo app deploys previews on Vercel, and Vercel blocks the preview of a commit whose author is not a member of your team. An invented address belongs to some unrelated GitHub user, and your preview will be blocked.

#### 6.2 Write the script

Create the file `src/run.mjs` in the **software-factory** repo and paste in the following. Replace the three `YOUR-...` values in the settings block.

```js
// Takes one ready issue from start to pull request.
// Run locally: node --env-file=.env src/run.mjs YOUR-USERNAME/software-factory-demo-app 1
import { Box } from "@upstash/box"

// Settings: change these to fit your own app.
const APP_REPO = "YOUR-USERNAME/software-factory-demo-app"
const ALLOWED_ACTORS = ["YOUR-USERNAME"]
const BASE_BRANCH = "main"
const SETUP = ["npm ci"]
const CHECKS = ["npm run build"]
const GIT_AUTHOR = { name: "YOUR NAME", email: "12345678+YOUR-USERNAME@users.noreply.github.com" }
const SETUP_TIMEOUT_MINUTES = 20
const AGENT_TIMEOUT_MINUTES = 25

// The labels from Step 3.2, and the places inside the Box that we use.
const LABELS = { ready: "ready", running: "factory:running", review: "factory:review", attention: "factory:needs-attention" }
const HOME = "/workspace/home"
const JOB = `${HOME}/job`
const ENV_FILE = `${HOME}/.factory/env`
const NEEDS_CLARIFICATION = "NEEDS_CLARIFICATION:"

// Input: the repo and issue number, from the command line or from the workflow.
const [repo = process.env.FACTORY_REPO, issueNumber = process.env.FACTORY_ISSUE] = process.argv.slice(2)
const githubToken = process.env.FACTORY_GITHUB_TOKEN
const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN

// Quote a value for the shell, hide secrets in anything we print, and wait.
const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
const hide = (text) => String(text).replaceAll(githubToken ?? "<none>", "***").replaceAll(claudeToken ?? "<none>", "***")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A small GitHub REST helper, using the factory token from Step 4.2.
async function github(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}
const addLabels = (labels) => github(`/repos/${repo}/issues/${issueNumber}/labels`, { method: "POST", body: { labels } })
const comment = (body) => github(`/repos/${repo}/issues/${issueNumber}/comments`, { method: "POST", body: { body } })
const removeLabel = (label) =>
  github(`/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, { method: "DELETE" }).catch((error) => {
    if (!String(error.message).includes(" 404 ")) throw error // the label was not on the issue
  })

// Run a short shell command in the Box, and throw on a non-zero exit code (the helper from Step 5).
async function sh(box, command, { allowFailure = false } = {}) {
  const run = await box.exec.command(`( ${command} ) 2>&1; echo "__EXIT__$?"`)
  const match = /__EXIT__(\d+)\s*$/.exec(run.result ?? "")
  const code = match ? Number(match[1]) : 1
  const output = (run.result ?? "").replace(/__EXIT__\d+\s*$/, "").trimEnd()
  if (code !== 0 && !allowFailure) throw new Error(`Command failed with exit code ${code}:\n${output.slice(-2000)}`)
  return { code, output }
}

// Run a longer bash script in the Box in the background, and poll until it ends.
async function runScript(box, name, lines, timeoutMinutes) {
  const base = `${JOB}/${name}`
  await sh(box, `mkdir -p ${JOB} && rm -f ${base}.exit ${base}.log`)
  await box.files.write({ path: `${base}.sh`, content: ["#!/bin/bash", `exec > ${base}.log 2>&1`, "set -e", ...lines, ""].join("\n") })
  await sh(box, `nohup setsid bash -lc ${q(`bash ${base}.sh; echo $? > ${base}.exit`)} > /dev/null 2>&1 & echo started`)

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

// The task for the agent: the issue, plus the rules of the factory.
const buildPrompt = (issue) => `You are a coding agent. The repository ${repo} is checked out in the current folder, on a new branch.

Implement this GitHub issue.

# Issue #${issue.number}: ${issue.title}

${issue.body?.trim() || "(The issue has no description.)"}

# Rules

- Make the smallest change that fully solves the issue. Follow the style of the existing code.
- Do not run git commit, git push or change git settings. The factory does that after you.
- Do not touch anything in .github/.
- Before you stop, run these commands yourself. They must pass: ${CHECKS.join(" ; ")}
- When you are done, reply with a short summary of what you changed. It becomes the pull request description.
- If the issue is too unclear to implement, change nothing and start your reply with "${NEEDS_CLARIFICATION}" followed by your question.
`

async function main() {
  // Refuse anything that is not meant for this factory.
  if (!repo || !issueNumber) throw new Error("Usage: node src/run.mjs <owner/repo> <issue number>")
  if (repo !== APP_REPO) throw new Error(`${repo} is not ${APP_REPO}, so this run is refused.`)
  if (!githubToken || !claudeToken) throw new Error("FACTORY_GITHUB_TOKEN and CLAUDE_CODE_OAUTH_TOKEN must both be set.")
  // The "Run workflow" button is a second way in, open to everyone with write access to this repo.
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && !ALLOWED_ACTORS.includes(process.env.GITHUB_ACTOR)) {
    throw new Error(`${process.env.GITHUB_ACTOR} is not in ALLOWED_ACTORS, so this run is refused.`)
  }

  // Only work on an open issue that still has the ready label. This also makes a duplicate run harmless.
  const issue = await github(`/repos/${repo}/issues/${issueNumber}`)
  console.log(`Issue ${repo}#${issue.number}: ${issue.title}`)
  if (issue.state !== "open" || !issue.labels.some((label) => label.name === LABELS.ready)) {
    console.log(`Not open with the "${LABELS.ready}" label. Skipping.`)
    return
  }

  // Report a problem on the issue and hand it back to a human.
  const needsAttention = async (message) => {
    await removeLabel(LABELS.ready)
    await removeLabel(LABELS.running)
    await addLabels([LABELS.attention])
    await comment(message)
    console.log(`Issue labelled ${LABELS.attention}.`)
  }

  // Show on the issue that work has started.
  await removeLabel(LABELS.ready)
  await removeLabel(LABELS.attention)
  await addLabels([LABELS.running])
  await comment("The factory picked this up.")

  // Create the Box. Its name has a time part so that a leftover Box never blocks a new run.
  const branch = `factory/issue-${issue.number}`
  const repoDir = `${HOME}/work/${repo.split("/")[1]}`
  const authedUrl = `https://x-access-token:${githubToken}@github.com/${repo}.git`
  const noStore = "-c credential.helper=" // the Box image tells git to save credentials on disk
  const box = await Box.create({ name: `factory-issue-${issue.number}-${Date.now().toString().slice(-6)}`, labels: ["factory", "job"], runtime: "node", timeout: 15 * 60 * 1000 })
  console.log(`Created Box ${box.id}`)

  try {
    // Clone with the token, then remove the token from the clone. It is only used again for the push.
    console.log("\nPreparing the workspace...")
    await sh(box, `rm -rf ${q(repoDir)} ${JOB} ~/.git-credentials && mkdir -p ${JOB}`)
    await sh(box, `git ${noStore} clone --quiet --depth 50 --branch ${q(BASE_BRANCH)} ${q(authedUrl)} ${q(repoDir)}`)
    await sh(box, `cd ${q(repoDir)} && git remote set-url origin https://github.com/${repo}.git && git checkout --quiet -b ${q(branch)} && git config user.name ${q(GIT_AUTHOR.name)} && git config user.email ${q(GIT_AUTHOR.email)}`)

    // Install the dependencies of the app.
    const setup = await runScript(box, "setup", [`cd ${q(repoDir)}`, ...SETUP], SETUP_TIMEOUT_MINUTES)
    if (!setup.passed) {
      await needsAttention(`The setup command failed in the Box, so the agent was not started. This is a factory problem, not a problem with the issue.\n\nLog:\n\n    ${hide(setup.log).slice(-3000).replaceAll("\n", "\n    ")}`)
      return
    }

    // Sign Claude Code in: the token goes in a file that only this user can read.
    console.log("\nSigning in and starting the agent...")
    await sh(box, `mkdir -p ${HOME}/.factory && chmod 700 ${HOME}/.factory`)
    await box.files.write({ path: ENV_FILE, content: `export CLAUDE_CODE_OAUTH_TOKEN='${claudeToken}'\n` })
    await sh(box, `chmod 600 ${ENV_FILE}`)

    // Run the agent. Its final reply is written to summary.md, and becomes the pull request description.
    await box.files.write({ path: `${JOB}/prompt.md`, content: buildPrompt(issue) })
    const agent = await runScript(
      box,
      "agent",
      [`. ${ENV_FILE}`, "export PATH=$HOME/.local/bin:$PATH", `cd ${q(repoDir)}`, `claude -p "$(cat ${JOB}/prompt.md)" --dangerously-skip-permissions --output-format text > ${JOB}/summary.md`],
      AGENT_TIMEOUT_MINUTES,
    )
    const summary = (await sh(box, `cat ${JOB}/summary.md 2>/dev/null`, { allowFailure: true })).output.trim()
    if (!agent.passed) {
      await needsAttention(`The agent stopped with an error.\n\nLog:\n\n    ${hide(agent.log).slice(-3000).replaceAll("\n", "\n    ")}`)
      return
    }

    // The agent may hand the issue back with a question instead of a change.
    if (summary.startsWith(NEEDS_CLARIFICATION)) {
      await needsAttention(`The agent needs more detail before it can start:\n\n> ${summary.slice(NEEDS_CLARIFICATION.length).trim()}\n\nEdit the issue, then add the \`${LABELS.ready}\` label again.`)
      return
    }

    // Run the checks ourselves. We do not take the agent's word for it.
    console.log("\nRunning checks...")
    const checks = await runScript(box, "checks", [`cd ${q(repoDir)}`, ...CHECKS], SETUP_TIMEOUT_MINUTES)
    if (!checks.passed) {
      await needsAttention(`The change did not pass the checks, so no pull request was opened.\n\nLog:\n\n    ${hide(checks.log).slice(-3000).replaceAll("\n", "\n    ")}`)
      return
    }

    // Did the agent change anything at all?
    const status = (await sh(box, `cd ${q(repoDir)} && git add -A && git status --porcelain`)).output.trim()
    if (!status) {
      await needsAttention(`The agent finished without changing any files.\n\nIts reply:\n\n> ${summary || "(empty)"}`)
      return
    }
    console.log(`\nChanged files:\n${status}`)

    // Commit and push. Only now does the token come back, and the agent is long finished.
    await sh(box, `cd ${q(repoDir)} && git commit --quiet -m ${q(`${issue.title}\n\nCloses #${issue.number}`)}`)
    await sh(box, `cd ${q(repoDir)} && git ${noStore} push --quiet --force ${q(authedUrl)} ${q(`${branch}:${branch}`)}`)

    // Open the pull request, or update the open one when this issue is run again.
    const prBody = `Closes #${issue.number}\n\n${summary || "(The agent gave no summary.)"}\n\n---\nBuilt by the factory in an Upstash Box. Checks passed: ${CHECKS.map((c) => `\`${c}\``).join(", ")}.`
    const open = await github(`/repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${encodeURIComponent(branch)}`)
    const pr = open.length
      ? await github(`/repos/${repo}/pulls/${open[0].number}`, { method: "PATCH", body: { title: issue.title, body: prBody } })
      : await github(`/repos/${repo}/pulls`, { method: "POST", body: { head: branch, base: BASE_BRANCH, title: issue.title, body: prBody } })
    console.log(`\nPull request: ${pr.html_url}`)

    // Show on the issue that a pull request is waiting.
    await removeLabel(LABELS.running)
    await addLabels([LABELS.review])
    await comment(`Pull request ready for review: ${pr.html_url}`)
  } catch (error) {
    await needsAttention(`The factory hit an error:\n\n    ${hide(error.message).slice(0, 1500).replaceAll("\n", "\n    ")}`).catch(() => {})
    throw error
  } finally {
    // Remove the sign-in file, then the Box.
    await sh(box, `rm -rf ${HOME}/.factory ~/.git-credentials`, { allowFailure: true }).catch(() => {})
    await box.delete()
    console.log(`\nDeleted Box ${box.id}.`)
  }
}

// Do not call process.exit() after fetch: on Windows it can crash Node. Set the exit code instead.
try {
  await main()
} catch (error) {
  console.error(`\nFactory run failed: ${hide(error.message)}`)
  process.exitCode = 1
}
```

What the script does that is worth understanding:

- **The token stays away from the agent.** The clone uses a URL that contains the token, with git's credential helper switched off (`-c credential.helper=`), because the Box image tells git to save credentials on disk where the agent could read them. Right after the clone, the remote URL is reset to the one without a token. The token only comes back for the push, after the agent has finished.
- **`runScript` is for everything slow.** `box.exec.command` holds one HTTP request open until the command ends, and the SDK's request timeout is 10 minutes by default. An agent run can take longer, so the script is written to a file and started in the background with `nohup setsid`, and we ask every 10 seconds whether an exit-code file has appeared. The short `sh` helper is kept for quick commands only.
- **The agent's reply goes to a file.** `claude -p ... > summary.md` puts the final reply in `summary.md`. The same script sends everything else to a log, which is what we show on the issue when something fails. This is also why the script uses `claude -p` without `--bare`: bare mode does not read your Claude token.
- **We run the checks ourselves.** The prompt tells the agent to run them too, but a pull request is only opened when our own run of `npm run build` passes.
- **Every way out ends on the issue.** A failure, a question from the agent, or an empty change ends with the label `factory:needs-attention` and a comment that says why, so you never have to dig through the Actions log to find out what happened.
- **A re-run replaces the old attempt.** The push uses `--force` on the `factory/issue-N` branch, and an open pull request for that branch is updated instead of duplicated.

#### 6.3 Try it from your machine first

The script can run on your machine with the secrets from `.env`, which is much faster to debug than a workflow. First create a small, safe test issue in the **demo app** and add the `ready` label to it, for example:

> **Title:** Change the homepage heading
> **Description:** On the homepage, replace the default content with a single heading that says "Built by the software factory".

Then run, in Git Bash in the **software-factory** repo:

```bash
    node --env-file=.env src/run.mjs YOUR-USERNAME/software-factory-demo-app 1
```

Replace `1` with the number of your issue. It takes a few minutes. Watch the issue in the browser while it runs: `ready` turns into `factory:running`, and then into `factory:review`. The output ends with the address of the pull request.

Open the pull request and read it like any other. It should say `Closes #1`, show a small diff, and start with the agent's own summary. If your demo app deploys previews on Vercel, the preview check should turn green.

If it fails, the issue now carries `factory:needs-attention` and a comment with the log. Read that first. Then:

1. `GitHub ... failed: 401` with `Bad credentials`: GitHub does not accept the token. It works on your machine but fails in the workflow? Then the stored secret is broken. There are two usual causes: the commands in Step 4.5 were run in cmd or PowerShell, which store the literal text `$FACTORY_GITHUB_TOKEN` instead of the token, or the secret was saved with a hidden `\r` from a Windows `.env` file. Open **Git Bash**, save the three secrets again with the commands in Step 4.5 (the `tr -d '\r'` version), and re-run the workflow. If it fails on your machine too, the token is wrong or has expired: create it again (Step 4.2).
2. `GitHub ... failed: 403` or `404`: the factory token (Step 4.2) cannot reach the demo app, is missing one of Contents, Pull requests or Issues, or has expired.
3. `GitHub ... failed: 422` when opening the pull request: usually a branch problem. Delete the `factory/issue-N` branch in the demo app and run again.
4. The setup command failed: look at the log on the issue. `npm ci` needs a `package-lock.json` in the demo app. Run `npm install` there once and commit the lock file.
5. The agent stopped with an error: usually the Claude token. Check Step 4.4.
6. The checks failed: the agent's change does not build. Read the log, improve the issue text, and add the label again.
7. The preview on the pull request is blocked: the commit author is wrong. Use the noreply address from 6.1.

A run that was killed in the middle leaves a Box called `factory-issue-N-...` behind. Delete it in the Upstash console. Boxes count against your plan.

#### 6.4 Run it from the workflow

When the local run works, make the factory workflow do the same. Replace **all** content of `.github/workflows/factory.yml` in the **software-factory** repo with:

```yaml
name: Factory

on:
  workflow_dispatch:
    inputs:
      repo:
        description: App repo, for example owner/name
        required: true
      issue:
        description: Issue number
        required: true

permissions:
  contents: read

run-name: "${{ inputs.repo }} #${{ inputs.issue }}"

# One run per issue at a time. A second run waits, finds that ready is gone, and stops.
concurrency:
  group: factory-${{ inputs.repo }}-${{ inputs.issue }}
  cancel-in-progress: false

jobs:
  work:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install the factory
        run: npm ci

      - name: Work on the issue
        env:
          FACTORY_REPO: ${{ inputs.repo }}
          FACTORY_ISSUE: ${{ inputs.issue }}
          FACTORY_GITHUB_TOKEN: ${{ secrets.FACTORY_GITHUB_TOKEN }}
          UPSTASH_BOX_API_KEY: ${{ secrets.UPSTASH_BOX_API_KEY }}
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: node src/run.mjs
```

Then commit everything the workflow needs. The lock file matters, because `npm ci` fails without it:

```bash
    cd software-factory
    git add package.json package-lock.json src scripts .github/workflows/factory.yml
    git commit -m "Let the agent work on an issue"
    git push
```

A few things worth knowing:

- The runner gets all three secrets, but only the script uses them. The agent in the Box only ever receives the Claude token, because that is the one thing it needs to run.
- The `inputs` go through `env` variables and not straight into the script, as in Step 3.4, so text in an input can never be run as a command.
- The factory repo is private, so the minutes the runner waits for the Box count against your GitHub plan. The runner is held for the whole run.

#### 6.5 Test the whole chain

1. In the demo app, create a new issue, for example "Add a footer to the homepage", with a clear description.
2. Read the issue text once more. The agent runs with its permission prompts switched off and reads whatever the issue says, so only label issues you trust, and especially so in a public repo.
3. Add the `ready` label.
4. Open the **Actions** tab of the `software-factory` repo. One **Factory** run appears, named after your repo and issue number. Open it to follow the log.
5. After a few minutes, check all of these:
   - The issue went `ready`, `factory:running`, `factory:review`, with two comments from the factory.
   - There is a pull request from `factory/issue-N` that says `Closes #N` and holds the agent's summary.
   - The preview deployment on the pull request is green.
   - No Box is left behind in the Upstash console.
6. Review the pull request, and merge it. The issue closes by itself.

If no run appears, go through the checklist at the end of Step 3.5 first. Everything there still applies.

A few things worth knowing:

- Each run creates a new Box, and deletes it at the end. That is simple, and the price is a slower start, because every run installs the dependencies from scratch. Later steps replace this with a pool of ready workers.
- When the checks fail, the agent gets no second chance yet. Giving it the failure output and one more attempt is a good extension once this works.
- Parallel runs for different issues of the same app all edit the same few files, so later merges may conflict. That is a property of parallel work, not a bug.
- When you finish the project, rotate or delete the four secrets from Step 4.

### Step 7: A pool of reusable workers

In Step 6 every run created a new Box and deleted it again. That works for one issue at a time, but it has two weak spots: every run pays for creating a Box, and nothing limits how many Boxes are alive when several issues are labelled at once. In this step we replace that with a **pool of workers**: a fixed number of named Boxes that sleep (are **paused**) when idle. A run **claims** a free worker, uses it, cleans it, and gives it back.

- **Workers.** `factory-worker-1`, `factory-worker-2`, and so on. Each one is a Box that is created once, ahead of time, and paused.
- **A shared state without a database.** Box **labels** are the state. A worker with the label `busy` is taken. The label API is reachable from every workflow run, so every run sees the same truth.
- **A claim.** A run picks a free worker, adds `busy` and its own label `run-<id>` to it, waits four seconds, and looks at the labels again. If another run label sorts lower than its own, that run won the worker, and we back off and try another one. If every worker is busy, the run waits and looks again every 30 seconds.
- **A release.** At the end the run removes the labels, deletes its sign-in file and its clone, and pauses the Box.

The workflow, the trigger and the GitHub part of `src/run.mjs` stay as they are. We add one file with the pool logic, one script to manage the workers, and change two blocks in `src/run.mjs`.

#### 7.1 Decide how many workers

Each worker is one Box, and paused Boxes count against your Upstash plan. Check the limit of your plan in the Upstash console first. On the free plan, the pricing page lists 10 concurrent running Boxes and does not state a total, and the first version of this factory ran into a "Box limit reached" error at 10 Boxes in total, paused ones included. Leave one slot for the smoke test.

All workers also share the rate limits of your one Claude subscription, so more workers means a faster pile-up of limits, not faster work. Start with **2**.

Browser access is decided when a Box is created and cannot be added later. The workers below are created with it switched on, like the Box in Step 5. If you never want it, change `browser: true` to `false` in the next file **before** you create the workers.

#### 7.2 Write the pool

Create the file `src/pool.mjs` in the **software-factory** repo and paste in the following:

```js
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
```

There is no lock anywhere, and none is needed in practice. Two things keep it safe enough: the workflow's `concurrency` group allows one run per issue, and the four-second wait lets a rival's label appear before anyone starts working. The claim protocol is simple, not perfect. The rare case where it fails is two runs that start within the same fraction of a second and are both unlucky, and the way out is in 7.6.

#### 7.3 Write the workers script

Create the file `scripts/workers.mjs` in the **software-factory** repo. One script, four commands: create the pool, look at it, free a stuck worker, delete the pool.

```js
// Manage the pool of worker Boxes.
// node --env-file=.env scripts/workers.mjs status
// node --env-file=.env scripts/workers.mjs provision [--yes]
// node --env-file=.env scripts/workers.mjs release <worker name>
// node --env-file=.env scripts/workers.mjs delete [--yes]
import { Box } from "@upstash/box"
import { BUSY_LABEL, listWorkers, workerNames, createWorkerBox } from "../src/pool.mjs"

const [command, argument] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
const yes = process.argv.includes("--yes")

async function main() {
  const workers = await listWorkers()

  // Who exists, who is busy, and for which run.
  if (command === "status") {
    if (workers.length === 0) console.log("No workers yet. Run the provision command.")
    for (const w of workers) {
      const run = (w.labels ?? []).find((label) => label.startsWith("run-"))
      console.log(`${w.name.padEnd(20)} ${w.status.padEnd(8)} ${w.labels?.includes(BUSY_LABEL) ? `BUSY (${run ?? "no run label"})` : "free"}`)
    }

  // Create the workers that are missing, and pause each one right away.
  } else if (command === "provision") {
    const missing = workerNames().filter((name) => !workers.some((w) => w.name === name))
    console.log(missing.length ? `Boxes to create: ${missing.join(", ")}` : "All workers exist already.")
    if (missing.length && !yes) console.log("\nPreview only. Add --yes to create them. Each one uses one Box slot.")
    if (missing.length && yes) {
      for (const name of missing) {
        const box = await createWorkerBox(name)
        await box.pause()
        console.log(`Created ${name} (${box.id}) and paused it.`)
      }
    }

  // Free a worker that a cancelled run left busy: remove its sign-in file and its labels, then pause it.
  } else if (command === "release") {
    const data = workers.find((w) => w.name === argument)
    if (!data) throw new Error(`No worker called "${argument}". Run the status command to see the names.`)
    const box = await Box.get(data.id)
    if (data.status === "paused") await box.resume()
    await box.exec.command("rm -rf /workspace/home/.factory ~/.git-credentials")
    for (const label of data.labels ?? []) if (label === BUSY_LABEL || label.startsWith("run-")) await box.labels.remove(label)
    await box.pause()
    console.log(`Released ${data.name}.`)

  // Delete all workers. This cannot be undone.
  } else if (command === "delete") {
    console.log(workers.length ? `Boxes to delete: ${workers.map((w) => w.name).join(", ")}` : "No workers to delete.")
    if (workers.length && !yes) console.log("\nPreview only. Add --yes to delete them for good.")
    if (workers.length && yes) {
      await Box.delete({ boxIds: workers.map((w) => w.id) })
      console.log("Deleted.")
    }

  } else {
    console.log("Usage: workers.mjs <status | provision | release <worker name> | delete> [--yes]")
  }
}

// Do not call process.exit() after fetch: on Windows it can crash Node. Set the exit code instead.
try {
  await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
```

#### 7.4 Create the workers

Look first, then create. In Git Bash in the **software-factory** repo:

```bash
    node --env-file=.env scripts/workers.mjs status
    node --env-file=.env scripts/workers.mjs provision
    node --env-file=.env scripts/workers.mjs provision --yes
    node --env-file=.env scripts/workers.mjs status
```

The first `status` prints that there are no workers. The `provision` preview names the two Boxes. After `--yes`, the last `status` should show:

```text
factory-worker-1     paused   free
factory-worker-2     paused   free
```

Check your Upstash console as well: two Boxes, paused. They cost nothing while paused except their disk.

#### 7.5 Change the run script to use the pool

Two blocks in `src/run.mjs` change. Nothing else in the file does.

**First**, replace the import at the top:

```js
import { Box } from "@upstash/box"
```

with:

```js
import { claimWorker, releaseWorker } from "./pool.mjs"
```

**Second**, find the block that starts at `// Show on the issue that work has started.` and ends at the line `console.log(`Created Box ${box.id}`)`. Replace that whole block, including the `branch`, `repoDir`, `authedUrl` and `noStore` lines in it, with:

```js
  // Claim a free worker first, so that the issue only says "running" when work really starts. This waits when all workers are busy.
  const runId = process.env.GITHUB_RUN_ID ?? `local${Date.now().toString().slice(-9)}`
  const claim = await claimWorker(runId)
  if (!claim) {
    await comment(`The factory had no free worker in time. Remove and add the \`${LABELS.ready}\` label again to try later.`)
    throw new Error("No free worker in time")
  }
  const { box, name } = claim
  console.log(`Worker ${name} claimed. Box: ${box.id}`)

  // Show on the issue that work has started, and by whom.
  await removeLabel(LABELS.ready)
  await removeLabel(LABELS.attention)
  await addLabels([LABELS.running])
  await comment(`Worker \`${name}\` picked this up.`)

  const branch = `factory/issue-${issue.number}`
  const repoDir = `${HOME}/work/${repo.split("/")[1]}`
  const authedUrl = `https://x-access-token:${githubToken}@github.com/${repo}.git`
  const noStore = "-c credential.helper=" // the Box image tells git to save credentials on disk
```

**Third**, in the `finally` block at the bottom of `main`, replace these lines:

```js
    // Remove the sign-in file, then the Box.
    await sh(box, `rm -rf ${HOME}/.factory ~/.git-credentials`, { allowFailure: true }).catch(() => {})
    await box.delete()
    console.log(`\nDeleted Box ${box.id}.`)
```

with:

```js
    // A paused Box keeps its disk. Remove the sign-in file, the clone and Claude's transcripts, then give the worker back.
    await sh(box, `rm -rf ${HOME}/.factory ~/.git-credentials ${q(repoDir)} ${JOB} ${HOME}/.claude/projects`, { allowFailure: true }).catch(() => {})
    await releaseWorker(claim)
```

The code at the start of the job that clones the repo already begins with `rm -rf` of an old clone, so a worker that was not cleaned properly still starts fresh.

Commit it with the workflow files from Step 6:

```bash
    git add src scripts
    git commit -m "Use a pool of workers"
    git push
```

#### 7.6 Test it

**One issue.** Create a small issue in the demo app, add the `ready` label, and watch two things at once: the issue in the browser, and in a second Git Bash window:

```bash
    node --env-file=.env scripts/workers.mjs status
```

While the run is going, one worker shows `BUSY (run-...)` and the Box in the Upstash console is running. When the pull request is open, the same worker is `paused` and `free` again. The first comment on the issue now names the worker.

**Three issues at once.** With two workers, this shows the waiting. Create three small issues and add `ready` to all of them in quick succession. Open the three **Factory** runs in the Actions tab. Two start working on different workers. The third prints `No free worker. Checking again in 30 seconds.` until one of the first two finishes, then takes the freed worker. At the end of the test all three issues are on `factory:review`, and `status` shows both workers free and paused.

If something goes wrong:

1. A run times out with "No free worker in time": all workers were busy for 30 minutes. Check `status`. If one shows `BUSY` but no run is going, a cancelled run left it behind, see the next point.
2. A worker is `BUSY` and no run is active: a cancelled or crashed run never reaches the `finally` block. Free it with `node --env-file=.env scripts/workers.mjs release factory-worker-1`. This also removes its sign-in file.
3. Two issues end up in the same worker: the claim race from 7.2. Look at the two run logs for "claimed by another run at the same moment". If you see it often, raise the four-second wait in `claimWorker`.
4. `Box.list` or `Box.get` returns an authorization error: `UPSTASH_BOX_API_KEY` is missing or wrong, locally in `.env` or as a secret.
5. The Box limit error when provisioning: your plan is full. Delete old Boxes in the console, for example leftovers from Steps 5 and 6 that are called `factory-smoke-claude` or `factory-issue-N-...`, or choose a smaller `WORKER_COUNT`.

A few things worth knowing:

- A paused Box keeps its disk. That is why the `finally` block deletes the Claude token and the GitHub clone, and why `release` does the same for a worker that a crashed run left behind. Never skip that.
- A run holds a GitHub Actions runner the whole time, including the time it waits for a free worker, up to 30 minutes. In a private repo those minutes count against your plan.
- Several pull requests in the same small app edit the same few files. Each one is fine alone, and later merges may conflict. That is a property of parallel work, not a bug.
- The workers are created once and keep running forever. When you finish the project, delete them with `node --env-file=.env scripts/workers.mjs delete --yes`, and rotate or delete the four secrets from Step 4.
- Every worker starts a job with an empty workspace but with the tools of the stock Box. If your app needs more tools than a stock Box has, those go into a worker image, which is the next step.

### Step 8: A worker image, and a scale test

This step has two parts. First we give the workers a **worker image**: a Box that is set up once, with everything slow or rarely changing already inside, and saved as a **snapshot**. Every worker is then created from that snapshot, so it starts with the tools it needs. Then we put the whole factory under load: six issues at once, three workers.

#### What is an image, and what goes into it

A snapshot is a copy of the full disk of a Box. Upstash can create any number of new Boxes from one snapshot, and deleting the original Box does not delete its snapshots.

What belongs in the image: things that are slow to install and rarely change. Language toolchains and system packages the app needs, agent skills, MCP servers, a browser tool for an agent that checks its own pages.

What does not belong in the image:

- **App code.** The app changes all the time, and every job makes a fresh clone anyway. A copy in the image is stale at once.
- **Secrets.** They are hard to rotate once they are baked into a snapshot. The factory writes them at the start of each job and removes them at the end.
- **Small files you keep editing**, such as house rules for the agent. Every wording change would mean a new image.

For our demo app, the stock Box is honestly already enough: it has Node, npm, git and Claude Code. So the image in this step is small on purpose. It does one useful thing, and shows the mechanism that you would use for anything bigger. It fills the **npm cache** with all the packages of the demo app, so the first `npm ci` in a fresh worker does not have to download them. A pool worker also warms its cache by itself during its first job, so the gain is the first job of every worker that is created new. The real value of this step is the mechanism: once it exists, adding a slow tool later is one more line in `worker/setup.sh`.

One rule about browsers, because your workers were created with browser access in Step 7. **Browser access is decided when a Box is created, and an image passes on the access of the Box it was built in.** `Box.fromSnapshot` does not send the `browser` option at all (we checked the SDK source), so nothing you pass there changes it. An image built in a Box without browser access gives every worker created from it no browser, with no way to add one later. We build in `factory-worker-1`, which has one.

#### 8.1 Write the setup script

Create the file `worker/setup.sh` in the **software-factory** repo. It defines what goes into the image:

```bash
#!/bin/bash
# Defines what goes into the worker image. scripts/build-image.mjs runs this
# inside a worker's Box and then takes a snapshot of the result.
#
# Put slow, rarely changing things here. Keep app code and secrets out.
#
# Facts about a Box: Debian 12 on ARM64, user "boxuser" with passwordless sudo,
# Node, git and Claude Code already installed.
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH

# The package files of the demo app were put in this folder by the build script.
# npm ci fills the npm cache (/tmp/.npm-cache) with every package of the app. The build
# script throws node_modules away afterwards, and the cache stays.
echo "--- npm cache of the demo app"
cd /workspace/home/.image-build/app
npm ci --silent

# More slow tools go here, for example a browser tool, a Python toolchain with
#   sudo apt-get install -y python3-venv python3-pip
# or an agent skill.

# The build log is the only evidence of what is in the image, and the build
# must fail when something is missing. List every tool the workers rely on.
echo "--- check"
node --version
npm --version
git --version
claude --version
```

The script runs with `set -euo pipefail`, so any failing line stops the build and no snapshot is taken.

#### 8.2 Write the build script

Create the file `scripts/build-image.mjs` in the **software-factory** repo and paste in the following. Replace `YOUR-USERNAME`.

```js
// Builds the worker image: runs worker/setup.sh in one worker's Box, cleans the Box, and takes a snapshot of it.
// Preview: node --env-file=.env scripts/build-image.mjs <worker name>
// Build:   node --env-file=.env scripts/build-image.mjs <worker name> --yes
import { readFileSync } from "node:fs"
import { Box } from "@upstash/box"
import { BUSY_LABEL, listWorkers } from "../src/pool.mjs"

// Settings: where the package files of the app come from, and what the image is called.
const APP_REPO = "YOUR-USERNAME/software-factory-demo-app"
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

// Run a short shell command in the Box, and throw on a non-zero exit code (the helper from Step 5).
async function sh(box, command, { allowFailure = false } = {}) {
  const run = await box.exec.command(`( ${command} ) 2>&1; echo "__EXIT__$?"`)
  const match = /__EXIT__(\d+)\s*$/.exec(run.result ?? "")
  const code = match ? Number(match[1]) : 1
  const output = (run.result ?? "").replace(/__EXIT__\d+\s*$/, "").trimEnd()
  if (code !== 0 && !allowFailure) throw new Error(`Command failed with exit code ${code}:\n${output.slice(-2000)}`)
  return { code, output }
}

// Run a longer bash script in the Box in the background and poll until it ends (the helper from Step 6).
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

// Read one file of the app from GitHub, with the factory token from Step 4.2. The token stays on this machine.
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

    // Remove everything that belongs to a job and not to the image: sign-in files, clones, transcripts of old agent runs.
    await sh(box, `cd ${HOME} && rm -rf .image-build work job .factory .claude/projects ~/.git-credentials /tmp/.npm-cache/_logs`)
    console.log("\nRemoved sign-in files, old workspaces and the build folder.")

    // Last line of defence: refuse to snapshot when anything that looks like a secret is still on the disk.
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

// Do not call process.exit() after fetch: on Windows it can crash Node. Set the exit code instead.
try {
  await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
```

What the script does that is worth understanding:

- **The helpers are copies.** `sh` and `runScript` are the same as in `src/run.mjs`. A bigger project would move them into one shared file. Here, copying keeps every step readable on its own.
- **The package files come through GitHub, not through a clone.** The script fetches `package.json` and `package-lock.json` from the demo app with the factory token on your machine and writes them into the Box. The token never enters the Box, and no app code ends up in the image.
- **Clean first, scan second, snapshot last.** A snapshot captures the whole disk, including whatever earlier jobs left behind. So the script removes sign-in files, clones and Claude's transcripts, then searches the disk for text that looks like a token, and takes the snapshot only when nothing was found.

#### 8.3 Use the image in the pool

Two small changes to `src/pool.mjs`, and two to `scripts/workers.mjs`.

**In `src/pool.mjs`**, replace the settings block at the top:

```js
// Settings: how many workers, and how long a run waits for a free one.
export const WORKER_COUNT = 2
export const NAME_PREFIX = "factory-worker-"
const WAIT_FOR_WORKER_MINUTES = 30
```

with:

```js
// Settings: how many workers, how long a run waits for a free one, and the worker image (empty until you have built one).
export const WORKER_COUNT = 3
export const NAME_PREFIX = "factory-worker-"
export const SNAPSHOT_ID = ""
const WAIT_FOR_WORKER_MINUTES = 30
```

and replace the `createWorkerBox` function:

```js
// Create one worker Box. The workers script pauses it right after.
export const createWorkerBox = (name) => Box.create({ name, labels: [POOL_LABEL], runtime: "node", browser: true, timeout: REQUEST_TIMEOUT_MS })
```

with:

```js
// Create one worker Box, from the worker image when there is one. The workers script pauses it right after.
// Box.fromSnapshot ignores "browser": a Box made from an image has browser access exactly when the Box the image was taken from had it.
export const createWorkerBox = (name) => {
  const options = { name, labels: [POOL_LABEL], runtime: "node", timeout: REQUEST_TIMEOUT_MS }
  return SNAPSHOT_ID ? Box.fromSnapshot(SNAPSHOT_ID, options) : Box.create({ ...options, browser: true })
}
```

`WORKER_COUNT` goes up to 3 for the scale test. Check that your Upstash plan has room for three Boxes. You leave `SNAPSHOT_ID` empty until 8.4 has built the image.

**In `scripts/workers.mjs`**, replace the first line that reads the command:

```js
const [command, argument] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
```

with:

```js
const [command, argument, shellCommand] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
```

then replace the loop inside the `provision` command:

```js
      for (const name of missing) {
        const box = await createWorkerBox(name)
        await box.pause()
        console.log(`Created ${name} (${box.id}) and paused it.`)
      }
```

with:

```js
      for (const name of missing) {
        const box = await createWorkerBox(name)
        // Browser access cannot be added later, so show it for every new worker.
        const browser = await box.browser.listTabs().then(() => "yes", () => "no")
        await box.pause()
        console.log(`Created ${name} (${box.id}), browser access: ${browser}, and paused it.`)
      }
```

and add a new command **above** the `// Delete all workers. This cannot be undone.` comment, to look inside a worker:

```js
  // Run one command in a free worker, for example to check what its image contains.
  } else if (command === "exec") {
    const data = workers.find((w) => w.name === argument)
    if (!data) throw new Error(`No worker called "${argument}". Run the status command to see the names.`)
    if (data.labels?.includes(BUSY_LABEL)) throw new Error(`${data.name} is busy. Pick a free worker.`)
    if (!shellCommand) throw new Error('Usage: workers.mjs exec <worker name> "<command>"')
    const box = await Box.get(data.id)
    if (data.status === "paused") await box.resume()
    console.log((await box.exec.command(shellCommand)).result)
    await box.pause()

```

#### 8.4 Build the image and recreate the workers

The workers you made in Step 7 do not change when an image appears. A Box that exists stays as it is. So the order is: build the image in one worker, then delete all workers and create them again from the image. Deleting the workers does not delete the snapshot. In Git Bash in the **software-factory** repo:

First look, and build:

```bash
    node --env-file=.env scripts/workers.mjs status
    node --env-file=.env scripts/build-image.mjs factory-worker-1
    node --env-file=.env scripts/build-image.mjs factory-worker-1 --yes
```

Both workers must be `free`. The preview prints the image name and the worker. The build takes a few minutes. At the end you should see the output of the check section (the versions of node, npm, git and claude), then `Secret scan clean.` and a snapshot id.

Open `src/pool.mjs` and paste the id between the quotes of `SNAPSHOT_ID`. Then delete the old workers, which is permanent, so look first:

```bash
    node --env-file=.env scripts/workers.mjs delete
    node --env-file=.env scripts/workers.mjs delete --yes
    node --env-file=.env scripts/workers.mjs provision --yes
    node --env-file=.env scripts/workers.mjs status
```

`provision` now creates `factory-worker-1` to `factory-worker-3` from the image. Look at the `browser access:` part of each line it prints. It must say `yes` for all three. If it says `no`, the image came from a Box without browser access: see the troubleshooting below.

Then check what a worker from the image really contains. The single quotes matter, so that Git Bash does not expand `~` or `$HOME` on your machine:

```bash
    node --env-file=.env scripts/workers.mjs exec factory-worker-2 'node --version; claude --version; du -sh /tmp/.npm-cache'
    node --env-file=.env scripts/workers.mjs exec factory-worker-2 'ls -d ~/.git-credentials /workspace/home/.factory /workspace/home/work 2>&1'
```

The first command must print the versions and a cache size of a few hundred megabytes or less. The second must answer `No such file or directory` three times: no secrets and no old workspaces in the image.

If something goes wrong:

1. `worker/setup.sh failed`: read the log that the script printed. `npm ci` needs a `package-lock.json` in the demo app, and the factory token needs access to it.
2. `has no browser access`: your workers were created without it. Set `browser: true` in the `Box.create` call of `createWorkerBox`, delete the workers, create them again with an empty `SNAPSHOT_ID`, and build the image again.
3. `browser access: no` for workers made from the image: the image was built in a Box without browser access. Same fix as the previous point.
4. `These files still hold something that looks like a secret`: the script names the files. Delete them in the Box, or add the folder to the clean-up line in the script, and build again. Do not remove the scan.
5. A Box limit error when creating the workers: your plan is full. Delete leftover Boxes in the Upstash console, or lower `WORKER_COUNT`.

#### 8.5 Prepare the issues for the scale test

Now the load. We create six small issues in the demo app, without labels, so you decide when the factory starts.

Create the file `scripts/demo-issues.json` in the **software-factory** repo. Replace `YOUR-USERNAME` in all six places:

```json
[
  {
    "repo": "YOUR-USERNAME/software-factory-demo-app",
    "title": "Add a footer to the homepage",
    "body": "Add a simple footer at the bottom of the homepage with the text \"Built by the software factory\". Follow the existing styling of the app."
  },
  {
    "repo": "YOUR-USERNAME/software-factory-demo-app",
    "title": "Add an About page",
    "body": "Add an /about page with a heading \"About\" and a short paragraph of two or three sentences about this demo app. Do not change any other page."
  },
  {
    "repo": "YOUR-USERNAME/software-factory-demo-app",
    "title": "Add a custom 404 page",
    "body": "Add a friendly 404 page with the message \"This page does not exist\" and a link back to the homepage."
  },
  {
    "repo": "YOUR-USERNAME/software-factory-demo-app",
    "title": "Add a health check route",
    "body": "Add a route at /api/health that returns JSON with {\"status\": \"ok\"} and HTTP status 200."
  },
  {
    "repo": "YOUR-USERNAME/software-factory-demo-app",
    "title": "Add a Contact page",
    "body": "Add a /contact page with a heading \"Contact\" and a mailto link with the text \"Send us an email\". Do not change any other page."
  },
  {
    "repo": "YOUR-USERNAME/software-factory-demo-app",
    "title": "Set the page title and description",
    "body": "Set the title of the app to \"Software Factory Demo\" and add a one-sentence description, in the metadata of the root layout."
  }
]
```

Create the file `scripts/create-demo-issues.mjs`:

```js
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
```

Commit everything, and preview the issues:

```bash
    git add worker scripts src
    git commit -m "Add a worker image and the scale test"
    git push
    node scripts/create-demo-issues.mjs
```

#### 8.6 Run the scale test

Before you start, read what will happen. Six issues and three workers means three runs start working and three wait. Every waiting run holds a GitHub Actions runner, up to 30 minutes, and in a private repo those minutes count against your plan. The three working agents share the rate limits of your one Claude subscription. Two of the six issues may touch the same files, so later merges may conflict. That is not a bug, it is what parallel work looks like.

1. Make sure all three workers are free: `node --env-file=.env scripts/workers.mjs status`.
2. Create the six issues and start them all at once:

```bash
    node scripts/create-demo-issues.mjs --yes --ready
```

3. Open the **Actions** tab of the `software-factory` repo. Six **Factory** runs appear, one per issue. Open one of the waiting ones. Its log says `No free worker. Checking again in 30 seconds.` every half minute.
4. In a second Git Bash window, watch the pool while the runs go:

```bash
    node --env-file=.env scripts/workers.mjs status
```

Run it a few times. Three workers show `BUSY (run-...)`. When one finishes it shows `free`, and a few seconds to half a minute later a waiting run has taken it.

5. When all six runs are done, check:
   - There are six pull requests in the demo app, one per issue, each saying `Closes #N`.
   - Every issue ended on `factory:review`, or on `factory:needs-attention` with a comment that tells you why.
   - `status` shows all three workers `paused` and `free`.
   - No run failed with a rate-limit message. If one did, its issue says so on `factory:needs-attention`: label it again later.
   - Each pull request has a green Vercel preview.
   - At most three Boxes exist in the Upstash console, all paused, none left over from this test.

6. Review the pull requests. Merge them one by one, and expect a conflict between the ones that touch the same files. Resolve it, or close the pull request and add the `ready` label to its issue again after the first merge, so the factory builds it on top of the new state.

If something goes wrong:

1. Fewer runs than issues: a trigger did not fire. Go through the checklist at the end of Step 3.5.
2. A run says `No free worker in time`: all workers were busy for 30 minutes. Look at `status`. A `BUSY` worker without a run is a leftover of a cancelled run: free it with `node --env-file=.env scripts/workers.mjs release factory-worker-1`.
3. Two issues in one worker: look for `claimed by another run at the same moment` in the logs. If it keeps happening, raise the four-second wait in `claimWorker` in `src/pool.mjs`.
4. Pull requests that are empty or break the build: read the agent's summary and the checks log on the issue, and improve the issue text.

A few things worth knowing:

- A passing scale test proves the mechanics: the trigger, the claiming, the waiting, the release, and the image. It does not prove that the agent writes good code. You read every pull request.
- The image is a copy of a moment in time. After you change `worker/setup.sh`, build again, paste the new id, delete the workers and create them again. Old snapshots are not removed automatically. Delete the ones you no longer need in the Upstash console.
- If you add a browser tool to the image later, check it with the `exec` command, with a real action, and not only with its version: open a page and read its title.

#### 8.7 Hand over and clean up

You have a working software factory. Before you stop:

1. **Rotate or delete every secret you used.** That is the trigger token in the demo app, and the factory token, the Upstash Box key and the Claude token in the factory repo. Any of them that you pasted in a chat or showed on screen is exposed and has to be replaced. Write down when each one expires: the GitHub tokens on the date you chose, the Claude token after a year.
2. **Know the risk.** The agent runs with its permission prompts switched off, holds its Claude sign-in for the length of a job, and reads whatever the issue says. The allow-list decides who may add the label, not who wrote the issue. So read an issue before you label it, above all in a public repo.
3. **Know the everyday commands:** `scripts/workers.mjs status` to see who is busy, `release <name>` for a worker that a cancelled run left busy, `build-image.mjs` after a change to `worker/setup.sh`.
4. **Stop the costs when you are done.** Delete the workers with `node --env-file=.env scripts/workers.mjs delete --yes`, and the snapshot in the Upstash console. Paused Boxes keep their disk and count against your plan.
