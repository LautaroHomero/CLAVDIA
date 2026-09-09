import { z } from "zod";
import {
  bookSlot,
  cancelAppointmentById,
  createPrescriptionRequest,
  getAppointment,
  getInvoicesForPatient,
  getLabResultsForPatient,
  getPatient,
  getProvider,
  getSlot,
  listAppointments,
  listOpenSlots,
  listProviders,
  recordPatientMessage,
  refundInvoice as refundInvoiceInDb,
  searchPatients,
} from "@/lib/db/repo";
import { buildPatientBriefing } from "@/lib/domain/briefing";
import { listPendingRequests } from "@/lib/approvals/registry";
import type { Actor, Role } from "@/lib/domain/types";
import { requestHuman } from "./request-human";

// The agent passes `experimental_context: Actor` into every tool call.
type ToolCtx = { toolCallId?: string; experimental_context?: unknown } | undefined;

function actorOf(ctx: ToolCtx): Actor | undefined {
  const a = ctx?.experimental_context as Actor | undefined;
  return a && typeof a === "object" && "role" in a ? a : undefined;
}

/** Patients may only ever act on their own record. */
function scopePatientId(ctx: ToolCtx, requested: string): string {
  const actor = actorOf(ctx);
  if (actor?.role === "paciente" && actor.patientId) return actor.patientId;
  return requested;
}

// ---------------------------------------------------------------------------
// Domain steps ("use step" => durable, retried, isolated)
// ---------------------------------------------------------------------------

async function clinicInfoStep() {
  "use step";
  return {
    name: "Consultorio Médico Belgrano",
    address: "Av. Cabildo 2200, piso 3, CABA",
    hours: "Lunes a viernes de 8:00 a 18:00",
    phone: "+54 11 4788-0000",
    providers: listProviders().map((p) => ({ id: p.id, name: p.name, specialty: p.specialty })),
    prep: {
      laboratorio: "Ayuno de 8 horas. Se puede tomar agua.",
      resonancia: "Traer estudios previos. Avisar si tiene marcapasos o prótesis metálicas.",
      ecografiaAbdominal: "Ayuno de 6 horas.",
    },
  };
}

async function findPatientStep({ query }: { query: string }) {
  "use step";
  const matches = searchPatients(query);
  return {
    count: matches.length,
    matches: matches.map((p) => ({
      patientId: p.id,
      fullName: p.fullName,
      dni: p.dni,
      dateOfBirth: p.dateOfBirth,
      coverage: p.coverage,
    })),
  };
}

async function patientBriefingStep({ patientId }: { patientId: string }, ctx: ToolCtx) {
  "use step";
  return buildPatientBriefing(scopePatientId(ctx, patientId));
}

async function availableSlotsStep({ date, providerId }: { date?: string; providerId?: string }) {
  "use step";
  const slots = listOpenSlots({ date, providerId }).slice(0, 20);
  return {
    count: slots.length,
    slots: slots.map((s) => {
      const provider = getProvider(s.providerId);
      return {
        slotId: s.id,
        start: s.start.replace("T", " "),
        durationMinutes: s.durationMinutes,
        provider: provider?.name ?? s.providerId,
        specialty: provider?.specialty,
      };
    }),
  };
}

async function myAgendaStep({ date }: { date?: string }, ctx: ToolCtx) {
  "use step";
  const actor = actorOf(ctx);
  const providerId = actor?.role === "medico" ? actor.providerId : undefined;
  const appts = listAppointments({ providerId, date });
  return {
    count: appts.length,
    scope: providerId ? getProvider(providerId)?.name : "todo el consultorio",
    appointments: appts.map((a) => {
      const patient = getPatient(a.patientId);
      const pendingLabs = getLabResultsForPatient(a.patientId).filter(
        (l) => l.status === "pending-review",
      );
      const unpaid = getInvoicesForPatient(a.patientId).filter((i) => i.status === "unpaid");
      return {
        appointmentId: a.id,
        start: a.start.replace("T", " "),
        patient: patient?.fullName ?? a.patientId,
        patientDni: patient?.dni,
        reason: a.reason,
        provider: getProvider(a.providerId)?.name,
        flags: [
          ...pendingLabs.map((l) => `Resultado pendiente: ${l.panel}`),
          ...unpaid.map((i) => `Factura impaga: ${i.concept} ($${i.amount.toLocaleString("es-AR")})`),
        ],
      };
    }),
  };
}

