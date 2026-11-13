// Dados de desenvolvimento: usuários de teste (um por papel), política de autonomia do agente
// e os leads de exemplo do protótipo. Seguro para rodar mais de uma vez (idempotente).
import { PrismaClient, type LeadStage, type LeadSource, type Temperature } from "@prisma/client";
import { hash } from "@node-rs/argon2";

const db = new PrismaClient();

const password = process.env.SEED_PASSWORD;
if (!password || password.length < 12) {
  throw new Error("Defina SEED_PASSWORD (mín. 12 caracteres) no .env antes de rodar o seed.");
}
if (process.env.NODE_ENV === "production") {
  throw new Error("O seed é só para desenvolvimento.");
}

const USERS = [
  { name: "Ana Administradora", email: "admin@flurtek.local", role: "ADMIN", states: [] as string[] },
  { name: "Carlos Comercial", email: "comercial@flurtek.local", role: "COMERCIAL", states: [] },
  { name: "Rita Representante", email: "representante@flurtek.local", role: "REPRESENTANTE", states: ["SC", "PR"] },
  { name: "Leo Leitura", email: "leitura@flurtek.local", role: "LEITURA", states: [] },
] as const;

const POLICIES = [
  ["classificar_lead", "Classificar leads e pontuar", "AUTOMATICO"],
  ["responder_duvida_tecnica", "Responder dúvidas técnicas", "AUTOMATICO"],
  ["primeiro_contato_inbound", "Primeiro contato de quem pediu cotação", "APROVACAO"],
  ["primeiro_contato_frio", "Primeiro contato frio (e-mail de prospecção)", "APROVACAO"],
  ["enviar_cotacao", "Enviar cotação", "APROVACAO"],
  ["follow_up", "Follow-up", "APROVACAO"],
  ["negociar_preco", "Negociar preço e desconto", "HUMANO"],
  ["suporte_pos_venda", "Suporte pós-venda", "APROVACAO"],
  ["criar_leads_prospeccao", "Criar leads de prospecção", "APROVACAO"],
  ["lembrete_recompra", "Lembrete de recompra", "APROVACAO"],
  ["lembrete_cobranca", "Lembrete de cobrança vencida", "APROVACAO"],
] as const;

type SeedLead = {
  co: string; seg: string; uf: string; cid: string; prod: string; vol: string; val: number;
  src: LeadSource; stage: LeadStage; score: number; temp: Temperature; agent: boolean; next: string;
};

