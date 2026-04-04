# aocr hooks

This is the hooks server that also has the reaper for **aocr**.

The webhooks from the registry are terminated in [src/controllers/HookAPI.ts](https://github.com/aerol-ai/aocr/blob/master/hooks/src/controllers/HookAPI.ts). The reaper runs on a cron and executes [src/commands/reap.ts](https://github.com/aerol-ai/aocr/blob/master/hooks/src/commands/reap.ts), deleting older tags so each repository keeps its newest image.


