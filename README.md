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

### Step 1: Create 2 private GitHub repositories, one for the **Software Factory** and one for the **Demo application**.

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
            -f repo="$GITHUB_REPOSITORY" \
            -f issue="$ISSUE_NUMBER"
```

Replace `YOUR-USERNAME` (two places) with your GitHub username.

A few things worth knowing:

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
