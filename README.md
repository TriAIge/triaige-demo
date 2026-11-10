# triaige-demo

Página de atendimento de um escritório fictício (**XPTO Advogados Associados**) que serve de ponto de entrada para o fluxo do TriAIge.

O cliente preenche o formulário e anexa documentos. Ao enviar, a página chama o `triaige-srv-orchestrator` na AWS:

1. `POST /sessions` — cria a sessão (o resumo vira o título do caso)
2. para cada arquivo: `presign` → upload no S3 → `complete`
3. `POST /sessions/{id}/finalize` — dispara o pipeline

Depois, a tela mostra o protocolo e acompanha o status da sessão até a notificação.

## Rodar

Precisa só de Node 18+ (sem `npm install`).

```bash
cp .env.example .env   # preencha TRIAIGE_API_TOKEN
node server.js
```

Abra http://localhost:5500.

## Por que tem um `server.js`

O orchestrator não libera CORS e o token do escritório não deve ficar no navegador. O `server.js` serve a página e repassa `/api/*` para o ALB (com o token) e o upload para a URL pré-assinada do S3.

## Observações

- Formatos aceitos: PDF, PNG, JPG e TIFF (os que o OCR do mcp-ai suporta).
- Quem recebe a notificação são os **contatos ativos do escritório** dono do token (`law_firm_contacts`). Nome, e-mail e telefone do formulário são só visuais — a API não tem campo para eles.
