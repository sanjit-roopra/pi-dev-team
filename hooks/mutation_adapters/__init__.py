"""Mutation-testing adapters (#578).

Public surface mirrors the bash lib.sh + adapter contract so mutation-gate can
switch consumers one at a time. See `lib.py` for the shared library and
`stryker.py`, `stryker_net.py`, `pitest.py`, `mutmut.py` for the per-runner
adapters.
"""
