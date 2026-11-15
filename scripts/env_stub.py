#!/usr/bin/env python3
"""Dummy make.fun env: /register accepts a port, /done says not done."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 18080


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        if self.path == "/register":
            length = int(self.headers.get("content-length", 0))
            body = self.rfile.read(length)
            try:
                payload = json.loads(body)
                port = payload.get("port")
            except Exception:
                port = None
            if isinstance(port, int):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "port": port}).encode())
            else:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":"bad port"}')
            return
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        if self.path == "/done":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"done": false}')
            return
        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
