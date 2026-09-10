# CLAVDIA · Secretario médico con aprobación humana

Un **agente de IA para la secretaría de un consultorio médico**. Su comportamiento
está definido en **archivos de texto plano** (no en código) y toda acción sensible
—renovar una receta, reembolsar una factura alta, un pedido ambiguo— **pausa el
workflow y le pide a una persona que apruebe o aclare, por Slack o desde la propia
app**, antes de continuar. La pausa es *durable*: el flujo puede quedar esperando
minutos o días sin consumir recursos y sobrevive a reinicios y redeploys.

Cada persona entra con **email + PIN**. Según su rol —**profesional** (médico/a de
cualquier especialidad, psicólogo/a…), **secretaría administrativa** o
**paciente**— cambian sus instrucciones, sus herramientas y a qué datos puede
acceder.

Construido para el _Plaude Engineering Challenge_.

---

## 1. Los cuatro pasos del challenge

| Paso | Pedido | Dónde está |
| --- | --- | --- |
| **1** | UI simple en Next.js para interactuar con el agente | App Router + `useChat` (streaming SSE). [`src/app/chat-app.tsx`](src/app/chat-app.tsx) (vista Asistente) y [`src/app/system-view.tsx`](src/app/system-view.tsx) (vista Sistema, sin IA), login en [`src/app/login/page.tsx`](src/app/login/page.tsx). |
| **2** | Agente con `DurableAgent` de Workflow DevKit + paso human-in-the-loop por Slack | [`src/workflows/secretary/workflow.ts`](src/workflows/secretary/workflow.ts) (el `DurableAgent`), [`hooks.ts`](src/workflows/secretary/hooks.ts) + [`request-human.ts`](src/workflows/secretary/request-human.ts) (la suspensión y el reanudado), [`src/app/api/slack/actions/route.ts`](src/app/api/slack/actions/route.ts) (webhook de Slack). |
| **3** | Instrucciones base en texto plano con escenarios que requieren aprobación | [`src/lib/agent/instructions.md`](src/lib/agent/instructions.md) (base) + [`src/lib/agent/roles/*.md`](src/lib/agent/roles) (por rol). |
| **4** | Email a opentowork@plaude.com con el link del repo | Enviado por separado. |

Directivas del challenge (`use next`, `use workflow`, `use github`, `use readme`) → Next.js 16, Workflow DevKit (`workflow` + `@workflow/ai`), repo en GitHub, este README.

---

## 2. Arquitectura

### 2.1 Ciclo de vida de un mensaje

```
Login (email + PIN)
   └─► cookie de sesión firmada (HMAC)  ─►  Actor { userId, role, name, patientId?, activeOrg? { providerId?, specialty?, canAdmin } }

Usuario escribe en el chat
   └─► POST /api/chat  ─►  start(secretaryWorkflow, [messages, actor])          ← Workflow DevKit
                              │
                              │  "use workflow"  (función durable, replay determinístico)
                              │
                              ├─ loadAgentInstructions(role)     "use step"     lee instructions.md + roles/<role>.md
                              │
                              ├─ new DurableAgent({ model, instructions, tools })
                              │     .stream({ messages, writable: getWritable(),
                              │              activeTools: TOOLS_BY_ROLE[role],
                              │              experimental_context: actor })
                              │       │
                              │       ├─ cada llamada al modelo            → "use step"  (reintentos, aislada)
                              │       ├─ cada tool de dominio              → "use step"  → SQLite (data/clinic.db)
                              │       └─ requestHumanApproval / askHumanInput   (corre en contexto de workflow)
                              │              │
                              │              ├─ notifyHuman()  "use step"  ─► Slack chat.postMessage (Block Kit)
                              │              │                             └─► INSERT pending_requests (SQLite)
                              │              │
                              │              ▼   humanHook.create({ token: toolCallId })
                              │           await hook       ⏸  EL WORKFLOW SE SUSPENDE (0 CPU, durable)
                              │              ▲
                              │              │  resumeHook(token, { approved | answer, ... })
                              │              │        ┌──────────────────────┴──────────────────────┐
                              │              │   POST /api/approvals                    POST /api/slack/actions
                              │              │   (botón del panel de la UI)             (botón de Slack, firma verificada)
                              │              │
                              │              └─ finalizeHuman()  "use step"  ─► edita el mensaje de Slack + UPDATE status='resolved'
                              │
                              └─ el agente sigue con la respuesta del humano
                                    stream de UIMessageChunks ─► run.readable ─► SSE ─► useChat (UI)
```

### 2.2 Qué aporta el Workflow DevKit

- **`"use workflow"`** convierte `secretaryWorkflow` en una función *durable*: sus
  entradas y salidas quedan en un event log y, ante un crash o un deploy nuevo, se
  **re-ejecuta de forma determinística** desde donde estaba.
- **`"use step"`** marca cada efecto (llamada al modelo, query a la DB, POST a
  Slack) como un paso *aislado y con reintentos*. Mientras un step corre, el
  workflow **se suspende sin consumir recursos**.
- **`DurableAgent`** (de `@workflow/ai/agent`) envuelve el loop del AI SDK: cada
  turno del modelo y cada ejecución de tool es un step durable. Escribe la
  respuesta como `UIMessageChunk`s a `getWritable()`, que sale por `run.readable`
  como SSE hacia el `useChat` del cliente.
- **Hooks** (`defineHook` / `hook.create` / `resumeHook`): es *la* primitiva de
  human-in-the-loop. Al hacer `await hook` dentro del workflow, la corrida se
  suspende hasta que alguien externo llama `resumeHook(token, payload)`. No hay
  polling, ni colas propias, ni estado a mano.

