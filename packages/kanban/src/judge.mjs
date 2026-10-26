// dsh-kanban: the out-of-band judge.
//
// Every adjudication/coverage/triage/answer/grill-decision call goes through the
// host's provider-neutral `ctx.llm.stream()` service. This file holds no
// credentials, no base URLs and no provider wire code: the adapters that already
// belong to the deployment own all three.

import { BlockAssembler } from '@deepseek-ai/dsh-llm';

import { routeForAttempt } from './config.mjs';
import { extractJson } from './result.mjs';

const HUMAN_CODES = new Set(['MISSING_CREDENTIAL', 'AUTH', 'NO_ADAPTER']);

export class JudgeError extends Error {
  constructor(message, { code = 'JUDGE_FAILED', failure = null } = {}) {
    super(message);
    this.name = 'JudgeError';
    this.code = code;
    this.failure = failure;
  }
}

/** One streamed call; returns text, usage and a typed failure instead of throwing on transport errors. */
export async function streamOnce(llm, { provider, model, reasoningEffort = null, system, messages, maxTokens = 4096, temperature = 0, signal, purpose }) {
  const assembler = new BlockAssembler();
  let finish = null;
  const request = {
    provider,
    model,
    messages,
    temperature,
    maxTokens,
    ...(reasoningEffort === null || reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(system === undefined ? {} : { system }),
    ...(signal === undefined ? {} : { signal }),
    ...(purpose === undefined ? {} : { purpose }),
  };
  try {
    for await (const chunk of llm.stream(request)) {
      assembler.push(chunk);
      if (chunk.type === 'finish') finish = chunk.reason;
    }
  } catch (error) {
    const failure = error?.failure ?? { message: String(error?.message ?? error), code: error?.code ?? 'UNKNOWN' };
    return { ok: false, failure, text: '', usage: assembler.usage ?? null, finish: null };
  }
  const text = assembler
    .blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const usage = assembler.usage ?? null;
  if (finish !== null && finish.kind === 'error') {
    return { ok: false, failure: finish.failure, text, usage, finish };
  }
  if (finish !== null && finish.kind === 'aborted') {
    return { ok: false, failure: finish.failure, text, usage, finish };
  }
  return { ok: true, failure: null, text, usage, finish };
}

export function createJudge({ llm, getConfig, budgetCheck = () => ({ ok: true }) }) {
  /**
   * One JSON call with at most two attempts. The second attempt uses the
   * escalation rung when the ladder offers a different route and the budget
   * allows it; otherwise the caller gets a typed failure and decides.
   */
  async function judgeJson({ task, system, payload, schema, ticket = null, maxAttempts = 2, signal, spanMeta = {} }) {
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const config = getConfig();
      const base = routeForAttempt(config, 'orchestrator', attempt);
      const route = base;
      if (route.provider === null || route.model === null) {
        throw new JudgeError('no orchestrator route configured (roles.orchestrator.provider/model)', { code: 'NO_ROUTE' });
      }
      const budget = budgetCheck({ route, ticket, promptChars: system.length + JSON.stringify(payload).length, maxTokens: 4096 });
      if (!budget.ok) {
        throw new JudgeError(budget.reason, { code: 'BUDGET' });
      }
      const result = await streamOnce(llm, {
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: payload }] }],
        maxTokens: 4096,
        signal,
      });
      last = result;
      if (!result.ok) {
        const code = result.failure?.code ?? 'UNKNOWN';
        if (HUMAN_CODES.has(code)) {
          throw new JudgeError(`orchestrator route failed: ${result.failure?.message ?? code}`, { code, failure: result.failure });
        }
        if (attempt === maxAttempts) break;
        continue;
      }
      const parsed = extractJson(result.text);
      if (parsed.ok) {
        return { ...parsed, text: result.text, usage: result.usage, route, attempts: attempt, failure: null, ...spanMeta };
      }
      last = { ...result, parseError: parsed.reason };
    }
    throw new JudgeError(last?.parseError ?? last?.failure?.message ?? 'judge did not return JSON', {
      code: last?.failure?.code ?? 'NO_JSON',
      failure: last?.failure ?? null,
    });
  }
  return { judgeJson, streamOnce };
}
