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

Load the values from `.env` into the repo secrets, so nothing is typed or shown on screen. In Git Bash:

```bash
    cd software-factory
    set -a; source .env; set +a
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

1. `GitHub ... failed: 403` or `404`: the factory token (Step 4.2) cannot reach the demo app, is missing one of Contents, Pull requests or Issues, or has expired.
2. `GitHub ... failed: 422` when opening the pull request: usually a branch problem. Delete the `factory/issue-N` branch in the demo app and run again.
3. The setup command failed: look at the log on the issue. `npm ci` needs a `package-lock.json` in the demo app. Run `npm install` there once and commit the lock file.
4. The agent stopped with an error: usually the Claude token. Check Step 4.4.
5. The checks failed: the agent's change does not build. Read the log, improve the issue text, and add the label again.
6. The preview on the pull request is blocked: the commit author is wrong. Use the noreply address from 6.1.

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
