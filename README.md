# Flurtek CRM

CRM próprio da Flurtek, com agente de IA em modo **sugere e aprova**. Especificação em `Spec-CRM-Agente-IA.md` e estrutura em `CRM-Estrutura-do-Projeto.md` (pasta Flurtek).

**Marco atual: M5 (agente de operação em modo simulado)**, M3 (formulários) e M4 (canal WhatsApp via ConextBot, simulado); antes: M2 + base do agente. — funil kanban, lead 360, conversas (agente/humano), fila de aprovações, autonomia, chave geral, clientes e recompra. Visão revisada: operação autônoma pelo WhatsApp do dono (`Operacao-Autonoma-WhatsApp.md`).

## Rodar (tudo em Docker, Node 22 LTS)

```bash
cp .env.example .env        # só na primeira vez; preencha as senhas
docker compose up -d        # sobe Postgres (porta 5442) e o app (http://localhost:3100)
docker compose exec -T app npx prisma db seed   # usuários e dados de exemplo (1ª vez)
```

Logs: `docker compose logs -f app` · Parar: `docker compose down` (os dados ficam no volume `dbdata`).

Usuários de teste (senha em `SEED_PASSWORD` no `.env`, só para desenvolvimento):
`admin@`, `comercial@`, `representante@` e `leitura@` + `flurtek.local`.

## Formulários do site e WhatsApp (ConextBot)

- **Formulários:** `POST /api/public/leads` (cabeçalhos `Origin` permitido e `x-site-key`). O script `prototipo/crm-forms.js` do site chama esse endereço. Variáveis: `INTAKE_SITE_KEY`, `INTAKE_ALLOWED_ORIGINS`.
- **Webhook de entrada:** `POST /api/webhooks/conextbot?token=<CONEXTBOT_WEBHOOK_TOKEN>`. Tudo que chega é gravado bruto em `WebhookEvent`.
- **Envio:** serviço `worker` (`docker compose logs -f worker`) envia o que já foi decidido por uma pessoa. `CHANNEL_MODE=mock` só simula; `CHANNEL_MODE=live` com `CONEXTBOT_API_KEY` envia de verdade.
- **Trocou o `.env`?** `docker compose up -d --force-recreate app worker` (o `restart` não relê o arquivo).
- **Rodar os testes:** pare o worker antes (`docker compose stop worker`), porque os testes usam o banco de desenvolvimento e o worker trataria os dados de teste. Depois `docker compose start worker`. Os arquivos de teste rodam um por vez.

## Agente de operação (M5)

O worker roda o agente e o executor a cada 5 s. O agente **cria ações**; só o executor envia.

