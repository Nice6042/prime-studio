"""Throwaway pass-through proxy on :47822 that records Anthropic rate-limit response headers.

Purpose: find out whether routing Prime through a proxy exposes subscription usage
(anthropic-ratelimit-unified-*), which would let Prime Studio show a real "% of plan used".
It only logs headers — nothing is stored or modified.

Run:  python ratelimit-probe.py
Use:  ANTHROPIC_BASE_URL=http://127.0.0.1:47822 prime-agent ...
Out:  ratelimit-headers.log
"""
import json
import os
import ssl
import time
from http.client import HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "api.anthropic.com"
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ratelimit-headers.log")
SKIP_REQ = {"host", "connection", "keep-alive", "transfer-encoding", "upgrade", "accept-encoding"}
SKIP_RESP = {"connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        conn = HTTPSConnection(UPSTREAM, 443, timeout=600, context=ssl.create_default_context())
        hdrs = {k: v for k, v in self.headers.items() if k.lower() not in SKIP_REQ}
        hdrs["Host"] = UPSTREAM
        try:
            conn.request(self.command, self.path, body=body or None, headers=hdrs)
            resp = conn.getresponse()
            interesting = {k: v for k, v in resp.getheaders()
                           if "ratelimit" in k.lower() or "retry-after" in k.lower()
                           or "unified" in k.lower() or "anthropic-" in k.lower()}
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps({"ts": time.time(), "path": self.path,
                                    "status": resp.status, "headers": interesting}) + "\n")
            self.send_response(resp.status)
            is_sse = "text/event-stream" in (resp.getheader("Content-Type") or "").lower()
            for k, v in resp.getheaders():
                if k.lower() not in SKIP_RESP:
                    self.send_header(k, v)
            if is_sse:
                self.send_header("Connection", "close")
                self.end_headers()
                while True:
                    chunk = resp.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            else:
                data = resp.read()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if data:
                    self.wfile.write(data)
        except Exception as e:
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps({"ts": time.time(), "error": repr(e)}) + "\n")
            self.close_connection = True
        finally:
            conn.close()

    do_GET = do_POST = do_PUT = do_DELETE = _proxy


if __name__ == "__main__":
    print("probe listening on 127.0.0.1:47822 -> api.anthropic.com", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 47822), H).serve_forever()