const LEADS: SeedLead[] = [
  { co: "Transportadora Serra Sul", seg: "Transportadoras", uf: "RS", cid: "Caxias do Sul", prod: "Água 1.000L (IBC)", vol: "2 IBC/mês", val: 5200, src: "SITE_FORMULARIO", stage: "NEGOCIACAO", score: 92, temp: "QUENTE", agent: false, next: "Cliente pediu desconto por contrato anual. Escalado para a equipe." },
  { co: "Oficina Bom Pistão", seg: "Oficinas e autopeças", uf: "RS", cid: "Bento Gonçalves", prod: "Água 20L", vol: "10 galões/mês", val: 1450, src: "WHATSAPP", stage: "COTACAO", score: 78, temp: "QUENTE", agent: true, next: "Follow-up em 24 h se não responder à cotação." },
  { co: "Empilhadeiras Gaúcha", seg: "Empilhadeiras e baterias", uf: "RS", cid: "Farroupilha", prod: "Água 20L", vol: "30 galões/mês", val: 3800, src: "GOOGLE_ADS", stage: "QUALIFICADO", score: 84, temp: "QUENTE", agent: true, next: "Agendar contato da equipe comercial para hoje." },
  { co: "Laser Corte Sul", seg: "Corte a laser e indústria", uf: "RS", cid: "Garibaldi", prod: "Água 1.000L (IBC)", vol: "1 IBC/mês", val: 2600, src: "PROSPECCAO_IA", stage: "NOVO", score: 71, temp: "MORNO", agent: true, next: "Aguardando aprovação do primeiro contato." },
  { co: "Auto Peças Vale", seg: "Oficinas e autopeças", uf: "SC", cid: "Joinville", prod: "Fluido de radiador", vol: "Revenda", val: 0, src: "REPRESENTANTE", stage: "NOVO", score: 66, temp: "MORNO", agent: false, next: "Quer ser revenda. Enviar critérios de representante." },
  { co: "Laboratório Analítica", seg: "Laboratórios", uf: "RS", cid: "Porto Alegre", prod: "Água 20L", vol: "8 galões/mês", val: 1200, src: "SITE_FORMULARIO", stage: "QUALIFICADO", score: 74, temp: "MORNO", agent: true, next: "Enviar ficha técnica e laudo de condutividade." },
  { co: "Clínica Bella Estética", seg: "Laboratórios", uf: "RS", cid: "Caxias do Sul", prod: "Água 5L", vol: "6 galões/mês", val: 480, src: "WHATSAPP", stage: "FECHADO", score: 88, temp: "QUENTE", agent: false, next: "Recompra prevista em 25 dias." },
  { co: "Frota Rodoviária Norte", seg: "Transportadoras", uf: "PR", cid: "Curitiba", prod: "Água 1.000L (IBC)", vol: "3 IBC/mês", val: 7800, src: "MARKETPLACE", stage: "COTACAO", score: 81, temp: "QUENTE", agent: false, next: "4 dias sem resposta. Sugerir ligação." },
  { co: "Auto Center Premium", seg: "Oficinas e autopeças", uf: "SP", cid: "Campinas", prod: "Fluido de radiador", vol: "Pronto p/ uso", val: 0, src: "SITE_LISTA_ESPERA", stage: "NOVO", score: 55, temp: "FRIO", agent: true, next: "Avisar no lançamento do fluido." },
  { co: "Metal Usinagem Serrana", seg: "Corte a laser e indústria", uf: "RS", cid: "Flores da Cunha", prod: "Água 1.000L (IBC)", vol: "1 IBC/mês", val: 2600, src: "REPRESENTANTE", stage: "NEGOCIACAO", score: 76, temp: "MORNO", agent: false, next: "Representante negocia prazo de pagamento." },
  { co: "Auto Mecânica Centro", seg: "Oficinas e autopeças", uf: "RS", cid: "Caxias do Sul", prod: "Água 5L", vol: "4 galões/mês", val: 320, src: "WHATSAPP", stage: "FECHADO", score: 69, temp: "MORNO", agent: true, next: "Recompra prevista em 12 dias." },
];

