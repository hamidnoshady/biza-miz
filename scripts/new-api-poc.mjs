#!/usr/bin/env node
/**
 * Standalone Biza Miz / New API compatibility smoke test.
 *
 * Defaults to READ-ONLY preflight. All completion/embedding calls require
 * BOTH --run and NEW_API_POC_PAID_ACK=yes. Do not use production credentials.
 *
 * This exercises protocol compatibility, NOT Biza Miz authorization or Rial
 * wallet settlement; those require a separate app-integrated canary.
 */
import { env, argv } from 'node:process';
import { pathToFileURL } from 'node:url';

const timeoutMs = 30_000;
const base = (env.NEW_API_POC_BASE_URL || 'http://127.0.0.1:3301/v1').replace(/\/+$/, '');
const root = base.endsWith('/v1') ? base.slice(0, -3) : base;
const tenantAKey = env.NEW_API_POC_TENANT_A_KEY || '';
const tenantBKey = env.NEW_API_POC_TENANT_B_KEY || '';
const model = env.NEW_API_POC_CHAT_MODEL || '';
const embeddingModel = env.NEW_API_POC_EMBEDDING_MODEL || '';
const tenantBExclusiveModel = env.NEW_API_POC_B_ONLY_MODEL || '';

export function parseSse(raw) {
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') {
      events.push({ done: true });
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {
      throw new Error('invalid SSE JSON frame');
    }
  }
  return events;
}

export function quotaSnapshot(payload) {
  const data = payload && typeof payload === 'object' ? payload.data : null;
  if (!data || typeof data !== 'object') return null;
  const used = Number(data.total_used);
  const available = Number(data.total_available);
  if (!Number.isFinite(used) || !Number.isFinite(available)) return null;
  // Quota units, not USD and NOT Rial.
  return { usedQuotaUnits: used, availableQuotaUnits: available };
}

function ensure(ok, message) {
  if (!ok) throw new Error(message);
}

