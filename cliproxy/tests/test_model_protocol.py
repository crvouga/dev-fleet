"""Contract tests: valid fixtures pass, and each wire-level defect is detected."""

import copy
import json
import random
import socketserver
import threading
import unittest

import modelhealth_support as support
from modelhealth import protocol, redact, scenario, transport

CHAT = {
    "id": "chatcmpl-1", "object": "chat.completion", "created": 1, "model": "m",
    "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
        "role": "assistant", "content": None,
        "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\": \"Paris\"}"}}]}}],
    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
}
RESPONSE = {
    "id": "resp_1", "object": "response", "status": "completed", "model": "m",
    "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "OK"}]},
               {"type": "function_call", "call_id": "call_1", "name": "get_weather", "arguments": "{}"}],
    "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
}


def mutate(base, path, value):
    data = copy.deepcopy(base)
    target = data
    for part in path[:-1]:
        target = target[part]
    if value is KeyError:
        del target[path[-1]]
    else:
        target[path[-1]] = value
    return data


class ChatContract(unittest.TestCase):
    def test_valid_response(self):
        norm = protocol.chat_response(CHAT)
        self.assertEqual(norm.violations, [])
        self.assertEqual(norm.tool_calls[0]["args"], {"city": "Paris"})
        self.assertEqual(norm.usage["total"], 5)

    def test_each_defect_is_reported(self):
        defects = {
            "id": (["id"], KeyError),
            "object": (["object"], "text_completion"),
            "created": (["created"], "1"),
            "finish": (["choices", 0, "finish_reason"], "done"),
            "role": (["choices", 0, "message", "role"], "user"),
            "call id": (["choices", 0, "message", "tool_calls", 0, "id"], ""),
            "call type": (["choices", 0, "message", "tool_calls", 0, "type"], "tool"),
            "arguments json": (["choices", 0, "message", "tool_calls", 0, "function", "arguments"], "{broken"),
            "arguments type": (["choices", 0, "message", "tool_calls", 0, "function", "arguments"], "[1]"),
            "usage total": (["usage", "total_tokens"], 99),
            "usage int": (["usage", "prompt_tokens"], "3"),
        }
        for name, (path, value) in defects.items():
            with self.subTest(name):
                self.assertTrue(protocol.chat_response(mutate(CHAT, path, value)).violations)

    def test_error_envelope(self):
        good = {"error": {"message": "bad", "type": "invalid_request_error"}}
        self.assertEqual(protocol.error_violations(good), [])
        for bad in ({"error": "text"}, {"error": {"type": "x"}}, {"error": {"message": "m"}}, [], {}):
            self.assertTrue(protocol.error_violations(bad))


class ResponsesContract(unittest.TestCase):
    def test_valid_response(self):
        norm = protocol.responses_response(RESPONSE)
        self.assertEqual(norm.violations, [])
        self.assertEqual((norm.content, norm.finish_reason, norm.tool_calls[0]["id"]), ("OK", "tool_calls", "call_1"))

    def test_each_defect_is_reported(self):
        defects = {
            "object": (["object"], "chat.completion"),
            "status": (["status"], "weird"),
            "call id": (["output", 1, "call_id"], KeyError),
            "usage": (["usage", "total_tokens"], 1),
            "output": (["output"], "none"),
        }
        for name, (path, value) in defects.items():
            with self.subTest(name):
                self.assertTrue(protocol.responses_response(mutate(RESPONSE, path, value)).violations)


class FakeStream:
    """Drive the stream normalizers from literal frames."""

    def __init__(self, frames, done=True):
        self.frames = [transport.Frame(event, data if isinstance(data, str) else json.dumps(data), 0.0) for event, data in frames]
        self.violations, self.ttft, self.done = [], 0.0, done

    def json_frames(self):
        return [(f.event, json.loads(f.data)) for f in self.frames if f.data != "[DONE]"]


def chunk(delta, finish=None, id_="c1"):
    return (None, {"id": id_, "object": "chat.completion.chunk", "model": "m",
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})


