# CLAVDIA · Secretario médico con aprobación humana

Un **agente de IA para la secretaría de un consultorio médico**. Su comportamiento
está definido en **archivos de texto plano** (no en código) y toda acción sensible
—renovar una receta, reembolsar una factura alta, un pedido ambiguo— **pausa el
workflow y le pide a una persona que apruebe o aclare, por Slack o desde la propia
app**, antes de continuar. La pausa es *durable*: el flujo puede quedar esperando
minutos o días sin consumir recursos y sobrevive a reinicios y redeploys.

Es **multi-consultorio**: cualquiera crea su organización con un wizard, y desde
ahí carga profesionales y pacientes con **solo el DNI** si ya están en el sistema.
Cada persona entra con **email o DNI + PIN**; el PIN nunca se reparte a mano — la
persona lo elige la primera vez con **"Olvidé mi PIN"** (código de un solo uso al
email o WhatsApp de su ficha). Según su rol —**profesional** (médico/a de cualquier
especialidad, psicólogo/a…), **secretaría administrativa** o **paciente**— cambian
sus instrucciones, sus herramientas y a qué datos puede acceder. La app tiene
**dos vistas**: el chat con el agente y una **vista Sistema sin IA** (calendario
mensual, fichas, política de turnos) para operar a mano lo mismo que hace el agente.

Construido para el _Plaude Engineering Challenge_.

---

## 1. Los cuatro pasos del challenge

| Paso | Pedido | Dónde está |
| --- | --- | --- |
| **1** | UI simple en Next.js para interactuar con el agente | App Router + `useChat` (streaming SSE). [`chat-app.tsx`](src/app/chat-app.tsx) (vista **Asistente**) y [`system-view.tsx`](src/app/system-view.tsx) + `system-calendar/patients/shared` (vista **Sistema**, sin IA: agendar / editar fichas a mano), login en [`login/page.tsx`](src/app/login/page.tsx). |
| **2** | Agente con `DurableAgent` de Workflow DevKit + paso human-in-the-loop por Slack | [`src/workflows/secretary/workflow.ts`](src/workflows/secretary/workflow.ts) (el `DurableAgent`), [`hooks.ts`](src/workflows/secretary/hooks.ts) + [`request-human.ts`](src/workflows/secretary/request-human.ts) (la suspensión y el reanudado), [`src/app/api/slack/actions/route.ts`](src/app/api/slack/actions/route.ts) (webhook de Slack). |
| **3** | Instrucciones base en texto plano con escenarios que requieren aprobación | [`src/lib/agent/instructions.md`](src/lib/agent/instructions.md) (base) + [`src/lib/agent/roles/*.md`](src/lib/agent/roles) (por rol). |
| **4** | Email a opentowork@plaude.com con el link del repo | Enviado por separado. |

Directivas del challenge (`use next`, `use workflow`, `use github`, `use readme`) → Next.js 16, Workflow DevKit (`workflow` + `@workflow/ai`), repo en GitHub, este README.

---

## 2. Arquitectura

### 2.1 Ciclo de vida de un mensaje

