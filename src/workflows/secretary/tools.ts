import { z } from "zod";
import {
  addProviderPrice,
  bookSlot,
  buildDayReport,
  cancelAppointmentById,
  createPatient,
  createPrescriptionRequest,
  createProfessional,
  getAppointment,
  getInvoicesForPatient,
  getLabResultsForPatient,
  getPatient,
  getPatientByDni,
  getProvider,
  getSavedDailyReport,
  getSlot,
  listAppointments,
  listOpenSlots,
  listProviderPrices,
  listProviders,
  priceForReason,
  providerNameTaken,
  recordPatientMessage,
  refundInvoice as refundInvoiceInDb,
  saveDailyReport,
  searchPatients,
  setAppointmentPrice,
  setAppointmentStatus,
  setProviderFee,
  userNameTaken,
} from "@/lib/db/repo";
import { buildPatientBriefing } from "@/lib/domain/briefing";
import { listPendingRequests } from "@/lib/approvals/registry";
import { hashPin } from "@/lib/auth/pin";
import { postText as postSlackText } from "@/lib/slack/client";
import type { DayReport } from "@/lib/db/repo";
import { DEMO_TODAY, DEMO_TOMORROW } from "@/lib/domain/clock";
import type { Actor, Role } from "@/lib/domain/types";
import { requestHuman } from "./request-human";

const ars = (n: number) => `$${n.toLocaleString("es-AR")}`;

/** Resolve which provider a pricing/report tool targets, given the caller's role. */
function resolveProviderId(ctx: ToolCtx, ref?: string): string | { error: string } {
  const actor = actorOf(ctx);
  if (actor?.role === "medico" && actor.providerId) return actor.providerId; // forced to self
  if (!ref) {
    return { error: "Indicá de qué profesional se trata (nombre, especialidad o id como prov_sosa)." };
  }
  if (ref.startsWith("prov_") && getProvider(ref)) return ref;
  const norm = ref.trim().toLowerCase();
  const hit = listProviders().find(
    (p) =>
      p.name.toLowerCase().includes(norm) ||
      norm.includes(p.name.toLowerCase()) ||
      p.specialty.toLowerCase().includes(norm),
  );
  return hit ? hit.id : { error: `No encontré al profesional "${ref}".` };
}

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

async function registerPatientStep({
  fullName,
  dni,
  dateOfBirth,
  coverage,
  phone,
  email,
  reason,
}: {
  fullName: string;
  dni: string;
  dateOfBirth: string;
  coverage: string;
  phone?: string;
  email?: string;
  reason?: string;
}) {
  "use step";
  const existing = getPatientByDni(dni);
  if (existing) {
    return {
      ok: false,
      alreadyExists: true,
      patientId: existing.id,
      message: `Ya hay un paciente con DNI ${dni}: ${existing.fullName} (${existing.id}). No lo dupliques.`,
    };
  }
  const patient = createPatient({ fullName, dni, dateOfBirth, coverage, phone, email, notes: reason });
  return {
    ok: true,
    patientId: patient.id,
    fullName: patient.fullName,
    dni: patient.dni,
    message: "Paciente dado de alta. Para acceso al portal, el paciente se registra desde la pantalla de login.",
  };
}

