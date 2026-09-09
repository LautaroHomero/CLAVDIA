# Secretario médico · agente con aprobación humana

Un agente de **secretaría médica** cuyo comportamiento se define en **texto plano**
([`src/lib/agent/`](src/lib/agent)) y que ejecuta un flujo **human-in-the-loop**:
cuando una acción es sensible (renovar una receta, reembolsar una factura alta, un
pedido ambiguo…), **pausa el workflow** y le pide a una persona que apruebe o
aclare — por **Slack** o desde la propia UI — y recién entonces continúa.

Cada persona entra con **perfil (paciente/profesional) + nombre + PIN** y, según su rol (**médico/a**,
**recepción** o **paciente**), el agente cambia sus instrucciones, las
herramientas disponibles y a qué datos puede acceder.

Construido para el _Plaude Engineering Challenge_.

| Requisito del challenge | Implementación |
| --- | --- |
| UI en Next.js para interactuar con el agente | App Router + `useChat`, con login por rol — [`src/app`](src/app) |
| Agente con `DurableAgent` (Workflow DevKit) + paso HITL por Slack | [`src/workflows/secretary/`](src/workflows/secretary) |
| Instrucciones en texto plano con escenarios de aprobación | [`src/lib/agent/instructions.md`](src/lib/agent/instructions.md) + [`roles/*.md`](src/lib/agent/roles) |
| Repo en GitHub + README | este repo |

---

## Roles

| Rol | Entra como | Qué le pide al agente | Aprobaciones |
| --- | --- | --- | --- |
| **Médico/a** | Dra. Ruiz / Dr. Sosa | Su agenda, fichas de pacientes, su **bandeja de aprobaciones**, renovar recetas | Es la autoridad: actúa directo. No genera aprobaciones (solo `askHumanInput` ante ambigüedad real). |
| **Recepción** | Sofía | Agendar / cancelar / reprogramar, tomar pedidos de receta, facturación — relatando lo que pide cada paciente | Dispara `requestHumanApproval` hacia el/la médico/a. |
| **Paciente** | María Gómez / Jorge Fernández | Ver **su** ficha y turnos, sacar/cancelar turnos, pedir su receta | Todo lo sensible se escala. Solo ve su propio registro (forzado en el servidor). |

Las reglas de cada rol viven en [`src/lib/agent/roles/<rol>.md`](src/lib/agent/roles)
y se anexan a la base [`instructions.md`](src/lib/agent/instructions.md). El
servidor además limita el **set de herramientas** por rol
([`TOOLS_BY_ROLE`](src/workflows/secretary/tools.ts)) y pasa el `Actor` a cada
tool para acotar los datos (un paciente nunca ve otra ficha).

### Login

En `/login` elegís **Soy paciente** o **Soy profesional**, escribís tu **nombre**
(sin importar mayúsculas ni acentos) y tu **PIN** de 4 dígitos. "Cerrar sesión"
está arriba a la derecha del chat.

Usuarios sembrados:

| Nombre | Perfil | PIN |
| --- | --- | --- |
| Dra. Elena Ruiz | profesional (médico/a) | `2468` |
| Dr. Martín Sosa | profesional (médico/a) | `1357` |
| Recepción (Sofía) | profesional (recepción) | `1234` |
| María Gómez | paciente | `1111` |
| Jorge Fernández | paciente | `2222` |

**Paciente nuevo:** en la pantalla de paciente, _"¿Sos nuevo/a? Registrate"_ crea
la ficha + un login (nombre, DNI, fecha de nacimiento, cobertura, PIN) y entra.
Un profesional o un paciente ya logueado también puede dar de alta a otra persona
pidiéndoselo al agente (`registerPatient`).

---

## Cómo funciona

