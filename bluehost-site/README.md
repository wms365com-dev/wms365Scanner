# Bluehost Upload Folder

Upload the contents of this folder to `public_html` on Bluehost.

Files in this folder:
- `index.html`
- `integrations.html`
- `implementation.html`
- `3pl-warehouse-management-software.html`
- `shopify-warehouse-management-software.html`
- `lot-tracking-expiration-date-inventory-software.html`
- `customer-portal-for-3pl-warehouses.html`
- `sftp-warehouse-integration-software.html`
- `pricing.html`
- `industries.html`
- `book-demo.html`
- `marketing.css`
- `marketing.js`
- `marketing-logo.svg`
- `site.webmanifest`
- `hero-warehouse-scene.svg`
- `industry-3pl-scene.svg`
- `industry-ecommerce-scene.svg`
- `industry-lot-control-scene.svg`
- `robots.txt`
- `sitemap.xml`
- `.htaccess`
- `GOOGLE_SEARCH_CONSOLE_SETUP.md`

Notes:
- `wms365.co` and `www.wms365.co` should stay on Bluehost.
- `app.wms365.co` should stay on Railway.
- The public pages already point login and portal traffic to `https://app.wms365.co`.
- The demo form and Stripe checkout use the Railway app/API endpoint configured in the page metadata.
- `marketing-logo.svg` is also used as the favicon source by the public pages.
- For Google Search Console:
  - preferred method: verify the domain with a DNS TXT record
  - alternate method: upload Google's exact HTML verification file to `public_html`
  - then submit `https://wms365.co/sitemap.xml`
  - follow the full checklist in `GOOGLE_SEARCH_CONSOLE_SETUP.md`
