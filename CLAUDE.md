@AGENTS.md

# CLAVDIA — guía para trabajar en este repo

Somos **decles**, un equipo chico de producto y tecnología. Este repo es
**Clavdia**: una agenda inteligente para consultorios médicos, con un agente de
IA (secretario/a) que usa **human-in-the-loop** para todo lo sensible. El
detalle completo de arquitectura, roles, modelo de datos y guía de prueba vive
en [`README.md`](README.md) — es largo pero es la fuente de verdad; no lo
dupliques, léelo antes de tocar algo que no conozcas.

La metodología y los principios de decisión del equipo (no específicos de este
repo) están en [`docs/como-trabajamos.md`](docs/como-trabajamos.md). En corto:
**problema antes que solución, lo concreto antes que lo complejo, construir
poco pero con intención**. Antes de agregar una funcionalidad, preguntate si
responde a alguna de las preguntas de esa guía (ahorra tiempo, mejora la
experiencia del paciente, reduce tarea manual, etc.) — si no, probablemente no
haga falta.

## Orientación rápida

- **El criterio del agente está en Markdown, no en código**:
  [`src/lib/agent/instructions.md`](src/lib/agent/instructions.md) (base) +
  [`src/lib/agent/roles/*.md`](src/lib/agent/roles) (por rol). Cambiar cuándo
  se pide aprobación humana o cómo se comporta el agente es editar esos
  archivos, no `workflow.ts` ni `tools.ts`.
- **Human-in-the-loop** corre sobre `DurableAgent` (Workflow DevKit):
  [`src/workflows/secretary/workflow.ts`](src/workflows/secretary/workflow.ts),
  [`hooks.ts`](src/workflows/secretary/hooks.ts) +
  [`request-human.ts`](src/workflows/secretary/request-human.ts). La fila
  `pending_requests` en Postgres es la fuente de verdad compartida entre el
  workflow, el panel de la UI y el webhook de Slack — no un `Map` en memoria.
- **Una sola implementación de agendar/cancelar/reprogramar**:
  [`src/lib/domain/scheduling.ts`](src/lib/domain/scheduling.ts). Tanto las
  tools del agente (`src/workflows/secretary/tools.ts`) como los endpoints REST
  de la vista Sistema (`src/app/api/appointments/**`) llaman a ese módulo — la
  autorización se chequea en cada caller, no ahí adentro.
- **Autorización siempre en el servidor**, nunca solo en la UI: scoping de
  datos por `Actor` (`experimental_context`), `TOOLS_BY_ROLE` para que el
  modelo ni vea tools que no le corresponden, y los mismos chequeos de rol /
  organización repetidos en los endpoints REST manuales.
- **Multi-consultorio (multi-tenant)**: casi todo lleva `organization_id` y las
  queries de [`src/lib/db/repo.ts`](src/lib/db/repo.ts) filtran por él.
  `patients` y `medications` son globales (una ficha por persona, compartida
  entre consultorios).
- **Identidad ancla en el DNI, nunca en el email**; el PIN nunca lo reparte un
  humano — la persona lo elige con "Olvidé mi PIN" (código de un solo uso). Ver
  §4.1 del README antes de tocar login/altas.
- **Base de datos**: Postgres vía Supabase, un proyecto por entorno. Schema en
  migraciones versionadas (`src/lib/db/migrations/*.sql`), aplicadas con
  `npm run db:migrate`. No hay seed local — los datos de cada entorno viven en
  su propio proyecto de Supabase.

## Comandos

```bash
npm install
cp .env.example .env.local     # ANTHROPIC_API_KEY, AUTH_SECRET, DATABASE_URL(_DIRECT)
npm run db:migrate             # aplica migraciones nuevas contra DATABASE_URL_DIRECT
npm run dev                    # http://localhost:3000
npm run lint
npm run build
```

No hay suite de tests automatizada todavía — la verificación es manual: la
guía de prueba paso a paso está en el §10 del README (usuarios sembrados,
casos A1–D2). Si vas a agregar tests, arrancá por lo que ya tiene mayor riesgo
de romperse en silencio: `scheduling.ts` y el scoping por rol/organización.

## Convenciones a respetar

- No metas lógica de negocio del agente en TypeScript — va en los `.md` de
  `src/lib/agent/`.
- No dupliques la lógica de agendar/cancelar/reprogramar fuera de
  `scheduling.ts`.
- No asumas que el modelo va a "portarse bien": todo control de acceso serio
  (qué ficha ve un paciente, qué tools tiene un rol) se aplica en el servidor.
- Nueva migración = archivo `NNNN_descripcion.sql` en `src/lib/db/migrations/`,
  nunca editar una migración ya aplicada.
- El agente hace tareas administrativas y escala todo lo clínico — no le
  agregues capacidad de dar indicaciones médicas.
