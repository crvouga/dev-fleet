"""Contract validators and normalizers for the public OpenAI wire protocols.

Chat Completions: https://platform.openai.com/docs/api-reference/chat
Responses:        https://platform.openai.com/docs/api-reference/responses
Server-sent events: https://html.spec.whatwg.org/multipage/server-sent-events.html

Each parser converts a response into a protocol-independent ``Normalized`` view
and collects wire-level ``violations``; semantic expectations are evaluated
separately from declarative fixtures.
"""

import json

CHAT_FINISH = {"stop", "length", "tool_calls", "content_filter", "function_call"}
RESPONSES_STATUS = {"completed", "incomplete", "failed", "in_progress", "cancelled", "queued"}


class Normalized:
    def __init__(self, protocol, stream):
        self.protocol = protocol
        self.stream = stream
        self.id = None
        self.model = None
        self.content = ""
        self.tool_calls = []  # {id, name, arguments, args, index}
        self.finish_reason = None
        self.usage = None  # {input, output, total}
        self.status = None
        self.violations = []
        self.events = 0
        self.ttft = None
        self.terminated = False
        self.upstream_error = None  # error event/object reported inside a 200 stream

    def flag(self, message):
        self.violations.append(message)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _arguments(call, norm, where):
    raw = call["arguments"]
    if not isinstance(raw, str):
        norm.flag(where + ": arguments must be a JSON string")
        return
    try:
        call["args"] = json.loads(raw) if raw.strip() else {}
    except ValueError:
        norm.flag(where + ": arguments are not valid JSON")
        return
    if not isinstance(call["args"], dict):
        norm.flag(where + ": arguments must encode an object")


def _usage(raw, keys, norm):
    if raw is None:
        return None
    if not isinstance(raw, dict):
        norm.flag("usage must be an object")
        return None
    prompt, completion, total = (raw.get(k) for k in keys)
    if not (_is_int(prompt) and _is_int(completion) and _is_int(total)):
        norm.flag("usage token counts must be non-negative integers")
        return None
    if total != prompt + completion:
        norm.flag("usage total is not input plus output tokens")
    return {"input": prompt, "output": completion, "total": total}


def models_list_violations(body):
    problems = []
    if not isinstance(body, dict) or body.get("object") not in (None, "list"):
        return ["models response is not an OpenAI list object"]
    data = body.get("data")
    if not isinstance(data, list):
        return ["models response has no data array"]
    for item in data:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            problems.append("model entry without a string id")
    return problems


def error_violations(body):
    """OpenAI-compatible error envelope: {"error": {"message", "type"|"code"}}."""
    if not isinstance(body, dict) or not isinstance(body.get("error"), dict):
        return ["error response is not an OpenAI error envelope"]
    error = body["error"]
    problems = []
    if not isinstance(error.get("message"), str) or not error["message"].strip():
        problems.append("error.message missing")
    if not (isinstance(error.get("type"), str) or error.get("code") is not None):
        problems.append("error.type/code missing")
    return problems


# ------------------------------------------------------------ Chat Completions

def chat_response(body):
    norm = Normalized("chat", False)
    if not isinstance(body, dict):
        norm.flag("body is not a JSON object")
        return norm
    if body.get("object") != "chat.completion":
        norm.flag("object is not chat.completion")
    if not isinstance(body.get("id"), str) or not body["id"]:
        norm.flag("id missing")
    if not _is_int(body.get("created")):
        norm.flag("created is not an integer")
    if not isinstance(body.get("model"), str) or not body["model"]:
        norm.flag("model missing")
    norm.id, norm.model = body.get("id"), body.get("model")
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        norm.flag("choices missing")
        return norm
    choice = choices[0]
    message = choice.get("message") if isinstance(choice, dict) else None
    if not isinstance(message, dict) or message.get("role") != "assistant":
        norm.flag("choices[0].message.role is not assistant")
        return norm
    content = message.get("content")
    if content is not None and not isinstance(content, str):
        norm.flag("message.content must be a string or null")
    norm.content = content or ""
    for index, call in enumerate(message.get("tool_calls") or []):
        where = "tool_calls[%d]" % index
        function = call.get("function") if isinstance(call, dict) else None
        if not isinstance(function, dict) or call.get("type") != "function":
            norm.flag(where + ": not a function call")
            continue
        if not isinstance(call.get("id"), str) or not call["id"]:
            norm.flag(where + ": id missing")
        if not isinstance(function.get("name"), str) or not function["name"]:
            norm.flag(where + ": name missing")
        entry = {"id": call.get("id"), "name": function.get("name"),
                 "arguments": function.get("arguments"), "args": None, "index": index}
        _arguments(entry, norm, where)
        norm.tool_calls.append(entry)
    norm.finish_reason = choice.get("finish_reason")
    if norm.finish_reason not in CHAT_FINISH:
        norm.flag("finish_reason is not a valid value")
    norm.usage = _usage(body.get("usage"), ("prompt_tokens", "completion_tokens", "total_tokens"), norm)
    norm.terminated = True
    return norm