async function main() {
  const passwordHash = await hash(password!, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

  const users = new Map<string, string>();
  for (const u of USERS) {
    const row = await db.user.upsert({
      where: { email: u.email },
      update: { name: u.name, role: u.role, states: [...u.states], passwordHash, active: true, failedLogins: 0, lockedUntil: null },
      create: { name: u.name, email: u.email, role: u.role, states: [...u.states], passwordHash },
    });
    users.set(u.role, row.id);
  }

  for (const [task, label, level] of POLICIES) {
    await db.autonomyPolicy.upsert({ where: { task }, update: { label }, create: { task, label, level } });
  }

  if ((await db.lead.count()) === 0) {
    for (const l of LEADS) {
      const company = await db.company.create({ data: { name: l.co, segment: l.seg, city: l.cid, uf: l.uf } });
      const lead = await db.lead.create({
        data: {
          title: l.co,
          companyId: company.id,
          stage: l.stage,
          score: l.score,
          temperature: l.temp,
          source: l.src,
          product: l.prod,
          volume: l.vol,
          estimatedValue: l.val || null,
          nextAction: l.next,
          uf: l.uf,
          city: l.cid,
          agentOwned: l.agent,
          ownerId: l.agent ? null : users.get("COMERCIAL"),
          consentAt: l.src === "PROSPECCAO_IA" ? null : new Date(),
          consentText: l.src === "PROSPECCAO_IA" ? null : "Dado de exemplo (seed de desenvolvimento).",
          consentSource: l.src === "PROSPECCAO_IA" ? null : "seed",
        },
      });
      await db.leadEvent.create({
        data: { leadId: lead.id, actorType: "SISTEMA", kind: "criado", text: `Lead de exemplo criado (origem: ${l.src}).` },
      });
    }

    // Uma ação pendente do agente, para o painel mostrar a fila de aprovação.
    const laser = await db.lead.findFirst({ where: { title: "Laser Corte Sul" } });
    if (laser) {
      await db.agentAction.create({
        data: {
          leadId: laser.id,
          tool: "rascunhar_mensagem",
          kind: "primeiro_contato_frio",
          draft:
            "Olá, equipe da Laser Corte Sul. Sou da Flurtek, fabricante de água desmineralizada em Caxias do Sul. Posso enviar uma cotação sem compromisso?\n\nSe preferir não receber nossos e-mails, responda com \"sair\".",
          confidence: 86,
          reason: "Empresa encontrada pelo CNAE de corte e usinagem. Segmento com alto consumo de água desmineralizada.",
        },
      });
    }
  }

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const byTitle = async (title: string) => db.lead.findFirst({ where: { title } });

  // Leads parados (sem contato há dias), para o painel mostrar a atenção necessária.
  for (const [title, d] of [["Frota Rodoviária Norte", 4], ["Auto Peças Vale", 3], ["Auto Center Premium", 6]] as const) {
    await db.lead.updateMany({ where: { title }, data: { lastContactAt: daysAgo(d) } });
  }

  await db.setting.upsert({ where: { key: "agent.enabled" }, update: {}, create: { key: "agent.enabled", value: true } });

  if ((await db.conversation.count()) === 0) {
    const convs: { lead: string | null; channel: "WHATSAPP" | "EMAIL" | "CHAT_SITE"; mode: "AGENTE" | "HUMANO"; unread: number; msgs: ["CLIENTE" | "AGENTE" | "EQUIPE" | "SISTEMA", string, number][] }[] = [
      { lead: "Transportadora Serra Sul", channel: "WHATSAPP", mode: "HUMANO", unread: 1, msgs: [["CLIENTE", "Há desconto para contrato anual?", 1], ["AGENTE", "Preço e desconto são tratados pela nossa equipe comercial. Já avisei o time e você receberá retorno hoje.", 1], ["SISTEMA", "Conversa assumida pela equipe.", 1]] },
      { lead: "Oficina Bom Pistão", channel: "WHATSAPP", mode: "AGENTE", unread: 0, msgs: [["CLIENTE", "Oi, vocês entregam água desmineralizada de 20L?", 3], ["AGENTE", "Olá! Entregamos sim. De qual cidade você fala e quantos galões usa por mês?", 3], ["CLIENTE", "Bento Gonçalves, uns 10 por mês", 3], ["AGENTE", "Perfeito. Já preparei uma cotação para 10 galões por mês e nossa equipe confirma o valor com você em breve.", 3], ["CLIENTE", "Vou ver com o dono e te falo", 1]] },
      { lead: "Laboratório Analítica", channel: "EMAIL", mode: "AGENTE", unread: 1, msgs: [["CLIENTE", "Bom dia, preciso do laudo de condutividade da água de 20L.", 1], ["AGENTE", "Bom dia! Vou encaminhar o seu pedido para a nossa equipe técnica, que enviará o laudo. Posso confirmar o volume que vocês consomem por mês?", 1]] },
      { lead: null, channel: "CHAT_SITE", mode: "AGENTE", unread: 0, msgs: [["CLIENTE", "Posso misturar o concentrado com água da torneira?", 0], ["AGENTE", "Não é recomendado: os minerais da torneira formam depósitos no radiador. Use água desmineralizada. Quer que eu indique o volume ideal?", 0]] },
    ];
    for (const c of convs) {
      const lead = c.lead ? await byTitle(c.lead) : null;
      const conv = await db.conversation.create({ data: { leadId: lead?.id, channel: c.channel, mode: c.mode, unread: c.unread } });
      let order = 0;
      for (const [author, body, d] of c.msgs) {
        await db.message.create({ data: { conversationId: conv.id, author, body, createdAt: new Date(daysAgo(d).getTime() + order++ * 60_000) } });
      }
    }
  }

  if ((await db.leadEvent.count({ where: { actorType: "AGENTE" } })) === 0) {
    const events: [string, string, number][] = [
      ["Transportadora Serra Sul", "Classificou como B2B recorrente, segmento Transportadoras, pontuação 92.", 0],
      ["Transportadora Serra Sul", "Respondeu o formulário em 38 s com opções de entrega.", 0],
      ["Empilhadeiras Gaúcha", "Qualificou por perguntas: frota de 12 empilhadeiras, consumo mensal alto.", 0],
      ["Laser Corte Sul", "Encontrou a empresa no cadastro público (CNAE de corte e usinagem) e rascunhou o primeiro contato.", 0],
      ["Oficina Bom Pistão", "Enviou follow-up 1 após a cotação, sem resposta ainda.", 1],
    ];
    for (const [title, text, d] of events) {
      const lead = await byTitle(title);
      if (lead) await db.leadEvent.create({ data: { leadId: lead.id, actorType: "AGENTE", kind: "agente", text, createdAt: daysAgo(d) } });
    }
  }

  if ((await db.agentAction.count()) < 3) {
    const extra: [string, string, string, string, number, string][] = [
      ["Frota Rodoviária Norte", "follow_up", "Olá! Passando para saber se a cotação de 3 IBC por mês ajudou na avaliação com a diretoria. Posso ajustar prazo de entrega ou condições de pagamento.", "4 dias sem resposta em lead de alto valor. Regra: follow-up após 72 h.", 91, "rascunhar_mensagem"],
      ["Empilhadeiras Gaúcha", "cotacao", "Empilhadeiras Gaúcha, segue a proposta para 30 galões de 20L por mês, com entrega semanal em Farroupilha. Valor sob confirmação da equipe comercial.", "Preço depende da tabela. O agente não define valor sozinho.", 73, "rascunhar_mensagem"],
    ];
    for (const [title, kind, draft, reason, confidence, tool] of extra) {
      const lead = await byTitle(title);
      if (lead) await db.agentAction.create({ data: { leadId: lead.id, tool, kind, draft, reason, confidence } });
    }
  }

  if ((await db.customer.count()) === 0) {
    const base: [string, string, string, string, number, number][] = [
      ["Clínica Bella Estética", "RS", "Água 5L", "6 galões", 5, 28],
      ["Auto Mecânica Centro", "RS", "Água 5L", "4 galões", 18, 30],
      ["Metalúrgica Boa Vista", "RS", "Água 20L", "10 galões", 24, 30],
      ["Transportadora Pioneira", "RS", "Água 1.000L (IBC)", "1 IBC", 41, 45],
      ["Oficina Serra Gaúcha", "RS", "Água 20L", "6 galões", 35, 30],
    ];
    for (const [name, uf, product, volume, ago, cycle] of base) {
      const company = (await db.company.findFirst({ where: { name } })) ?? (await db.company.create({ data: { name, uf, city: "Caxias do Sul" } }));
      const customer = await db.customer.create({ data: { companyId: company.id, cycleDays: cycle } });
      await db.order.create({ data: { customerId: customer.id, product, volume, value: 400, orderedAt: daysAgo(ago) } });
    }
  }

  if ((await db.knowledgeDoc.count()) === 0) {
    const docs: [string, string][] = [
      ["Água da torneira no radiador", "Não é recomendado usar água da torneira no radiador. Os minerais da água formam depósitos (incrustações) que reduzem a troca de calor e favorecem a corrosão. Use sempre água desmineralizada, que não deixa minerais nem depósitos no sistema."],
      ["Água desmineralizada para bateria", "A água desmineralizada é indicada para repor o nível de baterias automotivas, estacionárias e de empilhadeiras, sem introduzir minerais indesejados. Complete apenas o nível indicado pelo fabricante da bateria."],
      ["Diferença entre desmineralizada, deionizada e destilada", "As três passam por tratamento para remover sais minerais. A destilada vem de evaporação e condensação; a deionizada e a desmineralizada costumam usar resinas de troca iônica ou outros processos de filtragem. Para radiadores e baterias, o que importa é a baixa condutividade, informada na ficha técnica do produto."],
      ["Embalagens da água desmineralizada", "A água desmineralizada Flurtek é vendida em 1 litro, 5 litros, 20 litros e IBC de 1.000 litros. Os volumes de 20L e 1.000L são indicados para consumo recorrente de oficinas, empresas e indústria."],
      ["Aditivo para radiador: pronto para usar ou concentrado", "O aditivo protetivo para radiadores Flurtek tem duas versões de 1 litro. O pronto para usar já vem diluído e não deve receber água. O concentrado precisa ser diluído em água desmineralizada, e rende mais por embalagem. Confira no manual do veículo o tipo de aditivo recomendado."],
      ["Proteções do aditivo para radiador", "O aditivo protetivo para radiadores Flurtek é anticorrosivo, anticongelante, antifervura, anti-incrustante e antiespumante, conforme o rótulo. A formulação é de monoetilenoglicol com inibidores de corrosão e agentes orgânicos."],
      ["Compatibilidade do aditivo para radiador", "É indicado para motores de motos, automóveis, utilitários, caminhões, máquinas agrícolas e motores estacionários. Confirme sempre o tipo de aditivo recomendado no manual do veículo."],
      ["Como a água desmineralizada ECO-SUL é produzida (processo e pureza)", "A Água Desmineralizada ECO-SUL foi desenvolvida utilizando os processos mais modernos e eficazes que existem no Brasil. No processo de purificação, a água passa por diversos estágios de filtragem até atingir a pureza total: as partículas de impurezas e os minerais ficam retidos nos filtros do sistema. Como resultado, a água tem a condutividade elétrica controlada para atender às necessidades dos sistemas que a utilizam. O valor de condutividade está na ficha técnica do produto."],
      ["Água desmineralizada ECO-SUL: isenta de sais minerais e 100% purificada", "A água é isenta de sais minerais: evita a formação de depósitos e a corrosão em sistemas de arrefecimento, baterias e outros componentes em que a presença de sais minerais poderia ser prejudicial, oferecendo proteção e eficiência para equipamentos automotivos e industriais. Também é 100% purificada, atendendo a altos padrões de qualidade e livre de impurezas que poderiam comprometer o desempenho dos sistemas automotivos e industriais onde é aplicada."],
      ["Onde usar a água desmineralizada ECO-SUL (aplicações)", "Pode ser utilizada em máquinas a laser, baterias, radiadores, motores estacionários, reservatórios de carros, caminhonetes, tratores, barcos e caminhões. Também é indicada para ferros de passar roupa e laboratórios. Para equipamentos com exigência específica de condutividade (laser, autoclave, laboratório), peça a ficha técnica e confirme a especificação com o fabricante do equipamento."],
      ["Entrega e cotação", "Grandes volumes (20L e 1.000L) são entregues em frota própria na região de Caxias do Sul (RS). Nos demais estados, a Flurtek atende por representantes. Preços e condições são informados pela equipe comercial por cotação."],
    ];
    for (const [title, body] of docs) await db.knowledgeDoc.create({ data: { title, body, status: "APROVADO" } });
  }

  console.log(`Seed concluído: ${USERS.length} usuários, ${POLICIES.length} políticas, ${await db.lead.count()} leads.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
