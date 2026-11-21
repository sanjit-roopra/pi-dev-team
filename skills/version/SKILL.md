---
name: version
description: >-
  Report the installed version of the pi-dev-team package.
user-invocable: true
allowed-tools: Bash
---

# Version

Role: worker. Purely mechanical lookup.

You have been invoked with the `/version` command. Arguments: none.

Run and report the single output line verbatim:

```bash
node -e 'const p=require(process.env.DEV_TEAM_ROOT+"/package.json");console.log(`${p.name} v${p.version}`)'
```

If `DEV_TEAM_ROOT` is unset, report exactly:
`pi-dev-team extension is not loaded in this session.`

Do not add commentary beyond the single result line.