def chat_stream(result):
    norm = Normalized("chat", True)
    norm.violations.extend(result.violations)
    norm.ttft = result.ttft
    norm.terminated = result.done
    if not result.done:
        norm.flag("stream did not end with data: [DONE]")
    parts, calls, finished = [], {}, False
    for _event, chunk in result.json_frames():
        norm.events += 1
        if not isinstance(chunk, dict):
            norm.flag("chunk is not an object")
            continue
        if "error" in chunk:
            norm.upstream_error = chunk["error"]
            continue
        if chunk.get("object") != "chat.completion.chunk":
            norm.flag("chunk object is not chat.completion.chunk")
        if norm.id is None:
            norm.id = chunk.get("id")
        elif chunk.get("id") != norm.id:
            norm.flag("chunk id changed mid-stream")
        norm.model = norm.model or chunk.get("model")
        if chunk.get("usage") is not None:
            norm.usage = _usage(chunk["usage"], ("prompt_tokens", "completion_tokens", "total_tokens"), norm)
        for choice in chunk.get("choices") or []:
            delta = choice.get("delta") if isinstance(choice, dict) else None
            if not isinstance(delta, dict):
                norm.flag("choice without delta")
                continue
            if finished and (delta.get("content") or delta.get("tool_calls")):
                norm.flag("content after finish_reason")
            if delta.get("content"):
                parts.append(delta["content"])
            for fragment in delta.get("tool_calls") or []:
                index = fragment.get("index")
                if not _is_int(index):
                    norm.flag("tool call fragment without index")
                    continue
                call = calls.setdefault(index, {"id": None, "name": None, "arguments": "", "args": None, "index": index})
                function = fragment.get("function") or {}
                if fragment.get("id"):
                    call["id"] = call["id"] or fragment["id"]
                if function.get("name"):
                    call["name"] = call["name"] or function["name"]
                if isinstance(function.get("arguments"), str):
                    call["arguments"] += function["arguments"]
            if choice.get("finish_reason"):
                if finished:
                    norm.flag("more than one finish_reason")
                finished = True
                norm.finish_reason = choice["finish_reason"]
                if norm.finish_reason not in CHAT_FINISH:
                    norm.flag("finish_reason is not a valid value")
    if not finished and norm.upstream_error is None:
        norm.flag("stream carried no finish_reason")
    norm.content = "".join(parts)
    for index in sorted(calls):
        call = calls[index]
        if not call["id"] or not call["name"]:
            norm.flag("tool call %d lacks id or name" % index)
        _arguments(call, norm, "tool_calls[%d]" % index)
        norm.tool_calls.append(call)
    return norm


# ------------------------------------------------------------------- Responses

