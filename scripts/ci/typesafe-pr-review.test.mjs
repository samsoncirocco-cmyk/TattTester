import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  CHECKS,
  COMMENT_MARKER,
  ENDPOINT,
  MAX_CALLS,
  MODEL,
  WARN_THRESHOLD,
  buildRequest,
  isForkPullRequest,
  mergeWithPrior,
  parseDiff,
  planBatches,
  renderComment,
  reviewOptions,
  runReview,
  selectUnits,
  warningsFromAnswers,
} from './typesafe-pr-review.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const API_KEY = 'test-token';
const SENTINEL = 'DEPOSIT_FEE_SENTINEL';

function unified(files) {
  return files.map((file) => {
    const header = [
      `diff --git a/${file.path} b/${file.to || file.path}`,
      `--- ${file.deleted ? '/dev/null' : `a/${file.path}`}`,
      `+++ ${file.created ? '/dev/null' : `b/${file.to || file.path}`}`,
    ];
    if (file.deleted) {
      header[1] = `--- a/${file.path}`;
      header[2] = '+++ /dev/null';
    }
    if (file.created) {
      header[1] = '--- /dev/null';
      header[2] = `+++ b/${file.path}`;
    }
    const hunks = (file.hunks || []).map((hunk) => {
      const body = hunk.lines.join('\n');
      return `@@ -${hunk.oldStart ?? 1},${hunk.oldCount ?? hunk.lines.length} +${hunk.newStart ?? 1},${hunk.newCount ?? hunk.lines.length} @@\n${body}`;
    });
    return [...header, ...hunks].join('\n');
  }).join('\n');
}

