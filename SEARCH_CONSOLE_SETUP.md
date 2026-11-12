# WMS365 Search Console Setup

Use this checklist when connecting `https://wms365.co` to Google Search Console.

## What is already in the site package

The public site already includes:

- `robots.txt`
- `sitemap.xml`
- canonical URLs on the public pages
- structured data on the marketing pages
- a crawlable favicon reference using `marketing-logo.svg`

## Recommended property type

Use a **Domain property** in Google Search Console if possible.

Why:

- it covers `wms365.co` and `www.wms365.co`
- verification is done once at the DNS level
- it avoids having to upload a special HTML file to Bluehost

## Domain property verification

1. Open Google Search Console and add `wms365.co` as a **Domain property**.
2. Google will give you a DNS TXT record.
3. Add that TXT record where your DNS is managed.
4. Wait for DNS to propagate, then click **Verify** in Search Console.

## URL-prefix property alternative

If you use a **URL-prefix property** instead:

1. Add `https://wms365.co` in Search Console.
2. Choose **HTML file upload**.
3. Download the exact verification file Google gives you.
4. Upload that file to Bluehost `public_html` with the original file name and content unchanged.
5. Confirm it opens directly in the browser at the exact URL Google shows.
6. Click **Verify** in Search Console.

Important:

- Do not rename the Google verification file.
- Do not change its contents.
- Do not rely on redirects for that verification file.

## After verification

1. Submit `https://wms365.co/sitemap.xml`
2. Inspect and request indexing for:
   - `https://wms365.co/`
   - `https://wms365.co/pricing`
   - `https://wms365.co/industries`
   - `https://wms365.co/integrations`
   - `https://wms365.co/implementation`
   - `https://wms365.co/book-demo`
3. Check the Page Indexing report for crawl or canonical issues.
4. Check the Enhancements / structured data reports after Google crawls the pages.

## Hosting note

- `wms365.co` and `www.wms365.co` are the public SEO property.
- `app.wms365.co` is the software app and should stay out of the public index.