def _responses_final(response, norm):
    """Fold a final Response object into the normalized view."""
    if not isinstance(response, dict):
        norm.flag("response is not an object")
        return
    if response.get("object") not in (None, "response"):
        norm.flag("object is not response")
    if not isinstance(response.get("id"), str) or not response["id"]:
        norm.flag("response id missing")
    norm.id, norm.model = response.get("id"), response.get("model")
    if not isinstance(norm.model, str) or not norm.model:
        norm.flag("model missing")
    norm.status = response.get("status")
    if norm.status not in RESPONSES_STATUS:
        norm.flag("status is not a valid value")
    output = response.get("output")
    if not isinstance(output, list):
        norm.flag("output is not an array")
        return
    texts, calls = [], []
    for item in output:
        kind = item.get("type") if isinstance(item, dict) else None
        if kind == "message":
            if item.get("role") != "assistant" or not isinstance(item.get("content"), list):
                norm.flag("message item malformed")
                continue
            for part in item["content"]:
                if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                    texts.append(part["text"])
                elif part.get("type") == "refusal":
                    texts.append(str(part.get("refusal", "")))
        elif kind == "function_call":
            if not isinstance(item.get("call_id"), str) or not item["call_id"]:
                norm.flag("function_call without call_id")
            entry = {"id": item.get("call_id"), "name": item.get("name"),
                     "arguments": item.get("arguments"), "args": None, "index": len(calls)}
            if not isinstance(entry["name"], str) or not entry["name"]:
                norm.flag("function_call without name")
            _arguments(entry, norm, "function_call[%d]" % len(calls))
            calls.append(entry)
    norm.content = "".join(texts)
    norm.tool_calls = calls
    details = response.get("incomplete_details") or {}
    if norm.status == "completed":
        norm.finish_reason = "tool_calls" if calls else "stop"
    elif norm.status == "incomplete":
        norm.finish_reason = "length" if details.get("reason") == "max_output_tokens" else "content_filter"
    else:
        norm.finish_reason = norm.status
    norm.usage = _usage(response.get("usage"), ("input_tokens", "output_tokens", "total_tokens"), norm)
    if response.get("error"):
        norm.upstream_error = response["error"]


def responses_response(body):
    norm = Normalized("responses", False)
    _responses_final(body, norm)
    norm.terminated = True
    return norm


_TERMINAL = ("response.completed", "response.incomplete", "response.failed")


def responses_stream(result):
    norm = Normalized("responses", True)
    norm.violations.extend(result.violations)
    norm.ttft = result.ttft
    last_sequence = -1
    deltas, arguments, final, order = [], {}, None, []
    for event, data in result.json_frames():
        norm.events += 1
        if not isinstance(data, dict) or not isinstance(data.get("type"), str):
            norm.flag("event data lacks a type")
            continue
        kind = data["type"]
        if event is not None and event != kind:
            norm.flag("SSE event name differs from data.type")
        order.append(kind)
        if "sequence_number" in data:
            if not _is_int(data["sequence_number"]) or data["sequence_number"] <= last_sequence:
                norm.flag("sequence_number is not strictly increasing")
            else:
                last_sequence = data["sequence_number"]
        if kind == "response.output_text.delta":
            if not isinstance(data.get("delta"), str):
                norm.flag("output_text.delta without delta string")
            deltas.append(data.get("delta") or "")
        elif kind == "response.function_call_arguments.delta":
            arguments.setdefault(data.get("output_index"), []).append(data.get("delta") or "")
        elif kind == "error":
            norm.upstream_error = data.get("error") or data
        elif kind in _TERMINAL:
            if final is not None:
                norm.flag("more than one terminal event")
            final = data.get("response")
    if not order or order[0] != "response.created":
        norm.flag("first event is not response.created")
    if final is None:
        if norm.upstream_error is None:
            norm.flag("stream ended without a terminal response event")
        norm.content = "".join(deltas)
        return norm
    norm.terminated = True
    _responses_final(final, norm)
    streamed = "".join(deltas)
    if deltas and norm.content != streamed:
        norm.flag("streamed text differs from the final response")
    # output_index counts every output item, so match calls by ascending index.
    streamed_calls = ["".join(arguments[k]) for k in sorted(arguments, key=lambda k: (k is None, k))]
    for call, pieces in zip(norm.tool_calls, streamed_calls):
        if pieces != call["arguments"]:
            norm.flag("streamed tool arguments differ from the final response")
    return norm
