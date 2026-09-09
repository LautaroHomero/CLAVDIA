import { z } from "zod";
import {
  bookSlot,
  cancelAppointmentById,
  createPrescriptionRequest,
  getAppointment,
  getPatient,
  getSlot,
  listOpenSlots,
  listProviders,
  recordPatientMessage,
  refundInvoice as refundInvoiceInStore,
  searchPatients,
} from "@/lib/domain/store";
import { buildPatientBriefing } from "@/lib/domain/briefing";
import { requestHuman } from "./request-human";

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
    providers: listProviders().map((p) => ({
      id: p.id,
      name: p.name,
      specialty: p.specialty,
    })),
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

async function patientBriefingStep({ patientId }: { patientId: string }) {
  "use step";
  return buildPatientBriefing(patientId);
}

async function availableSlotsStep({
  date,
  providerId,
}: {
  date?: string;
  providerId?: string;
}) {
  "use step";
  const slots = listOpenSlots({ date, providerId }).slice(0, 20);
  return {
    count: slots.length,
    slots: slots.map((s) => {
      const provider = listProviders().find((p) => p.id === s.providerId);
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

async function scheduleAppointmentStep({
  patientId,
  slotId,
  reason,
}: {
  patientId: string;
  slotId: string;
  reason: string;
}) {
  "use step";
  if (!getPatient(patientId)) return { ok: false, error: `Paciente ${patientId} no existe.` };
  const slot = getSlot(slotId);
  if (!slot) return { ok: false, error: `El horario ${slotId} no existe.` };
  if (slot.taken) return { ok: false, error: `El horario ${slotId} ya fue tomado.` };
  const apt = bookSlot({ patientId, slotId, reason });
  const provider = listProviders().find((p) => p.id === apt.providerId);
  return {
    ok: true,
    appointmentId: apt.id,
    start: apt.start.replace("T", " "),
    provider: provider?.name,
    reason: apt.reason,
  };
}

async function cancelAppointmentStep({
  appointmentId,
  reason,
}: {
  appointmentId: string;
  reason: string;
}) {
  "use step";
  const existing = getAppointment(appointmentId);
  if (!existing) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  if (existing.status !== "scheduled")
    return { ok: false, error: `El turno ${appointmentId} está ${existing.status}.` };
  const apt = cancelAppointmentById(appointmentId, reason);
  return { ok: true, appointmentId: apt.id, status: apt.status };
}

async function rescheduleAppointmentStep({
  appointmentId,
  newSlotId,
  reason,
}: {
  appointmentId: string;
  newSlotId: string;
  reason: string;
}) {
  "use step";
  const existing = getAppointment(appointmentId);
  if (!existing) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  const slot = getSlot(newSlotId);
  if (!slot || slot.taken)
    return { ok: false, error: `El nuevo horario ${newSlotId} no está disponible.` };
  cancelAppointmentById(appointmentId, reason);
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
  reason,
  approvedBy,
}: {
  invoiceId: string;
  reason: string;
  approvedBy: string;
}) {
  "use step";
  try {
    const inv = refundInvoiceInStore(invoiceId, reason);
    return { ok: true, invoiceId: inv.id, status: inv.status, amount: inv.amount, approvedBy };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Tool set exposed to the agent
// ---------------------------------------------------------------------------

export const secretaryTools = {
  getClinicInfo: {
    description:
      "Devuelve datos del consultorio: dirección, horarios, profesionales y preparación de estudios. No requiere aprobación.",
    inputSchema: z.object({}),
    execute: clinicInfoStep,
  },

  findPatient: {
    description:
      "Busca pacientes por nombre, DNI, email o id. Úsalo para identificar a la persona antes del briefing. Si hay 0 o más de 1 coincidencia, no adivines: usá askHumanInput.",
    inputSchema: z.object({
      query: z.string().describe("Nombre, DNI, email o id del paciente"),
    }),
    execute: findPatientStep,
  },

  getPatientBriefing: {
    description:
      "Compila el resumen previo del paciente (antecedentes, alergias, medicación, próximos turnos, pendientes). Llamá a esto SIEMPRE apenas identifiques al paciente, antes de cualquier otra acción.",
    inputSchema: z.object({ patientId: z.string() }),
    execute: patientBriefingStep,
  },

  listAvailableSlots: {
    description: "Lista horarios de turno disponibles. Filtros opcionales por fecha (YYYY-MM-DD) y profesional.",
    inputSchema: z.object({
      date: z.string().optional().describe("Fecha YYYY-MM-DD"),
      providerId: z.string().optional().describe("id del profesional, ej. prov_ruiz"),
    }),
    execute: availableSlotsStep,
  },

  scheduleAppointment: {
    description:
      "Agenda un turno en un horario libre. Podés hacerlo sin aprobación para motivos administrativos comunes en horario de atención. Para sobreturnos, urgencias del mismo día o fuera de horario, pedí antes requestHumanApproval.",
    inputSchema: z.object({
      patientId: z.string(),
      slotId: z.string(),
      reason: z.string().describe("Motivo del turno"),
    }),
    execute: scheduleAppointmentStep,
  },

  cancelAppointment: {
    description:
      "Cancela un turno agendado. Si faltan menos de 24 h, o es un estudio de alto costo, pedí antes requestHumanApproval.",
    inputSchema: z.object({
      appointmentId: z.string(),
      reason: z.string(),
    }),
    execute: cancelAppointmentStep,
  },

  rescheduleAppointment: {
    description:
      "Reprograma un turno a un nuevo horario. Mismas reglas que cancelAppointment respecto a la aprobación humana.",
    inputSchema: z.object({
      appointmentId: z.string(),
      newSlotId: z.string(),
      reason: z.string(),
    }),
    execute: rescheduleAppointmentStep,
  },

  createPrescriptionRenewal: {
    description:
      "Registra una renovación de receta YA APROBADA por el médico. SIEMPRE obtené primero la aprobación con requestHumanApproval y pasá aquí quién la aprobó.",
    inputSchema: z.object({
      patientId: z.string(),
      medication: z.string().describe("Fármaco y dosis habitual"),
      approvedBy: z.string().describe("Quién aprobó la renovación"),
      note: z.string().optional(),
    }),
    execute: prescriptionRenewalStep,
  },

  sendPatientMessage: {
    description:
      "Envía un mensaje al paciente. Para recordatorios y avisos administrativos podés hacerlo directo. Si el mensaje incluye resultados, datos clínicos o de historia clínica, pedí antes requestHumanApproval.",
    inputSchema: z.object({
      patientId: z.string(),
      message: z.string(),
    }),
    execute: sendPatientMessageStep,
  },

  refundInvoice: {
    description:
      "Marca una factura como reembolsada. SIEMPRE requiere requestHumanApproval previo cuando el monto es $50.000 o más, o cuando el motivo no es claro. Pasá aquí quién lo aprobó.",
    inputSchema: z.object({
      invoiceId: z.string(),
      reason: z.string(),
      approvedBy: z.string(),
    }),
    execute: refundInvoiceStep,
  },

  requestHumanApproval: {
    description:
      "Pausa el flujo y pide APROBACIÓN a una persona del equipo (por Slack y/o en la app). Usalo antes de cualquier acción sensible. Devuelve { approved, note, respondedBy, timedOut }.",
    inputSchema: z.object({
      action: z.string().describe("Etiqueta corta, ej. 'Renovación de receta'"),
      summary: z
        .string()
        .describe(
          "Contexto completo para que la persona decida sin repreguntar: paciente + DNI, qué se pide, datos clave del briefing, importe si aplica, y tu recomendación.",
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
      { toolCallId }: { toolCallId: string },
    ) => {
      const res = await requestHuman({
        token: toolCallId,
        kind: "approval",
        action: input.action,
        summary: input.summary,
        details: input.details,
        riskLevel: input.riskLevel,
        patientName: input.patientName,
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
      "Pausa el flujo y pide ACLARACIÓN a una persona del equipo cuando no podés avanzar de forma responsable (identidad ambigua, intención poco clara, falta un dato). Devuelve { answer, respondedBy, timedOut }.",
    inputSchema: z.object({
      question: z.string().describe("Pregunta concreta, con las opciones entre las que elegir"),
      context: z.string().describe("Contexto breve de por qué lo consultás"),
      patientName: z.string().optional(),
    }),
    execute: async (
      input: { question: string; context: string; patientName?: string },
      { toolCallId }: { toolCallId: string },
    ) => {
      const res = await requestHuman({
        token: toolCallId,
        kind: "input",
        action: "Aclaración",
        summary: `${input.question}\n\n_Contexto:_ ${input.context}`,
        question: input.question,
        patientName: input.patientName,
      });
      return {
        answer: res.answer ?? "",
        respondedBy: res.respondedBy,
        timedOut: res.timedOut ?? false,
      };
    },
  },
};
