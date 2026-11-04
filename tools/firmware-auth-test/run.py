"""Extracts the Ethernet access-control C from the Flowcode source and runs it against stubs.

Usage: python run.py [path-to.fcfx]     (needs gcc on PATH; default is ../../../Firmware/WindTunnel V2.0.7.fcfx)
This checks the logic only. It does not prove the firmware compiles under Flowcode/XC16.
"""
import os
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
tmp = os.environ.get('TEMP', here)
args = [sys.executable, os.path.join(here, 'extract.py')] + sys.argv[1:]
subprocess.check_call(args)
exe = os.path.join(tmp, 'wt_fw_auth_test.exe')
subprocess.check_call(['gcc', '-Wall', '-Wextra', '-Wno-unused-function', '-Wno-unused-parameter', '-Wno-sign-compare', '-std=gnu99', '-o', exe, os.path.join(tmp, 'wt_fw_auth_test.c')])
sys.exit(subprocess.call([exe]))
