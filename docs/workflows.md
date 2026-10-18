# Workflows

These recipes use the tools directly or through the built-in prompts (`seo_audit`, `brand_presence`,
`post_to_social`, `fill_form`). All of them follow the same safety rules: CAPTCHAs go to the person
(`ask_human`), irreversible actions need a clear yes, and passwords or payment details are typed by the person.

## Website SEO check

1. `seo_site_check` on the origin: robots.txt, sitemap, llms.txt, HTTPS, HSTS.
2. `tabs_open_many` with the pages to audit, then one `batch` of `seo_audit` calls (one per tab).
3. `get_links` per page, then `check_links` on the internal hrefs for broken links and redirect chains.
4. `screenshot` each page to catch visual problems the HTML does not show.
5. Report issues per page with the fix. Close the tabs you opened.

## Brand presence

1. `tabs_open_many` (background): branded Google searches, Maps, reviews, and each social platform's search or profile page.
2. `batch` of `get_text` or `screenshot` over those tabs.
3. Summarise official profiles, follower counts, recent activity, review scores, and mismatches in name, address or phone.
   Read only: no following, liking or posting.

## Posting content to social media

1. Open each platform in its own tab. If a login is needed, the person logs in on the page.
2. `read_page` to find the composer, `type` the text, `upload_file` for media.
3. `screenshot` the filled composer and show it in chat. Wait for an explicit yes.
4. Click Post. With approvals on, the browser also asks the person to allow the click.
5. Verify the post appeared and report its URL.

Different platforms can be prepared in parallel tabs; keep the final Post step one at a time.

## Filling forms

1. `read_page` to list the fields, map the data, `fill_form`.
2. `screenshot` and show the result; wait for a yes before submitting.
3. The person types passwords, payment details and one-time codes themselves.

## When a CAPTCHA appears

The tab locks automatically and replies carry an ALERTS note. Call `ask_human` with `kind: "captcha"`.
The tab comes to the front with a prompt; the person solves the challenge and presses Done. Work then resumes.

## Monitoring a long task

Call `events` with the previous `latest` value to see new tabs, popups, dialogs, downloads, HTTP errors and CAPTCHAs
across the whole browser since your last check. `handle_dialog` clears a blocking alert or confirm.
