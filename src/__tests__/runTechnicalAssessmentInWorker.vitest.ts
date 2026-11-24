import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TechnicalAssessmentInput } from '../assess';
import { SCAN_LIMITS } from '../methodology';
import { runTechnicalAssessmentInWorker } from '../runTechnicalAssessmentInWorker';
import { ScanStoppedError } from '../transport/errors';

/** Code to run in place of the scan's own worker; null runs the real one. */
const stub = vi.hoisted(() => ({ workerCode: null as string | null }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const threads = await importOriginal<typeof import('node:worker_threads')>();
  class StubbableWorker extends threads.Worker {
    constructor(file: URL, options: import('node:worker_threads').WorkerOptions) {
      const code = stub.workerCode;
      super(code ? new URL(`data:text/javascript,${encodeURIComponent(code)}`) : file, options);
    }
  }
  return { ...threads, Worker: StubbableWorker };
});
const REAL_LIMITS = { ...SCAN_LIMITS };

/** An address the scanner refuses to read, which makes a real scan throw. */
const input: TechnicalAssessmentInput = {
  target: {
    submittedUrl: 'https://127.0.0.1/docs',
    resolvedUrl: 'https://127.0.0.1/docs',
    scopeRoot: 'https://127.0.0.1/docs',
    key: '127.0.0.1/docs',
    domain: '127.0.0.1',
    profile: 'developer-docs',
    locale: null,
    version: null,
  },
  reportUrl: 'https://documentation.ai/agent-score/acme',
  answerabilityPlanned: false,
};

afterEach(() => {
  stub.workerCode = null;
  Object.assign(SCAN_LIMITS, REAL_LIMITS);
});

describe('runTechnicalAssessmentInWorker', () => {
  it('returns what the worker found and passes its progress on', async () => {
    stub.workerCode = `import { parentPort, workerData } from 'node:worker_threads';
      parentPort.postMessage({ progress: 'Reading ' + workerData.target.key });
      parentPort.postMessage({ assessment: { report: { stage: 'final' }, sampledUrls: ['a'] } });`;
    const progress: string[] = [];
    const assessment = await runTechnicalAssessmentInWorker(input, { onProgress: (message) => progress.push(message) });
    expect(progress).toEqual(['Reading 127.0.0.1/docs']);
    expect(assessment).toEqual({ report: { stage: 'final' }, sampledUrls: ['a'] });
  });

  it('fails when the progress callback throws', async () => {
    stub.workerCode = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ progress: 'Reading' }); setInterval(() => {}, 50);";
    const onProgress = () => {
      throw new Error('terminal closed');
    };
    await expect(runTechnicalAssessmentInWorker(input, { onProgress })).rejects.toThrow('terminal closed');
  });

  it('stops a worker that a page has blocked, while the host keeps running', async () => {
    stub.workerCode = 'for (;;) {}';
    Object.assign(SCAN_LIMITS, { technicalHardLimitMs: 400 });
    let hostTicks = 0;
    const ticking = setInterval(() => hostTicks++, 20);
    await expect(runTechnicalAssessmentInWorker(input)).rejects.toBeInstanceOf(ScanStoppedError);
    clearInterval(ticking);
    expect(hostTicks).toBeGreaterThan(5);
  });

  it('fails a scan that uses up its memory, while the host keeps running', async () => {
    stub.workerCode = 'const kept = []; for (;;) kept.push(new Array(1_000).fill({}));';
    Object.assign(SCAN_LIMITS, { workerMemoryMb: 32 });
    await expect(runTechnicalAssessmentInWorker(input)).rejects.toEqual(new ScanStoppedError('32 MB of memory'));
  }, 20_000);

  it('fails when the worker stops without a result', async () => {
    stub.workerCode = 'process.exit(3);';
    await expect(runTechnicalAssessmentInWorker(input)).rejects.toThrow('exited with code 3 before it finished');
  });

  it('fails with the error the scan itself threw', async () => {
    await expect(runTechnicalAssessmentInWorker(input)).rejects.toThrow('127.0.0.1 is not a public address');
  }, 20_000);
});