```
Login (perfil + nombre + PIN) ─► cookie de sesión firmada (Actor: userId, role, patientId?/providerId?)
        │
Paciente/Recepción/Médico ─► /api/chat  ─► start(secretaryWorkflow, [messages, actor])
                                              │
                                              ├─ loadAgentInstructions(role)  "use step"  (base + roles/<role>.md)
                                              ├─ DurableAgent.stream({ activeTools: TOOLS_BY_ROLE[role],
                                              │                        experimental_context: actor })
                                              │     ├─ tools de secretaría  "use step"  ─► SQLite (data/clinic.db)
                                              │     └─ requestHumanApproval / askHumanInput
                                              │            │
                                              │            ├─ notifyHuman()  "use step"  ─► Slack (chat.postMessage)
                                              │            │                             └─► fila en SQLite (pending_requests)
                                              │            ▼   el workflow SE SUSPENDE en un hook (0 recursos, durable)
                                              │        await humanHook  ◄──── resumeHook(token, decisión)
                                              │            ▲                        │
                                              │            │           ┌───────────┴───────────┐
                                              │            │     POST /api/approvals     POST /api/slack/actions
                                              │            │     (panel de la UI)        (botones de Slack, firma verificada)
                                              │            └─ finalizeHuman() "use step" ─► actualiza Slack + marca resuelto
                                              │
                                              └─ stream de respuesta ─► UI (SSE)
```

- **El token del hook es el `toolCallId`** de la llamada del agente: los dos
  endpoints que reanudan el flujo (UI y Slack) no necesitan estado extra.
- La **fila de pendientes vive en SQLite**, así que el paso del workflow, la UI y
  el webhook de Slack ven lo mismo (un `Map` en memoria no sobrevive al
  aislamiento por-step del Workflow DevKit).
- Sin Slack configurado, el pedido aparece igual en el panel de la UI.
- La suspensión es **durable e ilimitada**: no consume recursos y sobrevive a
  reinicios y redeploys.

---

## Escenarios de aprobación (en `instructions.md`)

| Situación | Herramienta | Nota |
| --- | --- | --- |
| Briefing del paciente | `getPatientBriefing` | El agente **siempre** arranca resumiendo (antecedentes, alergias, medicación, turnos, pendientes). |
| Alta de paciente nuevo | `registerPatient` | Cualquier rol. El agente junta nombre, DNI, fecha de nacimiento y cobertura, confirma y crea la ficha. Sin aprobación; no duplica por DNI. |
| Renovación de receta | `requestHumanApproval` → `createPrescriptionRenewal` | Recepción/paciente la escalan; el/la médico/a la hace directo. |
| Reembolso ≥ $50.000 o motivo poco claro | `requestHumanApproval` → `refundInvoice` | |
| Cancelar/reprogramar < 24 h o estudio caro | `requestHumanApproval` → `cancelAppointment` | |
| Sobreturno / urgencia / fuera de horario | `requestHumanApproval` → `scheduleAppointment` | |
| Enviar resultados o datos clínicos al paciente | `requestHumanApproval` → `sendPatientMessage` | |
| Identidad ambigua / falta un dato | `askHumanInput` | Homónimos (María vs. Mario Gómez), datos que no cierran. |
| Consulta clínica ("¿es grave?") | — | El agente no responde: deriva al profesional. |

---

## Puesta en marcha

Requisitos: **Node ≥ 20**, herramientas de compilación de C (para `better-sqlite3`)
y una API key de Anthropic con saldo.

```bash
git clone <este-repo>
cd plaude-medical-secretary
npm install
cp .env.example .env.local     # completá ANTHROPIC_API_KEY (y AUTH_SECRET)
npm run dev                     # http://localhost:3000
```

En el primer arranque se crea y siembra `data/clinic.db` (SQLite, gitignored).
Entrá, elegí un usuario, ingresá su PIN (tabla de arriba) y probá los escenarios.

- Si `better-sqlite3` no carga: `npm rebuild better-sqlite3`.
- Observabilidad de los workflows: `npx workflow web`.

### Variables de entorno

| Variable | Requerida | Descripción |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | Modelo del agente. https://console.anthropic.com (necesita saldo). |
| `AUTH_SECRET` | recomendada | Firma la cookie de sesión. Sin ella usa un default de dev. |
| `AGENT_MODEL` | — | Id de modelo Anthropic. Default `claude-sonnet-4-5`. |
| `SLACK_BOT_TOKEN` | — | Bot token (`xoxb-…`). Sin esto, el HITL usa solo la UI. |
| `SLACK_SIGNING_SECRET` | — | Verifica la firma de los webhooks de Slack. |
| `SLACK_APPROVAL_CHANNEL` | — | **ID** del canal de aprobaciones (ej. `C0123ABCDE`). |

