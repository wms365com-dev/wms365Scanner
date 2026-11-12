# WMS365 Marketing Site

This folder is the clean public marketing package for promoting WMS365 on `wms365.co`.

Use this folder for Bluehost/static-site deployment work. The warehouse application remains hosted separately on Railway at `https://app.wms365.co`.

Key files:
- `index.html`: public landing page.
- `pricing.html`: pricing, Stripe checkout lead capture, add-ons, and Grey Wolf 3PL no-charge note.
- `integrations.html`: marketplace and integration messaging.
- `marketing.css`: public site styling.
- `marketing.js`: demo form, Stripe checkout, and build-label helpers.
- `robots.txt`, `sitemap.xml`, `site.webmanifest`: SEO and browser metadata files.

Operational note:
- Keep app-only files such as `index.html` for the warehouse app, `portal.html`, `login.html`, and `server.js` in the project root/Railway app.
- Keep public sales and SEO pages in this `marketing` folder when preparing Bluehost uploads.
