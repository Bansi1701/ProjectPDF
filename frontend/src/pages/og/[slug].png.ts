import type { APIRoute, GetStaticPaths } from 'astro';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

import { SITE, TOOLS } from '../../config/site';

interface OgProps {
  name: string;
  description: string;
}

interface TreeNode {
  type: string;
  props: Record<string, unknown>;
}

const node = (type: string, style: Record<string, unknown>, children: TreeNode[] | string): TreeNode => ({
  type,
  props: { style, children },
});

const fontRoot = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts');
const regular = readFileSync(join(fontRoot, 'LiberationSans-Regular.ttf'));
const bold = readFileSync(join(fontRoot, 'LiberationSans-Bold.ttf'));

export const getStaticPaths: GetStaticPaths = () => [
  { params: { slug: 'home' }, props: { name: 'Free PDF tools', description: SITE.description } satisfies OgProps },
  ...TOOLS.filter((tool) => tool.status === 'live').map((tool) => ({
    params: { slug: tool.slug },
    props: { name: tool.searchName, description: tool.blurb } satisfies OgProps,
  })),
];

export const GET: APIRoute<OgProps> = async ({ props }) => {
  const card = node('div', {
    width: '1200px',
    height: '630px',
    display: 'flex',
    flexDirection: 'column',
    padding: '58px 64px',
    color: '#f1f5f9',
    backgroundColor: '#0b0f17',
    fontFamily: 'Liberation Sans',
  }, [
    node('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, [
      node('div', { display: 'flex', alignItems: 'center', gap: '16px', fontSize: '25px', fontWeight: 700 }, [
        node('div', {
          width: '42px', height: '48px', borderRadius: '10px', backgroundColor: '#f8fafc',
          borderBottomRightRadius: '20px', boxShadow: '0 12px 32px rgba(251,113,133,.22)',
        }, ''),
        node('span', {}, SITE.name),
      ]),
      node('span', { color: '#94a3b8', fontSize: '18px' }, 'PRIVATE BY CONSTRUCTION'),
    ]),
    node('div', { display: 'flex', flexDirection: 'column', marginTop: '42px' }, [
      node('div', { color: '#fb7185', fontSize: '17px', fontWeight: 700, letterSpacing: '2px' }, 'BROWSER-SIDE PDF TOOL'),
      node('div', { marginTop: '8px', fontSize: '62px', lineHeight: 1.02, fontWeight: 700, letterSpacing: '-2px' }, props.name),
      node('div', { width: '860px', marginTop: '13px', color: '#cbd5e1', fontSize: '23px', lineHeight: 1.35 }, props.description),
    ]),
    node('div', {
      display: 'flex', flexDirection: 'column', marginTop: '32px', height: '192px', overflow: 'hidden',
      border: '1px solid #334155', borderRadius: '16px', backgroundColor: '#101722',
    }, [
      node('div', { display: 'flex', alignItems: 'center', height: '48px', padding: '0 18px', borderBottom: '1px solid #334155', color: '#94a3b8', fontSize: '16px' }, [
        node('span', { color: '#f1f5f9', fontWeight: 700, marginRight: '24px' }, 'Network'),
        node('span', { marginRight: '18px' }, 'All'),
        node('span', { marginRight: '18px' }, 'Fetch/XHR'),
        node('span', {}, 'Document'),
      ]),
      node('div', { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '17px' }, 'No document requests captured'),
      node('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '45px', padding: '0 18px', borderTop: '1px solid #334155', fontSize: '17px' }, [
        node('span', { color: '#86efac', fontWeight: 700 }, '0 requests · 0 document bytes transferred'),
        node('span', { color: '#94a3b8' }, 'Runs on this device'),
      ]),
    ]),
  ]);

  const svg = await satori(card as Parameters<typeof satori>[0], {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Liberation Sans', data: regular, weight: 400, style: 'normal' },
      { name: 'Liberation Sans', data: bold, weight: 700, style: 'normal' },
    ],
  });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