---

## Conectar Slack (opcional)

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest** → pegá:

   ```json
   {
     "display_information": { "name": "Secretario Médico" },
     "features": { "bot_user": { "display_name": "secretario-medico" } },
     "oauth_config": { "scopes": { "bot": ["chat:write", "chat:write.public"] } },
     "settings": {
       "interactivity": {
         "is_enabled": true,
         "request_url": "https://<tu-host-público>/api/slack/actions"
       }
     }
   }
   ```

2. **Install to Workspace** → copiá el **Bot User OAuth Token** (`xoxb-…`).
3. **Basic Information → App Credentials → Signing Secret**.
4. Creá un canal, invitá al bot (`/invite @secretario-medico`) y poné su **ID** en
   `SLACK_APPROVAL_CHANNEL` (canal → _About_ → abajo del todo).
5. En local, exponé el puerto y usá esa URL como _Request URL_:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

   (La URL de `trycloudflare.com` cambia en cada arranque: actualizá el _Request
   URL_ de la app cada vez. Para algo estable, deploy a Vercel.)

Ignorá la pantalla de "Install Slack CLI / `slack run`": eso es para apps Bolt en
Socket Mode. Acá Slack llama al webhook `/api/slack/actions` (ya en el manifiesto).

---

## Estructura

```
src/
├── app/
│   ├── page.tsx                  server: valida sesión → redirect /login o <ChatApp>
│   ├── chat-app.tsx              cliente: chat + panel de aprobaciones (por rol)
│   ├── login/page.tsx            selector de usuario + PIN
│   └── api/
│       ├── auth/{login,logout,me,users}   sesión (kind + nombre + PIN scrypt, cookie firmada)
│       ├── patients/route.ts     alta de paciente por autogestión (crea ficha + login)
│       ├── chat/route.ts         start(secretaryWorkflow, [messages, actor]) + stream SSE
│       ├── approvals/route.ts    GET pendientes (scope por rol) · POST decisión → resumeHook
│       └── slack/actions/route.ts  webhook de interactividad de Slack → resumeHook
├── workflows/secretary/
│   ├── workflow.ts               "use workflow": DurableAgent, activeTools + context por rol
│   ├── tools.ts                  herramientas ("use step") + TOOLS_BY_ROLE + human tools
│   ├── hooks.ts                  defineHook<HumanResponse>()
│   └── request-human.ts          suspende en el hook · notifica (Slack + DB)
└── lib/
    ├── agent/
    │   ├── instructions.md       comportamiento base (texto plano)
    │   └── roles/{medico,recepcion,paciente}.md
    ├── auth/{pin.ts,session.ts}  scrypt + cookie HMAC
    ├── db/
    │   ├── schema.ts  connection.ts  seed.ts   SQLite (better-sqlite3)
    │   └── repo.ts               todas las queries tipadas
    ├── domain/{types.ts,briefing.ts}
    ├── approvals/{types.ts,registry.ts}   fila HITL (tabla pending_requests)
    └── slack/{client.ts,blocks.ts}        Block Kit + verificación de firma
```

---

## Notas de producción

Es un demo:

- **Base de datos**: SQLite local (`data/clinic.db`), sembrada en cada primer
  arranque. Todas las queries pasan por `src/lib/db/repo.ts` — cambiar a Postgres
  es reemplazar ese archivo y `connection.ts`.
- **Auth**: usuario + PIN con `scrypt` y cookie firmada con HMAC. Suficiente para
  el demo, no para producción (sin rate-limiting, rotación, MFA, etc.).
- **Deploy**: el Workflow DevKit apunta a Vercel (persistencia y colas
  gestionadas). SQLite local no aplica en serverless: ahí iría Turso/Postgres.
- **PHI**: datos ficticios. Falta todo lo de una historia clínica real (auditoría,
  cifrado en reposo, RBAC fino, HIPAA/HDS).
- **Clínico**: el agente hace tareas administrativas y escala todo lo clínico. No
  sustituye criterio médico.
