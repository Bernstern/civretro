import { CDP } from "./cdp.js";

const CDP_RETRY_MS = 10_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function connectWithRetry(maxMs: number): Promise<CDP> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const cdp = new CDP();
      await cdp.connect();
      return cdp;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("Could not connect to Civ 7 CDP endpoint");
}

async function main() {
  const cdp = await connectWithRetry(CDP_RETRY_MS);
  try {
    const result = await cdp.eval<string>(
      `try { engine.call("exitToMainMenu"); "ok"; } catch(e) { "err:" + e.message; }`
    );
    if (typeof result === "string" && result.startsWith("err:")) {
      console.error(result);
      process.exit(1);
    }
    console.log("exited to main menu");
  } finally {
    await cdp.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
