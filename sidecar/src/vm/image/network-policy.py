#!/usr/bin/python3
"""Root-owned packet policy and bounded local DNS forwarder. No workload configuration."""
import hashlib
import ipaddress
import json
import os
import selectors
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

CONFIG = '/run/touri-network.json'
DNS_ADDRESS = ('127.0.0.53', 53)
# Public allow-list: DNS answers for allowed names open their addresses for at least this long.
ALLOW_MIN_SECONDS = 300
ALLOW_MAX_SECONDS = 86400
PRIVATE4 = '0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4'
PRIVATE6 = '::/96, ::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, 2001::/23, 2001:db8::/32, 2002::/16, fc00::/7, fe80::/10, ff00::/8'
SUFFIXES = ('localhost', 'local', 'lan', 'home', 'internal', 'intranet', 'corp', 'test', 'invalid', 'home.arpa')

def restricted(policy):
    return policy.get('restrictPublic') is True

def allowed_name(name, policy):
    return any(name == host or name.endswith('.' + host) for host in policy.get('publicHosts', []) if not is_address(host))

def is_address(value):
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False

def kept_elements(policy):
    # Re-applying an unchanged allow-list keeps the addresses already resolved, so live connections survive.
    try:
        with open(CONFIG) as stream:
            previous = json.load(stream)
    except (OSError, ValueError):
        return []
    if not restricted(previous) or previous.get('publicHosts') != policy.get('publicHosts'):
        return []
    kept = []
    for name in ('allow4', 'allow6'):
        listing = subprocess.run(['nft', '-j', 'list', 'set', 'inet', 'touri', name], capture_output=True)
        if listing.returncode != 0:
            continue
        for item in json.loads(listing.stdout).get('nftables', []):
            for element in item.get('set', {}).get('elem', []):
                value = element.get('elem', {}).get('val') if isinstance(element, dict) else element
                if isinstance(value, str) and is_address(value):
                    kept.append((name, value))
    return kept