async function registerProfessionalStep(
  {
    fullName,
    specialty,
    roomLabel,
    pin,
  }: { fullName: string; specialty: string; roomLabel?: string; pin: string },
  ctx: ToolCtx,
) {
  "use step";
  if (actorOf(ctx)?.role !== "recepcion") {
    return { ok: false, error: "Solo recepción puede dar de alta profesionales." };
  }
  if (!/^\d{4}$/.test(pin ?? "")) {
    return { ok: false, error: "Pedí un PIN de 4 dígitos para el acceso del profesional." };
  }
  if (providerNameTaken(fullName) || userNameTaken(fullName)) {
    return { ok: false, error: `Ya existe un profesional o usuario llamado "${fullName}".` };
  }
  const { hash, salt } = hashPin(pin);
  const { provider } = createProfessional({
    name: fullName,
    specialty,
    roomLabel: roomLabel?.trim() || "A confirmar",
    pinHash: hash,
    pinSalt: salt,
  });
  return {
    ok: true,
    providerId: provider.id,
    name: provider.name,
    specialty: provider.specialty,
    roomLabel: provider.roomLabel,
    access: { nombre: provider.name, pin },
    message:
      "Profesional dado de alta con agenda disponible. Pasale su nombre y PIN para que ingrese como 'profesional'.",
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
    today: DEMO_TODAY,
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
  const prov = providerId ? getProvider(providerId) : undefined;
  return {
    today: DEMO_TODAY,
    tomorrow: DEMO_TOMORROW,
    queriedDate: date ?? "todas las fechas",
    count: appts.length,
    scope: prov ? `${prov.name} · ${prov.specialty}` : "todo el consultorio",
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
    const price = priceForReason(apt.providerId, reason);
    setAppointmentPrice(apt.id, price);
    return {
      ok: true,
      appointmentId: apt.id,
      start: apt.start.replace("T", " "),
      provider: getProvider(apt.providerId)?.name,
      reason: apt.reason,
      price,
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
  setAppointmentPrice(apt.id, existing.price || priceForReason(apt.providerId, existing.reason));
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
// Pricing & daily reports
// ---------------------------------------------------------------------------

async function listPricesStep({ provider }: { provider?: string }, ctx: ToolCtx) {
  "use step";
  const pid = resolveProviderId(ctx, provider);
  if (typeof pid !== "string") return { ok: false, error: pid.error };
  const p = getProvider(pid)!;
  return {
    ok: true,
    providerId: pid,
    professional: p.name,
    specialty: p.specialty,
    consultaEstandar: p.defaultFee,
    practicas: listProviderPrices(pid).map((i) => ({ label: i.label, amount: i.amount })),
  };
}

async function setConsultationFeeStep(
  { provider, amount }: { provider?: string; amount: number },
  ctx: ToolCtx,
) {
  "use step";
  const pid = resolveProviderId(ctx, provider);
  if (typeof pid !== "string") return { ok: false, error: pid.error };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Importe inválido." };
  setProviderFee(pid, amount);
  return { ok: true, professional: getProvider(pid)!.name, consultaEstandar: Math.round(amount) };
}

async function addPriceItemStep(
  { provider, label, amount }: { provider?: string; label: string; amount: number },
  ctx: ToolCtx,
) {
  "use step";
  const pid = resolveProviderId(ctx, provider);
  if (typeof pid !== "string") return { ok: false, error: pid.error };
  if (!label?.trim()) return { ok: false, error: "Falta el nombre de la práctica." };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Importe inválido." };
  const item = addProviderPrice(pid, label, amount);
  return { ok: true, professional: getProvider(pid)!.name, added: item };
}

async function markAttendedStep({ appointmentId }: { appointmentId: string }, ctx: ToolCtx) {
  "use step";
  const apt = getAppointment(appointmentId);
  if (!apt) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  const actor = actorOf(ctx);
  if (actor?.role === "medico" && actor.providerId && apt.providerId !== actor.providerId) {
    return { ok: false, error: "Ese turno no es de tu agenda." };
  }
  if (apt.status === "cancelled") return { ok: false, error: "El turno está cancelado." };
  setAppointmentStatus(appointmentId, "completed");
  const price = apt.price || priceForReason(apt.providerId, apt.reason);
  if (!apt.price) setAppointmentPrice(appointmentId, price);
  return { ok: true, appointmentId, status: "completed", price };
}

function reportSummary(r: DayReport): Record<string, unknown> {
  return {
    date: r.date,
    recaudadoTotal: r.clinicRevenue,
    atendidosTotal: r.totalAttended,
    porProfesional: r.providers
      .filter((p) => p.attendedCount + p.cancelledCount + p.stillScheduled > 0)
      .map((p) => ({
        profesional: p.providerName,
        especialidad: p.specialty,
        atendidos: p.attendedCount,
        cancelados: p.cancelledCount,
        pendientes: p.stillScheduled,
        recaudado: p.revenue,
        detalle: p.attended.map((a) => `${a.time} ${a.patient} — ${a.reason} (${ars(a.price)})`),
      })),
  };
}

async function dailyReportStep({ date, provider }: { date?: string; provider?: string }, ctx: ToolCtx) {
  "use step";
  const day = date?.trim() || DEMO_TODAY;
  const actor = actorOf(ctx);
  let providerId: string | undefined;
  if (actor?.role === "medico") providerId = actor.providerId;
  else if (provider) {
    const r = resolveProviderId(ctx, provider);
    if (typeof r !== "string") return { ok: false, error: r.error };
    providerId = r;
  }
  const report = buildDayReport(day, providerId);
  const saved = getSavedDailyReport(day, providerId ?? "");
  return {
    ok: true,
    ...reportSummary(report),
    cierreOficial: saved ? `hecho por ${saved.generatedBy} el ${saved.generatedAt}` : "todavía no se cerró el día",
  };
}

async function closeDayStep({ date }: { date?: string }, ctx: ToolCtx) {
  "use step";
  if (actorOf(ctx)?.role !== "recepcion") {
    return { ok: false, error: "El cierre del día lo hace recepción." };
  }
  const day = date?.trim() || DEMO_TODAY;
  const by = actorOf(ctx)?.name ?? "Recepción";
  const clinic = buildDayReport(day);

  saveDailyReport(day, "", by, clinic);
  for (const p of clinic.providers) {
    saveDailyReport(day, p.providerId, by, buildDayReport(day, p.providerId));
  }

  const lines = [
    `*Cierre del día ${day}*`,
    `Atendidos: ${clinic.totalAttended} · Recaudado: ${ars(clinic.clinicRevenue)}`,
    "",
    ...clinic.providers
      .filter((p) => p.attendedCount + p.cancelledCount > 0)
      .map(
        (p) =>
          `• ${p.providerName} (${p.specialty}): ${p.attendedCount} atendidos, ${p.cancelledCount} cancelados — ${ars(p.revenue)}`,
      ),
  ];
  const slackPosted = await postSlackText(lines.join("\n"));

  return { ok: true, ...reportSummary(clinic), slackPosted };
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

  registerPatient: {
    description:
      "Da de alta un paciente nuevo. Lo pueden hacer médico/a, recepción o el propio paciente (por ejemplo para un familiar). Antes de llamarlo, pedí: nombre y apellido, DNI, fecha de nacimiento (AAAA-MM-DD) y cobertura; teléfono y email son opcionales. Si ya existe alguien con ese DNI, no dupliques: informá el patientId que devuelve.",
    inputSchema: z.object({
      fullName: z.string(),
      dni: z.string(),
      dateOfBirth: z.string().describe("AAAA-MM-DD"),
      coverage: z.string().describe("Obra social o prepaga"),
      phone: z.string().optional(),
      email: z.string().optional(),
      reason: z.string().optional().describe("Motivo del alta / nota interna"),
    }),
    execute: registerPatientStep,
  },

  registerProfessional: {
    description:
      "Da de alta un profesional nuevo (con su especialidad y una agenda de turnos). SOLO puede hacerlo recepción. Pedí antes: nombre completo con título (ej. 'Dra. Laura Gómez'), especialidad/profesión (ej. Dermatología, Psicología, Medicina del deporte), consultorio (opcional) y un PIN de 4 dígitos para su acceso. Devuelve el nombre y PIN para entregarle al profesional.",
    inputSchema: z.object({
      fullName: z.string().describe("Nombre con título, ej. 'Dr. Juan Pérez'"),
      specialty: z.string().describe("Especialidad o profesión"),
      roomLabel: z.string().optional().describe("Consultorio, ej. 'Consultorio 6'"),
      pin: z.string().describe("PIN de 4 dígitos para el login del profesional"),
    }),
    execute: registerProfessionalStep,
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

  listPrices: {
    description:
      "Muestra los precios de un profesional: la consulta estándar y las prácticas con nombre. El rol profesional ve el suyo; recepción debe indicar de quién (nombre, especialidad o id).",
    inputSchema: z.object({
      provider: z.string().optional().describe("Solo recepción: nombre / especialidad / id del profesional"),
    }),
    execute: listPricesStep,
  },

  setConsultationFee: {
    description:
      "Define el precio de la consulta estándar de un profesional. Lo puede hacer recepción (indicando el profesional) o el propio profesional (sobre sí mismo). Sin aprobación.",
    inputSchema: z.object({
      provider: z.string().optional(),
      amount: z.number().describe("Importe en pesos"),
    }),
    execute: setConsultationFeeStep,
  },

  addPriceItem: {
    description:
      "Agrega una práctica con su precio a un profesional (ej. 'Crioterapia' $30000). Recepción o el propio profesional. Sin aprobación.",
    inputSchema: z.object({
      provider: z.string().optional(),
      label: z.string().describe("Nombre de la práctica"),
      amount: z.number().describe("Importe en pesos"),
    }),
    execute: addPriceItemStep,
  },

  markAttended: {
    description:
      "Marca un turno como atendido (status 'completed'), lo que lo suma a la recaudación del día. Recepción, o el profesional dueño del turno.",
    inputSchema: z.object({ appointmentId: z.string() }),
    execute: markAttendedStep,
  },

  getDailyReport: {
    description:
      "Resumen del día: atendidos, cancelados, pendientes y recaudado. El profesional ve el suyo; recepción ve todo el consultorio (o filtra por profesional). Fecha opcional AAAA-MM-DD (default: hoy).",
    inputSchema: z.object({
      date: z.string().optional(),
      provider: z.string().optional().describe("Solo recepción: filtrar por profesional"),
    }),
    execute: dailyReportStep,
  },

  closeDay: {
    description:
      "Cierre del día (SOLO recepción): calcula y guarda el resumen del consultorio y el de cada profesional, y lo publica en Slack. Simula lo que en producción dispara un workflow al terminar el último turno.",
    inputSchema: z.object({ date: z.string().optional() }),
    execute: closeDayStep,
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

const COMMON = [
  "getClinicInfo",
  "getPatientBriefing",
  "listAvailableSlots",
  "registerPatient",
  "requestHumanApproval",
  "askHumanInput",
] as const;

export const TOOLS_BY_ROLE: Record<Role, (keyof typeof secretaryTools)[]> = {
  medico: [
    ...COMMON,
    "findPatient",
    "listMyAgenda",
    "listPendingApprovals",
    "scheduleAppointment",
    "cancelAppointment",
    "rescheduleAppointment",
    "markAttended",
    "createPrescriptionRenewal",
    "sendPatientMessage",
    "refundInvoice",
    "listPrices",
    "setConsultationFee",
    "addPriceItem",
    "getDailyReport",
  ],
  recepcion: [
    ...COMMON,
    "findPatient",
    "listMyAgenda",
    "registerProfessional",
    "scheduleAppointment",
    "cancelAppointment",
    "rescheduleAppointment",
    "markAttended",
    "createPrescriptionRenewal",
    "sendPatientMessage",
    "refundInvoice",
    "listPrices",
    "setConsultationFee",
    "addPriceItem",
    "getDailyReport",
    "closeDay",
  ],
  paciente: [
    ...COMMON,
    "scheduleAppointment",
    "cancelAppointment",
    "rescheduleAppointment",
  ],
};
