from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os

from packages.worker.app import describe


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(value).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)


context = json.loads(os.environ["ALIGNFIRST_CONTEXT"])
server = HTTPServer(("127.0.0.1", context["ports"]["api"]), Handler)
value = describe("api")
print("API_READY", flush=True)
server.serve_forever()