async function send(path, key, options = {}) {
  const headers = { ...options.headers };
  if (key) headers.Authorization = 'Bearer ' + key;
  const response = await fetch(root + path, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  if (contentType.includes('application/json')) {
    try { payload = JSON.parse(raw); } catch { /* report malformed response below */ }
  }
  // No request/response bodies or bearer credentials in logs.
  return { status: response.status, ok: response.ok, raw, payload, contentType };
}

function chat(messages, overrides = {}) {
  return {
    model,
    messages,
    max_tokens: 96,
    temperature: 0,
    ...overrides,
  };
}

async function test(name, fn, results) {
  try {
    const details = await fn();
    results.push({ test: name, status: 'PASS', ...(details || {}) });
  } catch (error) {
    results.push({ test: name, status: 'FAIL', reason: error instanceof Error ? error.message : 'unknown' });
  }
}

async function optionalUsage(key) {
  if (!key) return null;
  const res = await send('/api/usage/token', key);
  return res.ok ? quotaSnapshot(res.payload) : null;
}

async function main() {
  const runPaid = argv.includes('--run');
  if (runPaid && env.NEW_API_POC_PAID_ACK !== 'yes') {
    throw new Error('Paid tests require explicit NEW_API_POC_PAID_ACK=yes');
  }
  if (!tenantAKey) throw new Error('NEW_API_POC_TENANT_A_KEY is required');
  if (runPaid && !model) throw new Error('NEW_API_POC_CHAT_MODEL is required with --run');
  const results = [];
  await test('public status endpoint', async () => {
    const r = await send('/api/status', '');
    ensure(r.ok && r.payload && r.payload.success === true, 'New API status missing or not healthy (HTTP ' + r.status + ')');
    return { httpStatus: r.status };
  }, results);
  await test('tenant A model listing', async () => {
    const r = await send('/v1/models', tenantAKey);
    ensure(r.ok && Array.isArray(r.payload?.data), 'tenant A /v1/models invalid (HTTP ' + r.status + ')');
    if (model) ensure(r.payload.data.some((item) => item.id === model), 'chat model not exposed to tenant A');
    if (tenantBExclusiveModel) ensure(!r.payload.data.some((item) => item.id === tenantBExclusiveModel), 'tenant A can see B-only model');
    return { modelCount: r.payload.data.length };
  }, results);
  await test('invalid token denied', async () => {
    const r = await send('/v1/models', 'invalid-poc-token');
    ensure(r.status === 401 || r.status === 403, 'invalid bearer was not denied, HTTP ' + r.status);
  }, results);
  if (tenantBKey) {
    await test('tenant B model listing', async () => {
      const r = await send('/v1/models', tenantBKey);
      ensure(r.ok && Array.isArray(r.payload?.data), 'tenant B /v1/models invalid');
      if (tenantBExclusiveModel) ensure(r.payload.data.some((item) => item.id === tenantBExclusiveModel), 'B-only model unavailable to B');
      return { modelCount: r.payload.data.length };
    }, results);
  }
  const beforeA = await optionalUsage(tenantAKey);
  const beforeB = await optionalUsage(tenantBKey);

  if (runPaid) {
    await test('nonstream chat and usage', async () => {
      const r = await send('/v1/chat/completions', tenantAKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: chat([{ role: 'user', content: 'Reply with BIZA_MIZ_POC_OK' }]),
      });
      ensure(r.ok && Array.isArray(r.payload?.choices), 'chat failed (HTTP ' + r.status + ')');
      ensure(Number.isFinite(Number(r.payload?.usage?.prompt_tokens)), 'chat lacks prompt token usage');
      ensure(Number.isFinite(Number(r.payload?.usage?.completion_tokens)), 'chat lacks completion token usage');
      return { inputTokens: r.payload.usage.prompt_tokens, outputTokens: r.payload.usage.completion_tokens };
    }, results);
    await test('SSE chat and terminal event', async () => {
      const r = await send('/v1/chat/completions', tenantAKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: chat([{ role: 'user', content: 'Answer OK' }], { stream: true, stream_options: { include_usage: true } }),
      });
      ensure(r.ok && r.contentType.includes('text/event-stream'), 'streaming content type/status invalid (HTTP ' + r.status + ')');
      const events = parseSse(r.raw);
      ensure(events.some((e) => e.done), 'SSE missing [DONE]');
      ensure(events.some((e) => Array.isArray(e.choices)), 'SSE missing model choices');
      return { events: events.length, terminalUsage: events.some((e) => e.usage && Number.isFinite(Number(e.usage.prompt_tokens))) };
    }, results);
    await test('function tool-call response', async () => {
      const r = await send('/v1/chat/completions', tenantAKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: chat([{ role: 'user', content: 'Call poc_read_only_check with tenant_label A.' }], {
          tools: [{
            type: 'function',
            function: {
              name: 'poc_read_only_check',
              description: 'Read-only fixture; do not execute tools.',
              parameters: { type: 'object', properties: { tenant_label: { type: 'string' } }, required: ['tenant_label'] },
            },
          }],
          tool_choice: { type: 'function', function: { name: 'poc_read_only_check' } },
        }),
      });
      ensure(r.ok, 'tool request HTTP ' + r.status);
      const calls = r.payload?.choices?.[0]?.message?.tool_calls || [];
      ensure(calls.some((c) => c.function?.name === 'poc_read_only_check'), 'expected function call not returned');
      return { toolCalls: calls.length };
    }, results);
    await test('structured JSON response', async () => {
      const r = await send('/v1/chat/completions', tenantAKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: chat([{ role: 'user', content: 'Reply as JSON: {"test":"ok"}' }], { response_format: { type: 'json_object' } }),
      });
      ensure(r.ok, 'JSON-mode HTTP ' + r.status);
      const output = r.payload?.choices?.[0]?.message?.content;
      ensure(typeof output === 'string' && typeof JSON.parse(output) === 'object', 'not parseable JSON');
    }, results);
    if (embeddingModel) {
      await test('embeddings', async () => {
        const r = await send('/v1/embeddings', tenantAKey, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { model: embeddingModel, input: 'Biza Miz POC' },
        });
        ensure(r.ok && Array.isArray(r.payload?.data?.[0]?.embedding), 'embedding invalid (HTTP ' + r.status + ')');
        return { dimensions: r.payload.data[0].embedding.length };
      }, results);
    }
    if (tenantBKey && tenantBExclusiveModel) {
      await test('A blocked from B-only model', async () => {
        const r = await send('/v1/chat/completions', tenantAKey, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: { ...chat([{ role: 'user', content: 'OK' }]), model: tenantBExclusiveModel },
        });
        ensure([400, 403, 404].includes(r.status), 'cross-tenant model access was not blocked (HTTP ' + r.status + ')');
        return { httpStatus: r.status };
      }, results);
    }
  }

  const afterA = await optionalUsage(tenantAKey);
  const afterB = await optionalUsage(tenantBKey);
  console.log(JSON.stringify({
    mode: runPaid ? 'controlled-provider-tests' : 'read-only-preflight',
    billingNote: 'New API quota units are diagnostic; no Biza Miz wallet charge or USD/Rial inference',
    tenantAQuotaDelta: beforeA && afterA ? afterA.usedQuotaUnits - beforeA.usedQuotaUnits : null,
    tenantBQuotaDelta: beforeB && afterB ? afterB.usedQuotaUnits - beforeB.usedQuotaUnits : null,
    results,
  }, null, 2));
  if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error('PoC halted:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