function http({ status = 200, body = {}, headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function answersFor(requestBody, score) {
  const answers = {};
  for (const [id, question] of Object.entries(requestBody.questions)) {
    answers[id] = { type: 'noul', noul: score(question, id) };
  }
  return {
    model: 'jev-1.14.0',
    answers,
    usage: { input_tokens: 80, output_tokens: 10 },
  };
}

function baseEnv(overrides = {}) {
  return {
    TYPESAFE_API_KEY: API_KEY,
    GITHUB_TOKEN: 'test-token-github',
    GITHUB_REPOSITORY: 'samsoncirocco-cmyk/TattTester',
    PR_NUMBER: '17',
    PR_HEAD_REPO: 'samsoncirocco-cmyk/TattTester',
    ...overrides,
  };
}

function reviewDiff() {
  return unified([
    {
      path: 'src/services/payments/stripe-fee.js',
      hunks: [{
        oldStart: 10,
        oldCount: 3,
        newStart: 10,
        newCount: 4,
        lines: [
          ' const fee = 100;',
          `-const cap = 1;`,
          `+const cap = 2; // ${SENTINEL}`,
          ' return fee;',
        ],
      }],
    },
    {
      path: 'src/app/landing/page.js',
      hunks: [{
        lines: [
          '-export const quote = "";',
          '+export const quote = "Artists earn twice as much after switching.";',
        ],
      }],
    },
    {
      path: 'package-lock.json',
      hunks: [{ lines: ['-{}', '+{"lock":true}'] }],
    },
  ]);
}

function installFetch({ diff = reviewDiff(), typesafe, comments, onTypesafe } = {}) {
  const calls = [];
  let typesafeAttempts = 0;
  const fetch = vi.fn(async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    const accept = init.headers?.Accept || '';
    if (href === ENDPOINT) {
      typesafeAttempts += 1;
      if (onTypesafe) return onTypesafe(init, typesafeAttempts);
      if (typesafe) return typesafe(init, typesafeAttempts);
      const requestBody = JSON.parse(init.body);
      return http({
        body: answersFor(requestBody, (question) => {
          const file = question.instructions.file;
          const questionText = question.instructions.question;
          if (file.includes('stripe-fee') && questionText.includes('pricing')) return 0.91;
          if (file.includes('landing') && questionText.includes('marketing')) return 0.84;
          if (file.includes('stripe-fee') && questionText.includes('secret')) return 0.69;
          return 0.04;
        }),
      });
    }
    if (accept.includes('application/vnd.github.diff')) {
      return http({ body: diff });
    }
    if (href.includes('/issues/') && href.includes('/comments')) {
      if (comments) return comments(init, href);
      if (init.method === 'POST') return http({ status: 201, body: { id: 1 } });
      return http({ body: [] });
    }
    throw new Error(`unexpected fetch ${init.method || 'GET'} ${href}`);
  });
  return { fetch, calls };
}

function postedComment(calls) {
  const post = calls.find((call) => call.init.method === 'POST' && call.url.includes('/comments'));
  const patch = calls.find((call) => call.init.method === 'PATCH');
  const raw = post?.init.body || patch?.init.body;
  return raw ? JSON.parse(raw).body : null;
}

describe('parseDiff and selectUnits', () => {
  it('keeps text hunks and drops binary diffs, lockfiles, and context-only hunks', () => {
    const diff = [
      unified([
        {
          path: 'src/old-name.js',
          to: 'src/new-name.js',
          hunks: [{
            oldStart: 1,
            oldCount: 3,
            newStart: 1,
            newCount: 3,
            lines: [' keep', '-old', '+new'],
          }],
        },
        {
          path: 'src/removed.js',
          deleted: true,
          hunks: [{
            oldStart: 4,
            oldCount: 2,
            newStart: 0,
            newCount: 0,
            lines: ['-one', '-two'],
          }],
        },
      ]),
      'diff --git a/public/logo.png b/public/logo.png',
      'Binary files a/public/logo.png and b/public/logo.png differ',
      unified([{
        path: 'src/context-only.js',
        hunks: [{ lines: [' unchanged', ' still'] }],
      }]),
    ].join('\n');

    const units = selectUnits(parseDiff(diff));
    expect(units.map((unit) => [unit.file, unit.location])).toEqual([
      ['src/new-name.js', 'lines 1-3'],
      ['src/removed.js', 'removed lines 4-5'],
    ]);

    const lock = selectUnits(parseDiff(reviewDiff()));
    expect(lock.map((unit) => unit.file)).toEqual([
      'src/services/payments/stripe-fee.js',
      'src/app/landing/page.js',
    ]);
  });

  it('truncates an oversized hunk and marks it', () => {
    const longLine = `+${'a'.repeat(7000)}`;
    const [unit] = selectUnits(parseDiff(unified([{
      path: 'src/big.js',
      hunks: [{ lines: [longLine] }],
    }])));
    expect(unit.truncated).toBe(true);
    expect(unit.text.endsWith('[truncated]')).toBe(true);
    expect(unit.text.length).toBeLessThan(longLine.length);
  });
});

describe('planBatches', () => {
  it('sends sensitive files first and stops at the call cap', () => {
    const units = [
      { file: 'src/readme.js', text: 'x'.repeat(20), location: 'line 1' },
      { file: 'src/stripe/fee.js', text: 'y'.repeat(20), location: 'line 2' },
      { file: 'docs/notes.js', text: 'z'.repeat(20), location: 'line 3' },
    ];
    const { batches, skipped } = planBatches(units, { maxCalls: 1, maxHunksPerCall: 1 });
    expect(batches).toHaveLength(1);
    expect(batches[0].map((unit) => unit.file)).toEqual(['src/stripe/fee.js']);
    expect(skipped.map((unit) => unit.file)).toEqual(['src/readme.js', 'docs/notes.js']);
  });

  it('packs several hunks into one request until the hunk cap', () => {
    const units = Array.from({ length: 13 }, (_, index) => ({
      file: `src/file-${index}.js`,
      text: `+line ${index}`,
      location: 'line 1',
    }));
    const { batches, skipped } = planBatches(units, { maxCalls: 6, maxHunksPerCall: 12 });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(12);
    expect(batches[1]).toHaveLength(1);
    expect(skipped).toEqual([]);
  });
});

describe('buildRequest and warnings', () => {
  it('asks one Noul per check per hunk against jev-latest', () => {
    const units = selectUnits(parseDiff(reviewDiff()));
    const { body, index } = buildRequest(units);
    expect(body.model).toBe(MODEL);
    expect(body.model).toBe('jev-latest');
    expect(body.state).not.toContain(SENTINEL);
    expect(Object.values(body.questions)).toHaveLength(units.length * CHECKS.length);
    for (const question of Object.values(body.questions)) {
      expect(question.type).toBe('noul');
      expect(question.criteria.true).toEqual(expect.any(String));
      expect(question.criteria.false).toEqual(expect.any(String));
    }
    expect(Object.values(body.questions).map((question) => question.instructions.question)).toEqual(
      units.flatMap(() => CHECKS.map((check) => check.question)),
    );
    expect(body.questions.h0_pricing.instructions.diff_hunk).toContain(SENTINEL);
    expect(index.map((item) => item.label)).toEqual(units.flatMap(() => CHECKS.map((check) => check.label)));
  });

  it('reports file and probability only at or above the threshold', () => {
    const index = [
      { id: 'h0_pricing', file: 'src/fee.js', label: CHECKS[0].label, location: 'lines 10-13' },
      { id: 'h0_secret', file: 'src/fee.js', label: CHECKS[1].label, location: 'lines 10-13' },
      { id: 'h0_claims', file: 'src/fee.js', label: CHECKS[2].label, location: 'lines 10-13' },
    ];
    const { warnings, missing } = warningsFromAnswers(index, {
      h0_pricing: { type: 'noul', noul: WARN_THRESHOLD },
      h0_secret: { type: 'noul', noul: WARN_THRESHOLD - 0.01 },
      h0_claims: { type: 'noul' },
    });
    expect(missing).toEqual(['h0_claims']);
    expect(warnings).toEqual([{
      file: 'src/fee.js',
      label: CHECKS[0].label,
      location: 'lines 10-13',
      probability: WARN_THRESHOLD,
    }]);
  });
});

describe('renderComment', () => {
  it('renders one advisory comment with file, check, and probability', () => {
    const comment = renderComment({
      warnings: [
        { file: 'src/low.js', label: CHECKS[1].label, location: 'line 2', probability: 0.7 },
        { file: 'src/high.js', label: CHECKS[0].label, location: 'lines 4-6', probability: 0.95 },
      ],
      reviewedHunks: 2,
      calls: 1,
      skipped: [{ file: 'src/later.js' }],
      answeredBy: ['jev-1.14.0'],
      maxCalls: 1,
    });
    expect(comment.startsWith(COMMENT_MARKER)).toBe(true);
    expect(comment).toContain('does not block merge');
    expect(comment).toContain('`src/high.js` (lines 4-6)');
    expect(comment).toContain(CHECKS[0].label);
    expect(comment).toContain('0.95');
    expect(comment.indexOf('src/high.js')).toBeLessThan(comment.indexOf('src/low.js'));
    expect(comment).toContain('capped at 1');
    expect(comment).toContain('`jev-1.14.0`');
    expect(comment).not.toContain(SENTINEL);
  });
});

describe('runReview', () => {
  it('posts one comment for warnings and keeps the hunk text out of it', async () => {
    const { fetch, calls } = installFetch();
    const result = await runReview({
      env: baseEnv(),
      fetch,
      signal: new AbortController().signal,
      sleep: async () => {},
      log() {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.commented).toBe(true);
    expect(result.action).toBe('created');
    expect(result.calls).toBe(1);
    const typesafe = calls.filter((call) => call.url === ENDPOINT);
    expect(typesafe).toHaveLength(1);
    expect(typesafe[0].init.method).toBe('POST');
    expect(typesafe[0].init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const requestBody = JSON.parse(typesafe[0].init.body);
    expect(requestBody.model).toBe('jev-latest');
    expect(requestBody.questions.h0_pricing.type).toBe('noul');
    expect(JSON.stringify(requestBody)).toContain(SENTINEL);
    expect(JSON.stringify(requestBody)).not.toContain(API_KEY);

    const comment = postedComment(calls);
    expect(comment.startsWith(COMMENT_MARKER)).toBe(true);
    expect(comment).toContain('`src/services/payments/stripe-fee.js`');
    expect(comment).toContain('0.91');
    expect(comment).toContain(CHECKS[0].label);
    expect(comment).toContain('`src/app/landing/page.js`');
    expect(comment).toContain(CHECKS[2].label);
    const findings = comment.slice(0, comment.indexOf('Reviewed'));
    expect(findings).not.toContain(CHECKS[1].label);
    expect(comment).toContain(`Each hunk was asked: ${CHECKS.map((check) => check.label).join('; ')}.`);
    expect(comment).not.toContain(SENTINEL);
    expect(comment).not.toContain(API_KEY);
    expect(calls.filter((call) => call.init.method === 'POST' && call.url.includes('/comments'))).toHaveLength(1);
  });

  it('updates the existing marker comment instead of posting a second one', async () => {
    const commentUrl = 'https://api.github.com/repos/samsoncirocco-cmyk/TattTester/issues/comments/42';
    const { fetch, calls } = installFetch({
      comments(init, href) {
        if (!init.method || init.method === 'GET') {
          if (href.includes('page=2')) {
            return http({ body: [{ id: 42, url: commentUrl, body: `${COMMENT_MARKER}\nold warning` }] });
          }
          return http({
            body: [{ id: 1, body: 'thanks' }],
            headers: { link: '<https://api.github.com/repos/samsoncirocco-cmyk/TattTester/issues/17/comments?page=2>; rel="next"' },
          });
        }
        if (init.method === 'PATCH') return http({ body: { id: 42 } });
        return http({ status: 500, body: { error: 'should not create' } });
      },
    });

    const result = await runReview({
      env: baseEnv(),
      fetch,
      signal: new AbortController().signal,
      sleep: async () => {},
      log() {},
    });

    expect(result.action).toBe('updated');
    expect(calls.some((call) => call.init.method === 'PATCH' && call.url === commentUrl)).toBe(true);
    expect(calls.some((call) => call.init.method === 'POST' && call.url.includes('/comments'))).toBe(false);
  });

  it('clears a previous warning when nothing crosses the threshold', async () => {
    const { fetch, calls } = installFetch({
      typesafe(init) {
        const requestBody = JSON.parse(init.body);
        return http({ body: answersFor(requestBody, () => 0.12) });
      },
    });
    const result = await runReview({
      env: baseEnv(),
      fetch,
      signal: new AbortController().signal,
      sleep: async () => {},
      log() {},
    });
    expect(result.warnings).toEqual([]);
    expect(postedComment(calls)).toContain('No warnings at or above the threshold.');
  });

  it('skips a fork before any network call', async () => {
    const { fetch, calls } = installFetch();
    const result = await runReview({
      env: baseEnv({ PR_HEAD_REPO: 'someone/TattTester' }),
      fetch,
      signal: new AbortController().signal,
      log() {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.commented).toBe(false);
    expect(result.notices.join(' ')).toMatch(/fork/i);
    expect(calls).toHaveLength(0);
  });

  it('treats a fork flag in the event payload as a skip', async () => {
    const { fetch, calls } = installFetch();
    const result = await runReview({
      env: baseEnv({ PR_HEAD_REPO: '', GITHUB_REPOSITORY: '' }),
      fetch,
      readEvent: () => ({ pull_request: { head: { repo: { fork: true, full_name: 'someone/TattTester' } } } }),
      signal: new AbortController().signal,
      log() {},
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    expect(isForkPullRequest({}, { pull_request: { head: { repo: { fork: true } } } })).toBe(true);
  });

  it('prints a notice and does not call TypeSafe when the key is absent', async () => {
    const { fetch, calls } = installFetch();
    const logs = [];
    const result = await runReview({
      env: baseEnv({ TYPESAFE_API_KEY: '   ' }),
      fetch,
      signal: new AbortController().signal,
      log: (message) => logs.push(message),
    });
    expect(result.exitCode).toBe(0);
    expect(result.commented).toBe(false);
    expect(logs.join('\n')).toContain('TYPESAFE_API_KEY is not set');
    expect(calls).toHaveLength(0);
  });

  it('retries a TypeSafe 429 once and then comments', async () => {
    const sleeps = [];
    const { fetch, calls } = installFetch({
      onTypesafe(init, attempt) {
        if (attempt === 1) return http({ status: 429, headers: { 'retry-after': '1' } });
        const requestBody = JSON.parse(init.body);
        return http({ body: answersFor(requestBody, () => 0.05) });
      },
    });
    const result = await runReview({
      env: baseEnv(),
      fetch,
      signal: new AbortController().signal,
      sleep: async (delay) => { sleeps.push(delay); },
      log() {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.commented).toBe(true);
    expect(sleeps).toEqual([1000]);
    expect(calls.filter((call) => call.url === ENDPOINT)).toHaveLength(2);
  });

  it('exits 0 without a comment when TypeSafe fails', async () => {
    const { fetch, calls } = installFetch({
      onTypesafe() {
        return http({ status: 500 });
      },
    });
    const result = await runReview({
      env: baseEnv(),
      fetch,
      signal: new AbortController().signal,
      sleep: async () => {},
      log() {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.commented).toBe(false);
    expect(result.notices.join(' ')).toContain('HTTP 500');
    expect(calls.filter((call) => call.url === ENDPOINT)).toHaveLength(2);
    expect(calls.some((call) => call.init.method === 'POST' && call.url.includes('/comments'))).toBe(false);
  });

  it('does not retry a 401 and redacts the key from notices', async () => {
    const { fetch, calls } = installFetch({
      onTypesafe() {
        throw new Error(`socket hang up Bearer ${API_KEY}`);
      },
    });
    const result = await runReview({
      env: baseEnv(),
      fetch,
      signal: new AbortController().signal,
      sleep: async () => {},
      log() {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.commented).toBe(false);
    expect(result.notices.join(' ')).toContain('[redacted]');
    expect(result.notices.join(' ')).not.toContain(API_KEY);
    expect(calls.filter((call) => call.url === ENDPOINT)).toHaveLength(1);
  });

  it('posts a partial comment when a later batch fails', async () => {
    const files = Array.from({ length: 13 }, (_, index) => ({
      path: index === 0 ? 'src/stripe/fee.js' : `src/plain-${index}.js`,
      hunks: [{ lines: [`+const value${index} = ${index};`] }],
    }));
    const { fetch, calls } = installFetch({
      diff: unified(files),
      onTypesafe(init, attempt) {
        if (attempt > 1) return http({ status: 502 });
        const requestBody = JSON.parse(init.body);
        return http({
          body: answersFor(requestBody, (question) => (
            question.instructions.file.includes('stripe') && question.instructions.question.includes('pricing') ? 0.93 : 0.02
          )),
        });
      },
    });
    const result = await runReview({
      env: baseEnv({ TYPESAFE_MAX_CALLS: '2' }),
      fetch,
      signal: new AbortController().signal,
      sleep: async () => {},
      log() {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toBe(1);
    expect(result.commented).toBe(true);
    const comment = postedComment(calls);
    expect(comment).toContain('src/stripe/fee.js');
    expect(comment).toContain('0.93');
    expect(comment).toContain('Some TypeSafe calls failed');
  });

  it('names hunks left out by the call cap and still reviews a sensitive file', async () => {
    const files = [
      ...Array.from({ length: 12 }, (_, index) => ({
        path: `src/plain-${index}.js`,
        hunks: [{ lines: [`+const value${index} = ${index};`] }],
      })),
      {
        path: 'src/stripe/fee.js',
        hunks: [{ lines: ['+const deposit = 2500;'] }],
      },
    ];
    const { fetch, calls } = installFetch({
      diff: unified(files),
      typesafe(init) {
        const requestBody = JSON.parse(init.body);
        return http({
          body: answersFor(requestBody, (question) => (
            question.instructions.file.includes('stripe') && question.instructions.question.includes('pricing') ? 0.9 : 0.01
          )),
        });
      },
    });
    const result = await runReview({
      env: baseEnv({ TYPESAFE_MAX_CALLS: '1' }),
      fetch,
      signal: new AbortController().signal,
      sleep: async () => {},
      log() {},
    });
    expect(result.calls).toBe(1);
    const comment = postedComment(calls);
    expect(comment).toContain('src/stripe/fee.js');
    expect(comment).toContain('capped at 1');
    expect(comment).toContain('src/plain-11.js');
    const requestBody = JSON.parse(calls.find((call) => call.url === ENDPOINT).init.body);
    const filesSent = new Set(Object.values(requestBody.questions).map((question) => question.instructions.file));
    expect(filesSent.has('src/stripe/fee.js')).toBe(true);
    expect(filesSent.size).toBe(12);
  });

  it('falls back when the threshold override is not a probability', async () => {
    const { notices } = reviewOptions({ TYPESAFE_WARN_THRESHOLD: 'high', TYPESAFE_MAX_CALLS: '99' });
    expect(notices.join(' ')).toContain(WARN_THRESHOLD.toFixed(2));
    expect(notices.join(' ')).toContain(String(MAX_CALLS));
    const { fetch, calls } = installFetch({
      typesafe(init) {
        const requestBody = JSON.parse(init.body);
        return http({ body: answersFor(requestBody, () => 0.5) });
      },
    });
    const result = await runReview({
      env: baseEnv({ TYPESAFE_WARN_THRESHOLD: 'high' }),
      fetch,
      signal: new AbortController().signal,
      sleep: async () => {},
      log() {},
    });
    expect(result.warnings).toEqual([]);
    expect(postedComment(calls)).toContain('No warnings at or above the threshold.');
    expect(result.notices.join(' ')).toContain('TYPESAFE_WARN_THRESHOLD');
  });

  it('exits 0 when the pull request comment cannot be posted', async () => {
    const { fetch } = installFetch({
      comments() {
        return http({ status: 403, body: { message: 'Resource not accessible' } });
      },
    });
    const result = await runReview({
      env: baseEnv(),
      fetch,
      signal: new AbortController().signal,
      sleep: async () => {},
      log() {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.commented).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.notices.join(' ')).toContain('HTTP 403');
  });

  it('does not call TypeSafe when the diff has no reviewable hunks', async () => {
    const { fetch, calls } = installFetch({
      diff: [
        'diff --git a/public/logo.png b/public/logo.png',
        'Binary files a/public/logo.png and b/public/logo.png differ',
      ].join('\n'),
    });
    const result = await runReview({
      env: baseEnv(),
      fetch,
      signal: new AbortController().signal,
      sleep: async () => {},
      log() {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.notices.join(' ')).toMatch(/No reviewable diff hunks/);
    expect(calls.some((call) => call.url === ENDPOINT)).toBe(false);
  });
});

describe('workflow contract', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/typesafe-pr-review.yml'), 'utf8');
  const script = readFileSync(resolve(repoRoot, 'scripts/ci/typesafe-pr-review.mjs'), 'utf8');

  it('stays advisory, fork-safe, and outside the app env schema', () => {
    expect(workflow).toContain('secrets.TYPESAFE_API_KEY');
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(workflow).toContain('continue-on-error: true');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).not.toContain('issues: write');
    expect(workflow).toContain('ref: ${{ github.event.pull_request.base.sha }}');
    expect(workflow).toContain("vars.TYPESAFE_PR_REVIEW_LIVE == 'true' && secrets.TYPESAFE_API_KEY || ''");
    expect(workflow).not.toMatch(/github\.event\.pull_request\.(title|body)/);
    expect(workflow).toContain('node scripts/ci/typesafe-pr-review.mjs');
    expect(workflow).not.toMatch(/^\s*pull_request_target\s*:/m);
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(script).toContain(ENDPOINT);
    expect(script).toContain("model: MODEL");
    const imports = [...script.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
  });
});

describe('partial reviews (S427-1)', () => {
  const prior = `${COMMENT_MARKER}\n### TypeSafe semantic review (advisory)\n| \`src/a.js\` | secret | 0.91 |`;
  const priorComments = (patched) => (init) => {
    if (!init.method || init.method === 'GET') {
      return http({ body: [{ id: 42, url: 'https://api.github.com/repos/samsoncirocco-cmyk/TattTester/issues/comments/42', body: prior }] });
    }
    if (init.method === 'PATCH') { patched.push(JSON.parse(init.body).body); return http({ body: { id: 42 } }); }
    return http({ status: 500 });
  };

  for (const [name, answers] of [
    ['an empty 2xx answer set', () => ({})],
    ['out-of-range probabilities', (body) => answersFor(body, () => 1.7).answers],
    ['non-numeric probabilities', (body) => answersFor(body, () => 'high').answers],
  ]) {
    it(`does not report clean and keeps the earlier warning for ${name}`, async () => {
      const patched = [];
      const { fetch } = installFetch({
        typesafe(init) { return http({ body: { model: 'jev-1.14.0', answers: answers(JSON.parse(init.body)) } }); },
        comments: priorComments(patched),
      });
      const result = await runReview({ env: baseEnv(), fetch, signal: new AbortController().signal, sleep: async () => {}, log() {} });
      expect(result.exitCode).toBe(0);
      expect(result.partial).toBe(true);
      expect(patched).toHaveLength(1);
      expect(patched[0]).not.toContain('No warnings at or above the threshold.');
      expect(patched[0]).toContain('Partial review');
      expect(patched[0]).toContain('not reviewed');
      expect(patched[0]).toContain('| `src/a.js` | secret | 0.91 |');
    });
  }

  it('marks out-of-range answers as missing', () => {
    const index = [{ id: 'h0_secret', file: 'a', label: 'secret' }, { id: 'h0_price', file: 'a', label: 'price' }];
    const parsed = warningsFromAnswers(index, { h0_secret: { noul: -0.2 }, h0_price: { noul: 0.9 } }, 0.7);
    expect(parsed.missing).toEqual(['h0_secret']);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('does not nest an older kept review twice', () => {
    const once = mergeWithPrior('new', prior);
    const twice = mergeWithPrior('newer', `${COMMENT_MARKER}\n${once}`);
    expect(twice.match(/Earlier review/g)).toHaveLength(1);
  });

  it('escapes backslashes before pipes in table cells', () => {
    const comment = renderComment({
      warnings: [{ file: 'a\\|b.js', label: 'x', location: 'L1', probability: 0.9 }],
      reviewedHunks: 1, calls: 1, skipped: [],
    });
    expect(comment).toContain('a\\\\\\|b.js');
  });
});
