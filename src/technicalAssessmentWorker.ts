import { parentPort, workerData } from 'node:worker_threads';

import { runTechnicalAssessment, type TechnicalAssessmentInput } from './assess';
import type { WorkerMessage } from './runTechnicalAssessmentInWorker';

/** What runs inside the worker: one technical assessment, posting its progress and then its result. */

const post = (message: WorkerMessage) => parentPort?.postMessage(message);

const assessment = await runTechnicalAssessment(workerData as TechnicalAssessmentInput, {
  onProgress: (progress) => post({ progress }),
});
post({ assessment });
