from contextlib import contextmanager
from importlib.util import module_from_spec, spec_from_file_location
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import BaseRequestHandler, TCPServer
import time
from threading import Thread
import unittest

spec = spec_from_file_location(
    "thryve_observe", Path(__file__).resolve().parents[2] / "scripts" / "thryve-observe.py"
)
observe = module_from_spec(spec)
spec.loader.exec_module(observe)


@contextmanager
def serving(server_type, handler):
    with server_type(("127.0.0.1", 0), handler) as server:
        worker = Thread(target=server.serve_forever, daemon=True, kwargs={"poll_interval": 0.01})
        worker.start()
        try:
            yield server.server_address[1]
        finally:
            server.shutdown()
            worker.join()


class Http(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/slow":
            time.sleep(0.15)
            return
        body = {
            "/health": b'{"ok":true,"uptime_s":126,"mqtt_connected":false,"not_logged":"ignore"}',
            "/fake": b"<!doctype html>",
        }.get(self.path)
        self.send_response(200 if body is not None else 404)
        self.end_headers()
        if body:
            self.wfile.write(body)


class Ssh(BaseRequestHandler):
    def handle(self):
        self.request.sendall(b"notice\r\nSS")
        time.sleep(0.01)
        self.request.sendall(b"H-2.0-test\r\n")


class ProbeTests(unittest.TestCase):
    def test_http_distinguishes_success_wrong_route_wrong_content_and_timeout(self):
        with serving(ThreadingHTTPServer, Http) as port:
            healthy = observe.probe_http("127.0.0.1", port, "/health", 1)
            self.assertEqual(healthy["result"], "ok")
            self.assertEqual(healthy["uptime_s"], 126)
            self.assertFalse(healthy["mqtt_connected"])
            self.assertNotIn("not_logged", healthy)
            self.assertEqual(observe.probe_http("127.0.0.1", port, "/missing", 1)["http"], 404)
            self.assertEqual(observe.probe_http("127.0.0.1", port, "/fake", 1)["result"], "unexpected_response")
            self.assertEqual(observe.probe_http("127.0.0.1", port, "/slow", 0.05)["result"], "timeout")

    def test_ssh_checks_identification_even_when_the_banner_is_split(self):
        with serving(TCPServer, Ssh) as port:
            self.assertEqual(observe.probe_ssh("127.0.0.1", 1, port)["result"], "ok")
        self.assertEqual(observe.probe_ssh("127.0.0.1", 1, port)["result"], "refused")
