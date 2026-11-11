"""Evaluate declarative expectations against a normalized response."""

import json
import re

from . import schema


def _lower(text):
    return text.lower()


def _matches(actual, wanted):
    if isinstance(wanted, dict):
        if "regex" in wanted:
            return isinstance(actual, str) and re.search(wanted["regex"], actual) is not None
        if "min" in wanted or "max" in wanted:
            return isinstance(actual, (int, float)) and wanted.get("min", actual) <= actual <= wanted.get("max", actual)
    if isinstance(actual, str) and isinstance(wanted, str):
        return actual.casefold() == wanted.casefold()
    return actual == wanted


def evaluate(expect, norm, tool_schemas=None, max_gap=None):
    """Return a list of (category, message); empty means every expectation held."""
    found = [("protocol", message) for message in norm.violations]
    if norm.upstream_error is not None:
        found.append(("upstream", "provider error reported inside a successful response"))
    reasons = expect.get("finish_reason")
    if reasons and norm.finish_reason not in reasons:
        found.append(("assertion", "finish_reason %r not in %s" % (norm.finish_reason, reasons)))
    content = expect.get("content")
    if content:
        if content.get("non_empty") and not norm.content.strip():
            found.append(("assertion", "assistant content is empty"))
        needle = content.get("contains")
        if needle and _lower(needle) not in _lower(norm.content):
            found.append(("assertion", "assistant content does not contain the expected token"))
        if content.get("max_chars") and len(norm.content) > content["max_chars"]:
            found.append(("assertion", "assistant content exceeds max_chars"))
    if expect.get("usage") and norm.usage is None:
        found.append(("protocol", "usage metadata is missing"))
    stream = expect.get("stream")
    if stream:
        if norm.events < stream.get("min_events", 1):
            found.append(("assertion", "stream carried only %d events" % norm.events))
        if stream.get("max_gap_s") and max_gap is not None and max_gap > stream["max_gap_s"]:
            found.append(("assertion", "stream stalled %.1fs between events" % max_gap))
    if "json" in expect:
        try:
            document = json.loads(norm.content)
        except ValueError:
            found.append(("assertion", "content is not valid JSON"))
        else:
            found += [("assertion", "json " + e) for e in schema.errors(document, expect["json"]["schema"])]
    wanted = expect.get("tool_calls")
    if wanted is not None:
        found += _tool_calls(wanted, norm, tool_schemas or {})
    return found


def _tool_calls(wanted, norm, tool_schemas):
    calls = norm.tool_calls
    found = []
    if len(calls) < wanted.get("min", 0):
        found.append(("assertion", "expected at least %d tool calls, got %d" % (wanted["min"], len(calls))))
    if "max" in wanted and len(calls) > wanted["max"]:
        found.append(("assertion", "expected at most %d tool calls, got %d" % (wanted["max"], len(calls))))
    if wanted.get("unique_ids") and len({c["id"] for c in calls}) != len(calls):
        found.append(("protocol", "tool call ids are not unique"))
    for call in calls:
        if wanted.get("names") and call["name"] not in wanted["names"]:
            found.append(("assertion", "unexpected tool name %r" % call["name"]))
            continue
        if call["args"] is None:
            continue  # already reported as a protocol violation
        if wanted.get("arguments_schema") == "from_tools" and call["name"] in tool_schemas:
            found += [("assertion", "arguments " + e) for e in schema.errors(call["args"], tool_schemas[call["name"]])]
    for field, value in (wanted.get("arguments") or {}).items():
        if calls and not any(c["args"] and _matches(c["args"].get(field), value) for c in calls):
            found.append(("assertion", "no tool call carried the expected %r argument" % field))
    values = wanted.get("values")
    if values:
        seen = {c["args"].get(values["field"]) for c in calls if c["args"]}
        missing = [v for v in values["include"] if v not in seen]
        if missing:
            found.append(("assertion", "tool calls missed expected %r values" % values["field"]))
    return found
