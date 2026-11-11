"""Protocol-faithful local emulator of the proxy's OpenAI surface.

It is deterministic and credential-free. It implements Chat Completions and
Responses (streaming and not), tool calls, structured output, OpenAI error
envelopes, and the proxy's multi-account routing policy (fill-first or round
robin, session affinity, cooldown after quota or transient failures, bounded
credential retries), with a
virtual clock and injectable faults. It is a test double for the harness and
its contracts; it makes no claim about real provider or Cursor behavior.
"""

import hashlib
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = re.compile(r"[A-Z]{3}-[0-9]{4}")


def _words(text):
    return len(str(text).split())


class Account:
    def __init__(self, ident, models=None, quota=None):
        self.id = ident
        self.models = set(models) if models is not None else None
        self.quota = quota  # remaining requests; None is unlimited, 0 is exhausted
        self.fail_next = 0  # transient upstream failures still to emit
        self.cooldown_until = 0.0
        self.served = 0

    def serves(self, model_id):
        return self.models is None or model_id in self.models


class Emulator:
    def __init__(self, model_ids, keys=("emulator-client-key-0000000000000000",), accounts=None,
                 cooldown_s=30.0, transient_cooldown_s=60.0, max_retry_credentials=0, chunk_delay_s=0.0,
                 strategy="fill-first"):
        self.model_ids = list(model_ids)
        self.keys = set(keys)
        self.open_api = False  # fault: accepts anonymous callers
        self.accounts = accounts or [Account("acct-a"), Account("acct-b")]
        self.cooldown_s = cooldown_s
        self.transient_cooldown_s = transient_cooldown_s  # upstream's documented 60s transient-error cooldown
        self.strategy = strategy
        self.max_retry_credentials = max_retry_credentials
        self.chunk_delay_s = chunk_delay_s
        self.faults = {}
        self.offset = 0.0
        self.lock = threading.Lock()
        self.pointer = {}
        self.affinity = {}
        self.routing_log = []
        self.requests = 0
        self.server = None

    # ---------------------------------------------------------------- control
    def now(self):
        return time.monotonic() + self.offset

    def advance(self, seconds):
        with self.lock:
            self.offset += seconds

    def fault(self, **faults):
        with self.lock:
            self.faults.update(faults)

    def clear_faults(self):
        with self.lock:
            self.faults = {}

    def account(self, ident):
        return next(a for a in self.accounts if a.id == ident)

    def start(self):
        emulator = self

        class Handler(_Handler):
            owner = emulator

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, args=(0.02,), daemon=True).start()
        return "http://127.0.0.1:%d/v1" % self.server.server_address[1]

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()

    @property
    def key(self):
        return sorted(self.keys)[0]

    # ---------------------------------------------------------------- routing
    def route(self, model_id, affinity):
        """Return (account, error) following the documented routing policy.

        fill-first: accounts are tried in declaration order, so one account takes all traffic until
        it is exhausted (quota) or failing (transient), then the next. round-robin rotates instead.
        A session bound to an available account stays on it (an established binding outranks order);
        when that account is unavailable the session is rebound to the failover account.
        max_retry_credentials of 0 means every eligible credential may be tried.
        """
        with self.lock:
            now = self.now()
            candidates = [a for a in self.accounts if a.serves(model_id)]
            tried = []
            if not candidates:
                self.routing_log.append({"model": model_id, "tried": [], "served_by": None})
                return None, (404, "model_not_found", "No account serves this model.", None)
            if self.strategy == "round-robin":
                start = self.pointer.get(model_id, 0)
                order = [candidates[(start + i) % len(candidates)] for i in range(len(candidates))]
            else:
                order = list(candidates)
            sticky = self.affinity.get((model_id, affinity))
            if sticky is not None:
                order = [a for a in order if a.id == sticky] + [a for a in order if a.id != sticky]
            last, attempts = None, 0
            for account in order:
                if account.cooldown_until > now:
                    tried.append((account.id, "cooldown"))
                    continue
                if self.max_retry_credentials and attempts >= self.max_retry_credentials:
                    break
                attempts += 1
                if account.quota is not None and account.quota <= 0:
                    account.cooldown_until = now + self.cooldown_s
                    tried.append((account.id, "quota"))
                    last = (429, "rate_limit_exceeded", "Account quota exhausted.", self.cooldown_s)
                    continue
                if account.fail_next > 0:
                    account.fail_next -= 1
                    account.cooldown_until = now + self.transient_cooldown_s
                    tried.append((account.id, "upstream_error"))
                    last = (503, "upstream_unavailable", "Upstream provider is temporarily unavailable.", None)
                    continue
                if account.quota is not None:
                    account.quota -= 1
                account.served += 1
                self.pointer[model_id] = (candidates.index(account) + 1) % len(candidates)
                self.affinity[(model_id, affinity)] = account.id
                tried.append((account.id, "served"))
                self.routing_log.append({"model": model_id, "tried": tried, "served_by": account.id})
                return account, None
            if last is None:
                waits = [a.cooldown_until - now for a in candidates if a.cooldown_until > now]
                last = (429, "rate_limit_exceeded", "All credentials are cooling down.", max(waits or [1.0]))
            self.routing_log.append({"model": model_id, "tried": tried, "served_by": None})
            return None, last


