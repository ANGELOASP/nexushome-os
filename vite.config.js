import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';

// js/config.js é só do desenvolvimento local (gitignored). No build de produção a tag sai do HTML:
// sem o arquivo, a Vercel devolvia o index.html no lugar (SyntaxError no console) e o service worker
// o guardava como JS. Em produção a configuração vem do build (PRODUCTION_CONFIG em
// js/supabase-client.js e a variável VITE_VAPID_PUBLIC_KEY lida em js/pwa.js).
export function stripLocalConfig(html) {
  return html.replace(/[ \t]*<!--[^\n]*config\.example\.js[^\n]*-->[ \t]*\r?\n/, '')
    .replace(/[ \t]*<script src="js\/config\.js"><\/script>[ \t]*\r?\n?/, '');
}

export default defineConfig({
  plugins: [
    {
      name: 'nexushome-sem-config-local',
      apply: 'build',
      transformIndexHtml: { order: 'pre', handler: stripLocalConfig },
    },
    {
      // `npm run dev` sem js/config.js: devolve um script vazio (o fallback do Vite mandaria o index.html)
      name: 'nexushome-config-local-opcional',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] !== '/js/config.js' || existsSync(new URL('./js/config.js', import.meta.url))) return next();
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.end('// sem js/config.js: Modo Demonstração (ver js/config.example.js)\n');
        });
      },
    },
  ],
});
