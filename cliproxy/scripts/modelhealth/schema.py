"""Minimal JSON Schema subset validator (no third-party dependency).

Supports the keywords used by tool and structured-output fixtures: type, enum,
const, properties, required, additionalProperties, items, minItems, maxItems,
minimum, maximum, minLength, maxLength and pattern.
"""

import re

_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def errors(value, schema, path="$"):
    """Return a list of 'path: problem' strings; empty means valid."""
    found = []
    expected = schema.get("type")
    if expected is not None:
        names = expected if isinstance(expected, list) else [expected]
        if not any(_TYPES[name](value) for name in names):
            return [path + ": expected " + "|".join(names)]
    if "const" in schema and value != schema["const"]:
        found.append(path + ": does not equal the required constant")
    if "enum" in schema and value not in schema["enum"]:
        found.append(path + ": not one of the allowed values")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            found.append(path + ": shorter than minLength")
        if len(value) > schema.get("maxLength", 1 << 30):
            found.append(path + ": longer than maxLength")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            found.append(path + ": does not match pattern")
    if _TYPES["number"](value):
        if "minimum" in schema and value < schema["minimum"]:
            found.append(path + ": below minimum")
        if "maximum" in schema and value > schema["maximum"]:
            found.append(path + ": above maximum")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            found.append(path + ": fewer than minItems")
        if len(value) > schema.get("maxItems", 1 << 30):
            found.append(path + ": more than maxItems")
        if "items" in schema:
            for index, item in enumerate(value):
                found += errors(item, schema["items"], "%s[%d]" % (path, index))
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                found.append(path + "." + name + ": required")
        for name, item in value.items():
            if name in properties:
                found += errors(item, properties[name], path + "." + name)
            elif schema.get("additionalProperties") is False:
                found.append(path + "." + name + ": unexpected property")
    return found
