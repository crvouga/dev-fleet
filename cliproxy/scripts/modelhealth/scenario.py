"""Build protocol-specific request bodies from protocol-neutral turn fixtures."""

import copy
import json


def substitute(value, variables):
    """Replace {name} placeholders in every string of a fixture."""
    if isinstance(value, str):
        for name, text in variables.items():
            value = value.replace("{" + name + "}", text)
        return value
    if isinstance(value, list):
        return [substitute(item, variables) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, variables) for key, item in value.items()}
    return value


def _merge(base, extra):
    for key, value in (extra or {}).items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = copy.deepcopy(value)
    return base


def _chat_tool(name, spec):
    return {"type": "function", "function": {"name": name, "description": spec["description"], "parameters": spec["parameters"]}}


def _responses_tool(name, spec):
    return {"type": "function", "name": name, "description": spec["description"], "parameters": spec["parameters"]}


def _chat_messages(turn):
    messages = []
    if turn.get("system"):
        messages.append({"role": "system", "content": turn["system"]})
    if turn.get("developer"):
        messages.append({"role": "developer", "content": turn["developer"]})
    for message in turn.get("messages", []):
        if message["role"] == "assistant" and message.get("tool_calls"):
            messages.append({
                "role": "assistant",
                "content": message.get("content"),
                "tool_calls": [
                    {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
                    for c in message["tool_calls"]
                ],
            })
        elif message["role"] == "tool":
            messages.append({"role": "tool", "tool_call_id": message["tool_call_id"], "content": message["content"]})
        else:
            messages.append({"role": message["role"], "content": message["content"]})
    return messages


def _responses_input(turn):
    items = []
    if turn.get("developer"):
        items.append({"role": "developer", "content": turn["developer"]})
    for message in turn.get("messages", []):
        if message["role"] == "assistant" and message.get("tool_calls"):
            if message.get("content"):
                items.append({"role": "assistant", "content": message["content"]})
            for call in message["tool_calls"]:
                items.append({"type": "function_call", "call_id": call["id"], "name": call["name"], "arguments": call["arguments"]})
        elif message["role"] == "tool":
            items.append({"type": "function_call_output", "call_id": message["tool_call_id"], "output": message["content"]})
        else:
            items.append({"role": message["role"], "content": message["content"]})
    return items


def _tool_choice(protocol, choice):
    if choice is None or isinstance(choice, str):
        return choice
    name = choice["name"]
    if protocol == "chat":
        return {"type": "function", "function": {"name": name}}
    return {"type": "function", "name": name}


def build(protocol, model_id, turn, config, extra=None):
    """Return the JSON body for one request on the given wire protocol."""
    tools = {name: config["tools"][name] for name in turn.get("tools", [])}
    limit_field = config["protocols"][protocol]["token_limit_field"]
    body = {"model": model_id}
    if protocol == "chat":
        body["messages"] = _chat_messages(turn)
        if tools:
            body["tools"] = [_chat_tool(n, s) for n, s in tools.items()]
        if turn.get("json_schema"):
            spec = turn["json_schema"]
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": spec["name"], "schema": spec["schema"], "strict": True},
            }
        if turn.get("stream") and turn.get("include_usage"):
            body["stream_options"] = {"include_usage": True}
        if tools and "parallel_tool_calls" in turn:
            body["parallel_tool_calls"] = turn["parallel_tool_calls"]
    else:
        if turn.get("system"):
            body["instructions"] = turn["system"]
        body["input"] = _responses_input(turn)
        body["store"] = False
        if tools:
            body["tools"] = [_responses_tool(n, s) for n, s in tools.items()]
        if turn.get("json_schema"):
            spec = turn["json_schema"]
            body["text"] = {"format": {"type": "json_schema", "name": spec["name"], "schema": spec["schema"], "strict": True}}
        if tools and "parallel_tool_calls" in turn:
            body["parallel_tool_calls"] = turn["parallel_tool_calls"]
    if tools and turn.get("tool_choice") is not None:
        body["tool_choice"] = _tool_choice(protocol, turn["tool_choice"])
    if turn.get("max_tokens"):
        body[limit_field] = turn["max_tokens"]
    if turn.get("stream"):
        body["stream"] = True
    return _merge(body, extra)


def tool_schemas(config, names):
    return {name: config["tools"][name]["parameters"] for name in names}


def dumps(body):
    return json.dumps(body, separators=(",", ":")).encode()
