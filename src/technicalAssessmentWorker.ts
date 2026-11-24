import { Worker } from 'node:worker_threads';

import { runTechnicalAssessment, type TechnicalAssessmentInput } from './assess';
import type { WorkerMessage } from './runTechnicalAssessmentInWorker';

/** What runs in the worker process: one technical assessment, sending its progress and then how it ended. */

/** Ends this process once its host is gone. A thread, since a blocked page stops every timer of this one. */
const END_WITHOUT_HOST = `
  const host = process.ppid;
  setInterval(() => process.ppid === host || process.kill(process.pid, 'SIGKILL'), 1000);
`;

const send = (message: WorkerMessage) => process.send?.(message);
const sendFailure = ({ name, message }: Error) => send({ failure: { name, message } });

async function assess(input: TechnicalAssessmentInput): Promise<void> {
  try {
    send({ assessment: await runTechnicalAssessment(input, { onProgress: (progress) => send({ progress }) }) });
  } catch (error) {
    sendFailure(error as Error);
  }
}

new Worker(END_WITHOUT_HOST, { eval: true });
process.once('disconnect', () => process.exit());
process.once('uncaughtException', sendFailure);
process.once('message', assess);
