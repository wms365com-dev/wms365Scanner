# Google Search Console Setup

Use this checklist after uploading the public marketing site to Bluehost.

## Best verification method

Use a **Domain property** for `wms365.co` in Google Search Console.

Why:
- it covers `wms365.co`
- it covers `www.wms365.co`
- it keeps ownership tied to DNS instead of one uploaded HTML file

Google's verification guidance:
- [Verify your site ownership](https://support.google.com/webmasters/answer/9008080?hl=en)
- [Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)

## DNS verification steps

1. Open [Google Search Console](https://search.google.com/search-console/about).
2. Add a new property.
3. Choose **Domain**.
4. Enter `wms365.co`.
5. Google will give you a TXT record.
6. Add that TXT record in your DNS provider for `wms365.co`.
7. Wait for DNS propagation, then click **Verify** in Search Console.
8. Leave the TXT record in place after verification succeeds.

## Alternate verification method

If you prefer, you can verify `https://wms365.co/` as a URL-prefix property by uploading Google's HTML verification file to the root of `public_html`.

Important:
- the file name and file contents must stay exactly as Google gives them
- the file must be reachable directly at the site root
- do not rename it
- do not put it behind login
- do not redirect it

Example:
- if Google gives you `google1234567890abcdef.html`
- it must load at `https://wms365.co/google1234567890abcdef.html`

You cannot prebuild this file in the repo because Google creates a unique token for the account doing the verification.

## Sitemap submission

After verification:

1. Open the `wms365.co` property in Search Console.
2. Go to **Sitemaps**.
3. Submit:
   - `https://wms365.co/sitemap.xml`

Current sitemap coverage:
- `https://wms365.co/`
- `https://wms365.co/pricing`
- `https://wms365.co/industries`
- `https://wms365.co/integrations`
- `https://wms365.co/implementation`
- `https://wms365.co/book-demo`
- `https://wms365.co/3pl-warehouse-management-software`
- `https://wms365.co/shopify-warehouse-management-software`
- `https://wms365.co/lot-tracking-expiration-date-inventory-software`
- `https://wms365.co/customer-portal-for-3pl-warehouses`
- `https://wms365.co/sftp-warehouse-integration-software`

## Public files that should stay at the site root

- `index.html`
- `pricing.html`
- `industries.html`
- `integrations.html`
- `implementation.html`
- `book-demo.html`
- `3pl-warehouse-management-software.html`
- `shopify-warehouse-management-software.html`
- `lot-tracking-expiration-date-inventory-software.html`
- `customer-portal-for-3pl-warehouses.html`
- `sftp-warehouse-integration-software.html`
- `marketing.css`
- `marketing.js`
- `marketing-logo.svg`
- `site.webmanifest`
- `robots.txt`
- `sitemap.xml`

## What not to submit for indexing

Do not index the app host or private software routes:
- `https://app.wms365.co/login`
- `https://app.wms365.co/portal`
- `https://app.wms365.co/desktop`

Those app pages are intentionally not part of the public organic search strategy.

## First indexing requests

After the site is live, use URL Inspection in Search Console and request indexing for:
- `https://wms365.co/`
- `https://wms365.co/pricing`
- `https://wms365.co/industries`
- `https://wms365.co/integrations`
- `https://wms365.co/implementation`
- `https://wms365.co/book-demo`
- `https://wms365.co/3pl-warehouse-management-software`
- `https://wms365.co/shopify-warehouse-management-software`
- `https://wms365.co/lot-tracking-expiration-date-inventory-software`
- `https://wms365.co/customer-portal-for-3pl-warehouses`
- `https://wms365.co/sftp-warehouse-integration-software`

## Organic SEO next steps

The technical base is now in place, but long-term organic growth will come from more crawlable content. The next best pages to add are:
- industry-specific landing pages
- customer stories
- implementation guides
- warehouse billing pages
- lot tracking and expiry control pages
- Shopify fulfillment and SFTP integration guides
