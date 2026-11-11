import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Content-Security-Policy of the built site. GitHub Pages cannot send headers, so the policy is a <meta> tag,
 * added only to the build (the dev server needs inline scripts for hot reload).
 *
 * The site shows a lot of text and links that come from outside (Steam names, RSS headlines, Liquipedia, demos).
 * With this policy the browser runs only our own script files: an injected <script>, an inline handler or a
 * «javascript:» link does nothing even if such a string ever gets into a page.
 *   script-src   our files + WebAssembly (meshopt decoder of the 3D maps) + the inline scripts of index.html by hash
 *   style-src    our CSS, Google Fonts, <style> of the price charts (lightweight-charts)
 *   img/connect  any https: avatars, flags, logos, the stats server, data branches on raw.githubusercontent.com
 *   worker/media blob: — video of a 3D replay, decoder workers
 */
function csp(): Plugin {
  return {
    name: 'rush-b-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
          .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
        const policy = [
          "default-src 'self'",
          ["script-src 'self' 'wasm-unsafe-eval'", ...inline].join(' '),
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' data: https://fonts.gstatic.com",
          "img-src 'self' data: blob: https:",
          "media-src 'self' data: blob:",
          "connect-src 'self' data: blob: https:",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; ');
        const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
        // right after <meta charset> (the charset has to stay in the first bytes of the page), before any script
        if (/<meta charset=[^>]*>/i.test(html)) return html.replace(/<meta charset=[^>]*>/i, (m) => `${m}\n    ${meta}`);
        return html.replace(/<head[^>]*>/i, (m) => `${m}\n    ${meta}`);
      },
    },
  };
}

// GitHub Pages serves the site from /rush-b/
export default defineConfig({
  base: process.env.BASE_PATH || '/rush-b/',
  plugins: [react(), csp()],
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
});
