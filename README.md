# WMS365 Scanner

Shared, login-free inventory scanner for desktop and mobile.

## What Changed

- The frontend is still a single responsive HTML app.
- Shared inventory and activity now live on the server.
- The open scan batch and last location stay local in the browser until you save the batch.
- The backend is an Express API that stores data in PostgreSQL, which makes it a good fit for Railway.

## Railway Setup

1. Create a Railway project for this app.
2. Add a PostgreSQL database to the project.
3. Expose the database connection string to the app service as `DATABASE_PRIVATE_URL` or `DATABASE_URL`.
4. Deploy this folder as a Node service.
5. Start command: `npm start`

The server listens on Railway's `PORT` value automatically.

## Local Run

1. Install dependencies with `npm install`
2. Set `DATABASE_URL` to a PostgreSQL database
3. Run `npm start`

## Android Count App

The dedicated Android wrapper lives in `android-app/`. Open that folder in Android Studio, set `WMS365_BASE_URL` in `android-app/gradle.properties`, and run the `app` configuration on a device or emulator. It opens the hosted WMS365 mobile workspace at `/mobile`, so normal mobile web updates are picked up after deployment. The inventory count screen uses device WebView storage plus an IndexedDB offline queue, so counts saved during connectivity issues stay on the device and sync when the connection returns.

## Shared Data Model

- Shared on the server:
  - inventory
  - activity history
- Local in the browser:
  - open batch before submit
  - last used location

## Main Files

- `index.html`: responsive frontend
- `server.js`: Express + PostgreSQL API
- `package.json`: scripts and dependencies
"# wms365Scanner" 
"# wms365Scanner" 
