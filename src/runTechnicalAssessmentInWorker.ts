import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { EngineOptions, TechnicalAssessment, TechnicalAssessmentInput } from './assess';
import { SCAN_LIMITS } from './methodology';
import { ScanStoppedError } from './transport/errors';

/**
 * The technical assessment in a worker process of its own. Its checks parse
 * whatever a site serves, and a page can keep a parser busy or use up memory;
 * either would stop everything else in the process it runs in. Here that is
 * only the worker, so the host carries on and stops it at its limits. A thread
 * would not do: running out of memory in one can abort the host (Node 24).
 */

export type WorkerMessage =
  | { progress: string }
  | { assessment: TechnicalAssessment }
  | { failure: { name: string; message: string } };

/** How a process that used up its memory ends: Node aborts it, or the system kills it. */
const OUT_OF_MEMORY_EXITS = ['SIGABRT', 134, 'SIGKILL', 137];

export async function runTechnicalAssessmentInWorker(
  input: TechnicalAssessmentInput,
  { onProgress }: Pick<EngineOptions, 'onProgress'> = {},
): Promise<TechnicalAssessment> {
  const worker = startWorker();
  try {
    worker.send(input);
    return await waitForAssessment(worker, onProgress);
  } finally {
    await stopWorker(worker);
  }
}

/** Run from source (tests, `npm run check`), the worker needs tsx to load TypeScript; the built one does not. */
function startWorker(): ChildProcess {
  const isSource = import.meta.url.endsWith('.ts');
  const file = isSource ? './technicalAssessmentWorker.ts' : './technicalAssessmentWorker.js';
  const loader = isSource ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
  return fork(fileURLToPath(new URL(file, import.meta.url)), {
    execArgv: [...loader, `--max-old-space-size=${SCAN_LIMITS.workerMemoryMb}`],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}

async function stopWorker(worker: ChildProcess): Promise<void> {
  worker.removeAllListeners('message');
  const isRunning = worker.pid !== undefined && worker.exitCode === null && worker.signalCode === null;
  if (!isRunning) return;
  worker.kill('SIGKILL');
  await once(worker, 'exit');
}

function waitForAssessment(
  worker: ChildProcess,
  onProgress: EngineOptions['onProgress'],
): Promise<TechnicalAssessment> {
  const { technicalHardLimitMs, workerMemoryMb } = SCAN_LIMITS;
  return new Promise((resolve, reject) => {
    const hardLimit = setTimeout(
      () => reject(new ScanStoppedError(`${technicalHardLimitMs / 1000} seconds`)),
      technicalHardLimitMs,
    );
    worker.on('message', (message: WorkerMessage) => {
      if ('assessment' in message) return resolve(message.assessment);
      if ('failure' in message) return reject(Object.assign(new Error(message.failure.message), { name: message.failure.name }));
      try {
        onProgress?.(message.progress);
      } catch (error) {
        reject(error);
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code, signal) => {
      clearTimeout(hardLimit);
      // Changes nothing after a result or an error: the promise has settled by then.
      const isOutOfMemory = OUT_OF_MEMORY_EXITS.includes(signal ?? code ?? '');
      reject(
        isOutOfMemory
          ? new ScanStoppedError(`${workerMemoryMb} MB of memory`)
          : new Error(`The scan's worker ended (${signal ?? code}) before it finished`),
      );
    });
  });
}
