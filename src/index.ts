import { loadConfig } from "./config.ts";
import { runPoll } from "./poll.ts";
import { runSend } from "./send.ts";
import type { WindowName } from "./types.ts";

/**
 * Entry point. Invoked by cron:
 *   bun run src/index.ts poll
 *   bun run src/index.ts send 朝場 | 昼場 | 夜場
 *
 * The 24:00 JST cron fires `send 夜場`, which sends both 夜場 and Daily.
 */

const VALID_WINDOWS: WindowName[] = ["朝場", "昼場", "夜場"];

async function main() {
  const command = process.argv[2];
  if (!command) {
    console.error("Usage: bun run src/index.ts <poll|send> [window]");
    process.exit(2);
  }

  const config = loadConfig();

  if (command === "poll") {
    const pipelineId = process.argv[3];
    if (pipelineId) {
      assertKnownPipeline(config, pipelineId);
    }
    await runPoll(config, pipelineId);
    return;
  }

  if (command === "send") {
    const window = process.argv[3] as WindowName;
    if (!VALID_WINDOWS.includes(window)) {
      console.error(`Invalid window: ${window}. Must be one of: ${VALID_WINDOWS.join(", ")}`);
      process.exit(2);
    }
    const pipelineId = process.argv[4];
    if (pipelineId) {
      assertKnownPipeline(config, pipelineId);
    }
    await runSend(config, window, pipelineId);
    return;
  }

  console.error(`Unknown command: ${command}. Use 'poll' or 'send'.`);
  process.exit(2);
}

function assertKnownPipeline(config: ReturnType<typeof loadConfig>, pipelineId: string): void {
  if (!config.pipelines.some((pipeline) => pipeline.id === pipelineId)) {
    console.error(`Unknown pipeline id: ${pipelineId}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