# --------------------------------------------------------------------- brain

def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(p.get("text", "")) for p in content if isinstance(p, dict))
    return ""


def _conversation(protocol, body):
    """Flatten either protocol into [(role, text)], tool results and tool defs."""
    turns, results, system = [], [], []
    if protocol == "chat":
        for message in body.get("messages") or []:
            role, text = message.get("role"), _text_of(message.get("content"))
            if role in ("system", "developer"):
                system.append(text)
            elif role == "tool":
                results.append(text)
                turns.append(("tool", text))
            else:
                turns.append((role, text))
        tools = [t["function"] for t in body.get("tools") or []]
    else:
        if body.get("instructions"):
            system.append(body["instructions"])
        items = body.get("input")
        items = [{"role": "user", "content": items}] if isinstance(items, str) else (items or [])
        for item in items:
            if item.get("type") == "function_call_output":
                results.append(str(item.get("output")))
                turns.append(("tool", str(item.get("output"))))
            elif item.get("type") == "function_call":
                continue
            elif item.get("role") in ("system", "developer"):
                system.append(_text_of(item.get("content")))
            else:
                turns.append((item.get("role"), _text_of(item.get("content"))))
        tools = [t for t in body.get("tools") or []]
    return turns, results, system, tools


def _forced(protocol, body):
    choice = body.get("tool_choice")
    if isinstance(choice, dict):
        return (choice.get("function") or choice).get("name")
    return choice if choice in ("required", "none", "auto") else None


def _argument(name, spec, text, markers, tool_name, last_result):
    if "enum" in spec:
        for value in spec["enum"]:
            if str(value).lower() in text.lower():
                return value
        return spec["enum"][0]
    if spec.get("type") == "string":
        if spec.get("pattern") and TOKEN.search(text):
            return TOKEN.search(text).group(0)
        if name == "path":
            files = re.findall(r"[\w./-]+\.py", text)
            tests = [f for f in files if f.startswith("test_")]
            sources = [f for f in files if not f.startswith("test_")]
            chosen = (tests if tool_name == "run_tests" else sources) or files
            return chosen[0] if chosen else "main.py"
        if name == "content":
            return (last_result or "").replace(" - ", " + ") or "pass"
        return markers[0] if markers else "value"
    if spec.get("type") in ("integer", "number"):
        return 1
    if spec.get("type") == "boolean":
        return True
    return None


def _arguments(tool, text, markers, index, last_result):
    schema = tool.get("parameters") or {}
    out = {}
    for name, spec in (schema.get("properties") or {}).items():
        if name in schema.get("required", []) or True:
            local = markers[index:index + 1] or markers[:1]
            out[name] = _argument(name, spec, text, local, tool["name"], last_result)
    return out


def _json_value(spec, text="", name=""):
    if "const" in spec:
        return spec["const"]
    kind = spec.get("type")
    if kind == "object":
        return {k: _json_value(v, text, k) for k, v in spec.get("properties", {}).items()}
    if kind == "array":
        return [_json_value(spec.get("items", {}), text, name)]
    if kind in ("integer", "number"):
        return 2.8 if kind == "number" else 1
    if kind == "boolean":
        return True
    if kind == "string":
        stated = re.search(r"\b%s set to ([A-Za-z0-9_.-]+)" % re.escape(name), text) if name else None
        return stated.group(1) if stated else spec.get("enum", ["x"])[0]
    return None


