// Os testes usam o mesmo banco do desenvolvimento. Antes de começar guardamos o que é "dado de verdade"
// (ações pendentes do agente, configurações e políticas) e, ao terminar, devolvemos tudo como estava.
import { PrismaClient } from "@prisma/client";

export default async function setup() {
  const db = new PrismaClient();
  const [actions, settings, policies] = await Promise.all([db.agentAction.findMany(), db.setting.findMany(), db.autonomyPolicy.findMany()]);
  const actionIds = new Set(actions.map((a) => a.id));
  const settingKeys = new Set(settings.map((s) => s.key));

  return async function teardown() {
    for (const a of actions) {
      await db.agentAction.update({
        where: { id: a.id },
        data: { status: a.status, decidedById: a.decidedById, decidedAt: a.decidedAt, executedAt: a.executedAt, error: a.error, draft: a.draft },
      }).catch(() => {
        /* a ação foi apagada pelo teste: não é dado a restaurar */
      });
    }
    // Ações criadas pelos testes e que sobraram, sem lead de teste para limpá-las.
    await db.agentAction.deleteMany({ where: { id: { notIn: [...actionIds] }, lead: { is: null } } });
    for (const s of settings) {
      await db.setting.update({ where: { key: s.key }, data: { value: s.value as never } }).catch(() => db.setting.create({ data: { key: s.key, value: s.value as never } }));
    }
    await db.setting.deleteMany({ where: { key: { notIn: [...settingKeys] } } });
    for (const p of policies) await db.autonomyPolicy.update({ where: { task: p.task }, data: { level: p.level } }).catch(() => {});
    await db.$disconnect();
  };
}