### 2.3 El paso human-in-the-loop, en detalle

Todo pasa por una sola función, [`requestHuman()`](src/workflows/secretary/request-human.ts),
que exponen dos tools: **`requestHumanApproval`** (Sí/No + nota) y **`askHumanInput`**
(texto libre, para aclaraciones).

1. **El token del hook es el `toolCallId`** de la llamada del agente. Es único y
   determinístico, así que los dos endpoints que reanudan (panel de la UI y
   webhook de Slack) **no necesitan ninguna tabla de correlación**: reciben el
   token en el payload y llaman `resumeHook(token, …)`.
2. **`notifyHuman` (step)** postea a Slack con botones Block Kit *y* hace `INSERT`
   en la tabla `pending_requests`. La fila lleva `run_id`, `kind`, `summary`,
   `risk_level`, `patient_name`, `requested_by`, y la referencia al mensaje de
   Slack (`channel` + `ts`) para poder editarlo después.
3. **La fila vive en SQLite, no en memoria.** Cada `"use step"` corre en una
   invocación de ruta aislada; un `Map` en memoria no lo verían ni `/api/approvals`
   ni `/api/slack/actions`. La DB es la fuente de verdad compartida.
4. **Sin Slack configurado**, el pedido aparece igual en el panel de la app. Slack
   y el panel son **intercambiables**: el primero que responde gana; el otro, al
   refrescar, ve que ya está resuelto.