async function pendingApprovalsStep() {
  "use step";
  const items = listPendingRequests();
  return {
    count: items.length,
    note: "La decisión se toma desde el panel o desde Slack, no desde el chat.",
    requests: items.map((r) => ({
      token: r.token,
      kind: r.kind,
      action: r.action,
      patientName: r.patientName,
      riskLevel: r.riskLevel,
      requestedBy: r.requestedBy,
      createdAt: r.createdAt,
      summary: r.summary,
    })),
  };
}

async function scheduleAppointmentStep(
  { patientId, slotId, reason }: { patientId: string; slotId: string; reason: string },
  ctx: ToolCtx,
) {
  "use step";
  const pid = scopePatientId(ctx, patientId);
  if (!getPatient(pid)) return { ok: false, error: `Paciente ${pid} no existe.` };
  const slot = getSlot(slotId);
  if (!slot) return { ok: false, error: `El horario ${slotId} no existe.` };
  if (slot.taken) return { ok: false, error: `El horario ${slotId} ya fue tomado.` };
  try {
    const apt = bookSlot({ patientId: pid, slotId, reason });
    return {
      ok: true,
      appointmentId: apt.id,
      start: apt.start.replace("T", " "),
      provider: getProvider(apt.providerId)?.name,
      reason: apt.reason,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function cancelAppointmentStep(
  { appointmentId }: { appointmentId: string; reason: string },
  ctx: ToolCtx,
) {
  "use step";
  const existing = getAppointment(appointmentId);
  if (!existing) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  const actor = actorOf(ctx);
  if (actor?.role === "paciente" && actor.patientId && existing.patientId !== actor.patientId) {
    return { ok: false, error: "Ese turno no pertenece a tu ficha." };
  }
  if (existing.status !== "scheduled")
    return { ok: false, error: `El turno ${appointmentId} está ${existing.status}.` };
  const apt = cancelAppointmentById(appointmentId);
  return { ok: true, appointmentId: apt.id, status: apt.status };
}

async function rescheduleAppointmentStep(
  {
    appointmentId,
    newSlotId,
  }: { appointmentId: string; newSlotId: string; reason: string },
  ctx: ToolCtx,
) {
  "use step";
  const existing = getAppointment(appointmentId);
  if (!existing) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  const actor = actorOf(ctx);
  if (actor?.role === "paciente" && actor.patientId && existing.patientId !== actor.patientId) {
    return { ok: false, error: "Ese turno no pertenece a tu ficha." };
  }
  const slot = getSlot(newSlotId);
  if (!slot || slot.taken)
    return { ok: false, error: `El nuevo horario ${newSlotId} no está disponible.` };
  cancelAppointmentById(appointmentId);
  const apt = bookSlot({ patientId: existing.patientId, slotId: newSlotId, reason: existing.reason });
  return {
    ok: true,
    previousAppointmentId: appointmentId,
    appointmentId: apt.id,
    start: apt.start.replace("T", " "),
  };
}

async function prescriptionRenewalStep({
  patientId,
  medication,
  approvedBy,
  note,
}: {
  patientId: string;
  medication: string;
  approvedBy: string;
  note?: string;
}) {
  "use step";
  if (!getPatient(patientId)) return { ok: false, error: `Paciente ${patientId} no existe.` };
  const req = createPrescriptionRequest({
    patientId,
    medication,
    decision: "approved",
    decidedBy: approvedBy,
    note,
  });
  return { ok: true, prescriptionRequestId: req.id, medication: req.medication, status: req.status };
}

async function sendPatientMessageStep({
  patientId,
  message,
}: {
  patientId: string;
  message: string;
}) {
  "use step";
  if (!getPatient(patientId)) return { ok: false, error: `Paciente ${patientId} no existe.` };
  const msg = recordPatientMessage(patientId, message);
  return { ok: true, messageId: msg.id, sentAt: msg.sentAt };
}

async function refundInvoiceStep({
  invoiceId,
  approvedBy,
}: {
  invoiceId: string;
  reason: string;
  approvedBy: string;
}) {
  "use step";
  try {
    const inv = refundInvoiceInDb(invoiceId);
    return { ok: true, invoiceId: inv.id, status: inv.status, amount: inv.amount, approvedBy };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Tool set
// ---------------------------------------------------------------------------

export const secretaryTools = {
  getClinicInfo: {
    description:
      "Datos del consultorio: dirección, horarios, profesionales y preparación de estudios. No requiere aprobación.",
    inputSchema: z.object({}),
    execute: clinicInfoStep,
  },

  findPatient: {
    description:
      "Busca pacientes por nombre, DNI, email o id. Si hay 0 o más de 1 coincidencia, no adivines: usá askHumanInput.",
    inputSchema: z.object({ query: z.string().describe("Nombre, DNI, email o id") }),
    execute: findPatientStep,
  },

  getPatientBriefing: {
    description:
      "Compila el resumen previo del paciente (antecedentes, alergias, medicación, próximos turnos, pendientes). Llamalo SIEMPRE apenas identifiques al paciente, antes de cualquier otra acción.",
    inputSchema: z.object({ patientId: z.string() }),
    execute: patientBriefingStep,
  },

  listMyAgenda: {
    description:
      "Agenda de turnos. Para el rol médico/a viene filtrada por su consultorio; para recepción muestra todos. Incluye alertas por paciente (resultados pendientes, facturas impagas). Filtro opcional por fecha YYYY-MM-DD.",
    inputSchema: z.object({ date: z.string().optional() }),
    execute: myAgendaStep,
  },

  listPendingApprovals: {
    description:
      "Lista los pedidos human-in-the-loop en espera (bandeja de aprobaciones). Solo lectura: la aprobación/rechazo se hace desde el panel o Slack, no desde el chat.",
    inputSchema: z.object({}),
    execute: pendingApprovalsStep,
  },

  listAvailableSlots: {
    description: "Horarios de turno disponibles. Filtros opcionales: date (YYYY-MM-DD), providerId.",
    inputSchema: z.object({
      date: z.string().optional(),
      providerId: z.string().optional().describe("ej. prov_ruiz"),
    }),
    execute: availableSlotsStep,
  },

  scheduleAppointment: {
    description:
      "Agenda un turno en un horario libre. Turno común en horario de atención: directo. Sobreturno / urgencia / fuera de horario: pedí antes requestHumanApproval.",
    inputSchema: z.object({
      patientId: z.string(),
      slotId: z.string(),
      reason: z.string(),
    }),
    execute: scheduleAppointmentStep,
  },

  cancelAppointment: {
    description:
      "Cancela un turno agendado. Con menos de 24 h o si es un estudio de alto costo, pedí antes requestHumanApproval.",
    inputSchema: z.object({ appointmentId: z.string(), reason: z.string() }),
    execute: cancelAppointmentStep,
  },

  rescheduleAppointment: {
    description:
      "Reprograma un turno a un nuevo horario. Mismas reglas de aprobación que cancelAppointment.",
    inputSchema: z.object({
      appointmentId: z.string(),
      newSlotId: z.string(),
      reason: z.string(),
    }),
    execute: rescheduleAppointmentStep,
  },

  createPrescriptionRenewal: {
    description:
      "Registra una renovación de receta YA APROBADA por el médico. Recepción y paciente: obtené primero la aprobación con requestHumanApproval. Médico/a: puede llamarlo directo para sus pacientes. Pasá en approvedBy quién la aprobó.",
    inputSchema: z.object({
      patientId: z.string(),
      medication: z.string(),
      approvedBy: z.string(),
      note: z.string().optional(),
    }),
    execute: prescriptionRenewalStep,
  },

  sendPatientMessage: {
    description:
      "Envía un mensaje al paciente. Recordatorios/avisos administrativos: directo. Si incluye resultados o datos clínicos: pedí antes requestHumanApproval.",
    inputSchema: z.object({ patientId: z.string(), message: z.string() }),
    execute: sendPatientMessageStep,
  },

  refundInvoice: {
    description:
      "Marca una factura como reembolsada. Recepción: requiere requestHumanApproval previo si el monto es ≥ $50.000 o el motivo no es claro. Médico/a: directo. Pasá en approvedBy quién lo aprobó.",
    inputSchema: z.object({
      invoiceId: z.string(),
      reason: z.string(),
      approvedBy: z.string(),
    }),
    execute: refundInvoiceStep,
  },

  requestHumanApproval: {
    description:
      "Pausa el flujo y pide APROBACIÓN a una persona (Slack y/o panel de la app). Devuelve { approved, note, respondedBy, timedOut }.",
    inputSchema: z.object({
      action: z.string().describe("Etiqueta corta, ej. 'Renovación de receta'"),
      summary: z
        .string()
        .describe(
          "Contexto completo para decidir sin repreguntar: paciente + DNI, qué se pide, datos del briefing, importe si aplica, y tu recomendación.",
        ),
      riskLevel: z.enum(["bajo", "medio", "alto"]).optional(),
      patientName: z.string().optional(),
      details: z.string().optional(),
    }),
    execute: async (
      input: {
        action: string;
        summary: string;
        riskLevel?: "bajo" | "medio" | "alto";
        patientName?: string;
        details?: string;
      },
      ctx: ToolCtx,
    ) => {
      const res = await requestHuman({
        token: ctx?.toolCallId ?? `approval_${Date.now()}`,
        kind: "approval",
        action: input.action,
        summary: input.summary,
        details: input.details,
        riskLevel: input.riskLevel,
        patientName: input.patientName,
        requestedBy: actorOf(ctx)?.name,
      });
      return {
        approved: res.approved ?? false,
        note: res.note,
        respondedBy: res.respondedBy,
        timedOut: res.timedOut ?? false,
      };
    },
  },

  askHumanInput: {
    description:
      "Pausa el flujo y pide ACLARACIÓN a una persona cuando no podés avanzar responsablemente (identidad ambigua, intención poco clara, falta un dato). Devuelve { answer, respondedBy, timedOut }.",
    inputSchema: z.object({
      question: z.string(),
      context: z.string(),
      patientName: z.string().optional(),
    }),
    execute: async (
      input: { question: string; context: string; patientName?: string },
      ctx: ToolCtx,
    ) => {
      const res = await requestHuman({
        token: ctx?.toolCallId ?? `input_${Date.now()}`,
        kind: "input",
        action: "Aclaración",
        summary: `${input.question}\n\n_Contexto:_ ${input.context}`,
        question: input.question,
        patientName: input.patientName,
        requestedBy: actorOf(ctx)?.name,
      });
      return {
        answer: res.answer ?? "",
        respondedBy: res.respondedBy,
        timedOut: res.timedOut ?? false,
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Which tools each role may use
// ---------------------------------------------------------------------------

const COMMON = ["getClinicInfo", "getPatientBriefing", "listAvailableSlots", "requestHumanApproval", "askHumanInput"] as const;

export const TOOLS_BY_ROLE: Record<Role, (keyof typeof secretaryTools)[]> = {
  medico: [
    ...COMMON,
    "findPatient",
    "listMyAgenda",
    "listPendingApprovals",
    "scheduleAppointment",
    "cancelAppointment",
    "rescheduleAppointment",
    "createPrescriptionRenewal",
    "sendPatientMessage",
    "refundInvoice",
  ],
  recepcion: [
    ...COMMON,
    "findPatient",
    "listMyAgenda",
    "scheduleAppointment",
    "cancelAppointment",
    "rescheduleAppointment",
    "createPrescriptionRenewal",
    "sendPatientMessage",
    "refundInvoice",
  ],
  paciente: [
    ...COMMON,
    "scheduleAppointment",
    "cancelAppointment",
    "rescheduleAppointment",
  ],
};
