import { expect, test } from 'bun:test';
import { verifyRoundTrip } from './round-trip';

function fixture(mode: 'valid' | 'wrong-tool' | 'truncated-stream') {
  const bodies: unknown[] = [];
  const request = async (_url: unknown, options: RequestInit = {}) => {
    const body = JSON.parse(String(options.body));
    bodies.push(body);
    expect(options.redirect).toBe('error');
    if (body.stream)
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"OK"}\n\n' +
          (mode === 'truncated-stream'
            ? ''
            : 'data: {"type":"response.completed"}\n\n')
      );
    const nonce = body.tools[0].parameters.properties.nonce.enum[0];
    if (body.tool_choice !== 'none')
      return Response.json({
        output: [
          {
            type: 'function_call',
            name: mode === 'wrong-tool' ? 'shell' : 'fleet_echo',
            call_id: 'call-1',
            arguments: JSON.stringify({ nonce }),
          },
        ],
      });
    expect(body.input[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: nonce,
    });
    return Response.json({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: nonce }] },
      ],
    });
  };
  return { bodies, request: request as typeof fetch };
}
test('bounded Responses probe checks stream completion and returns only a validated echo result', async () => {
  const { request, bodies } = fixture('valid');
  await verifyRoundTrip('fixture-model', 'private-test-key', request);
  expect(bodies).toHaveLength(3);
  expect(JSON.stringify(bodies)).not.toContain('private-test-key');
});
test('unexpected tool name is never executed or returned to the model', async () => {
  const { request, bodies } = fixture('wrong-tool');
  await expect(
    verifyRoundTrip('fixture-model', 'private-test-key', request)
  ).rejects.toThrow('PROVIDER_TOOL_INVALID');
  expect(bodies).toHaveLength(2);
});
test('HTTP 200 and partial streaming are insufficient; no tool probe follows', async () => {
  const { request, bodies } = fixture('truncated-stream');
  await expect(
    verifyRoundTrip('fixture-model', 'private-test-key', request)
  ).rejects.toThrow('PROVIDER_STREAM_INCOMPLETE');
  expect(bodies).toHaveLength(1);
});
