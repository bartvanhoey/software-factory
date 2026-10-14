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

### Step 5: Smoke-test one sandbox

In this step we build the second hand-off: the **workspace**. We create one Upstash **Box** (a sandbox) from a script on your machine, sign Claude Code in inside it, ask it to reply `BOX OK`, and delete the Box again. No repo is touched and no issue is involved. If this works, the Box key, the Claude CLI and the sign-in token are all proven, and everything later builds on that.

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
