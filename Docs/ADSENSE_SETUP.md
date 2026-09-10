# AdSense setup — disabled pending consent

Owner decision, September 9, 2026: keep ads disabled until consent setup is ready.

September 10 update: the owner confirmed an **Ontario, Canada** operation serving
worldwide visitors and wants useful measurement only as applicable law permits.
Follow [PRIVACY_COLLECTION_STANDARD.md](PRIVACY_COLLECTION_STANDARD.md).
The actual app is now served at `https://filozy.com` through Cloudflare Pages;
the root seller record is reachable and the latest policies are delivered.
Cloudflare still injects Web Analytics automatically. This is not yet verified
as consent-controlled; it is a launch blocker, not an AdSense dependency.
No ads have been enabled and no worldwide compliance claim is made.

Publisher: `ca-pub-6531092487237731` (public identifier, not a secret).

The shared HTML head contains Google's verification meta tag on every page. It does not load a script, send a request to Google, or display ads. Choose the **meta tag** verification method in AdSense. Approval remains Google's decision.

The owner-supplied activation snippet is recorded below, **not inserted into live pages**:

```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6531092487237731" crossorigin="anonymous"></script>
```

Before activation:

1. Maintain the owner-approved public operator/contact: **Filozy**, **admin.filozy@gmail.com**. Both are included in Privacy and Terms. Confirm the inbox is monitored and establish a procedure for handling requests privately. Filozy is the requested public brand name; review whether applicable law requires additional legal-operator identification before claiming compliance.
2. Configure and publish an appropriate Google-certified CMP, with explicit choices, withdrawal, vendor disclosures and global defaults matching the owner's privacy-first policy. A home-made consent checkbox is not a substitute for Google's requirements.
3. Review the applicable consent requirements and Google's publisher policies. Non-personalized or limited ads do not automatically mean no storage or no consent requirements.
4. Update the public privacy policy and the first-party network/storage audits to describe actual enabled processing, rather than weakening those checks.
5. Keep the PDF workspace free of intrusive ads; assess third-party script access to the document environment before enabling scripts on processing routes. Never send PDF content, filenames, passwords or recognized text as ad data.
6. Test clean-browser, reject, accept, withdrawal, GPC and mobile flows. Verify there are no ad requests before the configured permission, no content shifts covering controls, and no ads in exported files.
7. Obtain explicit activation approval. Do not add a bypass flag that silently enables ads before the prerequisites are met.

Primary references checked September 9, 2026:

