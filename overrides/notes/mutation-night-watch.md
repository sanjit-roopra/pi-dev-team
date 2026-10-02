## pi port notes

- Where this skill schedules or runs `claude --print`, use `pi --mode json -p --no-session` (or the port's `claude` shim, which is on `PATH` inside pi sessions but not in cron). In a cron entry call `pi` directly.
