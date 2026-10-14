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

1. Create 2 private GitHub repositories, one for the **Software Factory** and one for the **Demo application**.

| Repo | Role |
|------|------|
| `software-factory` | The factory: workflow, scripts, config, and this step-by-step guide. |
| `software-factory-demo-app` | The app the factory works on. Its only factory-related file will be a small trigger workflow. |

Clone both repositories to your local machine.

1. Create and run a new **Next.js application** with recommended default settings

```bash
    npx create-next-app@latest software-factory-demo-app
```

When the app is created, navigate to the app folder and run the development server using the following commands:

```bash
    cd software-factory-demo-app
    npm run dev
```

Navigate to `http://localhost:3000` in your browser to see the app running.

Navigate to Vercel and create a new project. Connect your GitHub account and select the `software-factory-demo-app` repository. Deploy the app to Vercel.

Push the app to your GitHub repository using the following commands:

```bash
    git add .
    git commit -m "Initial commit"
    git push -u origin main
``` 






