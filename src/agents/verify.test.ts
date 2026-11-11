import { expect, test } from 'bun:test';
import { inferenceRequest } from './verify';
import { select } from './registry';

test('native Gemini uses generateContent rather than an OpenAI inference request', () => {
  const request = inferenceRequest(select('devbox', 'gemini', 'proxy'));
  expect(request.path).toBe('/v1beta/models/gemini-3-flash:generateContent');
  expect(request.body).toEqual({
    contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }],
    generationConfig: { maxOutputTokens: 1024 },
  });
});
test('Claude and Codex retain their distinct gateway protocols', () => {
  expect(inferenceRequest(select('devbox', 'claude', 'proxy')).path).toBe(
    '/v1/messages'
  );
  expect(inferenceRequest(select('devbox', 'codex', 'proxy')).path).toBe(
    '/v1/responses'
  );
});
