# ZANOX — Developer Handoff

This archive contains the ZANOX Expo/React Native/TypeScript project and its Express/tRPC backend, prepared for continued coding by another AI coding assistant or developer.

## Stack
- Expo SDK 57 / React Native / TypeScript
- Expo Router, NativeWind
- Express + tRPC
- Drizzle ORM with MySQL
- Manus Service API for LLM and speech
- EAS Android APK profile

## Local setup
```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test -- --run
pnpm build
pnpm exec expo start
```

## Android APK
```bash
eas build --platform android --profile preview
```
The Expo project ID is `f3311d35-0e7e-47e3-ae85-9677b4ead287`. Use your own secure Expo login/token; no token is included.

## Security
No API keys, database passwords, Expo tokens, private keys, `.env` files, Git history, node_modules, or generated build outputs are included. External credentials must remain in server-side secret configuration. `EXTERNAL_DB_SECRET` is a protected reference only. Root Manager uses a reviewed Patch workflow and does not provide unrestricted production Shell access or display secrets.

## Main files
- `app/owner.tsx`: owner command center, Root Manager, integrations UI
- `server/routers.ts`: tRPC procedures and authorization
- `server/db.ts`: database operations
- `server/external-connectors.ts`: safe MySQL/PostgreSQL/Supabase/REST tests
- `app.config.ts`: Expo and ZANOX configuration
- `eas.json`: APK build profile
- `TODO.md`: implementation status

## Existing deployment
https://aihub-c4easfzt.manus.space
