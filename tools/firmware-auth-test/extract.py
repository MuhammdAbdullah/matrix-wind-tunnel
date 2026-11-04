import sys
import xml.etree.ElementTree as ET

import os
HERE = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', '..', '..', 'Firmware', 'WindTunnel V2.0.7.fcfx')
# Flowcode keeps raw newlines inside attribute values; a standards-compliant parser would fold them
# to spaces, so protect them as character references before parsing.
import re
r = ET.fromstring(re.sub(r"'[^']*'", lambda m: m.group(0).replace('\n', '&#10;'), open(src, encoding='utf-8').read()))
names = [f.get('name') for f in r.iter('flowline') if f.get('name')]
want = ['LoadMAC', 'ApplyMAC', 'EthReject', 'EthChangeAddress', 'EthClientEvent', 'AuthSession', 'AuthGate', 'NetApiExtra']
print("well-formed; flowlines", len(names), {n: names.count(n) for n in want})

head = next(r.iter('supplement')).get('head')
bodies = {}
for m in r.iter('macro'):
    fl = m.find('flowline')
    if fl is not None and fl.get('name') in want:
        c = fl.find("command[@class_type='native']")
        bodies[fl.get('name')] = (c.get('ccode'), [p.get('name') for p in fl.findall('param')])

pj = [c.get('ccode') for c in r.iter('command') if c.get('title') == 'Unverified Ethernet client: stop here'][0]
ts = [c.get('ccode') for c in r.iter('command') if c.get('title') == 'Show port and MAC under the IP'][0]

prelude = open(os.path.join(HERE, 'harness_prelude.c')).read()
tail = open(os.path.join(HERE, 'harness_tests.c')).read()
out = [prelude, head, open(os.path.join(HERE, 'harness_stubs.c')).read()]
for n in ['EthReject', 'EthChangeAddress', 'LoadMAC', 'ApplyMAC', 'AuthSession', 'AuthGate', 'NetApiExtra', 'EthClientEvent']:
    code, params = bodies[n]
    sig = ','.join('MX_UINT8 FCL_%s' % p.upper() for p in params) or 'void'
    out.append('void FCM_%s(%s)\n{\n%s\n}\n' % (n, sig, code))
out.append('void screenfn(void){\n' + ts + '\n}\n')
out.append(tail)
open(os.path.join(os.environ.get('TEMP', HERE), 'wt_fw_auth_test.c'), 'w').write(''.join(out))
print("extracted")