5. **`finalizeHuman` (step)** reescribe el mensaje de Slack ("Resuelto — Aprobado
   por …") y marca la fila `resolved`.
6. **La espera es ilimitada.** El hook puede quedar días suspendido sin costo.
   (Se sacó un `Promise.race` con `sleep()` que dejaba un timer colgado; un límite
   real se implementaría con un `Run.wakeUp()` programado desde afuera.)
7. **Verificación de firma de Slack**: `/api/slack/actions` valida el header
   `X-Slack-Signature` (HMAC-SHA256 sobre `v0:timestamp:body`, ventana de 5 min)
   antes de tocar el workflow.

---

## 3. Instrucciones en texto plano (paso 3 del challenge)

El agente **no tiene lógica de negocio en el código**: su criterio está en Markdown.

```
src/lib/agent/
├── instructions.md          ← base compartida (rol, briefing obligatorio,
│                               los escenarios de aprobación, qué no hacer nunca,
│                               cómo redactar un pedido de aprobación, estilo)
└── roles/
    ├── medico.md             ← "sos su secretario/a; es la autoridad, actúa directo"
    ├── recepcion.md          ← "relatás pedidos de pacientes; escalás al médico/a"
    └── paciente.md           ← "solo su ficha; nada clínico; todo lo sensible se escala"
```

En cada corrida, [`workflow.ts`](src/workflows/secretary/workflow.ts) compone el
system prompt así:

```
instructions.md  +  roles/<role>.md  +  "## Fecha de referencia (hoy es …, mañana es …)"
                                     +  "## Quién sos" (nombre + especialidad, solo profesional)
```

La fecha se inyecta porque el modelo, si no, resuelve "hoy"/"mañana" a una fecha
inventada. El demo **se ancla a la hora real** en la que arrancás el server
([`src/lib/domain/clock.ts`](src/lib/domain/clock.ts)): "hoy" es la fecha de hoy y
la agenda en vivo de la Dra. Ruiz se siembra al **próximo horario disponible,
+30 y +60 min** (más dos turnos ya atendidos, para la recaudación). Como la DB
persiste, esos horarios quedan fijos al primer arranque; `rm -rf data && npm run
dev` vuelve a sembrar contra el nuevo "ahora".

### Escenarios que exigen intervención humana (en `instructions.md`)

| Situación | Qué hace el agente |
| --- | --- |
| **Briefing del paciente** | Antes de cualquier acción, `getPatientBriefing`: edad, cobertura, antecedentes, alergias, medicación crónica, próximos turnos, facturas impagas, resultados sin revisar. |
| **Renovación de receta / cambio de medicación** | `requestHumanApproval` → recién si aprueban, `createPrescriptionRenewal`. (El profesional lo hace directo sobre sus pacientes.) |
| **Reembolso ≥ $50.000** o de monto poco claro | `requestHumanApproval` → `refundInvoice`. |
| **Cancelar/reprogramar con < 24 h** o estudio de alto costo | `requestHumanApproval` → `cancelAppointment` / `rescheduleAppointment`. |
| **Sobreturno, urgencia el mismo día, fuera de horario** | `requestHumanApproval` → `scheduleAppointment`. |
| **Enviar resultados o datos clínicos** al paciente | `requestHumanApproval` → `sendPatientMessage`. |
| **Identidad ambigua / intención poco clara / falta un dato** | `askHumanInput` (ej. homónimos: María vs. Mario Gómez). |
| **Consulta clínica** ("¿es grave?", "¿qué tomo?") | No responde: deriva al profesional u ofrece turno. |

Cambiar el comportamiento del agente = editar estos `.md`. No hay recompilar.

---

## 4. Roles, seguridad y login

### 4.1 Login

`/login` → **email + PIN**, para los tres roles. El PIN es de 4 dígitos, se
guarda con `scrypt` + salt, y la sesión es una cookie `HttpOnly` firmada con HMAC
(`AUTH_SECRET`). El email identifica al usuario y sus membresías; si el staff
pertenece a más de un consultorio y no eligió, el endpoint responde
`{ needsOrg: true, organizations: [...] }` y la UI pide con cuál entrar. La cookie
guarda ese `activeOrgId`; se cambia cerrando sesión o con el selector del
encabezado (`POST /api/auth/switch-org`).

- **Paciente nuevo:** _"Soy paciente y no tengo cuenta"_ → formulario (nombre,
  DNI, fecha de nacimiento, cobertura, **email**, **consultorio**, PIN) → crea la
  ficha **y** el login, lo asocia a ese consultorio y entra. Si el DNI ya tenía
  ficha, la reutiliza y solo suma la asociación.
- **Registrar un consultorio nuevo:** _"Registrar un consultorio nuevo"_ → un
  **wizard de 3 pasos** (`POST /api/organizations`):
  1. **El consultorio** — nombre, dirección, localidad, teléfono, horarios.
  2. **Tu cuenta** — nombre completo, email, PIN, y **cómo vas a usar la
     plataforma**: *secretaría administrativa* o *profesional de la salud* (con
     especialidad y consultorio).
  3. **Confirmar** — repaso y creación.
  Quien funda el consultorio queda con permisos de administración
  (`membership.can_admin`) **aunque elija "profesional"**, así una consulta de una
  sola persona puede seguir dando de alta a más profesionales.

### 4.2 Los tres roles

| Rol | Es | El agente… | Aprobaciones |
| --- | --- | --- | --- |
| **Profesional** (`medico`) | Médico/a de cualquier especialidad, psicólogo/a, deportólogo/a… | Le muestra su agenda, fichas, su bandeja de aprobaciones; renueva recetas y ajusta facturas **directo** (es la autoridad). | Casi no genera. Solo `askHumanInput` ante ambigüedad real. |
| **Secretaría administrativa** (`recepcion`) | Mostrador / administración | Agenda / cancela / reprograma, toma pedidos de receta, facturación, altas (pacientes **y profesionales**), **cierre de caja**. | **Dispara** `requestHumanApproval` hacia el/la profesional. |
| **Paciente** (`paciente`) | El propio paciente | Solo **su** ficha y turnos; sacar/cancelar turnos; pedir su receta; ver la demora de hoy. | Todo lo sensible se escala. |

### 4.3 Cómo se aplica la seguridad

- **`TOOLS_BY_ROLE`** ([`tools.ts`](src/workflows/secretary/tools.ts)) → `activeTools`
  del `DurableAgent`: el modelo **ni ve** las herramientas que no le corresponden
  (un paciente no tiene `findPatient` ni `refundInvoice`). `registerProfessional`
  se agrega solo para la secretaría **o** un profesional fundador (`canAdmin`).
- El **`Actor`** viaja a cada tool vía `experimental_context`. Los steps lo usan
  para acotar datos: `scopePatientId()` fuerza `patientId = actor.patientId` para
  el rol paciente, así **nunca puede pedir la ficha de otro** aunque el modelo lo
  intente.
- Chequeos dentro de cada step (ej. `closeDay` exige `recepcion`;
  `registerProfessional` y `POST /api/professionals` exigen `activeOrg.canAdmin`).

### Consultorios sembrados

| Consultorio | Profesionales |
| --- | --- |
| **Consultorio Belgrano** | Dra. Elena Ruiz (clínica), Dr. Martín Sosa (cardiología) |
| **Centro Médico Palermo** | Dra. Elena Ruiz (clínica), Dra. Sofía Paz (dermatología), Lic. Paula Bianchi (psicología) |
| **Clínica del Deporte** | Dr. Nicolás Ferrari (medicina del deporte) |

### Usuarios sembrados

Todos entran con **email + PIN**.

| Email | Perfil · profesión | Consultorios | PIN |
| --- | --- | --- | --- |
| `elena.ruiz@clavdia.test` | profesional · Clínica Médica | Belgrano **y** Palermo (elige al entrar) | `2468` |
| `martin.sosa@clavdia.test` | profesional · Cardiología | Belgrano | `1357` |
| `sofia.paz@clavdia.test` | profesional · Dermatología | Palermo | `3690` |
| `paula.bianchi@clavdia.test` | profesional · Psicología | Palermo | `1470` |
| `nicolas.ferrari@clavdia.test` | profesional · Medicina del deporte · **fundador** (`canAdmin`) | Clínica del Deporte | `2580` |
| `recepcion.belgrano@clavdia.test` | secretaría administrativa | Belgrano | `1234` |
| `recepcion.palermo@clavdia.test` | secretaría administrativa | Palermo | `4321` |
| `recepcion.deporte@clavdia.test` | secretaría administrativa | Clínica del Deporte | `5678` |
| `maria.gomez@example.com` | paciente | Belgrano **y** Palermo | `1111` |
| `jorge.fernandez@example.com` | paciente | Belgrano | `2222` |

Dra. Ruiz demuestra el profesional multi-consultorio; María, el paciente que
opera en varios; Dr. Ferrari, un profesional que **también** administra su
consultorio (puede dar de alta a otros).

### 4.4 Multi-consultorio (multi-tenancy)

Cada **organización** (consultorio) es un inquilino aislado. El modelo:

- **`organizations`** — el consultorio (nombre, `slug`, dirección, **localidad**,
  horarios, teléfono).
- **`memberships`** (`user_id` × `organization_id`) — vincula al **staff** con una
  organización y lleva su `role` (`medico` / `recepcion`), su `provider_id` **en
  esa** organización si es médico/a, y `can_admin` (puede dar de alta
  profesionales / administrar). Un mismo profesional puede tener varias.
- **`patient_organizations`** (`patient_id` × `organization_id`) — en qué
  consultorios está asociado un paciente.
- **`patients`** y **`medications`** son **globales**: una persona tiene **una
  sola ficha**, compartida entre los consultorios donde se atiende. Todo lo
  transaccional (`providers`, `slots`, `appointments`, `invoices`,
  `lab_results`, `pending_requests`, `clinic_state`, …) lleva `organization_id` y
  las queries de [`repo.ts`](src/lib/db/repo.ts) filtran por él.

Cómo lo ve cada rol:

- **Staff** trabaja dentro de **un** consultorio activo (`actor.activeOrg`). Las
  altas, la agenda, los precios y el reporte quedan ahí. `registerProfessional`
  (chat) y `POST /api/professionals` (vista Sistema) reutilizan el usuario si esa
  persona ya tiene cuenta (mismo email); su PIN sigue siendo el de siempre.
- **Paciente** opera en **todos** sus consultorios a la vez (`actor.orgs`): un
  único briefing, una única lista de turnos. `listOrganizations` /
  `joinOrganization` para sumarse a otro; cuando una acción depende del lugar y
  está en varios, el agente pregunta y pasa `organization`.

---

## 5. Catálogo de funciones (tools del agente)

Todas las tools de dominio son `"use step"` (durables, con reintentos). "Aprobación"
= la instrucción manda pasar antes por `requestHumanApproval`; el código **no** la
fuerza (el control es el prompt, como pide el challenge), salvo el scoping de datos
y los chequeos de rol.

### 5.1 Núcleo human-in-the-loop

| Tool | Roles | Qué hace |
| --- | --- | --- |
| `requestHumanApproval` | todos | Suspende el workflow y pide **Sí/No + nota** a una persona (Slack y/o panel). Devuelve `{ approved, note, respondedBy, timedOut }`. Token = `toolCallId`. |
| `askHumanInput` | todos | Igual pero pide **texto libre** (aclaración): identidad ambigua, dato faltante, intención poco clara. Devuelve `{ answer, respondedBy }`. |
| `listPendingApprovals` | profesional | Solo lectura: lista la bandeja de pedidos en espera. La decisión se toma con los botones del panel / Slack, no por chat. |

### 5.2 Identificación y ficha

| Tool | Roles | Qué hace |
| --- | --- | --- |
| `getClinicInfo` | todos | Dirección, horarios, profesionales y preparación de estudios. Staff: su consultorio activo. Paciente en varios: `organization` opcional. |
| `listOrganizations` | paciente | Lista los consultorios de la plataforma (para elegir dónde sumarse). |
| `joinOrganization` | paciente | Asocia al paciente a otro consultorio; después puede sacar turno ahí. |
| `findPatient` | profesional, recepción | Busca por nombre / DNI / email / id **dentro del consultorio activo**. Si hay 0 o >1 coincidencias → `askHumanInput`. |
| `getPatientBriefing` | todos | El resumen del paciente para el día. Para el rol paciente, forzado a su propio `patientId` y abarca todos sus consultorios. |

### 5.3 Turnos

| Tool | Roles | Qué hace | Aprobación |
| --- | --- | --- | --- |
| `listAvailableSlots` | todos | Horarios libres (filtros: fecha, profesional). Paciente en varios consultorios: `organization` opcional. | — |
| `scheduleAppointment` | todos | Agenda un turno en un horario libre. Le calcula y guarda el `price` (matchea el motivo contra las prácticas del profesional, si no usa la consulta estándar). Staff: consultorio activo; paciente: `organization` opcional (y lo asocia si hace falta). | Sobreturno / urgencia / fuera de horario → sí. |
| `cancelAppointment` | todos | Cancela un turno; **libera el slot** y, si es de hoy, avisa a los que esperan que quedó un lugar más temprano. | < 24 h o estudio caro → sí. |
| `rescheduleAppointment` | todos | Cancela + reagenda a otro slot; conserva `price`; reavisa a los que esperan. | Mismas reglas que cancelar. |
| `listMyAgenda` | profesional, recepción | Agenda de turnos (para el profesional, filtrada a su consultorio) con alertas por paciente (resultado pendiente, factura impaga). | — |

### 5.4 Agenda en vivo (la jornada "respira")

El demo simula un reloj por profesional (`clinic_state`) que arranca en el primer
turno y avanza a medida que se atiende. Cada turno guarda `actual_start` /
`actual_end`.

| Tool | Roles | Qué hace |
| --- | --- | --- |
| `getNextPatient` | profesional | El paciente en atención o el próximo, con su resumen del día, **si cumple años** 🎂, horario programado vs. estimado, y cómo viene la agenda (en horario / atrasada / adelantada). |
| `startAttention` | profesional | El "ok" del profesional: registra la hora real de inicio. Recalcula el desfasaje y **avisa por su chat a los pacientes que siguen** si hay atraso/adelanto. |
| `warnDelay` | profesional | **Mientras todavía atiende**: aviso *tentativo* ("puede haber una demora, tu turno podría correrse ~N min") a los que siguen. No cambia la agenda real todavía. |
| `finishAttention` | profesional | Cierra la atención. Con `actualMinutes` si duró distinto (hizo una práctica → 50'). Avanza el reloj, recalcula la demora **real** y reavisa. |
| `markAttended` | profesional, recepción | Marca un turno como `completed` → suma a la recaudación del día. |
| `getMyVisitStatus` | paciente | Su turno de hoy: programado → estimado, demora, si hay lugar antes, y los avisos que le mandó el consultorio. |
| `changeMyVisitTime` | paciente | `later` = confirma que viene más tarde (no reagenda, lo tranquiliza). `earlier` = si hay un hueco antes con el mismo profesional, **adelanta el turno**. |

### 5.5 Recetas, mensajes, facturación

| Tool | Roles | Qué hace | Aprobación |
| --- | --- | --- | --- |
| `createPrescriptionRenewal` | profesional, recepción | Registra una renovación de receta **ya aprobada** (pasa `approvedBy`). | Recepción/paciente escalan primero; el profesional la hace directo. |
| `sendPatientMessage` | profesional, recepción | Mensaje al paciente. Recordatorios → directo. | Si incluye resultados / datos clínicos → sí. |
| `refundInvoice` | profesional, recepción | Marca una factura como reembolsada. | Recepción: ≥ $50.000 o motivo poco claro → sí. Profesional: directo. |

### 5.6 Precios y cierre de caja

| Tool | Roles | Qué hace |
| --- | --- | --- |
| `listPrices` | profesional, recepción | Precios de un profesional: consulta estándar + prácticas con nombre. El profesional ve el suyo; recepción indica de quién. |
| `setConsultationFee` | profesional, recepción | Fija el precio de la consulta estándar. El profesional sobre sí mismo; recepción sobre cualquiera. |
| `addPriceItem` | profesional, recepción | Agrega una práctica con su precio (ej. "Crioterapia" $30.000). |
| `getDailyReport` | profesional, recepción | Resumen del día: atendidos / cancelados / pendientes / **recaudado**, con detalle. El profesional ve el suyo; recepción todo el consultorio (o filtra por uno). |
| `closeDay` | **solo recepción** | Cierre del día: calcula y **guarda** el resumen del consultorio y el de cada profesional (`daily_reports`), y lo **publica en Slack**. Simula lo que en producción dispararía un workflow durable al terminar el último turno. |

### 5.7 Altas

| Tool | Roles | Qué hace |
| --- | --- | --- |
| `registerPatient` | profesional, recepción | Da de alta un paciente (nombre, DNI, fecha de nacimiento, cobertura) **y lo asocia al consultorio activo**. No duplica por DNI (si ya tenía ficha, solo suma la asociación). Crea la ficha, no el login (eso lo hace el propio paciente desde `/login`). |
| `registerProfessional` | **secretaría o profesional fundador** (`canAdmin`) | Da de alta a alguien del equipo **en el consultorio activo**. `role: "medico"` (default) → profesional: nombre con título, **email**, **tipo/especialidad** (deportólogo, cardiólogo, psicólogo, kinesiólogo…), consultorio, PIN → `provider` + `membership` + login + **agenda**. `role: "recepcion"` → secretaría administrativa: nombre, email, PIN (sin especialidad ni agenda). Si esa persona ya tenía cuenta (mismo email), reutiliza su usuario y PIN. También como formulario en la vista Sistema. |

---

## 6. La UI

Tailwind v4, tokens de diseño extraídos de una referencia real (tinta carbón
`#222832` sobre lienzo `#f0f3f5`, tarjetas blancas, tipografía Pretendard).

Un **encabezado** común, siempre visible, con: quién sos + consultorio activo, un
**conmutador de vista** (`Asistente` / `Sistema`, se recuerda en `localStorage`),
el **selector de consultorio** (si el/la profesional pertenece a más de uno —
`POST /api/auth/switch-org` + `router.refresh()`) y **Salir**. El estado del chat
(`useChat`) vive en el contenedor, así que cambiar de vista **no pierde la
conversación**.

### 6.1 Vista **Asistente** (IA)

El chat con streaming (`useChat` + SSE) y, a la derecha, un **panel lateral
distinto por rol**.

**Profesional** — layout más ancho:

- **Consultorio · ahora**: reloj + estado de la agenda (`+20 min` / en horario /
  adelantada); paciente en atención o próximo con su briefing y 🎂; botones
  **Iniciar atención** / **Terminé** (envían el mensaje al chat, que dispara la
  tool).
- **Mi agenda** (mini-calendario): todos sus turnos agrupados por día, con estado
  (punto de color), 🎂, y cuántos huecos libres hay por día.
- **Bandeja de aprobaciones**: las tarjetas de `requestHumanApproval` /
  `askHumanInput` con botones **Aprobar / Rechazar** o campo de respuesta. Estos
  botones van directo a `/api/approvals` → `resumeHook` (no pasan por el modelo).

**Paciente** — layout más angosto:

- **Tu turno de hoy**: programado → estimado, badge de demora (o "puede haber una
  demora" si el profesional hizo `warnDelay`), los avisos del consultorio, y
  botones **Voy más tarde** / **Ir más temprano (HH:MM)**.
- **Mis turnos** (mini-calendario): **solo los suyos**, con el profesional y la
  especialidad.
- **Tus pedidos en revisión**: sus `requestHumanApproval` en curso (solo lectura).

Endpoints que alimentan los paneles (polling): `GET /api/agenda` (estado vivo,
role-aware) y `GET /api/calendar` (el mini-calendario, role-aware).

### 6.2 Vista **Sistema** (sin IA)

El mismo dato, sin agente: un **calendario** grande a la izquierda y un panel de
fichas a la derecha. Todo de solo lectura — las altas y los cambios siguen
haciéndose desde el chat. Una sola llamada: `GET /api/system` (polling 5 s).

- **Staff** (médico/a y **secretaría**): pestañas **Calendario · Lista ·
  Pacientes** (agenda **de todo el consultorio activo**: hora · paciente ·
  profesional · motivo · estado, con 🎂), y a la derecha _Mi perfil_ y
  _Consultorio_ (dirección + localidad, horarios, teléfono).
  Si el usuario administra el consultorio (`canAdmin`) aparece además la pestaña
  **Profesionales**: la lista del equipo + **"+ Agregar al equipo"**
  (`POST /api/professionals`) — toggle **Profesional / Secretaría**; si es
  profesional se elige el **tipo** de una lista (`SPECIALTIES`) con opción
  "Otra…"; y una checklist de _Primeros pasos_ mientras no haya profesionales.
- **Paciente**: su calendario (turnos de **todos** sus consultorios) y _Mi ficha_
  — datos personales, cobertura, alergias, condiciones activas, medicación
  (marca las crónicas) y en qué consultorios está.

---

## 7. Modelo de datos (SQLite, `data/clinic.db`)

Se crea y siembra sola en el primer arranque y **persiste** entre ejecuciones.
En cada conexión: `SCHEMA` (`CREATE … IF NOT EXISTS`) →
[`migrate.ts`](src/lib/db/migrate.ts) (agrega columnas/índices nuevos in situ, sin
tocar los datos) → `seedIfEmpty` (solo si no hay organizaciones). Todas las
queries pasan por [`src/lib/db/repo.ts`](src/lib/db/repo.ts).

| Tabla | Para qué |
| --- | --- |
| `organizations` | los consultorios (inquilinos): nombre, `slug`, dirección, **localidad**, horarios, teléfono. |
| `users` | login **global**: nombre, **email** (único, identificador de login), rol, `pin_hash`/`pin_salt` (scrypt), `patient_id`. |
| `memberships` | staff × organización: `role`, `provider_id` en ese consultorio y `can_admin`. Un profesional puede tener varias. |
| `patient_organizations` | paciente × organización: en qué consultorios está asociado. |
| `providers` | profesionales (por consultorio): nombre, especialidad, consultorio, `default_fee`. |
| `provider_prices` | prácticas con nombre y precio, por profesional. |
| `patients`, `medications` | fichas y medicación — **globales** (una ficha por persona). |
| `slots` | grilla de horarios (09–12, cada 30', próximos días hábiles), `taken`. |
| `appointments` | turnos: `status` (`scheduled` / `in-progress` / `completed` / `cancelled`), `price`, `actual_start`/`actual_end`. |
| `invoices`, `lab_results` | facturación y resultados. |
| `prescription_requests`, `patient_messages` | pedidos de receta y mensajes enviados. |
| `pending_requests` | **la fila human-in-the-loop** (fuente de verdad compartida por workflow, UI y Slack). |
| `daily_reports` | snapshots del cierre del día (consultorio + por profesional). |
| `clinic_state` | el "reloj" simulado por profesional/día. |
| `patient_notices` | los avisos de demora que se le muestran a cada paciente. |

Todas las tablas transaccionales (`providers`, `slots`, `appointments`,
`invoices`, `lab_results`, `prescription_requests`, `patient_messages`,
`pending_requests`, `clinic_state`, `patient_notices`, `daily_reports`) llevan
`organization_id` y las queries de `repo.ts` filtran por él.

---

## 8. Puesta en marcha

Requisitos: **Node ≥ 20**, toolchain de C (para compilar `better-sqlite3`), y una
**API key de Anthropic con saldo**.

```bash
git clone <este-repo>
cd plaude-medical-secretary
npm install
cp .env.example .env.local          # completá ANTHROPIC_API_KEY (y AUTH_SECRET)
npm run dev                          # http://localhost:3000
```

Entrá, elegí un usuario de la tabla de arriba y probá. La DB (`data/clinic.db`)
se siembra en el primer arranque y **persiste** entre `npm run dev`: el esquema
es todo `IF NOT EXISTS`, [`migrate.ts`](src/lib/db/migrate.ts) agrega columnas
nuevas in situ y el seed solo corre si la base está vacía. Borrá `data/` solo si
querés volver a los datos de ejemplo (o `git pull` trae un cambio de esquema no
aditivo).

- Si `better-sqlite3` no carga: `npm rebuild better-sqlite3`.
- Observabilidad de los workflows (runs, steps, reintentos, suspensiones): `npx workflow web`.

### Variables de entorno

| Variable | Requerida | Descripción |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | Modelo del agente. https://console.anthropic.com |
| `AUTH_SECRET` | recomendada | Firma la cookie de sesión. Sin ella usa un default de dev. |
| `AGENT_MODEL` | — | Id de modelo Anthropic. Default `claude-haiku-4-5-20251001` (barato para probar; se puede subir a `claude-sonnet-4-5`). |
| `SLACK_BOT_TOKEN` | — | Bot token (`xoxb-…`). Sin esto, el human-in-the-loop usa solo el panel de la UI. |
| `SLACK_SIGNING_SECRET` | — | Verifica la firma de los webhooks de Slack. |
| `SLACK_APPROVAL_CHANNEL` | — | **ID** del canal de aprobaciones (ej. `C0123ABCDE`). |

---

## 9. Conectar Slack (opcional)

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest** → pegá:

   ```json
   {
     "display_information": { "name": "CLAVDIA Secretario Médico" },
     "features": { "bot_user": { "display_name": "clavdia" } },
     "oauth_config": { "scopes": { "bot": ["chat:write", "chat:write.public"] } },
     "settings": {
       "interactivity": {
         "is_enabled": true,
         "request_url": "https://<tu-host-público>/api/slack/actions"
       }
     }
   }
   ```

2. **Install to Workspace** → copiá el **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
3. **Basic Information → App Credentials → Signing Secret** → `SLACK_SIGNING_SECRET`.
4. Creá un canal, invitá al bot (`/invite @clavdia`) y poné su **ID** (canal →
   _About_ → abajo del todo) en `SLACK_APPROVAL_CHANNEL`.
5. En local, exponé el puerto y usá esa URL como _Request URL_ de la app:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

   La URL de `trycloudflare.com` cambia en cada arranque: hay que actualizar el
   _Request URL_ de la app cada vez. Para algo estable, deploy a Vercel.

> Ignorá la pantalla de "Install Slack CLI / `slack run`": es para apps Bolt en
> Socket Mode. Acá Slack llama al webhook HTTP `/api/slack/actions` (ya en el
> manifiesto). Con este bot **no se chatea** en Slack: solo se aprueba/rechaza con
> los botones.

---

## 10. Guía de prueba

**Gratis, sin gastar tokens** (login y paneles):

- Login `elena.ruiz@clavdia.test` / `2468` → como está en dos consultorios, la UI
  pide **elegir cuál** (Belgrano / Palermo). Email o PIN mal → error.
- Con Dra. Ruiz adentro (entró por Belgrano), usá el **selector de consultorio
  del encabezado**: la agenda y el panel cambian a Palermo.
- "Registrar un consultorio nuevo" → **wizard de 3 pasos**. Probá el paso 2 como
  *profesional* (elegís el **tipo** de una lista, con "Otra…") y como *secretaría*.
  Al crear entrás directo; en la vista Sistema aparece la pestaña **Profesionales**
  con **"+ Agregar al equipo"** y la checklist de primeros pasos.
- "Soy paciente y no tengo cuenta" → alta por autogestión (ahora con **email**).
- Login `maria.gomez@example.com` / `1111` → *Mis turnos* muestra turnos de
  **Belgrano y Palermo** juntos.
- Login `martin.sosa@clavdia.test` / `1357` (médico **sin** admin) → en Sistema
  **no** ve la pestaña Profesionales; `nicolas.ferrari@clavdia.test` / `2580`
  (profesional fundador) **sí** (toggle Profesional / Secretaría; profesional =
  elegir el tipo).
- Mirá los paneles: profesional ve *Consultorio · ahora* + *Mi agenda*; paciente
  ve *Tu turno de hoy* + *Mis turnos* (solo los suyos).
- Conmutá **Asistente / Sistema** en el encabezado: la vista Sistema muestra el
  calendario del consultorio + _Consultorio_ + _Profesionales_ (staff), o el
  calendario + _Mi ficha_ (paciente). La conversación no se pierde al volver.
- Aprobar/rechazar en el panel **no** gasta (va directo a la API).

**Con el agente** (recargá la página al cambiar de usuario; resetea el historial):

| # | Entrás como | Escribí | Esperás |
| --- | --- | --- | --- |
| A1 | Recepción `1234` | `Llamó Jorge Fernández, DNI 20.999.888, quiere renovar la receta de Apixabán.` | Busca al paciente, briefing, "⏸ esperando a una persona". Aparece la tarjeta en el panel y en Slack. **Apretá Aprobar** → el chat sigue solo y registra la renovación. |
| A2 | Recepción | `Una Gómez quiere cancelar su turno de mañana, no sé si María o Mario.` | `askHumanInput` (homónimos). Respondé en el panel. |
| A3 | Recepción | `Alta de profesional: Dr. Bruno Vega, bruno.vega@clavdia.test, traumatología, consultorio 6, PIN 9090.` | `registerProfessional` → crea profesional + login (por email) + agenda. |
| A4 | Recepción | `Recaudación de hoy del consultorio.` → luego `Cerrá el día.` | `getDailyReport` (total + por profesional) → `closeDay` (guarda + publica en Slack). |
| B1 | Dra. Ruiz `2468` | (o botón "Iniciar atención") `Que pase el que sigue.` | `startAttention`; Mario Gómez 🎂 queda "en atención". |
| B2 | Dra. Ruiz | `Se me complicó con Mario, avisá que me atraso unos 20 minutos.` | `warnDelay` → aviso tentativo a María y Jorge. |
| B3 | Dra. Ruiz | `Terminé. Le hice una práctica, en total 50 minutos.` | `finishAttention(50)` → agenda **+20**; "avisé a María y a Jorge". |
| B4 | Dra. Ruiz | `Renová la receta de Apixabán 5 mg de Jorge Fernández, la autorizo yo.` | `createPrescriptionRenewal` **directo, sin aprobación** (contraste con A1). |
| C1 | María Gómez `1111` | (mirá el panel *Tu turno de hoy*) `Voy a ir más tarde, gracias por avisar.` | El panel muestra `programado → ~estimado, +20 min`. `changeMyVisitTime("later")`. |
| C2 | María Gómez | `Me duele bastante el pecho, ¿qué me tomo?` | **No** da consejo clínico: deriva. |
| C3 | María Gómez | `Pasame la ficha de Jorge Fernández.` | Rechaza: solo tu propia ficha. |
| D1 | Dra. Ruiz `2468` | `María avisó que no viene hoy. Cancelá su turno con vos.` | `cancelAppointment` → "le avisé a Jorge que puede adelantarse". |
| D2 | Jorge Fernández `2222` | (panel *Tu turno de hoy*) botón **Ir más temprano (HH:MM)** | `changeMyVisitTime("earlier")` → el turno pasa al hueco libre. |

Para los casos B/D entrá con **Dra. Ruiz en Consultorio Belgrano** (ahí está
sembrada la agenda en vivo con Mario 🎂, María y Jorge).

Los horarios concretos dependen de la hora del **primer** arranque (la agenda se
siembra al *próximo* horario, +30 y +60 min) y quedan fijos porque la DB
persiste. Para resembrar contra el "ahora": `rm -rf data && npm run dev`.

---

## 11. Estructura del repo

```
src/
├── app/
│   ├── page.tsx                     server: valida la sesión → /login o <ChatApp>
│   ├── chat-app.tsx                 cliente: encabezado + conmutador de vista; vista Asistente (chat + paneles)
│   ├── system-view.tsx              cliente: vista Sistema (calendario + fichas, sin IA)
│   ├── login/page.tsx               email + PIN, picker de consultorio, alta de paciente, wizard de alta de consultorio
│   ├── globals.css                  tokens de diseño (Tailwind v4 @theme)
│   └── api/
│       ├── chat/route.ts            start(secretaryWorkflow, [messages, actor]) + stream SSE
│       ├── approvals/route.ts       GET pendientes (scope por rol) · POST decisión → resumeHook
│       ├── slack/actions/route.ts   webhook de Slack (firma verificada) → resumeHook
│       ├── agenda/route.ts          estado vivo de la agenda (role-aware)
│       ├── calendar/route.ts        mini-calendario de la vista Asistente (role-aware)
│       ├── system/route.ts          datos de la vista Sistema (calendario org-wide + fichas)
│       ├── patients/route.ts        alta de paciente por autogestión (ficha + login por email + join a un consultorio)
│       ├── organizations/route.ts   GET lista pública · POST wizard self-serve (org + usuario fundador, secretaría o profesional)
│       ├── professionals/route.ts   POST alta de profesional en el consultorio activo (solo canAdmin)
│       └── auth/{login,logout,me,switch-org}/route.ts
├── workflows/secretary/
│   ├── workflow.ts                  "use workflow": DurableAgent, instrucciones + activeTools + Actor por rol
│   ├── tools.ts                     todas las tools ("use step") + TOOLS_BY_ROLE
│   ├── hooks.ts                     defineHook<HumanResponse>()
│   └── request-human.ts             notifyHuman / await hook / finalizeHuman
└── lib/
    ├── agent/
    │   ├── instructions.md          comportamiento base (texto plano)
    │   ├── instructions.ts          lo lee en un "use step" (base + roles/<role>.md)
    │   └── roles/{medico,recepcion,paciente}.md
    ├── auth/{pin.ts,session.ts,actor.ts}   scrypt + cookie HMAC + hidratación del Actor (membership → activeOrg)
    ├── db/
    │   ├── schema.ts migrate.ts connection.ts seed.ts slots.ts   SQLite (better-sqlite3), multi-tenant, DB persistente
    │   └── repo.ts                  todas las queries tipadas (scope por organización)
    ├── domain/{types.ts,briefing.ts,clock.ts}
    ├── approvals/{types.ts,registry.ts}   la fila pending_requests
    └── slack/{client.ts,blocks.ts}        Block Kit + verificación de firma
```

---

## 12. Decisiones de diseño

- **El criterio del agente está en Markdown, no en el código.** Es el corazón del
  challenge: cambiar cuándo se pide aprobación no debería requerir un deploy.
- **La fila human-in-the-loop está en la DB, no en memoria.** Los `"use step"` del
  Workflow DevKit corren en rutas aisladas; la UI y el webhook de Slack necesitan
  ver lo mismo. Esto además arregla el bug de "el panel aparece vacío".
- **El token del hook = `toolCallId`.** Elimina toda la tabla de correlación entre
  "pedido" y "corrida suspendida".
- **La espera del hook es ilimitada.** Un `sleep()` de timeout dejaba una
  operación colgada al completar el run; se sacó. Un límite real se haría con un
  `Run.wakeUp()` programado.
- **`activeTools` por rol** en vez de solo chequear permisos dentro de cada tool:
  el modelo ni siquiera *ve* lo que no puede hacer → menos tokens y menos margen
  de error.
- **El scoping de datos del paciente se fuerza en el servidor** (`scopePatientId`),
  no se confía en el prompt.
- **Reloj simulado por profesional.** No hay "now" real durante una consulta en el
  demo; el reloj lo mueve el profesional al marcar inicio/fin. En producción, un
  workflow durable con `sleep()` haría el cierre del día y detectaría demoras.

### Qué es demo y qué iría a producción

| Demo | Producción |
| --- | --- |
| SQLite local, re-sembrada en cada arranque | Postgres/Turso (reemplazar `repo.ts` + `connection.ts`) |
| Login usuario + PIN + cookie HMAC | OAuth/SSO, rotación, MFA, rate-limiting |
| "Hoy" y la agenda se anclan a la hora del arranque; el reloj lo mueve el profesional | Reloj real + workflow `sleep()` para el cierre del día y la detección automática de demoras |
| Datos de paciente ficticios | Historia clínica real: auditoría, cifrado en reposo, RBAC fino, HIPAA/HDS |
| Túnel `trycloudflare` para Slack | Deploy en Vercel con URL estable |

El agente hace **tareas administrativas** y escala todo lo clínico. No sustituye
criterio médico.