- [Google: connect a site using an AdSense meta tag](https://support.google.com/adsense/answer/7584263?hl=en-GB)
- [Google: publisher consent-management requirements](https://support.google.com/adsense/answer/13554116?hl=en-GB)
- [Google EU user consent policy](https://www.google.com/about/company/user-consent-policy/)

These notes are an implementation checklist, not a worldwide legal-compliance certification.

## Historical account and domain findings — September 9

Observed on September 9, 2026; domain findings below are superseded by the
September 10 update above. They are not the current deployment status:

- The account's registered site is `filozy.com`, marked **Requires review**. Ownership verification and site review have not been submitted during this audit.
- `https://filozy.com/` currently serves GoDaddy's **Launching Soon** page, not this app. The app is still at `https://bansi1701.github.io/ProjectPDF/`.
- AdSense showed **Ads.txt: Not found**. The exact seller record from the account has now been added to `frontend/public/ads.txt`. On the present project-site deployment it is at `/ProjectPDF/ads.txt`, not the custom domain's root; this alone cannot resolve the registered domain's warning.
- A European consent-message preview was edited but **not saved or published**. Site selection and vendor/purpose review remain incomplete. Do not treat that preview as an installed CMP.
- DNS was not changed. The owner is asking a colleague to handle the connection.
- Private account, payment and identity verification requirements must be completed by the owner when Google requests them. Existing payment details are not proof of final payment eligibility.

## Release readiness and remaining decisions

| Area | Current implementation / required next action |
| --- | --- |
| Ownership and review | Custom domain now serves the app and root seller record; verification meta on every page. Confirm the current AdSense review/approval status in the account. |
| Account eligibility | Owner must confirm age, eligible account/location, identity, tax and payment requirements. The site code cannot certify these. |
| Privacy | Current no-ad processing, hosting requests, preferences and temporary workflow storage are disclosed. The owner approved Filozy and admin.filozy@gmail.com for public contact. Review legal-operator identification, additional processing/disclosures and the response procedure before activating advertising. Do not claim the policy is legally complete. |
| Consent | Ads do not run; Cloudflare injects analytics independently. Review/replace automatic injection before a consent-controlled launch. Review a certified CMP, separate analytics/ad choices, withdrawal, vendor/purpose descriptions, applicable US opt-outs/GPC and regional obligations. Use a conservative global opt-in default unless an exact exemption is reviewed. |
| Limited ads | Do not assume limited/non-personalized ads avoid consent or storage obligations. The draft's revenue-based consent optimization was switched off; that edit is unpublished. |
| Content and copyright | Public engine/font notices added and comparison claims qualified. Keep original writing, illustrations and evidence for asset rights. No comprehensive external plagiarism, trademark clearance or legal copyright opinion was performed. |
| Help quality | Existing tool guides and detailed articles are retained; inaccurate Split instructions corrected. Repeated generic FAQ templates need continued human editorial review and more tool-specific examples. No arbitrary word count guarantees approval. |
| Ad placement | Keep document previews, editing, upload, processing, error and download controls ad-free. If ads are approved later, start with manually reviewed informational pages; do not auto-insert ads across all tool routes. |
| User documents | Never pass file contents, filenames, passwords, OCR text or financial/medical details to advertising services. A third-party script on the workspace origin needs a separate security review. |
| Invalid traffic | Never click your own live ads, ask users to click ads, buy incentivized traffic or run test automation against live ad inventory. Use non-ad test environments. |
| Technical quality | Build, broken-link, metadata, typography, source-storage and verification-only checks run. An automated pass is not a guarantee for every device, file or future change. |
| Hosting terms | GitHub Pages restricts online-business/commercial-SaaS hosting. Monetizing this utility creates a material suitability risk; confirm permission with GitHub or choose suitable hosting before ad activation. A custom domain does not change the host's terms. |

## Colleague handoff — domain connection

The newer main-branch commits `54f0bec` and `2579f30` select **Cloudflare Pages** as the intended host. Follow [DEPLOYMENT.md](DEPLOYMENT.md) for that setup, with `SITE_ORIGIN=https://filozy.com` in **Cloudflare's** production environment. Do not set it on the GitHub Pages spare deployment. This source update does not prove the Cloudflare project or domain is connected; verify the actual dashboard and HTTPS site.

**Resolve hosting suitability before the monetized launch.** Keep this repository as the source of truth even if the production host changes. Do not buy hosting or change DNS without the owner's decision.

The steps below are an alternative **only if GitHub Pages is explicitly chosen** as an approved temporary/non-commercial custom-domain host. Do not use these DNS records for the intended Cloudflare deployment:

1. Sign in as an authorized repository owner. Verify `filozy.com` with GitHub before pointing DNS at it; use the verification value GitHub actually provides.
2. In repository Settings → Pages, save the custom domain `filozy.com`. A CNAME file alone does not configure an Actions-based custom domain.
3. In Settings → Secrets and variables → Actions → Variables, set `SITE_ORIGIN` to `https://filozy.com` and coordinate the rebuild with DNS cutover. This repository uses that value to change the base path, links, canonical URLs and sitemap from `/ProjectPDF/` to `/`.
4. At the DNS provider, replace only conflicting web-hosting records for the apex with GitHub's documented A records: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`. Set `www` CNAME to `bansi1701.github.io` (no repository path). Preserve mail/MX, SPF, DKIM and unrelated verification records. Do not add a wildcard.
5. Wait for DNS and the HTTPS certificate, enforce HTTPS when available, and verify both apex and www resolve to the intended site. Do not bypass certificate warnings.
6. Verify the homepage, a tool upload/export, privacy page, assets, canonical URLs and `https://filozy.com/ads.txt`. The seller file must show exactly `google.com, pub-6531092487237731, DIRECT, f08c47fec0942fa0`.
7. Only after the real site is live, return to AdSense's meta-tag verification and site review. Keep the ad script disabled until the consent/hosting blockers are resolved and the owner explicitly approves activation.

If a different host is selected, use that host's current DNS instructions instead; update the privacy hosting disclosure and build `SITE_ORIGIN` for the real domain. Do not reuse GitHub's IP addresses.

## Additional primary references

- [AdSense eligibility](https://support.google.com/adsense/answer/9724?hl=en)
- [AdSense program policies and invalid traffic](https://support.google.com/adsense/answer/48182?hl=en)
- [Google publisher policies](https://support.google.com/adsense/answer/10502938?hl=en)
- [Google replicated-content policy](https://support.google.com/publisherpolicies/answer/11190248?hl=en)
- [Required advertising privacy disclosures](https://support.google.com/adsense/answer/1348695?hl=en)
- [Ads.txt root-domain crawling](https://support.google.com/adsense/answer/7679060?hl=en)
- [GitHub Pages usage restrictions](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [GitHub custom-domain setup](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [ICO: privacy information to provide](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-privacy-information-should-we-provide/)

Check these sources again before activation: policies and account screens can change. Cookie consent alone does not establish compliance with all privacy, consumer, advertising, accessibility, copyright or local business laws.

## Controlled activation after the owner confirms the domain

The requested one-step experience means one coordinated release after the prerequisites are verified, not a switch that bypasses consent or Google's review. The site currently has no ad-activation flag and cannot accidentally turn on because DNS changes.

1. Verify Cloudflare deployment, domain/HTTPS, root ads.txt, verification tag, privacy host disclosure and an actual tool export. Inspect the delivered page's requests/cookies as well as the built files: do not enable optional host-injected analytics, tag managers or tracking without reviewing the consent and disclosure requirements.
2. Review the external policy for the enabled processing and confirm the contact inbox is monitored. The owner chose Filozy as the public operator name and approved admin.filozy@gmail.com after being told the email will be visible on the website. Review whether more legal identification is needed; do not publish a personal name or substitute a private email without permission.
3. Finish the real domain's certified CMP configuration: actual vendor/purpose list, prominent rejection, user-accessible withdrawal, applicable regional settings and the stricter global opt-in behavior. Publish only after owner approval. An unpublished European-message preview is not a global consent system.
4. Confirm AdSense site approval and any owner-only account checks. Never submit identity or tax information on the owner's behalf without explicit authority.
5. Prepare and review the minimal ad-loader integration on approved informational pages only; update the current verification-only guard deliberately. Test it in a non-serving environment first. Obtain explicit activation confirmation, then release and verify reject/accept/withdrawal behavior and mobile placement.
6. If verification fails, leave ads off. If activation later regresses, remove the loader and deploy the verification-only configuration; do not leave a privacy failure live.

Domain confirmation is the cue to run this checklist. Google review and private account checks cannot be automated away or promised as a literal one-click approval.
