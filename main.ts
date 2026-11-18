// Entry point: the harness lifecycle. The program binds a free port, tells the
// trial environment which port it picked, then waits until the environment
// reports the trial is finished and exits. The scoring target is the server
// that app.ts builds; this file only runs the lifecycle the harness defines.
//
// Sequence:
//   1. MAKEFUN_ENV_URL gives the environment's origin (http://store:8080 in a
//      trial container). With no URL there is nothing to register with, so
//      the process stops with exit code 1 right away.
//   2. Build the server and listen on port 0 so the kernel chooses a free
//      one. Port 8080 is never bound here: it belongs to the environment.
//   3. POST $MAKEFUN_ENV_URL/register with {"port": N}. The environment
//      remembers the caller's address plus N and starts dialing it. Only the
//      first register counts; a 409 means another entry already won, and
//      this process simply keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body reads {"done": true}. The
//      environment answers immediately ({"done": false} while the suite is
//      still running), so this is a poll. A failed or slow poll is retried
//      with a short backoff; the process never leaves before done is true.
//   5. Close the server and exit 0. The harness then stops the environment,
//      which writes the export the scorer reads.
//
// This module imports only its own server: no package, no Node built-in,
// no model call.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// How long a single register or done request may run before it is dropped
// and retried.
const FETCH_TIMEOUT_MS = 30_000;
// First pause between retries, and the longest pause allowed.
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Pause after `failures` failed attempts: exponential from BACKOFF_FIRST_MS,
// capped at BACKOFF_CAP_MS.
function backoffAfter(failures: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8));
}

// Run `step` until it reports success (true) or a fatal error (throw).
// A false return means "not yet": wait with backoff and try again.
async function untilDone(step: (attempt: number) => Promise<boolean>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (await step(attempt)) return;
    await pause(backoffAfter(attempt));
  }
}

// POST the bound port until the environment accepts it. 200 is the usual
// answer; 409 means a first register already won, which this process cannot
// fix. 400 and 405 are contract errors and end the program; a network error
// or any other status is retried, since the environment may still be
// starting up.
async function registerPort(port: number): Promise<void> {
  await untilDone(async () => {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return true;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
      return false;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
      return false;
    }
  });
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function awaitDone(): Promise<void> {
  await untilDone(async () => {
    try {
      const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) return false;
      const payload = (await response.json()) as { done?: unknown };
      return payload.done === true;
    } catch {
      // The environment is not answering yet, or the poll timed out: it is
      // not done, so poll again.
      return false;
    }
  });
}

// Bind the port, register it, then wait for the environment: the whole life
// of the process.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