- **Cérebro (IA):** configurado **pelo painel**, em *Inteligência artificial* (só ADMIN): cole a chave do OpenRouter (https://openrouter.ai/keys), escolha os modelos e use *Testar conexão*. A chave fica criptografada no banco (AES-256-GCM, `APP_ENCRYPTION_KEY`), nunca volta para a tela e vale em até 5 segundos, sem reiniciar. Sem chave, usa regras simuladas (`MockBrain`). O `.env` continua valendo como plano B (`OPENROUTER_API_KEY`, ou `ANTHROPIC_API_KEY` para usar direto a Anthropic); o que estiver no painel vence o `.env`. `LLM_PROVIDER=auto` (padrão) escolhe o OpenRouter quando há chave dele; use `openrouter`, `anthropic` ou `mock` para forçar. Os modelos são os identificadores do OpenRouter, definidos em `OPENROUTER_MODEL` (agente de atendimento, padrão `anthropic/claude-sonnet-4.5`) e `OPENROUTER_OWNER_MODEL` (interpretação das ordens do dono, padrão `anthropic/claude-haiku-4.5`); troque quando quiser testar outro modelo. `OPENROUTER_DATA_COLLECTION=deny` (padrão) só usa provedores que não guardam nem treinam com as conversas. As mesmas travas valem para qualquer modelo: a IA só propõe, falha da IA escala para uma pessoa, e a ordem do dono só é aceita se cair no conjunto fechado de intenções.
- **Travas (valem acima da configuração de autonomia):** preço, desconto, contrato, reclamação, reembolso e tentativa de dar ordens sempre vão para uma pessoa; texto com valor, desconto ou promessa nunca é automático; cotação sempre passa por aprovação; confiança abaixo de 60% exige aprovação; fora da janela de 24 h precisa de modelo.
- **Fluxos:** responder cliente (`processConversation`), pré-análise de leads do site (`processNewLeads`), follow-up em 24 h, 72 h e 7 dias (`runFollowUps`), lembrete de recompra (`runRepurchase`).
- **Base de conhecimento:** só documentos `APROVADO` (tabela `KnowledgeDoc`, 8 documentos de exemplo no seed).

## Agente-chefe de gabinete (M6)

O dono (e gestores) falam com o agente pelo próprio WhatsApp. Cadastre o número em **Config > Números autorizados**; a pessoa envia `VERIFICAR <código>` (6 dígitos, vale 30 min) e só então o número passa a valer. Mensagens de clientes nunca são ordens.

- **Comandos:** relatório (hoje, ontem, semana, mês), pendências, aprovar/rejeitar por código `#XXXX` ou "todas", status de um lead, "me avise quando X responder", follow-up das cotações paradas, pausar/retomar o agente ou a prospecção fria, horário de silêncio.
- **Segurança:** a IA só classifica a frase em uma intenção de lista fechada (`OwnerBrain`); quem executa é código, com as permissões do usuário vinculado. Ordens sensíveis exigem `CONFIRMO` em 5 min. Gestor só consulta e aprova caso a caso.
- **Proativo:** resumo diário após as 8h (São Paulo) e aviso de assuntos escalados. Fora da janela de 24 h o aviso espera o dono escrever (modelos serão ligados quando o formato do ConextBot chegar).

## Financeiro (M7): cobrança Asaas e nota fiscal

Pedido → cobrança (Pix, boleto, cartão ou "cliente escolhe") → conciliação automática → nota fiscal. Tela: **Financeiro** (ADMIN e COMERCIAL).

- **Quem decide:** valor e vencimento são sempre de uma pessoa. O agente nunca cria cobrança nem negocia preço. Cancelar cobrança ou nota é só do ADMIN (nota exige motivo).
- **Asaas:** `PAYMENT_MODE=mock` (padrão), `sandbox` ou `live`, com `ASAAS_API_KEY` no `.env`. Webhook: `POST /api/webhooks/asaas` com o token de `ASAAS_WEBHOOK_TOKEN` no cabeçalho `asaas-access-token` (configure o mesmo valor no painel do Asaas, em Integrações > Webhooks, com os eventos de cobrança). Eventos repetidos são ignorados; pagamento atrasado não desfaz pagamento já recebido.
- **O que o agente faz sozinho:** concilia o pagamento, avisa o dono no WhatsApp, marca vencidas e propõe um lembrete ao cliente (`lembrete_cobranca`), que sempre passa por aprovação porque leva valor e link. No máximo um lembrete a cada 5 dias. O dono pergunta "financeiro" e recebe a posição (só o dono, não o gestor).
- **Nota fiscal:** um pedido nunca gera duas notas. Exige CNPJ do cliente. Emissão automática ao receber fica desligada por padrão (`finance.autoInvoice`).
- **Atenção:** o Asaas só emite NFS-e (serviço). Água e fluido são produto (NF-e), então a emissão real exige um provedor de NF-e (ex.: Focus NFe, eNotas) ou o contador, com NCM, CFOP e certificado A1. A emissão hoje é simulada atrás da interface `FiscalProvider`.

## Site e CRM no mesmo app

O app serve o site público e o CRM juntos: `/`, `/agua-desmineralizada`, `/fluido-de-radiador`, `/representantes`, `/quem-somos`, `/contato` e as políticas abrem sem login; o CRM (`/painel`, `/funil`, `/financeiro`...) continua atrás do login.

- **Origem das páginas:** HTML em `site/` e imagens em `public/site/`, importados do protótipo com `node scripts/import-site.mjs "<pasta do protótipo>"` (reimporte depois de mexer no protótipo; edições feitas direto em `site/` se perdem).
- **Formulários:** o script `/site/crm-forms.js` envia para `/api/public/leads` na mesma origem. A chave pública vem de `INTAKE_SITE_KEY`, injetada pelo servidor. A origem do site precisa estar em `INTAKE_ALLOWED_ORIGINS` (em produção, o domínio real).
- **SEO:** `/robots.txt` bloqueia as áreas do CRM e `/sitemap.xml` lista as páginas. O servidor acrescenta a cada página o `canonical`, o Open Graph (preview ao compartilhar), o ícone e endereços completos nos dados estruturados. Tudo isso depende de `SITE_URL`: defina com o domínio final (com https). O mesmo vale para `AUTH_URL`, usado nos redirecionamentos do login.
- **Pendente:** uma imagem de compartilhamento própria (1200x630) para o Open Graph; hoje usa a foto do produto.

### Chat do site com o agente

Botão no canto de todas as páginas (acima do WhatsApp). O visitante aceita a Política de Privacidade, conversa com o assistente (identificado como IA) e pode pedir a equipe humana. Cada visitante vira uma conversa do canal `CHAT_SITE` e um lead (origem "Site · chat"), e o agente responde pelo mesmo fluxo e as mesmas travas do WhatsApp: dúvida técnica responde sozinho; preço, desconto, contrato e reclamação vão para a equipe com aviso padrão e o dono é avisado. A equipe responde pelo CRM (Conversas) e o visitante recebe como "Equipe Flurtek".

- **API:** `POST/GET /api/public/chat` (origem permitida + chave do site, limites por IP e por sessão, isca anti-robô). O token da sessão (128 bits) é a única credencial do visitante.
- **Diferenças do WhatsApp:** sem janela de 24 h, sem horário de silêncio e com teto de 60 respostas/dia por conversa.
- **Resposta de verdade:** a qualidade depende da chave de IA (`OPENROUTER_API_KEY`); sem ela o agente usa regras simples e a base de conhecimento (`KnowledgeDoc`).

### Blog

Artigos em `content/blog/*.md` (metadados no topo: título, descrição, palavra-chave, imagem, CTA e relacionados). Gere as páginas com `docker compose exec app node scripts/build-blog.mjs` (depois de `scripts/import-site.mjs`, que traz o cabeçalho e o rodapé do site). Cada artigo sai com índice lateral, FAQ, dados estruturados (Article, BreadcrumbList e FAQPage), canonical e Open Graph, e entra no `sitemap.xml`. O gerador recusa título com mais de 70 caracteres e descrição com mais de 165.

## NF-e direto na SEFAZ (em andamento)

Etapa 1 pronta: **conexão e diagnóstico**, sem emitir nada. Em **Configuração fiscal**, o botão *Testar conexão com a SEFAZ* confere o certificado A1 (titular, CNPJ, validade) e consulta o status do serviço no ambiente escolhido (RS, NF-e 4.00).

- **Certificado (pela tela):** o administrador envia o `.pfx` e a senha em Configuração fiscal. O sistema só guarda se a senha abrir o arquivo, e grava os dois **criptografados** (AES-256-GCM) no banco, com a chave `APP_ENCRYPTION_KEY` do `.env`. A tela nunca mostra o arquivo nem a senha, só titular, CNPJ e validade. Enviar outro substitui; remover volta ao `.env`. **Faça backup da `APP_ENCRYPTION_KEY`**: se ela mudar, é preciso enviar o certificado de novo.
- **Certificado (alternativa por .env):** `.pfx` em `certs/` com `SEFAZ_CERT_PATH` e `SEFAZ_CERT_PASSWORD` (ou `SEFAZ_CERT_BASE64`). Só vale se nada foi enviado pela tela.
- **Endereços:** homologação e produção do RS vêm de fábrica e podem ser trocados por `SEFAZ_STATUS_URL_HOMOLOGACAO` e `SEFAZ_STATUS_URL_PRODUCAO`. Foram tirados de listas públicas e ainda não foram testados com o seu certificado.
- **Falta:** montar e assinar o XML da NF-e, enviar o lote, tratar autorização, rejeição e cancelamento, e gerar o DANFE. Só depois o provedor da SEFAZ substitui o simulado, e o contador valida notas em homologação antes da produção.

## Comandos úteis (dentro do contêiner)

| Comando | O que faz |
|---|---|
| `docker compose exec -T app npm test` | Testes unitários (Vitest) |
| `docker compose exec -T app node scripts/smoke-auth.mjs` | Teste de fumaça de login e papéis |
| `docker compose exec -T app npx tsc --noEmit` | Checagem de tipos |
| `docker compose exec -T app npx eslint src tests scripts prisma` | Lint |
| `docker compose exec app npx prisma migrate dev --name <nome>` | Nova migração |
| `docker compose exec app npx prisma studio` | Navegar no banco |

> **Dica (Windows + Docker):** o Next não percebe pastas e arquivos novos no volume do Windows. Depois de criar rotas ou editar arquivos e não ver a mudança, rode `docker compose restart app`.

## Estrutura

- `prisma/` schema, migrações e seed
- `src/auth.ts`, `src/auth.config.ts`, `src/proxy.ts` login (Auth.js) e barreira de rotas
- `src/server/` regras: papéis (`rbac.ts`), sessão, senha, auditoria
- `src/server/leads/` regras do funil (`rules.ts`) e serviço com permissões e escopo (`service.ts`)
- `src/app/` páginas: `/login`, `/painel`, `/funil`, `/leads/[id]`, `/leads/novo`, `/conversas`, `/agente`, `/clientes`, `/config/usuarios`, `/api/health`
- `tests/`, `scripts/` testes unitários e de fumaça

## Segurança já implementada

Representante só enxerga e anota nos leads dos seus estados (a mesma resposta 404 para "não existe" e "não é seu") · senhas com argon2id · bloqueio por 5 tentativas (15 min) · mensagem única de erro de login · papéis verificados no servidor a cada requisição (conta desativada ou papel alterado valem na hora) · último administrador protegido · auditoria de login e de mudanças de usuário · `.env` fora do Git.

## Próximos marcos

M4 (falta: chave real do ConextBot, formato do webhook e envio de modelos) · M5 (falta: chave da Anthropic para a IA real e avaliação com conversas reais) · M6 pronto em modo simulado (falta o canal real) · M7 financeiro pronto em modo simulado (falta chave Asaas e provedor de NF-e) · M8 prospecção e integrações · M9 avaliação contínua.
