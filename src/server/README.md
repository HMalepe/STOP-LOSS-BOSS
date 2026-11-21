# src/server: application services
- env, logging, auth, audit, kill switch, plans (preview → execute), presets. Route handlers in `src/app/api` stay thin and call into here.
