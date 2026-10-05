// ============================================================
// NexusHome OS — Configuração local (EXEMPLO)
// ------------------------------------------------------------
// 1) Copie este arquivo para: js/config.js
// 2) Preencha com as credenciais do seu projeto Supabase
//    (Project Settings → API → Project URL / anon public key)
//
// Se as credenciais estiverem vazias ou a conexão falhar,
// o aplicativo entra automaticamente em "Modo Demonstração"
// (simulação completa no navegador, sem backend).
//
// Alternativa: em tempo de execução você também pode definir
// localStorage.setItem('nh_supabase_url', '...')
// localStorage.setItem('nh_supabase_anon_key', '...')
// e recarregar a página. O localStorage tem prioridade.
// ============================================================
window.NEXUSHOME_CONFIG = {
  SUPABASE_URL: "",       // ex.: "https://abcdefgh.supabase.co"
  SUPABASE_ANON_KEY: "",  // ex.: "eyJhbGciOi..."
};
