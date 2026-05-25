from mitmproxy import http
import base64
import json
import os
import time


LOG_PATH = os.environ.get("MITM_JSONL_LOG", r"C:\tmp\mitmproxy-vscode-flows.jsonl")


def _headers(headers):
    return [[key, value] for key, value in headers.items(multi=True)]


def _body(message):
    content = message.raw_content
    if content is None:
        return None
    return {
        "encoding": "base64",
        "length": len(content),
        "data": base64.b64encode(content).decode("ascii"),
    }


def _write(event):
    event["logged_at"] = time.time()
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")


class FullFlowLogger:
    def request(self, flow: http.HTTPFlow):
        request = flow.request
        _write(
            {
                "type": "request",
                "flow_id": flow.id,
                "method": request.method,
                "url": request.pretty_url,
                "scheme": request.scheme,
                "host": request.host,
                "port": request.port,
                "path": request.path,
                "http_version": request.http_version,
                "headers": _headers(request.headers),
                "body": _body(request),
                "timestamp_start": request.timestamp_start,
                "timestamp_end": request.timestamp_end,
                "client_conn": {
                    "address": flow.client_conn.address,
                    "peername": flow.client_conn.peername,
                },
            }
        )

    def response(self, flow: http.HTTPFlow):
        response = flow.response
        if response is None:
            return
        _write(
            {
                "type": "response",
                "flow_id": flow.id,
                "status_code": response.status_code,
                "reason": response.reason,
                "headers": _headers(response.headers),
                "body": _body(response),
                "timestamp_start": response.timestamp_start,
                "timestamp_end": response.timestamp_end,
            }
        )

    def error(self, flow: http.HTTPFlow):
        if flow.error is None:
            return
        _write(
            {
                "type": "error",
                "flow_id": flow.id,
                "message": flow.error.msg,
            }
        )


addons = [FullFlowLogger()]
