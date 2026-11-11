"""HTTP/SSE client with strict framing checks, deadlines and no redirects or hidden retries."""

import http.client
import json
import ssl
import time
import urllib.parse

USER_AGENT = "cliproxy-fleet/1.0 model-health"
MAX_BODY = 4 * 1024 * 1024
_SSE_FIELDS = ("data", "event", "id", "retry")


class TransportError(Exception):
    """A request that produced no HTTP response; category feeds failure reporting."""

    def __init__(self, category, detail):
        super().__init__(detail)
        self.category = category
        self.detail = detail


class Response:
    def __init__(self, status, headers, body, elapsed):
        self.status = status
        self.headers = {k.lower(): v for k, v in headers}
        self.body = body
        self.elapsed = elapsed

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None


class Frame:
    def __init__(self, event, data, at):
        self.event = event
        self.data = data
        self.at = at  # seconds since the request was sent


class StreamResult:
    def __init__(self):
        self.status = 0
        self.headers = {}
        self.frames = []
        self.violations = []
        self.error_body = b""
        self.ttft = None  # first frame carrying data
        self.elapsed = 0.0
        self.cancelled = False
        self.done = False  # saw the literal [DONE] sentinel
        self.clean_eof = False  # server ended the body after a complete frame

    def json_frames(self):
        out = []
        for frame in self.frames:
            if frame.data == "[DONE]":
                continue
            try:
                out.append((frame.event, json.loads(frame.data)))
            except ValueError:
                self.violations.append("non-JSON data frame")
        return out


def _loopback(host):
    return host in ("127.0.0.1", "localhost", "::1")


class Client:
    """One origin + optional bearer key. Every call is a single attempt."""

    def __init__(self, base_url, key=None, redactor=None, timeout=60.0, on_request=None):
        parts = urllib.parse.urlsplit(base_url)
        if parts.scheme not in ("https", "http") or not parts.hostname:
            raise ValueError("Endpoint must be an absolute URL")
        if parts.scheme == "http" and not _loopback(parts.hostname):
            raise ValueError("HTTPS required (plain HTTP is allowed only for loopback emulators)")
        self.scheme = parts.scheme
        self.host = parts.hostname
        self.port = parts.port
        self.prefix = parts.path.rstrip("/")
        self.base_url = base_url.rstrip("/")
        self.key = key
        self.redact = redactor or (lambda text, limit=300: str(text)[:limit])
        self.timeout = timeout
        self.on_request = on_request or (lambda kind: None)

    def _connect(self, timeout):
        if self.scheme == "https":
            return http.client.HTTPSConnection(
                self.host, self.port, timeout=timeout, context=ssl.create_default_context()
            )
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    def _headers(self, authenticated, body, extra):
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if authenticated and self.key:
            headers["Authorization"] = "Bearer " + self.key
        if body is not None:
            headers["Content-Type"] = "application/json"
        headers.update(extra or {})
        return headers

    def _send(self, method, path, body, authenticated, timeout, extra, kind):
        self.on_request(kind)
        connection = self._connect(timeout or self.timeout)
        payload = None
        if body is not None:
            payload = body if isinstance(body, bytes) else json.dumps(body).encode()
        started = time.monotonic()
        try:
            connection.request(
                method, self.prefix + path, payload, self._headers(authenticated, payload, extra)
            )
            return connection, connection.getresponse(), started
        except Exception as error:
            connection.close()
            raise self._classify(error) from None

    def _classify(self, error):
        text = self.redact(type(error).__name__ + ": " + str(error))
        if isinstance(error, (TimeoutError,)) or "timed out" in str(error):
            return TransportError("timeout", text)
        return TransportError("transport", text)

    def request(self, method, path, body=None, authenticated=True, timeout=None,
                headers=None, kind="request"):
        connection, response, started = self._send(
            method, path, body, authenticated, timeout, headers, kind
        )
        try:
            data = response.read(MAX_BODY + 1)
        except Exception as error:
            raise self._classify(error) from None
        finally:
            connection.close()
        if len(data) > MAX_BODY:
            raise TransportError("protocol", "Response body exceeds the harness limit")
        return Response(response.status, response.getheaders(), data, time.monotonic() - started)

    def stream(self, path, body, timeout=None, deadline=None, stop_after=None,
               headers=None, kind="inference"):
        """POST a streaming request and parse SSE frames.

        timeout is the per-read idle limit; deadline bounds the whole stream.
        stop_after closes the connection after N data frames (cancellation).
        """
        result = StreamResult()
        extra = {"Accept": "text/event-stream"}
        extra.update(headers or {})
        connection, response, started = self._send(
            "POST", path, body, True, timeout, extra, kind
        )
        result.status = response.status
        result.headers = {k.lower(): v for k, v in response.getheaders()}
        try:
            if response.status != 200:
                result.error_body = response.read(64 * 1024)
                return result
            if "text/event-stream" not in result.headers.get("content-type", ""):
                result.violations.append("content-type is not text/event-stream")
            event, data_lines, saw_field = None, [], False
            limit = deadline or (self.timeout * 4)
            while True:
                if time.monotonic() - started > limit:
                    raise TransportError("timeout", "Stream exceeded its overall deadline")
                try:
                    raw = response.readline()
                except Exception as error:
                    raise self._classify(error) from None
                if not raw:
                    result.clean_eof = not saw_field
                    if saw_field:
                        result.violations.append("stream ended inside an unterminated frame")
                    break
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line == "":
                    if saw_field:
                        at = time.monotonic() - started
                        frame = Frame(event, "\n".join(data_lines), at)
                        if data_lines:
                            result.frames.append(frame)
                            if result.ttft is None:
                                result.ttft = at
                            if frame.data == "[DONE]":
                                result.done = True
                        event, data_lines, saw_field = None, [], False
                        if stop_after and len(result.frames) >= stop_after:
                            result.cancelled = True
                            break
                    continue
                if line.startswith(":"):
                    continue  # comment / keep-alive
                name, sep, value = line.partition(":")
                if name not in _SSE_FIELDS or (not sep and name != "data"):
                    result.violations.append("invalid SSE line")
                    continue
                value = value[1:] if value.startswith(" ") else value
                saw_field = True
                if name == "data":
                    data_lines.append(value)
                elif name == "event":
                    event = value
                if result.done and name == "data":
                    result.violations.append("data after [DONE]")
        finally:
            connection.close()
            result.elapsed = time.monotonic() - started
        return result
