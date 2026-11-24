import type { AnswerabilityResult } from '../report.types';

/** An Answerability result with nothing measured yet, or nothing measurable. */
export function emptyAnswerability(
  state: 'pending' | 'unavailable',
  reason?: string,
  models?: AnswerabilityResult['models'],
): AnswerabilityResult {
  return {
    state,
    ...(reason && { reason }),
    ...(models && { models }),
    total: 0,
    correct: 0,
    retrieved: 0,
    answered: 0,
    supported: 0,
    transcript: [],
  };
}