```
Login ((email | DNI) + PIN)   ·   "Olvidé mi PIN" → código de un solo uso → PIN nuevo
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
                              │       ├─ cada tool de dominio              → "use step"  → Postgres (Supabase)
                              │       └─ requestHumanApproval / askHumanInput   (corre en contexto de workflow)
                              │              │
                              │              ├─ notifyHuman()  "use step"  ─► Slack chat.postMessage (Block Kit)
                              │              │                             └─► INSERT pending_requests (Postgres)
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
3. **La fila vive en Postgres, no en memoria.** Cada `"use step"` corre en una
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

### 2.4 Controles de costo del agente

Todo en [`workflow.ts`](src/workflows/secretary/workflow.ts):

- **`maxSteps: 10`** acota el loop de tool-calling: una tool que devuelve error en
  bucle no puede encadenar llamadas al modelo indefinidamente. **`maxOutputTokens:
  2048`** es un tope de seguridad (las respuestas del chat son un párrafo).
- **Prompt caching de Anthropic.** El system prompt (base + rol + fecha +
  "quién sos") y los esquemas de las tools son byte-estables durante toda la
  conversación → se marcan como **prefijo cacheado con `ttl: "1h"`** (el default
  son 5 min; se sube porque el workflow puede quedar suspendido en un hook mucho
  rato entre steps). La **cola de la conversación** lleva un breakpoint de 5 min
  aparte, así las múltiples llamadas dentro de un mismo turno (una por
  tool round-trip) releen el historial desde cache en vez de re-facturarlo.
- **Contabilidad por step** (`onStepFinish`): loguea `input / output / cacheRead
  / cacheWrite` por organización y rol (`[secretary] llm-step …`). Solo cuenta
  tokens; no registra contenido. Sirve para verificar que el cache pega y para
  medir uso por consultorio.

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

### 4.1 Login e identidad

`/login` → **email o DNI + PIN**, para los tres roles (`identifier` en
`POST /api/auth/login`: si tiene `@` es email, si no es DNI). El PIN es de 4
dígitos, se guarda con `scrypt` + salt, y la sesión es una cookie `HttpOnly`
firmada con HMAC (`AUTH_SECRET`). Si el staff pertenece a más de un consultorio y
no eligió, el endpoint responde `{ needsOrg: true, organizations: [...] }` y la UI
pide con cuál entrar; la cookie guarda ese `activeOrgId` (se cambia cerrando
sesión o con el selector del encabezado, `POST /api/auth/switch-org`).

**La identidad se ancla en el DNI**, no en el email. Dar de alta a alguien que ya
está en el sistema (paciente que se atiende en otro consultorio, profesional que
trabaja en varios) es **solo el DNI**: se lo suma a la organización sin volver a
pedir datos. Persona nueva → nombre + email + teléfono (+ especialidad si es
profesional). `users` guarda `dni` y `phone` además del `email`; el índice único
por DNI ignora puntos y espacios.

**El PIN no se reparte a mano.** Toda cuenta nace sin PIN (`pin_hash = ''`); la
persona lo elige la primera vez con **"Olvidé mi PIN"**:

1. `POST /api/auth/pin-reset/request` — email o DNI → **código de 6 dígitos de un
   solo uso** al email de la ficha (o WhatsApp si se pide y hay teléfono). El
   código se guarda **hasheado** (nunca en claro), vence en 10 min, y hay
   *cooldown* de 60 s para no spamear. La respuesta HTTP es **idéntica exista o no
   la cuenta** → no sirve para enumerar emails/DNIs registrados.
2. `POST /api/auth/pin-reset/confirm` — email/DNI + código + PIN nuevo. Máximo 5
   intentos y el código se quema. **Paciente** → queda logueado en el acto (probó
   que controla el canal). **Staff** → se le pide iniciar sesión (puede tener que
   elegir consultorio).

El envío sale por [`src/lib/notify`](src/lib/notify) — transporte *pluggable*
(`NOTIFY_TRANSPORT`): el default `log` imprime el código en la consola del server
(alcanza para dev y un primer deploy); `resend` / `twilio` se enchufan sin tocar
el resto del código.

**Altas (todas siguen el mismo patrón DNI-first):**

- **Paciente** (staff, chat o vista Sistema): DNI conocido → se lo suma y se le
  asegura un login sin PIN (`ensurePatientLogin`); DNI nuevo → nombre, nacimiento,
  cobertura, email y teléfono. En ambos casos entra con DNI/email + "Olvidé mi
  PIN".
- **Profesional / secretaría** (`POST /api/professionals`, solo `canAdmin`): DNI
  conocido → se lo suma (el profesional con `providers` + agenda propias en esta
  organización); DNI nuevo → nombre, email, teléfono (+ tipo/especialidad de
  `SPECIALTIES` si es profesional). Dedup por DNI y después por email.
- **Paciente por autogestión** (_"Soy paciente y no tengo cuenta"_, sin sesión):
  si el DNI ya tiene ficha **y todavía no tiene login**, para reclamarlo el
  **email y el teléfono deben coincidir** con los de la ficha (`normEmail` /
  `normPhone`) → si no, `403`; si ya tiene login → `409` ("recuperá el PIN").
- **Registrar un consultorio nuevo** → **wizard de 3 pasos** (`POST
  /api/organizations`): (1) el consultorio — nombre, dirección, localidad,
  teléfono, horarios; (2) tu cuenta — nombre, **DNI**, email, **teléfono**, y si
  sos *secretaría administrativa* o *profesional* (con especialidad y consultorio);
  (3) confirmar. Quien funda queda con `membership.can_admin` **aunque elija
  "profesional"**, así una consulta unipersonal puede seguir sumando gente. El
  PIN se elige igual con "Olvidé mi PIN".

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
- **Los endpoints REST manuales** (`/api/appointments/**`, `/api/patients/**`,
  `/api/providers/settings`, `/api/appointment-changes`) repiten el mismo control
  del lado del servidor: un paciente solo toca su ficha y sus turnos; un médico,
  solo su propia agenda; recepción, solo su consultorio activo. La UI nunca es la
  autoridad.
- **`AUTH_SECRET` en producción**: si no está seteado (o mide < 32 chars, o es el
  default de dev), la app **no arranca** — un secreto conocido dejaría forjar
  cookies de sesión y suplantar cualquier rol/consultorio. En dev cae al default.
  La cookie lleva `Secure` solo en producción (para que el `http` local funcione).
- **Recuperación de PIN** (`pin_reset_codes`): el código va **hasheado con salt**
  por fila, con TTL de 10 min, tope de 5 intentos (después se quema) y *cooldown*
  de reenvío. La respuesta del endpoint `request` no cambia según exista o no la
  cuenta → **sin enumeración**. El destino se muestra siempre enmascarado
  (`ma••••@dominio`, `••• 4040`).

### Consultorios sembrados

| Consultorio | Profesionales |
| --- | --- |
| **Consultorio Belgrano** | Dra. Elena Ruiz (clínica), Dr. Martín Sosa (cardiología) |
| **Centro Médico Palermo** | Dra. Elena Ruiz (clínica), Dra. Sofía Paz (dermatología), Lic. Paula Bianchi (psicología) |
| **Clínica del Deporte** | Dr. Nicolás Ferrari (medicina del deporte) |

### Usuarios sembrados

Los datos de ejemplo cargados en la base dejan el PIN puesto (para no pasar por
"Olvidé mi PIN" en cada prueba), así que entran con **email + PIN**. Los
pacientes de ejemplo también entran con su **DNI** (`getUserByDni` cae a buscar
por la ficha). Las altas nuevas —hechas desde la app— arrancan sin PIN.

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
  (chat) y `POST /api/professionals` (vista Sistema) dedup por **DNI**: si la
  persona ya está en el sistema, se la suma a esta organización sin re-tipear
  datos (el profesional con `providers` + agenda propias acá).
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

`scheduleAppointment` / `cancelAppointment` / `rescheduleAppointment` no tienen la
lógica propia: llaman a [`src/lib/domain/scheduling.ts`](src/lib/domain/scheduling.ts)
(`bookAppointment` / `cancelAppointment` / `rescheduleAppointment` +
`refreshWaitingNotices`), **el mismo módulo** que usan los endpoints REST de la
vista Sistema. Una sola implementación de "reservar / liberar / reprogramar y
reacomodar los avisos de demora", con la autorización afuera.

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

### 5.7 Altas (DNI-first, sin PIN a mano)

| Tool | Roles | Qué hace |
| --- | --- | --- |
| `registerPatient` | profesional, recepción | **DNI conocido** → se lo suma al consultorio activo y se le asegura un login sin PIN (`ensurePatientLogin`), sin pedir nada más. **DNI nuevo** → además nombre, nacimiento (AAAA-MM-DD), cobertura, email y teléfono. En los dos casos el paciente entra con su DNI/email + "Olvidé mi PIN". |
| `registerProfessional` | **secretaría o profesional fundador** (`canAdmin`) | `role: "medico"` (default) o `"recepcion"`. **DNI conocido** → se suma a la organización: el profesional con `providers` + `membership` + **agenda** propias; la secretaría con `membership` `can_admin`. **DNI nuevo** → además nombre, email, teléfono (+ tipo/especialidad de `SPECIALTIES` si es `medico`). Dedup por DNI y después email. **Nunca se asigna un PIN**: la persona lo elige con "Olvidé mi PIN". También como formulario en la vista Sistema ("+ Agregar al equipo"). |

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

El mismo dominio, **operable a mano**, sin gastar tokens. `GET /api/system` /
`/api/calendar-grid` alimentan la lectura (polling); las mutaciones van a
endpoints REST dedicados que comparten la lógica con el agente (`scheduling.ts`).
Cada acción vuelve a chequear rol / consultorio / propiedad en el servidor.

**Staff** (médico/a y secretaría) — pestañas:

- **Calendario** — un **calendario mensual** (`MonthCalendar`): elegís
  profesional (el médico queda fijo al suyo), ves cuántos turnos y cuántos huecos
  por día, entrás a un día y ahí **agendás** (elegís paciente con `PatientPicker`
  + horario con `SlotPicker` → `POST /api/appointments`), **cancelás** o
  **reprogramás** cada turno (`PATCH/DELETE /api/appointments/[id]`). Cancelar o
  mover un turno de hoy reacomoda los avisos de demora igual que por el chat.
- **Lista** — la agenda del consultorio como lista por día, con las mismas
  acciones por fila + botón **"+ Nuevo turno"**.
- **Pacientes** — buscador de los pacientes del consultorio
  (`/api/patients/search`: nombre / DNI / email / teléfono). Abrís una ficha y
  **editás** datos, cobertura, alergias, condiciones y notas
  (`PATCH /api/patients/[id]`); **agregás / quitás medicación**
  (`/api/patients/[id]/medications[/medId]`); y **"+ Nuevo paciente"**: el campo
  es el **DNI** — si ya está en el sistema alcanza con eso; si es nuevo/a se
  despliegan nombre, nacimiento, cobertura, email y teléfono.
- **Profesionales** — solo si `canAdmin`: la lista del equipo + **"+ Agregar al
  equipo"** (`POST /api/professionals`, toggle **Profesional / Secretaría**).
  Primer campo: el **DNI**. Si la persona ya está en el sistema, con eso se la
  suma; si es nueva se piden nombre, email, teléfono y —si es profesional— el
  **tipo** de `SPECIALTIES` (con "Otra…"). **Sin campo de PIN**: entra con "Olvidé
  mi PIN". Checklist de _Primeros pasos_ mientras no haya profesionales.

Panel derecho del staff: _Mi perfil_, _Consultorio_ (dirección + localidad,
horarios, teléfono) y —solo para el médico— **_Cambios de turno (mi agenda)_**:
dos políticas por profesional (`provider_settings`, `PATCH /api/providers/settings`):

| Ajuste | Opciones |
| --- | --- |
| **¿Quién puede sacar o cambiar turnos?** | `anyone` (incluye al paciente) · `staff_only` (solo recepción y el/la profesional) |
| **Cambios del paciente con < 24 h** | `direct` · `needs_approval` (queda pendiente de aprobación) |

Cuando un cambio del paciente cae en `needs_approval`, se crea una fila en
`appointment_change_requests` y aparece en **_Pedidos de cambio_** (del médico, o
de todo el consultorio para recepción): **Aprobar** aplica la
cancelación/reprogramación, **Rechazar** la descarta (`POST /api/appointment-changes`).

**Paciente** — su calendario (turnos de **todos** sus consultorios) con
**cancelar / reprogramar** por turno *respetando la política del profesional*
(`manageFlags`: bloqueado si es `staff_only`; si es `< 24 h` + `needs_approval`,
el botón crea un pedido en vez de aplicar el cambio). Más _Mi ficha_ (datos,
cobertura, alergias, condiciones, medicación con marca de crónica, consultorios)
y _Mis pedidos de cambio_ en revisión.

---

## 7. Modelo de datos (Postgres / Supabase)

La base es **Postgres** (un proyecto de [Supabase](https://supabase.com) por
entorno — dev / test / prod), accedida de forma async con
[`postgres.js`](https://github.com/porsager/postgres) desde
[`src/lib/db/connection.ts`](src/lib/db/connection.ts). El schema **no** corre
en el path de request: son migraciones `.sql` versionadas en
[`src/lib/db/migrations/`](src/lib/db/migrations/), aplicadas con
`npm run db:migrate` ([`scripts/migrate.ts`](scripts/migrate.ts), runner en
[`src/lib/db/migrate.ts`](src/lib/db/migrate.ts)). Todas las queries pasan por
[`src/lib/db/repo.ts`](src/lib/db/repo.ts) (async de punta a punta). No hay
seed local ni datos embebidos en el repo — cada entorno **es** un proyecto de
Supabase real y sus datos viven ahí; el SQL editor de Supabase sirve para
consultar (o cargar) cualquiera de los tres directamente.

| Tabla | Para qué |
| --- | --- |
| `organizations` | los consultorios (inquilinos): nombre, `slug`, dirección, **localidad**, horarios, teléfono. |
| `users` | login **global**: nombre, **email** + **dni** (ambos con índice único, cualquiera sirve para entrar), **phone**, rol, `pin_hash`/`pin_salt` (scrypt; `''` = todavía sin PIN), `patient_id`. |
| `pin_reset_codes` | códigos de un solo uso para recuperar / activar el PIN: `code_hash`/`code_salt`, `channel` (`email`/`whatsapp`), `sent_to` (enmascarado), `attempts`, `expires_at`, `consumed_at`. |
| `memberships` | staff × organización: `role`, `provider_id` en ese consultorio y `can_admin`. Un profesional puede tener varias. |
| `patient_organizations` | paciente × organización: en qué consultorios está asociado. |
| `providers` | profesionales (por consultorio): nombre, especialidad, consultorio, `default_fee`. |
| `provider_prices` | prácticas con nombre y precio, por profesional. |
| `provider_settings` | política de **cambios manuales de turno** por profesional: `who_can_change` (`anyone`/`staff_only`), `late_change_policy` (`direct`/`needs_approval`). |
| `patients`, `medications` | fichas y medicación — **globales** (una ficha por persona). |
| `slots` | grilla de horarios (09–12, cada 30', próximos días hábiles), `taken`. |
| `appointments` | turnos: `status` (`scheduled` / `in-progress` / `completed` / `cancelled`), `price`, `actual_start`/`actual_end`, `created_via`. |
| `appointment_change_requests` | cambio de turno de un paciente con < 24 h que espera visto bueno del profesional: `kind` (`cancel`/`reschedule`), `new_slot_id`, `status` (`pending`/`approved`/`rejected`). |
| `invoices`, `lab_results` | facturación y resultados. |
| `prescription_requests`, `patient_messages` | pedidos de receta y mensajes enviados. |
| `pending_requests` | **la fila human-in-the-loop** (fuente de verdad compartida por workflow, UI y Slack). |
| `daily_reports` | snapshots del cierre del día (consultorio + por profesional). |
| `clinic_state` | el "reloj" simulado por profesional/día. |
| `patient_notices` | los avisos de demora que se le muestran a cada paciente. |

Todas las tablas transaccionales (`providers`, `slots`, `appointments`,
`appointment_change_requests`, `invoices`, `lab_results`, `prescription_requests`,
`patient_messages`, `pending_requests`, `clinic_state`, `patient_notices`,
`daily_reports`) llevan `organization_id` y las queries de `repo.ts` filtran por él.

---

## 8. Puesta en marcha

Requisitos: **Node ≥ 20**, un proyecto de **Supabase** (gratis alcanza para
dev/test) y una **API key de Anthropic con saldo**.

```bash
git clone <este-repo>
cd plaude-medical-secretary
npm install
cp .env.example .env.local          # ANTHROPIC_API_KEY, AUTH_SECRET, DATABASE_URL(_DIRECT)
npm run db:migrate                   # crea el schema en el proyecto de DATABASE_URL_DIRECT
npm run dev                          # http://localhost:3000
```

`DATABASE_URL` / `DATABASE_URL_DIRECT` salen del proyecto de Supabase en
Settings → Database (connection string pooled y directa respectivamente — ver
[`.env.example`](.env.example)); apuntar esas dos variables a otro proyecto es
todo lo que hace falta para moverse entre dev / test / prod, el código no sabe
en qué entorno está. No hay seed local: la data (organizaciones, profesionales,
pacientes de ejemplo) ya vive cargada en cada proyecto de Supabase — entrá y
elegí un usuario de la tabla de arriba. Para agregar una
migración nueva: un archivo `NNNN_algo.sql` en `src/lib/db/migrations/` y
`npm run db:migrate` en cada entorno.

- Observabilidad de los workflows (runs, steps, reintentos, suspensiones): `npx workflow web`.

### Variables de entorno

| Variable | Requerida | Descripción |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | Modelo del agente. https://console.anthropic.com |
| `DATABASE_URL` | ✅ | Connection string **pooled** de Supabase (puerto 6543) — la usa la app en runtime. |
| `DATABASE_URL_DIRECT` | ✅ para migrar | Connection string **directa** de Supabase (puerto 5432) — solo la usa `npm run db:migrate`. |
| `AUTH_SECRET` | ✅ en prod | Firma la cookie de sesión (HMAC). En dev cae a un default; **en producción es obligatoria** y debe medir ≥ 32 chars random o la app no arranca (`openssl rand -base64 48`). |
| `AGENT_MODEL` | — | Id de modelo Anthropic. Default `claude-haiku-4-5-20251001` (barato para probar; se puede subir a `claude-sonnet-4-5`). |
| `NOTIFY_TRANSPORT` | — | Canal de salida de los códigos de recuperación de PIN. Default `log` (los imprime en la consola del server — alcanza para dev y un primer deploy). `resend` / `twilio` se implementan en [`src/lib/notify`](src/lib/notify) y se activan acá (con `RESEND_API_KEY` / `TWILIO_*`). |
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
  pide **elegir cuál** (Belgrano / Palermo). Datos o PIN mal → error genérico.
- Con Dra. Ruiz adentro (entró por Belgrano), usá el **selector de consultorio
  del encabezado**: la agenda y el panel cambian a Palermo.
- Login `28.444.123` / `1111` (María por **DNI** en vez de email) → misma sesión.
- **"Olvidé mi PIN"** con `maria.gomez@example.com` o `28444123` → mirá la consola
  del server: el transporte `log` imprime el código de 6 dígitos. Pegalo + un PIN
  nuevo → María queda logueada. Pedirlo para un email inexistente devuelve el
  **mismo** mensaje (sin filtrar si existe).
- "Registrar un consultorio nuevo" → **wizard de 3 pasos**. En el paso 2 va tu
  **DNI + teléfono** y si sos *profesional* (elegís el **tipo**, con "Otra…") o
  *secretaría*. Al crear entrás directo; primera vez sin PIN → te manda a "Olvidé
  mi PIN". En la vista Sistema aparece la pestaña **Profesionales** con
  **"+ Agregar al equipo"** y la checklist de primeros pasos.
- "Soy paciente y no tengo cuenta" → alta por autogestión (DNI + datos; para
  reclamar una ficha existente, email y teléfono tienen que coincidir).
- Login `martin.sosa@clavdia.test` / `1357` (médico **sin** admin) → en Sistema
  **no** ve la pestaña Profesionales; `nicolas.ferrari@clavdia.test` / `2580`
  (profesional fundador) **sí**. En "+ Agregar al equipo" el primer campo es el
  **DNI**: uno nuevo despliega nombre/email/teléfono/tipo; sin campo de PIN.
- Mirá los paneles: profesional ve *Consultorio · ahora* + *Mi agenda*; paciente
  ve *Tu turno de hoy* + *Mis turnos* (solo los suyos).
- Conmutá **Asistente / Sistema** en el encabezado (se recuerda; la conversación
  no se pierde al volver).
- **Vista Sistema, staff**: en *Calendario* entrá a un día y **agendá** un turno
  (paciente + horario); en *Lista* **cancelá / reprogramá** una fila; en
  *Pacientes* abrí una ficha y editá alergias o sumá una medicación.
- **Política de cambios**: entrá como `sofia.paz@clavdia.test` / `3690`, en el
  panel derecho poné *"¿Quién puede sacar o cambiar turnos?" → Solo recepción y
  yo*. Ahora entrá como su paciente: los botones **cancelar / reprogramar** de la
  vista Sistema aparecen bloqueados. Con *< 24 h → Requieren mi aprobación*, el
  botón crea un **pedido de cambio** que la Dra. Paz ve en *Pedidos de cambio*.
- Aprobar/rechazar en el panel **no** gasta (va directo a la API).

**Con el agente** (recargá la página al cambiar de usuario; resetea el historial).
"Recepción `1234`", "Dra. Ruiz `2468`", etc. son atajos: el login real es
`recepcion.belgrano@clavdia.test` / `1234`, `elena.ruiz@clavdia.test` / `2468`, …
(ver tabla de usuarios sembrados).

| # | Entrás como | Escribí | Esperás |
| --- | --- | --- | --- |
| A1 | Recepción `1234` | `Llamó Jorge Fernández, DNI 20.999.888, quiere renovar la receta de Apixabán.` | Busca al paciente, briefing, "⏸ esperando a una persona". Aparece la tarjeta en el panel y en Slack. **Apretá Aprobar** → el chat sigue solo y registra la renovación. |
| A2 | Recepción | `Una Gómez quiere cancelar su turno de mañana, no sé si María o Mario.` | `askHumanInput` (homónimos). Respondé en el panel. |
| A3 | Recepción | `Alta de profesional: Dr. Bruno Vega, DNI 27.111.222, bruno.vega@clavdia.test, tel 11-5555-9090, traumatología, consultorio 6.` | `registerProfessional` (DNI nuevo) → crea profesional + `membership` + agenda, **sin PIN**. Entra con DNI/email + "Olvidé mi PIN". |
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
│   ├── system-view.tsx              cliente: shell de la vista Sistema (pestañas, panel lateral, pedidos de cambio)
│   ├── system-calendar.tsx          cliente: calendario mensual + reserva/cancelación/reprogramación
│   ├── system-patients.tsx          cliente: buscador de pacientes + edición de ficha + medicación
│   ├── system-shared.tsx            cliente: CalRow (acciones por turno), PatientPicker, SlotPicker, helpers
│   ├── login/page.tsx               (email|DNI)+PIN, picker de consultorio, "Olvidé mi PIN", alta de paciente, wizard de consultorio
│   ├── globals.css                  tokens de diseño (Tailwind v4 @theme)
│   └── api/
│       ├── chat/route.ts            start(secretaryWorkflow, [messages, actor]) + stream SSE
│       ├── approvals/route.ts       GET pendientes (scope por rol) · POST decisión → resumeHook
│       ├── slack/actions/route.ts   webhook de Slack (firma verificada) → resumeHook
│       ├── agenda/route.ts          estado vivo de la agenda — vista Asistente (role-aware)
│       ├── calendar/route.ts        mini-calendario — vista Asistente (role-aware)
│       ├── system/route.ts          datos de la vista Sistema (agenda org-wide + fichas + pedidos de cambio)
│       ├── calendar-grid/route.ts   conteos por día del calendario mensual + turnos/huecos de un día
│       ├── appointments/route.ts            POST: agendar (agente y manual comparten scheduling.ts)
│       ├── appointments/[id]/route.ts       PATCH reprogramar · DELETE cancelar (o crea pedido de cambio)
│       ├── appointment-changes/route.ts     GET pendientes · POST aprobar/rechazar un cambio de turno
│       ├── slots/route.ts           huecos libres para los pickers de reserva/reprogramación
│       ├── providers/settings/route.ts      GET/PATCH la política de cambios del profesional
│       ├── patients/route.ts        alta de paciente (staff DNI-first + ensurePatientLogin; o autogestión con verificación email+tel)
│       ├── patients/search/route.ts         lista/búsqueda de pacientes del consultorio (staff)
│       ├── patients/[id]/route.ts            GET/PATCH la ficha (scope por rol/consultorio)
│       ├── patients/[id]/medications/[...]   POST/DELETE medicación de la ficha
│       ├── organizations/route.ts   GET lista pública · POST wizard self-serve (org + usuario fundador)
│       ├── professionals/route.ts   POST alta de profesional o secretaría (DNI-first, sin PIN; solo canAdmin)
│       └── auth/
│           ├── {login,logout,me,switch-org}/route.ts   login por email|DNI, sesión
│           └── pin-reset/{request,confirm}/route.ts     código de un solo uso → PIN nuevo
├── workflows/secretary/
│   ├── workflow.ts                  "use workflow": DurableAgent, prompt cacheado, maxSteps, contabilidad por step
│   ├── tools.ts                     todas las tools ("use step") + TOOLS_BY_ROLE
│   ├── hooks.ts                     defineHook<HumanResponse>()
│   └── request-human.ts             notifyHuman / await hook / finalizeHuman
└── lib/
    ├── agent/
    │   ├── instructions.md          comportamiento base (texto plano)
    │   ├── instructions.ts          lo lee en un "use step" (base + roles/<role>.md)
    │   └── roles/{medico,recepcion,paciente}.md
    ├── auth/{pin.ts,session.ts,actor.ts}   scrypt (PIN + código de recuperación) + cookie HMAC (AUTH_SECRET fuerte en prod) + hidratación del Actor
    ├── db/
    │   ├── connection.ts             singleton postgres.js (pooled, prepare:false)
    │   ├── migrate.ts migrations/*.sql   runner de migraciones versionadas
    │   ├── slots.ts                  genera la grilla de horarios de un profesional nuevo
    │   └── repo.ts                  todas las queries tipadas y async (scope por organización)
    ├── domain/
    │   ├── {types.ts,briefing.ts,clock.ts,specialties.ts}
    │   ├── scheduling.ts            reservar / cancelar / reprogramar + refresco de avisos (agente + REST)
    │   └── appointment-view.ts      manageFlags (qué puede hacer el actor a mano) + vista de pedidos de cambio
    ├── approvals/{types.ts,registry.ts}   la fila pending_requests
    ├── notify/index.ts                    envío de códigos (transporte pluggable: log · resend · twilio)
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
- **Una sola implementación de agendado, dos entradas.** El agente (`tools.ts`) y
  los endpoints REST de la vista Sistema llaman al mismo `scheduling.ts`; la
  autorización queda afuera, en cada caller. La vista sin IA no es una maqueta:
  hace las mismas mutaciones que el chat.
- **La política de cambios vive en los datos** (`provider_settings`), no en el
  prompt: cada profesional decide si el paciente puede autogestionar turnos y qué
  pasa con los cambios de último momento. Vale para el chat y para la vista
  Sistema.
- **Prompt caching deliberado.** System prompt + tools como prefijo cacheado a 1 h
  (el workflow puede quedar suspendido mucho rato); cola de conversación con
  breakpoint de 5 min para no re-facturar el historial en cada tool round-trip.
  `onStepFinish` mide tokens por consultorio.
- **Fail-closed en auth de producción.** Sin `AUTH_SECRET` fuerte la app no
  arranca, en vez de correr con una clave conocida.
- **Identidad anclada en el DNI, PINs que nadie reparte.** El alta de una persona
  ya conocida es solo el DNI (sin re-tipear datos ni crear duplicados); el PIN lo
  elige la propia persona con "Olvidé mi PIN" (código de un solo uso al canal que
  ya está en su ficha). Un staff nunca conoce ni dicta el PIN de otro. El envío es
  un módulo aparte (`src/lib/notify`) con transporte pluggable — cambiar de la
  consola a Resend/Twilio no toca el resto del código.
- **Reloj simulado por profesional.** No hay "now" real durante una consulta en el
  demo; el reloj lo mueve el profesional al marcar inicio/fin. En producción, un
  workflow durable con `sleep()` haría el cierre del día y detectaría demoras.

### Qué es demo y qué iría a producción

| Demo | Producción |
| --- | --- |
| Postgres (Supabase) ya en dev/test; prod en el tier free | Upgradear el proyecto de prod antes del launch (los free se pausan por inactividad) |
| Web corriendo local (`npm run dev`) | Elegir hosting (Vercel u otro) y wirear `DATABASE_URL`/`DATABASE_URL_DIRECT` por entorno |
| Login (email\|DNI) + PIN + cookie HMAC (`AUTH_SECRET` fuerte y cookie `Secure` en prod) | OAuth/SSO, rotación, MFA, rate-limiting por IP |
| Recuperación de PIN por código de 6 dígitos; transporte `log` (consola) por default | Provider real (Resend / Twilio WhatsApp) vía `NOTIFY_TRANSPORT`; rate-limit y captcha en `request` |
| Reclamo de ficha existente verificando que email + teléfono coincidan con la ficha | Verificación real del canal (link / OTP), no "coincide con lo cargado" |
| "Hoy" y la agenda se anclan a la hora del arranque; el reloj lo mueve el profesional | Reloj real + workflow `sleep()` para el cierre del día y la detección automática de demoras |
| Contabilidad de tokens a `console.info` | Métrica agregada por consultorio → billing / límites |
| Datos de paciente ficticios | Historia clínica real: auditoría, cifrado en reposo, RBAC fino, HIPAA/HDS |
| Túnel `trycloudflare` para Slack | Deploy en Vercel con URL estable |

El agente hace **tareas administrativas** y escala todo lo clínico. No sustituye
criterio médico.