def plan(protocol, body):
    """Decide the model's reply: {'text', 'calls', 'finish'}; deterministic."""
    turns, results, system, tools = _conversation(protocol, body)
    user_text = " ".join(t for r, t in turns if r == "user")
    last_user = next((t for r, t in reversed(turns) if r == "user"), "")
    forced = _forced(protocol, body)
    limit = body.get("max_tokens") or body.get("max_output_tokens") or 1000
    by_name = {t["name"]: t for t in tools}
    if tools and forced not in (None, "none", "auto") and not (forced == "required" and not tools):
        names = [forced] if forced in by_name else [tools[0]["name"]]
        markers = re.findall(r"\[\[(.+?)\]\]", last_user)
        count = max(1, len(markers)) if forced == "required" else 1
        calls = [{"name": names[0], "arguments": _arguments(by_name[names[0]], last_user, markers, i, results[-1] if results else None)}
                 for i in range(count)]
        return {"text": "", "calls": calls, "finish": "tool_calls"}
    schema = None
    if protocol == "chat" and (body.get("response_format") or {}).get("type") == "json_schema":
        schema = body["response_format"]["json_schema"]["schema"]
    if protocol == "responses" and ((body.get("text") or {}).get("format") or {}).get("type") == "json_schema":
        schema = body["text"]["format"]["schema"]
    if schema is not None:
        text = json.dumps(_json_value(schema, last_user))
    elif results and turns and turns[-1][0] == "tool":
        text = "Done. " + " ".join(results)
    elif "code word" in last_user.lower() and TOKEN.search(user_text):
        text = TOKEN.search(user_text).group(0)
    elif any(re.search(r"exact marker", s) for s in system):
        text = "Hello. " + TOKEN.search(" ".join(system)).group(0)
    elif re.search(r"[Cc]ount from 1 to (\d+)", last_user):
        text = "\n".join(str(i) for i in range(1, int(re.search(r"to (\d+)", last_user).group(1)) + 1))
    elif re.search(r"numbers from 1 to (\d+)", last_user):
        text = " ".join(str(i) for i in range(1, int(re.search(r"to (\d+)", last_user).group(1)) + 1))
    else:
        text = "OK"
    words = text.split(" ") if "\n" not in text else text.split("\n")
    finish = "stop"
    if len(words) > limit:
        text, finish = (" " if "\n" not in text else "\n").join(words[:limit]), "length"
    return {"text": text, "calls": [], "finish": finish}


def _usage_counts(body, reply):
    prompt = _words(json.dumps(body.get("messages") or body.get("input") or ""))
    completion = _words(reply["text"]) + sum(_words(json.dumps(c["arguments"])) for c in reply["calls"])
    return prompt, max(1, completion)


def _call_id(seed, index, prefix):
    return prefix + hashlib.sha1(("%s-%d" % (seed, index)).encode()).hexdigest()[:12]


# ------------------------------------------------------------------ renderers

def chat_body(model_id, body, reply, request_id, faults):
    prompt, completion = _usage_counts(body, reply)
    message = {"role": "assistant", "content": reply["text"] or None}
    if reply["calls"]:
        message["tool_calls"] = [
            {"id": None if faults.get("drop_tool_ids") else _call_id(request_id, i, "call_"), "type": "function",
             "function": {"name": c["name"], "arguments": "{broken" if faults.get("bad_json_args") else json.dumps(c["arguments"])}}
            for i, c in enumerate(reply["calls"])]
    out = {"id": "chatcmpl-" + request_id, "object": "chat.completion", "created": 1_700_000_000, "model": model_id,
           "choices": [{"index": 0, "message": message, "finish_reason": faults.get("finish_reason", reply["finish"])}]}
    if not faults.get("drop_usage"):
        out["usage"] = {"prompt_tokens": prompt, "completion_tokens": completion,
                        "total_tokens": prompt + completion + (1 if faults.get("bad_usage") else 0)}
    return out


