/// <reference types="astro/client" />

declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
