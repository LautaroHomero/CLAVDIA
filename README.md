# Secretario médico · agente con aprobación humana

Un agente de **secretaría médica** cuyo comportamiento se define en un archivo de
**texto plano** ([`src/lib/agent/instructions.md`](src/lib/agent/instructions.md))
y que ejecuta un flujo **human-in-the-loop**: cuando una acción es sensible
(renovar una receta, reembolsar una factura alta, un pedido ambiguo…), el agente
**pausa el workflow** y le pide a una persona que apruebe o aclare — por **Slack**
o desde la propia UI — y recién entonces continúa.

Construido para el _Plaude Engineering Challenge_ con:

| Requisito del challenge | Implementación |
| --- | --- |
| UI en Next.js para interactuar con el agente | App Router + `useChat` — [`src/app/page.tsx`](src/app/page.tsx) |
| Agente con `DurableAgent` (Workflow DevKit) + paso HITL por Slack | [`src/workflows/secretary/`](src/workflows/secretary) |
| Instrucciones en texto plano con escenarios de aprobación | [`src/lib/agent/instructions.md`](src/lib/agent/instructions.md) |
| Repo en GitHub + README | este repo |

---

## Cómo funciona

```
Paciente ─► /api/chat ─► start(secretaryWorkflow)         (Workflow DevKit)
                              │
                              ├─ loadAgentInstructions()   "use step"  (lee instructions.md)
                              ├─ DurableAgent.stream(...)   loop del agente (LLM en steps durables)
                              │     │
                              │     ├─ tools de secretaría  "use step": agenda, recetas, facturación…
                              │     │
                              │     └─ requestHumanApproval / askHumanInput
                              │            │
                              │            ├─ notifyHuman()  "use step"  ──► Slack (chat.postMessage)
                              │            │                             └─► registro en memoria (panel de la UI)
                              │            │
                              │            ▼   el workflow SE SUSPENDE en un hook (0 recursos)
                              │        await humanHook  ◄──── resumeHook(token, decisión)
                              │            ▲                        │
                              │            │           ┌───────────┴───────────┐
                              │            │       POST /api/approvals   POST /api/slack/actions
                              │            │       (botones de la UI)    (botones de Slack, firma verificada)
                              │            │
                              │            └─ finalizeHuman() "use step" ──► actualiza el mensaje de Slack
                              │
                              └─ stream de respuesta ─► UI (SSE)
```

- **El token del hook es el `toolCallId`** de la llamada del agente. Así, los dos
  endpoints que reanudan el flujo (UI y Slack) no necesitan estado extra.
- Si Slack **no** está configurado, el pedido igual aparece en el panel
  **"Pendientes de un humano"** de la UI. El repo funciona con solo clonar +
  `ANTHROPIC_API_KEY`.
- La suspensión es **durable**: el workflow puede esperar horas o días (hay un
  timeout de 24 h configurable) y sobrevive a redeploys y reinicios.

---

## Escenarios de aprobación (definidos en `instructions.md`)

| Situación | Herramienta | Qué pasa |
| --- | --- | --- |
| Briefing del paciente | `getPatientBriefing` | El agente **siempre** arranca resumiendo al paciente (antecedentes, alergias, medicación, turnos, pendientes) antes de atender. |
| Renovación de receta | `requestHumanApproval` → `createPrescriptionRenewal` | Siempre la aprueba el médico. |
| Reembolso ≥ $50.000 o motivo poco claro | `requestHumanApproval` → `refundInvoice` | Aprobación de administración. |
| Cancelar/reprogramar < 24 h o estudio caro | `requestHumanApproval` → `cancelAppointment` | Aprobación de recepción. |
| Sobreturno / urgencia / fuera de horario | `requestHumanApproval` → `scheduleAppointment` | Aprobación del médico. |
| Enviar resultados / datos clínicos al paciente | `requestHumanApproval` → `sendPatientMessage` | Aprobación explícita. |
| Identidad ambigua / intención poco clara / falta un dato | `askHumanInput` | El agente pide una aclaración concreta y sigue esa indicación. |
| Consulta clínica ("¿es grave?", "¿qué tomo?") | — | El agente **no** responde: deriva al profesional. |

> Las reglas viven en el prompt de texto plano, no en el código. Editá
> `instructions.md` y cambiás el comportamiento sin recompilar.

---

## Puesta en marcha

Requisitos: **Node ≥ 20** y una API key de Anthropic.