class StreamContracts(unittest.TestCase):
    def test_fragmented_tool_arguments_are_assembled_for_any_split(self):
        rng = random.Random(11)
        for _ in range(100):
            arguments = json.dumps({"city": rng.choice(["Paris", "Zürich", "São Paulo"]), "n": rng.randint(0, 99)})
            cuts = sorted(rng.sample(range(1, len(arguments)), min(4, len(arguments) - 1)))
            pieces = [arguments[a:b] for a, b in zip([0] + cuts, cuts + [len(arguments)])]
            frames = [chunk({"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "f", "arguments": ""}}]})]
            frames += [chunk({"tool_calls": [{"index": 0, "function": {"arguments": p}}]}) for p in pieces]
            frames.append(chunk({}, "tool_calls"))
            norm = protocol.chat_stream(FakeStream(frames))
            self.assertEqual(norm.violations, [])
            self.assertEqual(norm.tool_calls[0]["args"], json.loads(arguments))

    def test_chat_stream_defects(self):
        ok = [chunk({"role": "assistant", "content": ""}), chunk({"content": "hi"}), chunk({}, "stop")]
        self.assertEqual(protocol.chat_stream(FakeStream(ok)).violations, [])
        cases = {
            "no done": FakeStream(ok, done=False),
            "no finish": FakeStream(ok[:2]),
            "id changes": FakeStream([ok[0], chunk({"content": "x"}, id_="other"), ok[2]]),
            "content after finish": FakeStream([ok[0], ok[2], chunk({"content": "late"})]),
            "two finishes": FakeStream(ok + [chunk({}, "stop")]),
            "bad finish": FakeStream([ok[0], chunk({}, "nonsense")]),
            "bad args": FakeStream([chunk({"tool_calls": [{"index": 0, "id": "c", "function": {"name": "f", "arguments": "{x"}}]}), ok[2]]),
            "tool without id": FakeStream([chunk({"tool_calls": [{"index": 0, "function": {"name": "f", "arguments": "{}"}}]}), ok[2]]),
        }
        for name, stream in cases.items():
            with self.subTest(name):
                self.assertTrue(protocol.chat_stream(stream).violations)

    def test_responses_stream_requires_ordered_events_and_terminal_response(self):
        def event(kind, **data):
            return (kind, dict(data, type=kind))

        final = dict(RESPONSE, output=[{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "OK"}]}])
        good = [event("response.created", response={}, sequence_number=0),
                event("response.output_text.delta", delta="OK", sequence_number=1),
                event("response.completed", response=final, sequence_number=2)]
        self.assertEqual(protocol.responses_stream(FakeStream(good)).violations, [])
        broken = {
            "no created": good[1:],
            "no terminal": good[:2],
            "sequence": [good[0], event("response.output_text.delta", delta="OK", sequence_number=0), good[2]],
            "name mismatch": [("response.other", good[0][1])] + good[1:],
            "text mismatch": [good[0], event("response.output_text.delta", delta="NO", sequence_number=1), good[2]],
        }
        for name, frames in broken.items():
            with self.subTest(name):
                self.assertTrue(protocol.responses_stream(FakeStream(frames)).violations)


class RawServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def serve(payload, status="200 OK", content_type="text/event-stream"):
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            length = 0
            while True:
                line = self.rfile.readline().strip()
                if not line:
                    break
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":")[1])
            self.rfile.read(length)  # drain the body so the close is not a reset
            self.wfile.write(("HTTP/1.0 %s\r\nContent-Type: %s\r\n\r\n" % (status, content_type)).encode() + payload)

    server = RawServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, args=(0.02,), daemon=True).start()
    return server, "http://127.0.0.1:%d/v1" % server.server_address[1]