def apply(policy, blocked=False):
    # Discover the host-facing router; LAN consent never grants access to the host.
    routes = json.loads(subprocess.check_output(['ip', '-j', 'route', 'show', 'default']))
    gateways = [str(ipaddress.IPv4Address(r['gateway'])) for r in routes if r.get('gateway')]
    restrict = restricted(policy) and not blocked
    kept = kept_elements(policy) if restrict else []
    lines = ['table inet touri {']
    if restrict:
        lines += ['set allow4 { type ipv4_addr; flags timeout; }', 'set allow6 { type ipv6_addr; flags timeout; }']
    lines += ['chain output { type filter hook output priority -150; policy drop;']
    lines += ['meta skuid 1000 tcp dport { 5900, 9222 } drop', 'meta skuid 1001 tcp dport { 9876, 5900 } drop', 'oifname "lo" accept']
    # Only the root resolver may send conventional DNS to configured upstreams.
    for resolver in policy['resolvers']:
        address = ipaddress.ip_address(resolver)
        family = 'ip' if address.version == 4 else 'ip6'
        lines += [f'meta skuid 0 {family} daddr {address} udp dport 53 accept', f'meta skuid 0 {family} daddr {address} tcp dport 53 accept']
    lines += ['udp dport { 53, 853 } drop', 'tcp dport { 53, 853 } drop']
    # Link-local/metadata and the host/router stay denied even with LAN enabled.
    lines += ['ip daddr 169.254.0.0/16 drop', 'ip6 daddr fe80::/10 drop']
    for gateway in gateways:
        lines.append(f'ip daddr {gateway} drop')
    for host in policy.get('hostAddresses', []):
        address = ipaddress.ip_address(host)
        lines.append(f'{"ip" if address.version == 4 else "ip6"} daddr {address} drop')
    if not policy['allowLan']:
        lines += [f'ip daddr {{ {PRIVATE4} }} drop', f'ip6 daddr {{ {PRIVATE6} }} drop']
    else:
        lines += ['ip daddr { 0.0.0.0/8, 127.0.0.0/8, 224.0.0.0/4, 240.0.0.0/4 } drop', 'ip6 daddr { ::/96, ::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, 2002::/16, ff00::/8 } drop']
    if restrict:
        # Only addresses of allowed names (added by the DNS forwarder) and listed IPs leave the machine.
        if policy['allowLan']:
            lines += ['ip daddr { 10.0.0.0/8, 100.64.0.0/10, 172.16.0.0/12, 192.168.0.0/16 } accept', 'ip6 daddr fc00::/7 accept']
        lines += ['ip daddr @allow4 accept', 'ip6 daddr @allow6 accept']
    elif not blocked:
        lines.append('accept')
    lines += ['}', 'chain input { type filter hook input priority -150; policy drop; iifname "lo" accept; ct state established,related accept; }', '}']
    for host in policy.get('publicHosts', []) if restrict else []:
        if is_address(host):
            lines.append(f'add element inet touri {"allow4" if ipaddress.ip_address(host).version == 4 else "allow6"} {{ {host} }}')
    for name, address in kept:
        lines.append(f'add element inet touri {name} {{ {address} timeout {ALLOW_MIN_SECONDS}s }}')
    # nft applies the whole transaction atomically, including established flows.
    exists = subprocess.run(['nft', 'list', 'table', 'inet', 'touri'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    script = ('delete table inet touri\n' if exists else '') + '\n'.join(lines) + '\n'
    subprocess.run(['nft', '-f', '-'], input=script.encode(), check=True)
    fd = os.open(CONFIG + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(policy, out); out.flush(); os.fsync(out.fileno())
    os.replace(CONFIG + '.tmp', CONFIG)
    with open('/etc/resolv.conf', 'w') as out:
        out.write('nameserver 127.0.0.53\noptions timeout:2 attempts:1\n')
    if restrict:
        ensure_forwarder()

def source_digest():
    with open(os.path.abspath(__file__), 'rb') as stream:
        return hashlib.sha256(stream.read()).hexdigest()

def forwarders():
    found = []
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            with open(f'/proc/{pid}/cmdline', 'rb') as stream:
                args = stream.read().split(b'\0')
        except OSError:
            continue
        if len(args) >= 3 and args[1].endswith(b'network-policy.py') and args[2] == b'serve':
            found.append((int(pid), args[1].decode(errors='replace')))
    return found

def ensure_forwarder():
    # Machines whose image predates the allow-list run an older forwarder; replace it with this version.
    me, digest = os.path.abspath(__file__), source_digest()
    running = forwarders()
    try:
        with open('/run/touri-dns.version') as stream:
            current = stream.read().strip() == digest
    except OSError:
        current = False
    if current and any(path == me for _, path in running):
        return
    for pid, _ in running:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    try:
        os.remove('/run/touri-dns.version')
    except OSError:
        pass
    log = os.open('/run/touri-dns.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    try:
        process = subprocess.Popen([sys.executable, me, 'serve'], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    finally:
        os.close(log)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and process.poll() is None:
        if os.path.exists('/run/touri-dns.version'):
            return
        time.sleep(0.05)
    raise RuntimeError('DNS forwarder did not start')

def answer_addresses(reply):
    # A/AAAA records of a reply, following compression pointers; malformed replies open nothing.
    try:
        questions, answers = struct.unpack('!HH', reply[4:8])
        at = 12
        def skip(at):
            while True:
                length = reply[at]
                if length & 0xc0 == 0xc0:
                    return at + 2
                at += 1 + length
                if length == 0:
                    return at
        for _ in range(questions):
            at = skip(at) + 4
        found = []
        for _ in range(answers):
            at = skip(at)
            kind, klass, ttl, size = struct.unpack('!HHIH', reply[at:at + 10])
            data = reply[at + 10:at + 10 + size]
            at += 10 + size
            if klass == 1 and kind == 1 and size == 4:
                found.append(('allow4', socket.inet_ntop(socket.AF_INET, data), ttl))
            elif klass == 1 and kind == 28 and size == 16:
                found.append(('allow6', socket.inet_ntop(socket.AF_INET6, data), ttl))
        return found
    except (IndexError, struct.error, ValueError, OSError):
        return []

def open_answers(reply, policy):
    statics = set(policy.get('publicHosts', []))
    lines = []
    for name, address, ttl in answer_addresses(reply):
        if address in statics:
            continue
        seconds = min(max(ttl, ALLOW_MIN_SECONDS) + 60, ALLOW_MAX_SECONDS)
        element = f'inet touri {name} {{ {address} timeout {seconds}s }}'
        # add (no-op when present), delete, add again: refreshes the timeout in one transaction.
        lines += [f'add element {element}', f'delete element inet touri {name} {{ {address} }}', f'add element {element}']
    if not lines:
        return
    try:
        subprocess.run(['nft', '-f', '-'], input=('\n'.join(lines) + '\n').encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
    except subprocess.SubprocessError:
        pass

def permitted_question(packet, policy):
    if len(packet) < 17 or packet[4:6] != b'\x00\x01':
        return False
    at, labels = 12, []
    while at < len(packet):
        length = packet[at]; at += 1
        if length == 0:
            break
        if length > 63 or at + length > len(packet):
            return False
        labels.append(packet[at:at+length].decode('ascii').lower()); at += length
    else:
        return False
    name = '.'.join(labels)
    if len(labels) < 2 or at + 4 != len(packet):
        return False
    if any(name == suffix or name.endswith('.' + suffix) for suffix in SUFFIXES + tuple(policy['privateDomains'])):
        return False
    if name.endswith('.in-addr.arpa') or name.endswith('.ip6.arpa'):
        return False
    if restricted(policy) and not allowed_name(name, policy):
        return False
    return True

def query(packet):
    try:
        with open(CONFIG) as stream:
            policy = json.load(stream)
        if permitted_question(packet, policy):
            for resolver in policy['resolvers']:
                with socket.socket(socket.AF_INET6 if ':' in resolver else socket.AF_INET, socket.SOCK_DGRAM) as upstream:
                    upstream.settimeout(2)
                    try:
                        upstream.connect((resolver, 53)); upstream.send(packet)
                        reply = upstream.recv(65535)
                        if reply[:2] == packet[:2]:
                            if restricted(policy):
                                open_answers(reply, policy)
                            return reply
                    except OSError:
                        pass
    except (ValueError, OSError, UnicodeError):
        pass
    if len(packet) < 12:
        return b''
    return packet[:2] + b'\x81\x83' + packet[4:6] + b'\x00' * 6 + packet[12:]

def bind(kind):
    # A replaced forwarder may still hold the address for a moment.
    deadline = time.monotonic() + 2
    while True:
        server = socket.socket(socket.AF_INET, kind)
        if kind == socket.SOCK_STREAM:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            server.bind(DNS_ADDRESS)
            return server
        except OSError:
            server.close()
            if time.monotonic() > deadline:
                raise
            time.sleep(0.05)

def serve():
    udp = bind(socket.SOCK_DGRAM)
    tcp = bind(socket.SOCK_STREAM); tcp.listen(16)
    try:
        with open('/run/touri-dns.version', 'w') as out:
            out.write(source_digest())
    except OSError:
        pass
    poll = selectors.DefaultSelector(); poll.register(udp, selectors.EVENT_READ); poll.register(tcp, selectors.EVENT_READ)
    slots = threading.BoundedSemaphore(32)
    def handle_udp(packet, peer):
        try:
            reply = query(packet)
            if reply: udp.sendto(reply, peer)
        finally: slots.release()
    def handle_tcp(peer):
        try:
            peer.settimeout(3)
            def read(n):
                data = b''
                while len(data) < n:
                    chunk = peer.recv(n-len(data))
                    if not chunk: raise OSError('closed')
                    data += chunk
                return data
            size = struct.unpack('!H', read(2))[0]
            reply = query(read(size))
            peer.sendall(struct.pack('!H', len(reply)) + reply)
        except OSError: pass
        finally: peer.close(); slots.release()
    while True:
        for event, _ in poll.select():
            if event.fileobj is udp:
                packet, peer = udp.recvfrom(4096)
                if slots.acquire(False): threading.Thread(target=handle_udp, args=(packet, peer), daemon=True).start()
            else:
                peer, _ = tcp.accept()
                if slots.acquire(False): threading.Thread(target=handle_tcp, args=(peer,), daemon=True).start()
                else: peer.close()

if __name__ == '__main__':
    if sys.argv[1] == 'serve': serve()
    elif sys.argv[1] == 'boot': apply(dict(allowLan=False, resolvers=[], privateDomains=[]), blocked=True)
    else: apply(json.loads(sys.argv[2]))
