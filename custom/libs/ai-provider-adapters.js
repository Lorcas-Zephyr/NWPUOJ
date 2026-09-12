'use strict';

const https = require('https');
const http = require('http');

const PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    name: 'DeepSeek',
    model: 'deepseek-v4-pro',
    endpoint: 'https://api.deepseek.com/v1',
    keyEnv: 'SYZOJ_AI_DEEPSEEK_API_KEY'
  }),
  gpt: Object.freeze({
    name: 'GPT',
    model: 'gpt-5.6-sol',
    endpoint: 'https://apiaifirst.com/v1',
    keyEnv: 'SYZOJ_AI_GPT_API_KEY'
  })
});

function providerConfig(provider) {
  const key = String(provider || '').trim().toLowerCase();
  const configured = PROVIDERS[key];
  if (!configured) throw new Error('Unsupported AI provider.');
  return {
    ...configured,
    endpoint: String(process.env[`${configured.keyEnv}_ENDPOINT`] || process.env[`SYZOJ_AI_${key.toUpperCase()}_ENDPOINT`] || configured.endpoint).replace(/\/+$/, ''),
    model: String(process.env[`${configured.keyEnv}_MODEL`] || process.env[`SYZOJ_AI_${key.toUpperCase()}_MODEL`] || configured.model),
    apiKey: String(process.env[configured.keyEnv] || '').trim()
  };
}

function providerError(code, message, statusCode) {
  const safeMessage = String(message || 'AI provider request failed.').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]');
  const error = new Error(safeMessage.slice(0, 500));
  error.code = code;
  if (statusCode) error.statusCode = statusCode;
  return error;
}

function requestJson(url, body, headers, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'http:' ? http : https;
    const request = client.request(target, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (_) {}
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = payload && payload.error && payload.error.message || `AI provider returned HTTP ${response.statusCode}.`;
          reject(providerError(response.statusCode === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_ERROR', message, response.statusCode));
          return;
        }
        if (!payload || typeof payload !== 'object') {
          reject(providerError('AI_RESPONSE_INVALID', 'AI provider returned an invalid JSON response.', 502));
          return;
        }
        resolve(payload);
      });
    });
    request.on('timeout', () => request.destroy(providerError('AI_TIMEOUT', 'AI provider request timed out.', 504)));
    request.on('error', error => {
      if (error && ['AI_TIMEOUT', 'AI_RATE_LIMITED', 'AI_PROVIDER_ERROR', 'AI_RESPONSE_INVALID'].includes(error.code)) return reject(error);
      reject(providerError('AI_PROVIDER_ERROR', 'AI provider network request failed.', 502));
    });
    request.write(body);
    request.end();
  });
}

function extractText(payload) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => typeof item === 'string' ? item : item && item.text || '').join('');
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (Array.isArray(payload.output)) {
    return payload.output.flatMap(item => Array.isArray(item && item.content) ? item.content : [])
      .map(item => item && (item.text || item.value) || '').join('');
  }
  return '';
}

function completionUsage(payload) {
  const usage = payload.usage || {};
  return {
    prompt_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    completion_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    total_tokens: Number(usage.total_tokens || Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0))
  };
}

function completionText(payload) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const finishReason = String(choice && choice.finish_reason || '');
  if (finishReason === 'length') throw providerError('AI_RESPONSE_TRUNCATED', 'AI provider response was truncated.', 502);
  if (['content_filter', 'insufficient_system_resource'].includes(finishReason)) {
    throw providerError('AI_PROVIDER_ERROR', `AI provider stopped generation: ${finishReason}.`, 502);
  }
  const value = extractText(payload);
  if (!String(value).trim()) throw providerError('AI_RESPONSE_EMPTY', 'AI provider returned empty content.', 502);
  return {
    value,
    model: String(payload.model || ''),
    finish_reason: finishReason || null,
    usage: completionUsage(payload)
  };
}

function parseJsonText(text) {
  const source = String(text || '').trim();
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : source;
  try { return JSON.parse(candidate); } catch (_) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch (_) {}
    }
  }
  throw providerError('AI_RESPONSE_INVALID', 'AI response did not contain valid JSON.', 502);
}

async function requestCompletion(provider, messages, options = {}) {
  const config = providerConfig(provider);
  if (!config.apiKey) {
    throw providerError('AI_CREDENTIAL_MISSING', `${config.name} API key is not configured.`, 503);
  }
  const requestBody = {
    model: config.model,
    messages,
    temperature: options.temperature == null ? 0.2 : Number(options.temperature),
    max_tokens: Math.min(provider === 'deepseek' ? 128000 : 16000, Math.max(256, Number(options.maxTokens || 8000)))
  };
  if (options.json) requestBody.response_format = { type: 'json_object' };
  if (provider === 'deepseek' && typeof options.thinking === 'boolean') {
    requestBody.thinking = { type: options.thinking ? 'enabled' : 'disabled' };
  }
  if (provider === 'deepseek' && options.reasoningEffort) requestBody.reasoning_effort = String(options.reasoningEffort);
  const body = JSON.stringify(requestBody);
  const payload = await requestJson(`${config.endpoint}/chat/completions`, body, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    'User-Agent': 'NWPUOJ-AI-Contest/1.0'
  }, Number(options.timeoutMs || process.env.SYZOJ_AI_REQUEST_TIMEOUT_MS || 180000));
  const completion = completionText(payload);
  completion.model = completion.model || config.model;
  return completion;
}

async function completeJson(provider, messages, options = {}) {
  const completion = await requestCompletion(provider, messages, { ...options, json: true });
  return { ...completion, value: parseJsonText(completion.value) };
}

async function completeText(provider, messages, options = {}) {
  return requestCompletion(provider, messages, { ...options, json: false });
}

function publicProviderConfig(provider) {
  const config = providerConfig(provider);
  return { provider: String(provider).toLowerCase(), name: config.name, model: config.model, endpoint: config.endpoint };
}

module.exports = { PROVIDERS, completeJson, completeText, providerConfig, publicProviderConfig };
