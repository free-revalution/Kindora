#!/usr/bin/env python3
"""Bind a UDP socket on the requested port for T4/T5 port-occupancy tests."""
import socket
import sys
import time

if len(sys.argv) != 2:
    print("usage: port_holder.py <port>", file=sys.stderr)
    sys.exit(2)
port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.bind(("127.0.0.1", port))
except OSError as e:
    print(f"bind_fail: {e}", file=sys.stderr)
    sys.exit(1)
print(f"bound {port}", flush=True)
time.sleep(45)