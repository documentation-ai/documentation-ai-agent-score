import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { EngineOptions, TechnicalAssessment, TechnicalAssessmentInput } from './assess';
import { SCAN_LIMITS } from './methodology';
import { ScanStoppedError } from './transport/errors';

/**
 * The technical assessment in a worker thread of its own. Its checks parse
 * whatever a site serves, and a page that keeps a parser busy blocks the thread
 * it runs in: no timer, deadline or other job there runs meanwhile. Here that
 * is only the worker, so the host carries on and stops it at the hard limit. A
 * scan that needs more memory than its worker may use fails by itself too.
 */

export type WorkerMessage = { progress: string } | { assessment: TechnicalAssessment };

export async function runTechnicalAssessmentInWorker(
  input: TechnicalAssessmentInput,
  { onProgress }: Pick<EngineOptions, 'onProgress'> = {},
): Promise<TechnicalAssessment> {
  const worker = startWorker(input);
  try {
    return await waitForAssessment(worker, onProgress);
  } finally {
    await worker.terminate();
  }
}

function startWorker(workerData: TechnicalAssessmentInput): Worker {
  const { file, execArgv } = getWorkerEntry();
  return new Worker(new URL(file, import.meta.url), {
    workerData,
    execArgv,
    resourceLimits: { maxOldGenerationSizeMb: SCAN_LIMITS.workerMemoryMb },
  });
}

/** Run from source (tests, `npm run check`), the worker needs tsx to load TypeScript; the built one does not. */
function getWorkerEntry() {
  if (!import.meta.url.endsWith('.ts')) return { file: './technicalAssessmentWorker.js', execArgv: [] };
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return { file: './technicalAssessmentWorker.ts', execArgv: ['--import', tsx] };
}

function waitForAssessment(worker: Worker, onProgress: EngineOptions['onProgress']): Promise<TechnicalAssessment> {
  const { technicalHardLimitMs, workerMemoryMb } = SCAN_LIMITS;
  return new Promise((resolve, reject) => {
    const hardLimit = setTimeout(
      () => reject(new ScanStoppedError(`${technicalHardLimitMs / 1000} seconds`)),
      technicalHardLimitMs,
    );
    worker.on('message', (message: WorkerMessage) => {
      if ('assessment' in message) return resolve(message.assessment);
      try {
        onProgress?.(message.progress);
      } catch (error) {
        reject(error);
      }
    });
    worker.on('error', (error: NodeJS.ErrnoException) => {
      const isOutOfMemory = error.code === 'ERR_WORKER_OUT_OF_MEMORY';
      reject(isOutOfMemory ? new ScanStoppedError(`${workerMemoryMb} MB of memory`) : error);
    });
    worker.on('exit', (code) => {
      clearTimeout(hardLimit);
      // Changes nothing after a result or an error: the promise has settled by then.
      reject(new Error(`The scan's worker exited with code ${code} before it finished`));
    });
  });
}
