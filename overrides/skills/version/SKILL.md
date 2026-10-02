---
name: version
description: >-
  Report the installed version of the pi-dev-team package and the upstream
  dev-team release it was synced from.
user-invocable: true
allowed-tools: Bash
---

# Version

Role: worker. Purely mechanical lookup.

You have been invoked with the `/version` command. Arguments: none.

Run and report the single output line verbatim:

```bash
node -e 'const p=require(process.env.CLAUDE_PLUGIN_ROOT+"/package.json");const u=require(process.env.CLAUDE_PLUGIN_ROOT+"/UPSTREAM.json");console.log(`${p.name} v${p.version} (upstream dev-team v${u.version} @ ${String(u.commit).slice(0,10)})`)'
```

If `CLAUDE_PLUGIN_ROOT` is unset, report exactly:
`pi-dev-team extension is not loaded in this session.`

Do not add commentary beyond the single result line.
