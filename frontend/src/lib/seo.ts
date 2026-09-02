import { SITE } from '../config/site';

export interface HowToStep {
  name: string;
  text: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface BreadcrumbItem {
  name: string;
  url: string;
}

export interface ArticleItem {
  headline: string;
  description: string;
  path: string;
  keywords: string[];
  about: string;
  /** ISO date; omitted for pages whose date is not a meaningful signal. */
  dateModified?: string;
}

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, '');

/**
 * Where the site is deployed, base path included: "https://hatepdf.com" or
 * "https://bansi1701.github.io/ProjectPDF".
 *
 * Both halves come from astro.config, which reads SITE_ORIGIN, so moving to a
 * custom domain is one environment variable — not a hunt through canonicals,
 * robots, sitemaps and schema for a hardcoded host.
 */
export const SITE_HOST = (import.meta.env.SITE ?? 'https://bansi1701.github.io').replace(/\/+$/, '');
export const BASE_PATH = trimSlashes(import.meta.env.BASE_URL ?? '/');
export const SITE_ORIGIN = BASE_PATH ? `${SITE_HOST}/${BASE_PATH}` : SITE_HOST;

export const canonical = (path = '/'): string => {
  let localPath = path.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
  if (BASE_PATH && (localPath === BASE_PATH || localPath.startsWith(`${BASE_PATH}/`))) {
    localPath = localPath.slice(BASE_PATH.length).replace(/^\/+/, '');
  }
  const [pathAndQuery, hash] = localPath.split('#', 2);
  const [pathname, query] = pathAndQuery.split('?', 2);
  const cleanPath = pathname.replace(/\/+$/, '');
  const isFile = /\.[a-z0-9]+$/i.test(cleanPath);
  const suffix = cleanPath ? `${cleanPath}${isFile ? '' : '/'}` : '';
  const search = query ? `?${query}` : '';
  const fragment = hash ? `#${hash}` : '';
  return `${SITE_ORIGIN}/${suffix}${search}${fragment}`;
};

const organizationRef = () => ({ '@id': `${SITE_ORIGIN}/#organization` });

/** The one entity every other schema points back to. Emitted on the homepage. */
export const organizationLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${SITE_ORIGIN}/#organization`,
  name: SITE.name,
  url: `${SITE_ORIGIN}/`,
  logo: canonical('/brand/pdfcraft-fold-mark.png'),
  description: SITE.description,
  sameAs: ['https://github.com/Bansi1701/ProjectPDF'],
});

export const softwareAppLd = (name: string, description: string, path: string) => ({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name,
  description,
  url: canonical(path),
  applicationCategory: 'UtilitiesApplication',
  operatingSystem: 'Any modern web browser',
  browserRequirements: 'JavaScript enabled; no account required',
  permissions: 'none',
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  featureList: ['Runs in the browser', 'No file upload', 'No account required'],
  publisher: organizationRef(),
});

export const howToLd = (name: string, steps: HowToStep[]) => ({
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name,
  step: steps.map((step, index) => ({
    '@type': 'HowToStep',
    position: index + 1,
    name: step.name,
    text: step.text,
  })),
});

export const faqLd = (faqs: FaqItem[]) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map((faq) => ({
    '@type': 'Question',
    name: faq.question,
    acceptedAnswer: { '@type': 'Answer', text: faq.answer },
  })),
});

export const breadcrumbLd = (items: BreadcrumbItem[]) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map((item, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: item.name,
    item: canonical(item.url),
  })),
});

export const articleLd = (article: ArticleItem) => ({
  '@context': 'https://schema.org',
  '@type': 'TechArticle',
  headline: article.headline,
  description: article.description,
  url: canonical(article.path),
  mainEntityOfPage: canonical(article.path),
  inLanguage: 'en',
  isAccessibleForFree: true,
  keywords: article.keywords.join(', '),
  ...(article.dateModified ? { dateModified: article.dateModified, datePublished: article.dateModified } : {}),
  about: {
    '@type': 'Thing',
    name: article.about,
  },
  author: organizationRef(),
  publisher: organizationRef(),
});

export const helpCollectionLd = (items: Array<{ name: string; path: string }>) => ({
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: 'HatePDF Help Center',
  description: 'Step-by-step guides and answers for every HatePDF tool.',
  url: canonical('/help/'),
  mainEntity: {
    '@type': 'ItemList',
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      url: canonical(item.path),
    })),
  },
});

/* No SearchAction: the site has no ?q= handler, and a sitelinks search box
   that leads nowhere is worse for trust than none. */
export const websiteLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': `${SITE_ORIGIN}/#website`,
  name: SITE.name,
  url: `${SITE_ORIGIN}/`,
  description: SITE.description,
  inLanguage: 'en',
  publisher: organizationRef(),
});
