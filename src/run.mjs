// Takes one ready issue from start to pull request.
// Run locally: node --env-file=.env src/run.mjs bartvanhoey/software-factory-demo-app 1
// import { Box } from "@upstash/box"
import { claimWorker, releaseWorker } from "./pool.mjs";

// Settings: change these to fit your own app.
const APP_REPO = "bartvanhoey/software-factory-demo-app";
const ALLOWED_ACTORS = ["bartvanhoey"];
const BASE_BRANCH = "main";
const SETUP = ["npm ci"];
const CHECKS = ["npm run build"];
const GIT_AUTHOR = {
  name: "Bart Van Hoey",
  email: "2319374+bartvanhoey@users.noreply.github.com",
};
const SETUP_TIMEOUT_MINUTES = 20;
const AGENT_TIMEOUT_MINUTES = 25;

// The labels from Step 3.2, and the places inside the Box that we use.
const LABELS = {
  ready: "ready",
  running: "factory:running",
  review: "factory:review",
  attention: "factory:needs-attention",
};
const HOME = "/workspace/home";
const JOB = `${HOME}/job`;
const ENV_FILE = `${HOME}/.factory/env`;
const NEEDS_CLARIFICATION = "NEEDS_CLARIFICATION:";

// Input: the repo and issue number, from the command line or from the workflow.
const [
  repo = process.env.FACTORY_REPO,
  issueNumber = process.env.FACTORY_ISSUE,
] = process.argv.slice(2);
const githubToken = process.env.FACTORY_GITHUB_TOKEN;
const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

// Quote a value for the shell, hide secrets in anything we print, and wait.
const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const hide = (text) =>
  String(text)
    .replaceAll(githubToken ?? "<none>", "***")
    .replaceAll(claudeToken ?? "<none>", "***");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A small GitHub REST helper, using the factory token from Step 4.2.
async function github(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(
      `GitHub ${method} ${path} failed: ${response.status} ${await response.text()}`,
    );
  return response.status === 204 ? null : response.json();
}
const addLabels = (labels) =>
  github(`/repos/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    body: { labels },
  });
const comment = (body) =>
  github(`/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: { body },
  });
