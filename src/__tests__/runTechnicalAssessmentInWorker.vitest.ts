import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { TechnicalAssessmentInput } from '../assess';
import { SCAN_LIMITS } from '../methodology';
import { runTechnicalAssessmentInWorker } from '../runTechnicalAssessmentInWorker';
import { ScanStoppedError } from '../transport/errors';

/** A file to run in place of the scan's own worker; null runs the real one. */
const stub = vi.hoisted(() => ({ workerFile: null as string | null }));

vi.mock('node:child_process', async (importOriginal) => {
  const childProcess = await importOriginal<typeof import('node:child_process')>();
  const fork = (file: string, options: import('node:child_process').ForkOptions) =>
    childProcess.fork(stub.workerFile ?? file, { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return { ...childProcess, fork };
});

const stubFolder = mkdtempSync(join(tmpdir(), 'agent-score-worker-'));
const REAL_LIMITS = { ...SCAN_LIMITS };

function runInWorkerInstead(code: string) {
  stub.workerFile = join(stubFolder, 'worker.mjs');
  writeFileSync(stub.workerFile, code);
}

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
  stub.workerFile = null;
  Object.assign(SCAN_LIMITS, REAL_LIMITS);
});

afterAll(() => rmSync(stubFolder, { recursive: true }));

describe('runTechnicalAssessmentInWorker', () => {
  it('returns what the worker found and passes its progress on', async () => {
    runInWorkerInstead(`process.once('message', (input) => {
      process.send({ progress: 'Reading ' + input.target.key });
      process.send({ assessment: { report: { stage: 'final' }, sampledUrls: ['a'] } });
    });`);
    const progress: string[] = [];
    const assessment = await runTechnicalAssessmentInWorker(input, { onProgress: (message) => progress.push(message) });
    expect(progress).toEqual(['Reading 127.0.0.1/docs']);
    expect(assessment).toEqual({ report: { stage: 'final' }, sampledUrls: ['a'] });
  });

  it('fails with the error the scan itself threw', async () => {
    const scan = runTechnicalAssessmentInWorker(input);
    await expect(scan).rejects.toMatchObject({ name: 'BlockedTargetError', message: '127.0.0.1 is not a public address' });
  }, 20_000);

  it('fails when the progress callback throws', async () => {
    runInWorkerInstead("process.send({ progress: 'Reading' }); setInterval(() => {}, 50);");
    const onProgress = () => {
      throw new Error('terminal closed');
    };
    await expect(runTechnicalAssessmentInWorker(input, { onProgress })).rejects.toThrow('terminal closed');
  });

  it('stops a worker that a page has blocked, while the host keeps running', async () => {
    runInWorkerInstead('for (;;) {}');
    Object.assign(SCAN_LIMITS, { technicalHardLimitMs: 400 });
    let hostTicks = 0;
    const ticking = setInterval(() => hostTicks++, 20);
    await expect(runTechnicalAssessmentInWorker(input)).rejects.toEqual(new ScanStoppedError('0.4 seconds'));
    clearInterval(ticking);
    expect(hostTicks).toBeGreaterThan(5);
  });

  it('leaves no worker running', async () => {
    runInWorkerInstead(`process.send({ progress: String(process.pid) }); setInterval(() => {}, 50);`);
    Object.assign(SCAN_LIMITS, { technicalHardLimitMs: 1_000 });
    let pid = 0;
    const scan = runTechnicalAssessmentInWorker(input, { onProgress: (message) => (pid = Number(message)) });
    await expect(scan).rejects.toBeInstanceOf(ScanStoppedError);
    expect(() => process.kill(pid, 0)).toThrow('ESRCH');
  });

  it('fails a scan that uses up its memory, while the host keeps running', async () => {
    runInWorkerInstead('const kept = []; for (;;) kept.push(new Array(1_000).fill({}));');
    Object.assign(SCAN_LIMITS, { workerMemoryMb: 32 });
    await expect(runTechnicalAssessmentInWorker(input)).rejects.toEqual(new ScanStoppedError('32 MB of memory'));
  }, 20_000);

  it('fails when the worker stops without a result', async () => {
    runInWorkerInstead('process.exit(3);');
    await expect(runTechnicalAssessmentInWorker(input)).rejects.toThrow('ended (3) before it finished');
  });
});