class SseFraming(unittest.TestCase):
    def stream(self, payload, **kwargs):
        server, base = serve(payload, **kwargs)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return transport.Client(base, "k", timeout=2).stream("/x", {"a": 1}, timeout=2, deadline=5)

    def test_crlf_comments_multiline_data_and_done(self):
        result = self.stream(b": keepalive\r\nevent: a\r\ndata: {\"x\":\r\ndata: 1}\r\n\r\ndata: [DONE]\r\n\r\n")
        self.assertEqual(result.violations, [])
        self.assertEqual(result.json_frames(), [("a", {"x": 1})])
        self.assertTrue(result.done and result.clean_eof)

    def test_malformed_framing_is_flagged(self):
        for name, (payload, expected) in {
            "bare line": (b"data: {}\n\ngarbage\n\ndata: [DONE]\n\n", "invalid SSE line"),
            "unterminated": (b"data: {}\n\ndata: {\"half\"", "unterminated"),
            "after done": (b"data: [DONE]\n\ndata: {}\n\n", "after [DONE]"),
        }.items():
            with self.subTest(name):
                self.assertTrue(any(expected in v for v in self.stream(payload).violations))

    def test_wrong_content_type_and_error_status(self):
        self.assertTrue(any("content-type" in v for v in self.stream(b"data: [DONE]\n\n", content_type="application/json").violations))
        result = self.stream(b"{}", status="429 Too Many Requests", content_type="application/json")
        self.assertEqual(result.status, 429)
        self.assertEqual(result.frames, [])

    def test_redirects_are_not_followed(self):
        server, base = serve(b"", status="302 Found", content_type="text/plain")
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.assertEqual(transport.Client(base, "k", timeout=2).request("GET", "/models").status, 302)

    def test_plain_http_is_refused_except_loopback(self):
        with self.assertRaises(ValueError):
            transport.Client("http://example.com/v1")
        transport.Client("http://127.0.0.1:1/v1")


class Redaction(unittest.TestCase):
    def test_secrets_and_token_shapes_are_removed(self):
        scrub = redact.Redactor(["super-secret-value"])
        text = scrub("failed with super-secret-value and Authorization: Bearer abc.def.ghi and sk-abcdefghijklmnop12345 " + "x" * 400)
        for leaked in ("super-secret-value", "abc.def.ghi", "sk-abcdefghijklmnop12345"):
            self.assertNotIn(leaked, text)
        self.assertLessEqual(len(text), 300)


class RequestBuilding(unittest.TestCase):
    def test_same_turn_maps_to_each_protocol(self):
        raw = support.RAW
        turn = {"system": "S", "messages": [{"role": "user", "content": "u"}], "tools": ["get_weather"],
                "tool_choice": {"name": "get_weather"}, "max_tokens": 9, "stream": True, "include_usage": True}
        chat = scenario.build("chat", "model_id", turn, raw, {"reasoning_effort": "low"})
        self.assertEqual(chat["messages"][0], {"role": "system", "content": "S"})
        self.assertEqual(chat["tool_choice"], {"type": "function", "function": {"name": "get_weather"}})
        self.assertEqual((chat["max_tokens"], chat["stream_options"], chat["reasoning_effort"]), (9, {"include_usage": True}, "low"))
        responses = scenario.build("responses", "model_id", turn, raw, {})
        self.assertEqual(responses["instructions"], "S")
        self.assertEqual(responses["tool_choice"], {"type": "function", "name": "get_weather"})
        self.assertEqual((responses["max_output_tokens"], responses["store"], responses["tools"][0]["name"]), (9, False, "get_weather"))

    def test_tool_results_become_protocol_items(self):
        turn = {"messages": [
            {"role": "assistant", "tool_calls": [{"id": "c1", "name": "f", "arguments": "{}"}]},
            {"role": "tool", "tool_call_id": "c1", "content": "R"}]}
        chat = scenario.build("chat", "a", turn, support.RAW, {})["messages"]
        self.assertEqual(chat[0]["tool_calls"][0]["id"], "c1")
        self.assertEqual(chat[1], {"role": "tool", "tool_call_id": "c1", "content": "R"})
        items = scenario.build("responses", "a", turn, support.RAW, {})["input"]
        self.assertEqual([i["type"] for i in items], ["function_call", "function_call_output"])
        self.assertEqual(items[1]["call_id"], "c1")


if __name__ == "__main__":
    unittest.main()
