# Privacy collection standard — Ontario operator, worldwide visitors

Reviewed September 10, 2026. Owner-confirmed operating location: Ontario, Canada.
Public operator/contact remain **Filozy** and **admin.filozy@gmail.com**.

This is an engineering release standard, not a legal opinion or certification
for every country. Privacy laws generally constrain collection; they do not
require collecting visitor analytics to earn advertising revenue. Consent does
not make an otherwise prohibited, unnecessary or unfair use lawful.

## Current facts and launch blocker

- Document processing stays in the browser. No customer documents, filenames,
  document passwords, OCR text or signature data may become analytics/ad events.
- AdSense is verification-only. No ad loader or certified CMP is installed.
- The September 10 live delivery of filozy.com includes a Cloudflare Web Analytics
  beacon, injected by the host rather than the application's source. It runs
  independently of AdSense and has not been verified as consent-controlled.
- The updated public notice discloses this current measurement. Disclosure is
  **not** proof of consent or an exemption. Do not mark the worldwide launch ready.
- Automatic injection must be replaced with a reviewed consent-controlled setup,
  or removed pending review. This requires the owner's Cloudflare configuration.
  Turning off automatic injection is not a permanent ban on analytics: a reviewed
  manual integration can run after the appropriate permission. Do not disable
  Cloudflare security protections or use broad `no-transform` as a shortcut.

## Purpose-specific default

| Purpose | Release rule |
| --- | --- |
| Deliver files and protect the service | Minimise ordinary connection/security data; document purpose, provider, retention and applicable lawful basis. Do not relabel optional measurement as essential. |
| User-requested local preferences and workflows | Keep existing local-only handling, expiry and clear-data controls; no advertising reuse. |
| Website measurement | Separate analytics choice. Conservative default: no optional analytics until valid permission. Any consent exemption needs a documented provider/configuration and legal review, not just a country code or the word “cookieless”. |
| Advertising | Separate advertising permission, Google-certified CMP where required, reviewed vendor/purpose list, applicable opt-outs and explicit owner activation. Remains disabled now. |
| Email marketing | Not enabled. Assess Canada's CASL and destination rules separately before collecting subscribers or sending promotions. |

## Regional review matrix

| Visitors / operation | Requirements to assess before collection |
| --- | --- |
| Ontario / Canadian commercial activity | PIPEDA: accountability, identified purposes, meaningful consent where required, minimum collection, limited retention, safeguards, access/correction and complaints. Cross-border commercial handling is also in scope. Review provincial rules where applicable. |
| EEA | Assess GDPR territorial scope (including targeting services or monitoring behaviour) and national ePrivacy rules. Prior consent is the default for non-exempt device access; assess GDPR legal basis, transfers, rights, contracts and representation separately. |
| UK | Assess UK GDPR and current PECR storage/access guidance. A statistical-purpose exception has conditions and an objection mechanism; it is not an advertising exception or a universal analytics exemption. Use opt-in unless the exact exception is reviewed. |
| Switzerland | Review Swiss data protection/cookie duties and Google's separate consent requirements. Do not equate Google policy with the complete local law. |
| US | Assess each applicable state's scope/thresholds, disclosures, sale/sharing/targeted-advertising opt-outs, appeals and applicable universal opt-out signals. Honour GPC in the relevant consent/ad integration. Children's and sensitive-data rules can require more than an opt-out. “US” is not permission to track everyone. |
| Other countries or unknown location | No automatic collection allowlist. Keep optional processing off until reviewed purpose-specific permission and other applicable requirements are satisfied. If the market cannot be supported lawfully, do not activate that processing there. |

Geo-location is only a routing aid, not a legal determination. Do not infer
permission from language, time zone, a VPN or a missing country. A future routing
service should use minimum coarse location, avoid retaining raw IP addresses for
analytics, and fail closed when consent, vendor readiness or region is unknown.
Never request GPS or fingerprint a browser to determine privacy permissions.

## Consent integration acceptance criteria — not yet implemented

1. Prominent Accept, Reject and Manage controls; analytics and ads separately
   selectable; no optional preselection or consent inferred from scrolling.
2. Usable tools after rejection; persistent privacy choices and easy withdrawal.
3. Reviewed certified CMP/vendor APIs, not a home-made checkbox used as a TCF
   substitute. A European AdSense message alone is not a worldwide consent system.
4. Honour applicable GPC/GPP opt-outs without treating a general Accept click as
   automatic permission to override them. CMP unavailable/stale/error means off.
5. Separate informational advertising pages from document workspaces. No ad
   scripts in document preview/edit/upload/processing/download routes.
6. Minimise metrics to reviewed aggregate usage/performance. Do not transmit raw
   query strings, fragments, identifying URLs, document data or user identifiers.
7. Record the actual data, recipients, subprocessors, retention/deletion, transfer
   arrangements, consent evidence and security controls. Confirm contracts and
   actual dashboard settings; do not invent storage locations or retention periods.
8. Use synthetic files and non-serving ads tests: fresh visit, reject, accept only
   analytics, accept only ads, withdraw, expired consent, GPC, unknown region,
   CMP/network failure, mobile and representative regions. Inspect actual requests
   and storage. Never click live ads or generate test advertising impressions.
9. Owner confirms applicable business identity, privacy responsibility, monitored
   mailbox and request/breach procedure. Review local counsel requirements for
   targeted markets; no claim of worldwide immunity or zero legal risk.

## Delivery checks

`audit-ad-readiness.mjs` rejects unreviewed optional runtime in built HTML/JS.
`audit-live-delivery.mjs` verifies the exact deployed revision, core pages, seller
record, disclosures and observed external tags. It reports the known host beacon
as a **warning**, not as approved or consent-compliant. Use
`--require-no-analytics` to fail while the automatic beacon remains.

Run with `SITE_ORIGIN=https://filozy.com` and `PUBLIC_BUILD_ID` equal to the full
deployed commit. These checks are not a browser egress test and cannot establish
global legal compliance or validate a third-party script's internal behaviour.

## Official sources

- [OPC: PIPEDA scope and responsibilities](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda_brief/)
- [OPC: meaningful consent](https://www.priv.gc.ca/en/privacy-topics/privacy-for-businesses/appropriate-handling-of-personal-information/collecting-personal-information-and-consent/consent/gl_omc_201805/)
- [EU GDPR, including Articles 3, 5, 6, 7, 12–22 and 44 onwards](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679)
- [ICO: current storage/access exceptions](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/)
- [California regulator: privacy rights and GPC](https://cppa.ca.gov/faq.html)
- [Google: European certified CMP requirements](https://support.google.com/adsense/answer/13554116?hl=en)
- [Google: US state messages and GPP](https://support.google.com/adsense/answer/10961479?hl=en)
- [Cloudflare: analytics data categories](https://developers.cloudflare.com/web-analytics/data-metrics/dimensions/)
- [Cloudflare: automatic injection controls](https://developers.cloudflare.com/web-analytics/get-started/)

Recheck sources and account settings before activation and after material changes.