def chat_events(model_id, body, reply, request_id, faults):
    base = {"id": "chatcmpl-" + request_id, "object": "chat.completion.chunk", "created": 1_700_000_000, "model": model_id}

    def chunk(delta, finish=None, usage=None, choices=True):
        data = dict(base)
        data["choices"] = [{"index": 0, "delta": delta, "finish_reason": finish}] if choices else []
        if usage:
            data["usage"] = usage
        return (None, json.dumps(data))

    yield chunk({"role": "assistant", "content": ""})
    pieces = reply["text"].split(" ") if "\n" not in reply["text"] else reply["text"].split("\n")
    glue = " " if "\n" not in reply["text"] else "\n"
    for i, piece in enumerate(pieces if reply["text"] else []):
        yield chunk({"content": piece + (glue if i < len(pieces) - 1 else "")})
    for index, call in enumerate(reply["calls"]):
        arguments = json.dumps(call["arguments"])
        yield chunk({"tool_calls": [{"index": index, "id": _call_id(request_id, index, "call_"), "type": "function",
                                     "function": {"name": call["name"], "arguments": ""}}]})
        for start in range(0, len(arguments), 7):
            yield chunk({"tool_calls": [{"index": index, "function": {"arguments": arguments[start:start + 7]}}]})
    yield chunk({}, finish=faults.get("finish_reason", reply["finish"]))
    if body.get("stream_options", {}).get("include_usage"):
        prompt, completion = _usage_counts(body, reply)
        yield chunk({}, usage={"prompt_tokens": prompt, "completion_tokens": completion,
                               "total_tokens": prompt + completion}, choices=False)


def responses_object(model_id, body, reply, request_id, faults, status="completed"):
    output = []
    if reply["text"]:
        output.append({"type": "message", "id": "msg_" + request_id, "role": "assistant", "status": "completed",
                       "content": [{"type": "output_text", "text": reply["text"], "annotations": []}]})
    for i, call in enumerate(reply["calls"]):
        output.append({"type": "function_call", "id": "fc_%s%d" % (request_id, i), "call_id": _call_id(request_id, i, "call_"),
                       "name": call["name"], "arguments": json.dumps(call["arguments"]), "status": "completed"})
    prompt, completion = _usage_counts(body, reply)
    out = {"id": "resp_" + request_id, "object": "response", "created_at": 1_700_000_000, "model": model_id,
           "status": "incomplete" if reply["finish"] == "length" else status, "output": output}
    if reply["finish"] == "length":
        out["incomplete_details"] = {"reason": "max_output_tokens"}
    if not faults.get("drop_usage"):
        out["usage"] = {"input_tokens": prompt, "output_tokens": completion, "total_tokens": prompt + completion}
    return out


def responses_events(model_id, body, reply, request_id, faults):
    sequence = [0]

    def event(kind, **data):
        data.update(type=kind, sequence_number=sequence[0])
        sequence[0] += 1
        return (kind, json.dumps(data))

    final = responses_object(model_id, body, reply, request_id, faults)
    shell = dict(final, status="in_progress", output=[])
    yield event("response.created", response=shell)
    yield event("response.in_progress", response=shell)
    for index, item in enumerate(final["output"]):
        yield event("response.output_item.added", output_index=index, item=dict(item, status="in_progress"))
        if item["type"] == "message":
            yield event("response.content_part.added", output_index=index, content_index=0, item_id=item["id"],
                        part={"type": "output_text", "text": "", "annotations": []})
            words = reply["text"].split(" ") if "\n" not in reply["text"] else reply["text"].split("\n")
            glue = " " if "\n" not in reply["text"] else "\n"
            for i, piece in enumerate(words):
                yield event("response.output_text.delta", output_index=index, content_index=0, item_id=item["id"],
                            delta=piece + (glue if i < len(words) - 1 else ""))
            yield event("response.output_text.done", output_index=index, content_index=0, item_id=item["id"], text=reply["text"])
        else:
            arguments = item["arguments"]
            for start in range(0, len(arguments), 7):
                yield event("response.function_call_arguments.delta", output_index=index, item_id=item["id"],
                            delta=arguments[start:start + 7])
            yield event("response.function_call_arguments.done", output_index=index, item_id=item["id"], arguments=arguments)
        yield event("response.output_item.done", output_index=index, item=item)
    yield event("response.incomplete" if final["status"] == "incomplete" else "response.completed", response=final)


# --------------------------------------------------------------------- server

