#!/usr/bin/env python3
import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status = int(os.environ.get("HBG_TEST_HTTP_CODE", "200"))
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"data":[]}')

    def log_message(self, *_args):
        return


HTTPServer(("127.0.0.1", 18317), Handler).serve_forever()