```bash
git clone <este-repo>
cd plaude-medical-secretary
npm install
cp .env.example .env.local     # completá ANTHROPIC_API_KEY
npm run dev                     # http://localhost:3000
```

Abrí la app, probá un escenario del panel izquierdo y resolvé las aprobaciones
en el panel derecho.

Observabilidad de los workflows (runs, steps, reintentos, suspensiones):

```bash
npx workflow web
```

### Variables de entorno

| Variable | Requerida | Descripción |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | Modelo del agente. https://console.anthropic.com |
| `AGENT_MODEL` | — | Id de modelo Anthropic. Default `claude-sonnet-4-5`. |
| `SLACK_BOT_TOKEN` | — | Bot token (`xoxb-…`). Si falta, el HITL usa solo la UI. |
| `SLACK_SIGNING_SECRET` | — | Para verificar la firma de los webhooks de Slack. |
| `SLACK_APPROVAL_CHANNEL` | — | **ID** del canal de aprobaciones (ej. `C0123ABCDE`). |

---

## Conectar Slack (opcional)

1. **Crear la app** en <https://api.slack.com/apps> → _Create New App_ → _From scratch_.
2. **OAuth & Permissions** → _Bot Token Scopes_: `chat:write`, `chat:write.public`.
   Instalá la app en el workspace y copiá el **Bot User OAuth Token** → `SLACK_BOT_TOKEN`.
3. **Basic Information** → _Signing Secret_ → `SLACK_SIGNING_SECRET`.
4. Creá un canal (ej. `#aprobaciones-medicas`), invitá al bot
   (`/invite @tu-app`) y poné su **ID** en `SLACK_APPROVAL_CHANNEL`
   (clic derecho en el canal → _Ver detalles_ → abajo del todo).
5. **Interactivity & Shortcuts** → _On_ → _Request URL_:
   `https://<tu-host-público>/api/slack/actions`.
   En local, exponé el puerto con un túnel:

   ```bash
   npx untun@latest tunnel http://localhost:3000
   # o: cloudflared tunnel --url http://localhost:3000
   ```

6. Reiniciá `npm run dev` con el `.env.local` completo. Ahora cada pedido de
   aprobación llega a Slack con botones **Aprobar / Rechazar**; al hacer clic,
   `resumeHook` reanuda el workflow. La UI y Slack son intercambiables: el
   primero que responde, gana.

---

## Estructura

```
src/
├── app/
│   ├── page.tsx                     UI de chat + panel de aprobaciones
│   └── api/
│       ├── chat/route.ts            start(secretaryWorkflow) + stream SSE
│       ├── approvals/route.ts       GET pendientes · POST decisión (UI) → resumeHook
│       └── slack/actions/route.ts   webhook de interactividad de Slack → resumeHook
├── workflows/secretary/
│   ├── workflow.ts                  "use workflow": el DurableAgent
│   ├── tools.ts                     herramientas ("use step") + requestHumanApproval / askHumanInput
│   ├── hooks.ts                     defineHook<HumanResponse>()
│   └── request-human.ts             suspende en el hook · notifica · timeout de 24 h
└── lib/
    ├── agent/
    │   ├── instructions.md          ← comportamiento del agente (texto plano)
    │   └── instructions.ts          lo lee en un "use step"
    ├── domain/                      mock in-memory: pacientes, turnos, facturas, labs
    │   ├── store.ts
    │   └── briefing.ts              arma el resumen previo del paciente
    ├── approvals/                   tipos + registro de pendientes (vista para la UI)
    └── slack/                       Block Kit + cliente + verificación de firma
```

---

## Notas de producción

Es un demo; para llevarlo a producción:

- **Datos**: `src/lib/domain/store.ts` es un mock en memoria (se re-siembra en cada
  arranque). Reemplazar por una base real — toda lectura/escritura ya pasa por
  funciones chicas para facilitar el cambio.
- **Registro de pendientes** (`src/lib/approvals/registry.ts`): estado local del
  proceso. En multi-instancia, respaldarlo en Redis/Postgres. La fuente de verdad
  ya es el hook del workflow; el registro es solo una vista para el panel.
- **Deploy**: el Workflow DevKit está pensado para Vercel (persistencia y colas
  gestionadas). En local corre con `next dev` sin infraestructura extra.
- **PHI**: no usar datos reales de pacientes. Este repo no implementa los
  controles de una historia clínica real (auditoría, cifrado, RBAC, HIPAA/HDS).
- **Cumplimiento clínico**: el agente hace tareas administrativas y escala todo lo
  clínico. No sustituye criterio médico.
