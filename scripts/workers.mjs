// Manage the pool of worker Boxes.
// node --env-file=.env scripts/workers.mjs status
// node --env-file=.env scripts/workers.mjs provision [--yes]
// node --env-file=.env scripts/workers.mjs release <worker name>
// node --env-file=.env scripts/workers.mjs delete [--yes]
import { Box } from "@upstash/box";
import {
  BUSY_LABEL,
  listWorkers,
  workerNames,
  createWorkerBox,
} from "../src/pool.mjs";

// const [command, argument] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
const [command, argument, shellCommand] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"));
const yes = process.argv.includes("--yes");

async function main() {
  const workers = await listWorkers();

  // Who exists, who is busy, and for which run.
  if (command === "status") {
    if (workers.length === 0)
      console.log("No workers yet. Run the provision command.");
    for (const w of workers) {
      const run = (w.labels ?? []).find((label) => label.startsWith("run-"));
      console.log(
        `${w.name.padEnd(20)} ${w.status.padEnd(8)} ${w.labels?.includes(BUSY_LABEL) ? `BUSY (${run ?? "no run label"})` : "free"}`,
      );
    }

    // Create the workers that are missing, and pause each one right away.
  } else if (command === "provision") {
    const missing = workerNames().filter(
      (name) => !workers.some((w) => w.name === name),
    );
    console.log(
      missing.length
        ? `Boxes to create: ${missing.join(", ")}`
        : "All workers exist already.",
    );
    if (missing.length && !yes)
      console.log(
        "\nPreview only. Add --yes to create them. Each one uses one Box slot.",
      );
    if (missing.length && yes) {
      // for (const name of missing) {
      //   const box = await createWorkerBox(name)
      //   await box.pause()
      //   console.log(`Created ${name} (${box.id}) and paused it.`)
      // }

      for (const name of missing) {
        const box = await createWorkerBox(name);
        // Browser access cannot be added later, so show it for every new worker.
        const browser = await box.browser.listTabs().then(
          () => "yes",
          () => "no",
        );
        await box.pause();
        console.log(
          `Created ${name} (${box.id}), browser access: ${browser}, and paused it.`,
        );
      }
    }

    // Free a worker that a cancelled run left busy: remove its sign-in file and its labels, then pause it.
  } else if (command === "release") {
    const data = workers.find((w) => w.name === argument);
    if (!data)
      throw new Error(
        `No worker called "${argument}". Run the status command to see the names.`,
      );
    const box = await Box.get(data.id);
    if (data.status === "paused") await box.resume();
    await box.exec.command(
      "rm -rf /workspace/home/.factory ~/.git-credentials",
    );
    for (const label of data.labels ?? [])
      if (label === BUSY_LABEL || label.startsWith("run-"))
        await box.labels.remove(label);
    await box.pause();
    console.log(`Released ${data.name}.`);

    // Run one command in a free worker, for example to check what its image contains.
  } else if (command === "exec") {
    const data = workers.find((w) => w.name === argument);
    if (!data)
      throw new Error(
        `No worker called "${argument}". Run the status command to see the names.`,
      );
    if (data.labels?.includes(BUSY_LABEL))
      throw new Error(`${data.name} is busy. Pick a free worker.`);
    if (!shellCommand)
      throw new Error('Usage: workers.mjs exec <worker name> "<command>"');
    const box = await Box.get(data.id);
    if (data.status === "paused") await box.resume();
    console.log((await box.exec.command(shellCommand)).result);
    await box.pause();

    // Delete all workers. This cannot be undone.
  } else if (command === "delete") {
    console.log(
      workers.length
        ? `Boxes to delete: ${workers.map((w) => w.name).join(", ")}`
        : "No workers to delete.",
    );
    if (workers.length && !yes)
      console.log("\nPreview only. Add --yes to delete them for good.");
    if (workers.length && yes) {
      await Box.delete({ boxIds: workers.map((w) => w.id) });
      console.log("Deleted.");
    }
  } else {
    console.log(
      "Usage: workers.mjs <status | provision | release <worker name> | delete> [--yes]",
    );
  }
}

// Do not call process.exit() after fetch: on Windows it can crash Node. Set the exit code instead.
try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
