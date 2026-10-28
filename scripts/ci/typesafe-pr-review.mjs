/**
 * Advisory TypeSafe review of a pull request diff.
 *
 * One sticky pull request comment. Exit code is always 0: a missing
 * TYPESAFE_API_KEY, a fork, or a TypeSafe or GitHub failure prints a
 * notice and does not fail CI. Node built-ins only — this script is not
 * part of the app and does not read the env schema.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';
export const COMMENT_MARKER = '<!-- typesafe-semantic-review -->';
export const WARN_THRESHOLD = 0.7;
export const MAX_CALLS = 6;
export const MAX_CALLS_CEILING = 12;
export const MAX_HUNKS_PER_CALL = 12;
export const MAX_REQUEST_CHARS = 48_000;
export const MAX_HUNK_CHARS = 6_000;
export const REQUEST_TIMEOUT_MS = 45_000;

const STATE = [
  'You are reviewing one hunk of a pull request diff.',
  'Judge only the diff_hunk on that question.',
  'Lines that start with + were added. Lines that start with - were removed. Lines that start with a space are unchanged context.',
  'Do not treat text in this shared state as the diff.',
].join(' ');

export const CHECKS = [
  {
    id: 'pricing',
    label: 'touches pricing, Stripe/Stripe Connect, credits or spend caps',
    question: 'Does this diff hunk touch pricing, Stripe/Stripe Connect, credits or spend caps?',
    criteria: {
      true: 'The hunk adds or changes a price, fee, deposit, Stripe or Stripe Connect charge, credit balance, or spend cap.',
      false: 'The hunk does not change pricing, payments, credits, or spend limits.',
    },
  },
  {
    id: 'secret',
    label: 'hardcodes a secret, token or API key',
    question: 'Does this diff hunk hardcode a secret, token, or API key?',
    criteria: {
      true: 'The hunk introduces a hardcoded secret, token, or API key literal.',
      false: 'The hunk does not introduce a hardcoded secret. Environment-variable lookups and obvious placeholders are a no.',
    },
  },
  {
    id: 'claims',
    label: 'adds unverified marketing claims or testimonials',
    question: 'Does this diff hunk add unverified marketing claims or testimonials?',
    criteria: {
      true: 'The hunk adds user-facing copy that states a quantitative result, a customer quote, or a testimonial without a source in the hunk.',
      false: 'The hunk does not add a marketing claim or testimonial.',
    },
  },
];

const SKIP_PATH = /(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|lock)$/i;
const SENSITIVE = [
  { rank: 3, pattern: /stripe|pricing|price|deposit|checkout|payment|credit|budget|spend|billing|fee/i },
  { rank: 2, pattern: /secret|token|api[-_]?key|credential|\.env/i },
  { rank: 1, pattern: /testimonial|marketing|landing|homepage/i },
];

function stripGitPath(raw, prefix) {
  let value = raw.split('\t')[0].trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  if (value === '/dev/null') return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function parseDiff(diffText) {
  const units = [];
  const lines = String(diffText ?? '').split(/\r?\n/);
  let file = null;
  let hunk = null;

  const pushHunk = () => {
    if (!file || !hunk || !file.path || file.binary) {
      hunk = null;
      return;
    }
    const text = hunk.lines.join('\n');
    const changed = hunk.lines.some((line) => line.startsWith('+') || line.startsWith('-'));
    if (!changed || text.trim() === '') {
      hunk = null;
      return;
    }
    units.push({
      file: file.path,
      oldStart: hunk.oldStart,
      oldCount: hunk.oldCount,
      newStart: hunk.newStart,
      newCount: hunk.newCount,
      text,
    });
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      pushHunk();
      file = { path: null, binary: false };
      continue;
    }
    if (!file) continue;
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true;
      hunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = stripGitPath(line.slice(4), 'b/');
      if (path) file.path = path;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!file.path) {
        const path = stripGitPath(line.slice(4), 'a/');
        if (path) file.path = path;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      pushHunk();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match || file.binary) continue;
      hunk = {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      continue;
    }
    if (hunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\'))) {
      hunk.lines.push(line);
    }
  }
  pushHunk();
  return units;
}

export function locationLabel(unit) {
  if (unit.newCount > 0) {
    const end = unit.newStart + unit.newCount - 1;
    return unit.newCount === 1 ? `line ${unit.newStart}` : `lines ${unit.newStart}-${end}`;
  }
  if (unit.oldCount > 0) {
    const end = unit.oldStart + unit.oldCount - 1;
    return unit.oldCount === 1 ? `removed line ${unit.oldStart}` : `removed lines ${unit.oldStart}-${end}`;
  }
  return 'diff';
}

function truncateHunk(text) {
  if (text.length <= MAX_HUNK_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_HUNK_CHARS)}\n[truncated]`, truncated: true };
}

export function selectUnits(units) {
  const selected = [];
  for (const unit of units) {
    if (SKIP_PATH.test(unit.file) || SKIP_EXT.test(unit.file)) continue;
    const { text, truncated } = truncateHunk(unit.text);
    selected.push({ ...unit, text, truncated, location: locationLabel(unit) });
  }
  return selected;
}

function priority(unit) {
  for (const entry of SENSITIVE) {
    if (entry.pattern.test(unit.file)) return entry.rank;
  }
  return 0;
}

function requestChars(units) {
  const hunkChars = units.reduce((sum, unit) => sum + unit.text.length, 0);
  return STATE.length + hunkChars * CHECKS.length + units.length * CHECKS.length * 500;
}

export function planBatches(units, options = {}) {
  const maxCalls = options.maxCalls ?? MAX_CALLS;
  const maxHunksPerCall = options.maxHunksPerCall ?? MAX_HUNKS_PER_CALL;
  const maxRequestChars = options.maxRequestChars ?? MAX_REQUEST_CHARS;
  const ordered = units
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => priority(b.unit) - priority(a.unit) || a.index - b.index)
    .map((item) => item.unit);

  const batches = [];
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    batches.push(current);
    current = [];
  };

  for (let index = 0; index < ordered.length; index += 1) {
    const unit = ordered[index];
    const overflow = current.length > 0
      && (current.length >= maxHunksPerCall || requestChars([...current, unit]) > maxRequestChars);
    if (overflow) flush();
    if (batches.length >= maxCalls) {
      return { batches, skipped: ordered.slice(index) };
    }
    current.push(unit);
  }
  flush();
  return { batches, skipped: [] };
}

export function buildRequest(batch) {
  const questions = {};
  const index = [];
  batch.forEach((unit, hunkIndex) => {
    for (const check of CHECKS) {
      const id = `h${hunkIndex}_${check.id}`;
      questions[id] = {
        type: 'noul',
        instructions: {
          file: unit.file,
          location: unit.location,
          diff_hunk: unit.text,
          question: check.question,
        },
        criteria: {
          true: check.criteria.true,
          false: check.criteria.false,
        },
      };
      index.push({
        id,
        file: unit.file,
        label: check.label,
        location: unit.location,
        checkId: check.id,
      });
    }
  });
  return {
    body: {
      model: MODEL,
      state: STATE,
      questions,
    },
    index,
  };
}

export function warningsFromAnswers(index, answers, threshold = WARN_THRESHOLD) {
  const warnings = [];
  const missing = [];
  for (const item of index) {
    const probability = answers?.[item.id]?.noul;
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      missing.push(item.id);
      continue;
    }
    if (probability >= threshold) {
      warnings.push({
        file: item.file,
        label: item.label,
        location: item.location,
        probability,
      });
    }
  }
  return { warnings, missing };
}

function cell(value) {
  // Escape backslashes first so a trailing backslash cannot unescape the pipe.
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

export function renderComment({
  warnings,
  reviewedHunks,
  calls,
  skipped,
  threshold = WARN_THRESHOLD,
  maxCalls = MAX_CALLS,
  model = MODEL,
  answeredBy = [],
  truncated = false,
  partialFailure = false,
  unanswered = 0,
}) {
  const partial = partialFailure || unanswered > 0;
  const lines = [
    COMMENT_MARKER,
    '### TypeSafe semantic review (advisory)',
    '',
    `This check does not block merge. A warning is a Noul probability at or above **${threshold.toFixed(2)}** from \`${model}\`.`,
    '',
  ];

  if (warnings.length === 0 && partial) {
    lines.push('**Partial review.** No warnings were found in the answers received, but this is not a clean result.');
  } else if (warnings.length === 0) {
    lines.push('No warnings at or above the threshold.');
  } else {
    const sorted = [...warnings].sort((a, b) => (
      b.probability - a.probability || a.file.localeCompare(b.file) || a.label.localeCompare(b.label)
    ));
    const shown = sorted.slice(0, 40);
    lines.push('| File | Check | Probability |');
    lines.push('| --- | --- | --- |');
    for (const warning of shown) {
      const where = warning.location ? `\`${cell(warning.file)}\` (${cell(warning.location)})` : `\`${cell(warning.file)}\``;
      lines.push(`| ${where} | ${cell(warning.label)} | ${warning.probability.toFixed(2)} |`);
    }
    if (sorted.length > shown.length) {
      lines.push('');
      lines.push(`${sorted.length - shown.length} more warnings were omitted from this comment.`);
    }
  }

  lines.push('');
  const hunkWord = reviewedHunks === 1 ? 'hunk' : 'hunks';
  const callWord = calls === 1 ? 'call' : 'calls';
  lines.push(`Reviewed ${reviewedHunks} ${hunkWord} in ${calls} TypeSafe API ${callWord}.`);
  lines.push(`Each hunk was asked: ${CHECKS.map((check) => check.label).join('; ')}.`);
  if (answeredBy.length > 0) {
    lines.push(`Answered by ${answeredBy.map((name) => `\`${name}\``).join(', ')}.`);
  }
  if (skipped.length > 0) {
    const files = [...new Set(skipped.map((unit) => unit.file))];
    const shown = files.slice(0, 15).map((file) => `\`${file}\``).join(', ');
    const extra = files.length > 15 ? ', …' : '';
    lines.push(`Not sent (${skipped.length} ${skipped.length === 1 ? 'hunk' : 'hunks'}) because this run is capped at ${maxCalls} TypeSafe calls: ${shown}${extra}.`);
  }
  if (truncated) {
    lines.push('At least one hunk was truncated before it was sent.');
  }
  if (partialFailure) {
    lines.push('Some TypeSafe calls failed. Those hunks are omitted. The workflow still exits successfully.');
  }
  if (unanswered > 0) {
    lines.push(`${unanswered} ${unanswered === 1 ? 'check' : 'checks'} got no valid answer and ${unanswered === 1 ? 'was' : 'were'} not reviewed.`);
  }
  return lines.join('\n');
}

export function isForkPullRequest(env, event) {
  const baseRepo = env.GITHUB_REPOSITORY
    || event?.repository?.full_name
    || event?.pull_request?.base?.repo?.full_name
    || '';
  const headRepo = env.PR_HEAD_REPO || event?.pull_request?.head?.repo?.full_name || '';
  if (headRepo && baseRepo && headRepo !== baseRepo) return true;
  return event?.pull_request?.head?.repo?.fork === true;
}

export function reviewOptions(env) {
  const notices = [];
  let threshold = WARN_THRESHOLD;
  if (env.TYPESAFE_WARN_THRESHOLD !== undefined && env.TYPESAFE_WARN_THRESHOLD !== '') {
    const parsed = Number(env.TYPESAFE_WARN_THRESHOLD);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      notices.push(`TYPESAFE_WARN_THRESHOLD must be between 0 and 1. Using ${WARN_THRESHOLD.toFixed(2)}.`);
    } else {
      threshold = parsed;
    }
  }

  let maxCalls = MAX_CALLS;
  if (env.TYPESAFE_MAX_CALLS !== undefined && env.TYPESAFE_MAX_CALLS !== '') {
    const parsed = Number(env.TYPESAFE_MAX_CALLS);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CALLS_CEILING) {
      notices.push(`TYPESAFE_MAX_CALLS must be an integer from 1 to ${MAX_CALLS_CEILING}. Using ${MAX_CALLS}.`);
    } else {
      maxCalls = parsed;
    }
  }

  return { threshold, maxCalls, notices };
}

function safeError(error, secret) {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name) ?? headers.get(name.toLowerCase());
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : null;
}

function nextLink(headers) {
  const link = header(headers, 'link') || '';
  const match = /<([^>]+)>;\s*rel="next"/.exec(link);
  return match ? match[1] : null;
}

async function readBody(response) {
  if (typeof response.text === 'function') return response.text();
  if (typeof response.json === 'function') return JSON.stringify(await response.json());
  return '';
}

export async function postSystemOne({ fetch, apiKey, body, sleep, signal, endpoint = ENDPOINT }) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (response.ok) {
      if (typeof response.json === 'function') return response.json();
      return JSON.parse(await readBody(response));
    }
    lastStatus = response.status;
    const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
    if (!retryable || attempt === 1) {
      throw new Error(`HTTP ${response.status}`);
    }
    const retryAfter = Number(header(response.headers, 'retry-after'));
    const delay = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 0) * 1000, 5000) : 1000;
    await sleep(delay);
  }
  throw new Error(`HTTP ${lastStatus}`);
}

function githubHeaders(token, accept) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tatt-typesafe-pr-review',
  };
}

export async function fetchPullRequestDiff({ fetch, env, signal }) {
  if (env.TYPESAFE_DIFF_FILE) return readFileSync(env.TYPESAFE_DIFF_FILE, 'utf8');

  const repo = env.GITHUB_REPOSITORY;
  const pr = env.PR_NUMBER;
  const token = env.GITHUB_TOKEN;
  if (repo && pr && token) {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
      headers: githubHeaders(token, 'application/vnd.github.diff'),
      signal,
    });
    if (!response.ok) throw new Error(`GitHub diff HTTP ${response.status}`);
    const text = await readBody(response);
    return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  }

  if (env.BASE_SHA && env.HEAD_SHA) {
    return execFileSync('git', ['diff', '--unified=3', `${env.BASE_SHA}...${env.HEAD_SHA}`], {
      encoding: 'utf8',
      maxBuffer: 2_000_000,
    });
  }

  throw new Error('No pull request diff source');
}

async function listReviewComments({ fetch, env, signal }) {
  let url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues/${env.PR_NUMBER}/comments?per_page=100`;
  const headers = githubHeaders(env.GITHUB_TOKEN, 'application/vnd.github+json');
  while (url) {
    const response = await fetch(url, { headers, signal });
    if (!response.ok) throw new Error(`GitHub comments HTTP ${response.status}`);
    const comments = typeof response.json === 'function' ? await response.json() : JSON.parse(await readBody(response));
    const existing = comments.find((comment) => typeof comment.body === 'string' && comment.body.startsWith(COMMENT_MARKER));
    if (existing) return existing;
    url = nextLink(response.headers);
  }
  return null;
}

export const PRIOR_MARKER = '<!-- typesafe-prior-review -->';

// A partial run never erases an earlier review: the earlier result is kept below the new one.
export function mergeWithPrior(body, priorBody) {
  if (!priorBody) return body;
  const prior = priorBody.split(PRIOR_MARKER)[0].replace(COMMENT_MARKER, '').trim();
  if (!prior) return body;
  return `${body}\n\n${PRIOR_MARKER}\n<details><summary>Earlier review, kept because this run was partial</summary>\n\n${prior}\n\n</details>`;
}

export async function upsertReviewComment({ fetch, env, body, signal, partial = false }) {
  const headers = githubHeaders(env.GITHUB_TOKEN, 'application/vnd.github+json');
  const existing = await listReviewComments({ fetch, env, signal });
  if (existing) {
    if (partial) body = mergeWithPrior(body, existing.body);
    const response = await fetch(existing.url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
      signal,
    });
    if (!response.ok) throw new Error(`GitHub comment update HTTP ${response.status}`);
    return 'updated';
  }
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues/${env.PR_NUMBER}/comments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body }),
    signal,
  });
  if (!response.ok) throw new Error(`GitHub comment create HTTP ${response.status}`);
  return 'created';
}

function readGithubEvent(env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export async function runReview(deps) {
  const env = deps.env ?? {};
  const log = deps.log ?? (() => {});
  const notices = [];
  const notice = (message) => {
    notices.push(message);
    log(`notice: ${message}`);
  };
  const secret = (env.TYPESAFE_API_KEY || '').trim();
  const signal = deps.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const sleep = deps.sleep ?? ((delay) => new Promise((resolveDelay) => {
    setTimeout(resolveDelay, delay);
  }));
  const fetch = deps.fetch ?? globalThis.fetch;

  try {
    const event = deps.readEvent ? deps.readEvent() : readGithubEvent(env);
    if (isForkPullRequest(env, event)) {
      notice('Skipping TypeSafe review for a fork pull request.');
      return { exitCode: 0, notices, commented: false, warnings: [], calls: 0 };
    }
    if (!secret) {
      notice('TYPESAFE_API_KEY is not set. Skipping TypeSafe review.');
      return { exitCode: 0, notices, commented: false, warnings: [], calls: 0 };
    }

    const options = reviewOptions(env);
    for (const message of options.notices) notice(message);

    const diff = await fetchPullRequestDiff({ fetch, env, signal });
    const units = selectUnits(parseDiff(diff));
    if (units.length === 0) {
      notice('No reviewable diff hunks. Skipping TypeSafe review.');
      return { exitCode: 0, notices, commented: false, warnings: [], calls: 0 };
    }

    const { batches, skipped } = planBatches(units, { maxCalls: options.maxCalls });
    const warnings = [];
    const answeredBy = [];
    const sent = [];
    let calls = 0;
    let partialFailure = false;
    let unanswered = 0;

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const request = buildRequest(batch);
      try {
        const response = await postSystemOne({
          fetch,
          apiKey: secret,
          body: request.body,
          sleep,
          signal,
        });
        calls += 1;
        sent.push(...batch);
        if (response?.model && !answeredBy.includes(response.model)) answeredBy.push(response.model);
        const usage = response?.usage;
        if (usage && Number.isFinite(usage.input_tokens)) {
          log(`TypeSafe call used ${usage.input_tokens} input tokens.`);
        }
        const parsed = warningsFromAnswers(request.index, response?.answers, options.threshold);
        warnings.push(...parsed.warnings);
        unanswered += parsed.missing.length;
        if (parsed.missing.length > 0) {
          notice(`TypeSafe response omitted ${parsed.missing.length} answer(s).`);
        }
      } catch (error) {
        notice(`TypeSafe request failed (${safeError(error, secret)}).`);
        if (calls === 0) {
          return { exitCode: 0, notices, commented: false, warnings: [], calls: 0, skipped: skipped.length };
        }
        partialFailure = true;
        break;
      }
    }

    const reviewedHunks = sent.length;
    const truncated = sent.some((unit) => unit.truncated);

    const comment = renderComment({
      warnings,
      reviewedHunks,
      calls,
      skipped,
      threshold: options.threshold,
      maxCalls: options.maxCalls,
      model: MODEL,
      answeredBy,
      truncated,
      partialFailure,
      unanswered,
    });
    const partial = partialFailure || unanswered > 0;

    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY || !env.PR_NUMBER) {
      notice('GitHub comment target is not set. The review result was not posted.');
      log(comment);
      return { exitCode: 0, notices, commented: false, warnings, calls, comment, partial };
    }

    try {
      const action = await upsertReviewComment({ fetch, env, body: comment, signal, partial });
      log(`TypeSafe review comment ${action}.`);
      return { exitCode: 0, notices, commented: true, warnings, calls, comment, action, partial };
    } catch (error) {
      notice(`Could not post the pull request comment (${safeError(error, secret)}).`);
      return { exitCode: 0, notices, commented: false, warnings, calls, comment, partial };
    }
  } catch (error) {
    notice(`TypeSafe review failed (${safeError(error, secret)}).`);
    return { exitCode: 0, notices, commented: false, warnings: [], calls: 0 };
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  const result = await runReview({
    env: process.env,
    log: (message) => {
      if (message.startsWith('notice: ')) {
        const text = message.slice('notice: '.length).replace(/[\r\n]/g, ' ');
        console.log(`::notice title=TypeSafe review::${text}`);
        return;
      }
      console.log(message);
    },
  });
  process.exit(result.exitCode);
}