const removeLabel = (label) =>
  github(
    `/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    { method: "DELETE" },
  ).catch((error) => {
    if (!String(error.message).includes(" 404 ")) throw error; // the label was not on the issue
  });

// Run a short shell command in the Box, and throw on a non-zero exit code (the helper from Step 5).
async function sh(box, command, { allowFailure = false } = {}) {
  const run = await box.exec.command(`( ${command} ) 2>&1; echo "__EXIT__$?"`);
  const match = /__EXIT__(\d+)\s*$/.exec(run.result ?? "");
  const code = match ? Number(match[1]) : 1;
  const output = (run.result ?? "").replace(/__EXIT__\d+\s*$/, "").trimEnd();
  if (code !== 0 && !allowFailure)
    throw new Error(
      `Command failed with exit code ${code}:\n${output.slice(-2000)}`,
    );
  return { code, output };
}

// Run a longer bash script in the Box in the background, and poll until it ends.
async function runScript(box, name, lines, timeoutMinutes) {
  const base = `${JOB}/${name}`;
  await sh(box, `mkdir -p ${JOB} && rm -f ${base}.exit ${base}.log`);
  await box.files.write({
    path: `${base}.sh`,
    content: [
      "#!/bin/bash",
      `exec > ${base}.log 2>&1`,
      "set -e",
      ...lines,
      "",
    ].join("\n"),
  });
  await sh(
    box,
    `nohup setsid bash -lc ${q(`bash ${base}.sh; echo $? > ${base}.exit`)} > /dev/null 2>&1 & echo started`,
  );

  const started = Date.now();
  while (Date.now() - started < timeoutMinutes * 60_000) {
    await sleep(10_000);
    const { output } = await sh(
      box,
      `cat ${base}.exit 2>/dev/null || echo running`,
    );
    if (output.trim() !== "running") {
      const log = (
        await sh(box, `tail -n 80 ${base}.log`, { allowFailure: true })
      ).output;
      return { passed: output.trim() === "0", log };
    }
    console.log(`  ${name} is still running...`);
  }
  throw new Error(`"${name}" did not finish within ${timeoutMinutes} minutes.`);
}

// The task for the agent: the issue, plus the rules of the factory.
const buildPrompt = (
  issue,
) => `You are a coding agent. The repository ${repo} is checked out in the current folder, on a new branch.

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
`;

async function main() {
  // Refuse anything that is not meant for this factory.
  if (!repo || !issueNumber)
    throw new Error("Usage: node src/run.mjs <owner/repo> <issue number>");
  if (repo !== APP_REPO)
    throw new Error(`${repo} is not ${APP_REPO}, so this run is refused.`);
  if (!githubToken || !claudeToken)
    throw new Error(
      "FACTORY_GITHUB_TOKEN and CLAUDE_CODE_OAUTH_TOKEN must both be set.",
    );
  // The "Run workflow" button is a second way in, open to everyone with write access to this repo.
  if (
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    !ALLOWED_ACTORS.includes(process.env.GITHUB_ACTOR)
  ) {
    throw new Error(
      `${process.env.GITHUB_ACTOR} is not in ALLOWED_ACTORS, so this run is refused.`,
    );
  }

  // Only work on an open issue that still has the ready label. This also makes a duplicate run harmless.
  const issue = await github(`/repos/${repo}/issues/${issueNumber}`);
  console.log(`Issue ${repo}#${issue.number}: ${issue.title}`);
  if (
    issue.state !== "open" ||
    !issue.labels.some((label) => label.name === LABELS.ready)
  ) {
    console.log(`Not open with the "${LABELS.ready}" label. Skipping.`);
    return;
  }

  // Report a problem on the issue and hand it back to a human.
  const needsAttention = async (message) => {
    await removeLabel(LABELS.ready);
    await removeLabel(LABELS.running);
    await addLabels([LABELS.attention]);
    await comment(message);
    console.log(`Issue labelled ${LABELS.attention}.`);
  };

  // Show on the issue that work has started.
  //   await removeLabel(LABELS.ready)
  //   await removeLabel(LABELS.attention)
  //   await addLabels([LABELS.running])
  //   await comment("The factory picked this up.")

  //   // Create the Box. Its name has a time part so that a leftover Box never blocks a new run.
  //   const branch = `factory/issue-${issue.number}`
  //   const repoDir = `${HOME}/work/${repo.split("/")[1]}`
  //   const authedUrl = `https://x-access-token:${githubToken}@github.com/${repo}.git`
  //   const noStore = "-c credential.helper=" // the Box image tells git to save credentials on disk
  //   const box = await Box.create({ name: `factory-issue-${issue.number}-${Date.now().toString().slice(-6)}`, labels: ["factory", "job"], runtime: "node", timeout: 15 * 60 * 1000 })
  //   console.log(`Created Box ${box.id}`)

  // Claim a free worker first, so that the issue only says "running" when work really starts. This waits when all workers are busy.
  const runId =
    process.env.GITHUB_RUN_ID ?? `local${Date.now().toString().slice(-9)}`;
  const claim = await claimWorker(runId);
  if (!claim) {
    await comment(
      `The factory had no free worker in time. Remove and add the \`${LABELS.ready}\` label again to try later.`,
    );
    throw new Error("No free worker in time");
  }
  const { box, name } = claim;
  console.log(`Worker ${name} claimed. Box: ${box.id}`);

  // Show on the issue that work has started, and by whom.
  await removeLabel(LABELS.ready);
  await removeLabel(LABELS.attention);
  await addLabels([LABELS.running]);
  await comment(`Worker \`${name}\` picked this up.`);

  const branch = `factory/issue-${issue.number}`;
  const repoDir = `${HOME}/work/${repo.split("/")[1]}`;
  const authedUrl = `https://x-access-token:${githubToken}@github.com/${repo}.git`;
  const noStore = "-c credential.helper="; // the Box image tells git to save credentials on disk

  try {
    // Clone with the token, then remove the token from the clone. It is only used again for the push.
    console.log("\nPreparing the workspace...");
    await sh(
      box,
      `rm -rf ${q(repoDir)} ${JOB} ~/.git-credentials && mkdir -p ${JOB}`,
    );
    await sh(
      box,
      `git ${noStore} clone --quiet --depth 50 --branch ${q(BASE_BRANCH)} ${q(authedUrl)} ${q(repoDir)}`,
    );
    await sh(
      box,
      `cd ${q(repoDir)} && git remote set-url origin https://github.com/${repo}.git && git checkout --quiet -b ${q(branch)} && git config user.name ${q(GIT_AUTHOR.name)} && git config user.email ${q(GIT_AUTHOR.email)}`,
    );

    // Install the dependencies of the app.
    const setup = await runScript(
      box,
      "setup",
      [`cd ${q(repoDir)}`, ...SETUP],
      SETUP_TIMEOUT_MINUTES,
    );
    if (!setup.passed) {
      await needsAttention(
        `The setup command failed in the Box, so the agent was not started. This is a factory problem, not a problem with the issue.\n\nLog:\n\n    ${hide(setup.log).slice(-3000).replaceAll("\n", "\n    ")}`,
      );
      return;
    }

    // Sign Claude Code in: the token goes in a file that only this user can read.
    console.log("\nSigning in and starting the agent...");
    await sh(box, `mkdir -p ${HOME}/.factory && chmod 700 ${HOME}/.factory`);
    await box.files.write({
      path: ENV_FILE,
      content: `export CLAUDE_CODE_OAUTH_TOKEN='${claudeToken}'\n`,
    });
    await sh(box, `chmod 600 ${ENV_FILE}`);

    // Run the agent. Its final reply is written to summary.md, and becomes the pull request description.
    await box.files.write({
      path: `${JOB}/prompt.md`,
      content: buildPrompt(issue),
    });
    const agent = await runScript(
      box,
      "agent",
      [
        `. ${ENV_FILE}`,
        "export PATH=$HOME/.local/bin:$PATH",
        `cd ${q(repoDir)}`,
        `claude -p "$(cat ${JOB}/prompt.md)" --dangerously-skip-permissions --output-format text > ${JOB}/summary.md`,
      ],
      AGENT_TIMEOUT_MINUTES,
    );
    const summary = (
      await sh(box, `cat ${JOB}/summary.md 2>/dev/null`, { allowFailure: true })
    ).output.trim();
    if (!agent.passed) {
      await needsAttention(
        `The agent stopped with an error.\n\nLog:\n\n    ${hide(agent.log).slice(-3000).replaceAll("\n", "\n    ")}`,
      );
      return;
    }

    // The agent may hand the issue back with a question instead of a change.
    if (summary.startsWith(NEEDS_CLARIFICATION)) {
      await needsAttention(
        `The agent needs more detail before it can start:\n\n> ${summary.slice(NEEDS_CLARIFICATION.length).trim()}\n\nEdit the issue, then add the \`${LABELS.ready}\` label again.`,
      );
      return;
    }

    // Run the checks ourselves. We do not take the agent's word for it.
    console.log("\nRunning checks...");
    const checks = await runScript(
      box,
      "checks",
      [`cd ${q(repoDir)}`, ...CHECKS],
      SETUP_TIMEOUT_MINUTES,
    );
    if (!checks.passed) {
      await needsAttention(
        `The change did not pass the checks, so no pull request was opened.\n\nLog:\n\n    ${hide(checks.log).slice(-3000).replaceAll("\n", "\n    ")}`,
      );
      return;
    }

    // Did the agent change anything at all?
    const status = (
      await sh(box, `cd ${q(repoDir)} && git add -A && git status --porcelain`)
    ).output.trim();
    if (!status) {
      await needsAttention(
        `The agent finished without changing any files.\n\nIts reply:\n\n> ${summary || "(empty)"}`,
      );
      return;
    }
    console.log(`\nChanged files:\n${status}`);

    // Commit and push. Only now does the token come back, and the agent is long finished.
    await sh(
      box,
      `cd ${q(repoDir)} && git commit --quiet -m ${q(`${issue.title}\n\nCloses #${issue.number}`)}`,
    );
    await sh(
      box,
      `cd ${q(repoDir)} && git ${noStore} push --quiet --force ${q(authedUrl)} ${q(`${branch}:${branch}`)}`,
    );

    // Open the pull request, or update the open one when this issue is run again.
    const prBody = `Closes #${issue.number}\n\n${summary || "(The agent gave no summary.)"}\n\n---\nBuilt by the factory in an Upstash Box. Checks passed: ${CHECKS.map((c) => `\`${c}\``).join(", ")}.`;
    const open = await github(
      `/repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${encodeURIComponent(branch)}`,
    );
    const pr = open.length
      ? await github(`/repos/${repo}/pulls/${open[0].number}`, {
          method: "PATCH",
          body: { title: issue.title, body: prBody },
        })
      : await github(`/repos/${repo}/pulls`, {
          method: "POST",
          body: {
            head: branch,
            base: BASE_BRANCH,
            title: issue.title,
            body: prBody,
          },
        });
    console.log(`\nPull request: ${pr.html_url}`);

    // Show on the issue that a pull request is waiting.
    await removeLabel(LABELS.running);
    await addLabels([LABELS.review]);
    await comment(`Pull request ready for review: ${pr.html_url}`);
  } catch (error) {
    await needsAttention(
      `The factory hit an error:\n\n    ${hide(error.message).slice(0, 1500).replaceAll("\n", "\n    ")}`,
    ).catch(() => {});
    throw error;
  } finally {
    // Remove the sign-in file, then the Box.
    // await sh(box, `rm -rf ${HOME}/.factory ~/.git-credentials`, {
    //   allowFailure: true,
    // }).catch(() => {});
    // await box.delete();
    // console.log(`\nDeleted Box ${box.id}.`);

    // A paused Box keeps its disk. Remove the sign-in file, the clone and Claude's transcripts, then give the worker back.
    await sh(box, `rm -rf ${HOME}/.factory ~/.git-credentials ${q(repoDir)} ${JOB} ${HOME}/.claude/projects`, { allowFailure: true }).catch(() => {})
    await releaseWorker(claim)
  }
}

// Do not call process.exit() after fetch: on Windows it can crash Node. Set the exit code instead.
try {
  await main();
} catch (error) {
  console.error(`\nFactory run failed: ${hide(error.message)}`);
  process.exitCode = 1;
}
