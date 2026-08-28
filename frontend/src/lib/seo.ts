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
}

export const SITE_ORIGIN = 'https://bansi1701.github.io/ProjectPDF';

export const canonical = (path = '/'): string => {
  const localPath = path
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/?ProjectPDF\/?/, '')
    .replace(/^\/+/, '');
  const [pathAndQuery, hash] = localPath.split('#', 2);
  const [pathname, query] = pathAndQuery.split('?', 2);
  const cleanPath = pathname.replace(/\/+$/, '');
  const isFile = /\.[a-z0-9]+$/i.test(cleanPath);
  const suffix = cleanPath ? `${cleanPath}${isFile ? '' : '/'}` : '';
  const search = query ? `?${query}` : '';
  const fragment = hash ? `#${hash}` : '';
  return `${SITE_ORIGIN}/${suffix}${search}${fragment}`;
};

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
  about: {
    '@type': 'Thing',
    name: article.about,
  },
  author: {
    '@type': 'Organization',
    name: SITE.name,
    url: `${SITE_ORIGIN}/`,
  },
  publisher: {
    '@type': 'Organization',
    name: SITE.name,
    url: `${SITE_ORIGIN}/`,
  },
});

export const helpCollectionLd = (items: Array<{ name: string; path: string }>) => ({
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: 'ProjectPDF Help Center',
  description: 'Step-by-step guides and answers for every ProjectPDF tool.',
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

export const websiteLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE.name,
  url: `${SITE_ORIGIN}/`,
  potentialAction: {
    '@type': 'SearchAction',
    target: {
      '@type': 'EntryPoint',
      urlTemplate: `${SITE_ORIGIN}/?q={search_term_string}`,
    },
    'query-input': 'required name=search_term_string',
  },
});