class _Handler(BaseHTTPRequestHandler):
    owner = None
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    def _send(self, status, body, headers=None, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, str(value))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status, code, message, retry_after=None, headers=None):
        headers = dict(headers or {})
        if retry_after:
            headers["Retry-After"] = str(int(retry_after))
        kind = "invalid_request_error" if status < 500 else "server_error"
        if status == 401:
            kind = "authentication_error"
        elif status == 429:
            kind = "rate_limit_error"
        self._send(status, {"error": {"message": message, "type": kind, "param": None, "code": code}}, headers)

    def _authorized(self):
        if self.owner.open_api:
            return True
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and auth[7:] in self.owner.keys

    def do_GET(self):
        owner = self.owner
        if self.path == "/management.html":
            return self._send(200, b"<html>dashboard</html>", content_type="text/html")
        if self.path == "/v1/models":
            if not self._authorized():
                return self._error(401, "invalid_api_key", "Missing or invalid API key.")
            missing = owner.faults.get("missing_models", ())
            data = [{"id": a, "object": "model", "created": 1_700_000_000, "owned_by": "cli-proxy"}
                    for a in owner.model_ids if a not in missing]
            return self._send(200, {"object": "list", "data": data})
        self._error(404, "not_found", "Unknown path.")

    def do_POST(self):
        owner = self.owner
        owner.requests += 1
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        if not self._authorized():
            return self._error(401, "invalid_api_key", "Missing or invalid API key.")
        protocol = {"/v1/chat/completions": "chat", "/v1/responses": "responses"}.get(self.path)
        if protocol is None:
            return self._error(404, "not_found", "Unknown path.")
        try:
            body = json.loads(raw)
            assert isinstance(body, dict)
        except (ValueError, AssertionError):
            return self._error(400, "invalid_json", "Request body is not valid JSON.")
        faults = dict(owner.faults)
        override = faults.get("status")
        if override and faults.get("status_remaining", 1) > 0:
            with owner.lock:
                owner.faults["status_remaining"] = faults.get("status_remaining", 1) - 1
            return self._error(override, "injected_fault", "Injected fault.", faults.get("retry_after"))
        required = "messages" if protocol == "chat" else "input"
        model_id = body.get("model")
        if required not in body:
            return self._error(400, "missing_required_parameter", "Missing required parameter: '%s'." % required)
        if model_id not in owner.model_ids or model_id in faults.get("missing_models", ()):
            return self._error(404, "model_not_found", "The model does not exist.")
        failing = faults.get("model_status", {}).get(model_id)
        if failing:
            return self._error(failing, "injected_fault", "Injected fault.", faults.get("retry_after"))
        affinity = self.headers.get("X-Session-Id") or body.get("user") or hashlib.sha1(
            json.dumps(body.get("messages") or body.get("input"), sort_keys=True).encode()).hexdigest()[:8]
        account, failure = owner.route(model_id, affinity)
        if failure:
            status, code, message, retry_after = failure
            return self._error(status, code, message, retry_after)
        headers = {"X-Emulator-Account": account.id}
        request_id = hashlib.sha1(str(owner.requests).encode()).hexdigest()[:16]
        reply = plan(protocol, body)
        if faults.get("shared_token"):  # simulates cross-request contamination
            for call in reply["calls"]:
                call["arguments"] = {k: ("AAA-0000" if isinstance(v, str) and TOKEN.fullmatch(v) else v)
                                     for k, v in call["arguments"].items()}
        if faults.get("stall_s"):
            time.sleep(faults["stall_s"])
        if not body.get("stream"):
            if protocol == "chat":
                return self._send(200, chat_body(model_id, body, reply, request_id, faults), headers)
            return self._send(200, responses_object(model_id, body, reply, request_id, faults), headers)
        self._stream(protocol, model_id, body, reply, request_id, faults, headers)

    def _stream(self, protocol, model_id, body, reply, request_id, faults, headers):
        owner = self.owner
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        events = (chat_events if protocol == "chat" else responses_events)(model_id, body, reply, request_id, faults)
        try:
            if faults.get("first_token_delay_s"):
                time.sleep(faults["first_token_delay_s"])
            for count, (name, data) in enumerate(events):
                if faults.get("truncate_after") is not None and count >= faults["truncate_after"]:
                    return  # connection closes with no terminal event or [DONE]
                if faults.get("corrupt_frame") == count:
                    self.wfile.write(b"this is not an sse field\n\n")
                frame = ("event: %s\n" % name if name else "") + "data: " + data + "\n\n"
                self.wfile.write(frame.encode())
                self.wfile.flush()
                if owner.chunk_delay_s:
                    time.sleep(owner.chunk_delay_s)
            if protocol == "chat" and not faults.get("omit_done"):
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return  # client cancelled
