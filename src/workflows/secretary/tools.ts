import { z } from "zod";
import {
  addProviderPrice,
  bookSlot,
  buildDayReport,
  addMembership,
  cancelAppointmentById,
  createPatient,
  ensurePatientLogin,
  createPrescriptionRequest,
  createProfessional,
  createUser,
  earlierOpeningToday,
  finishAttention,
  getAppointment,
  getInvoice,
  getInvoicesForPatient,
  getLabResultsForPatient,
  getOrganization,
  getPatient,
  getPatientByDni,
  getProvider,
  getSavedDailyReport,
  getUserByDni,
  inProgressAppointment,
  joinPatientOrg,
  listAppointments,
  listOpenSlots,
  listOrganizations,
  listPatientNotices,
  listProviderPrices,
  listProviders,
  nextScheduledAppointment,
  patientInOrg,
  patientNextAppointment,
  priceForReason,
  providerAgenda,
  providerNameTakenInOrg,
  recordPatientMessage,
  refundInvoice as refundInvoiceInDb,
  replacePatientNotice,
  resolvePatientNotice,
  saveDailyReport,
  searchPatients,
  setAppointmentPrice,
  setAppointmentStatus,
  setProviderFee,
  startAttention,
} from "@/lib/db/repo";
import type { DayReport } from "@/lib/db/repo";
import { listPendingRequests } from "@/lib/approvals/registry";
import { buildPatientBriefing } from "@/lib/domain/briefing";
import {
  bookAppointment,
  cancelAppointment as cancelAppointmentSvc,
  refreshWaitingNotices,
  rescheduleAppointment as rescheduleAppointmentSvc,
} from "@/lib/domain/scheduling";
import { postText as postSlackText } from "@/lib/slack/client";
import { DEMO_TODAY, DEMO_TOMORROW } from "@/lib/domain/clock";
import type { Actor, OrgRef, Role } from "@/lib/domain/types";
import { requestHuman } from "./request-human";

const ars = (n: number) => `$${n.toLocaleString("es-AR")}`;

// The agent passes `experimental_context: Actor` into every tool call.
type ToolCtx = { toolCallId?: string; experimental_context?: unknown } | undefined;

function actorOf(ctx: ToolCtx): Actor | undefined {
  const a = ctx?.experimental_context as Actor | undefined;
  return a && typeof a === "object" && "role" in a ? a : undefined;
}

/** Staff's active organization id (undefined for patients). */
const staffOrgId = (ctx: ToolCtx) => actorOf(ctx)?.activeOrg?.id;
const staffProviderId = (ctx: ToolCtx) => actorOf(ctx)?.activeOrg?.providerId;
const patientOrgIds = (ctx: ToolCtx) => actorOf(ctx)?.orgs.map((o) => o.id) ?? [];

/** Patients may only act on their own record. */
function scopePatientId(ctx: ToolCtx, requested: string): string {
  const actor = actorOf(ctx);
  return actor?.role === "paciente" && actor.patientId ? actor.patientId : requested;
}

/** Resolve which provider (in the staff's active org) a pricing/report tool targets. */
async function resolveProviderId(ctx: ToolCtx, ref?: string): Promise<string | { error: string }> {
  const actor = actorOf(ctx);
  if (actor?.role === "medico" && actor.activeOrg?.providerId) return actor.activeOrg.providerId;
  const orgId = staffOrgId(ctx);
  if (!orgId) return { error: "Sin organización activa." };
  if (!ref) return { error: "Indicá de qué profesional se trata (nombre o especialidad)." };
  if (ref.startsWith("prov_") && (await getProvider(ref))?.organizationId === orgId) return ref;
  const n = ref.trim().toLowerCase();
  const providers = await listProviders(orgId);
  const hit = providers.find(
    (p) =>
      p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase()) || p.specialty.toLowerCase().includes(n),
  );
  return hit ? hit.id : { error: `No encontré al profesional "${ref}" en ${actor?.activeOrg?.name}.` };
}

/** Resolve which of the patient's organizations an action targets. */
function resolvePatientOrg(ctx: ToolCtx, ref?: string): OrgRef | { error: string } {
  const orgs = actorOf(ctx)?.orgs ?? [];
  if (orgs.length === 0)
    return { error: "No estás registrado en ningún consultorio. Usá listOrganizations y joinOrganization." };
  if (!ref) {
    return orgs.length === 1
      ? orgs[0]
      : { error: `Indicá en qué consultorio: ${orgs.map((o) => o.name).join(" / ")}.` };
  }
  const n = ref.trim().toLowerCase();
  const hit = orgs.find((o) => o.name.toLowerCase().includes(n) || n.includes(o.name.toLowerCase()) || o.id === ref);
  return hit ?? { error: `No estás registrado en "${ref}". Tus consultorios: ${orgs.map((o) => o.name).join(", ")}.` };
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

async function listOrganizationsStep() {
  "use step";
  const orgs = await listOrganizations();
  return {
    organizations: orgs.map((o) => ({ id: o.id, name: o.name, address: o.address })),
    note: "Para atenderte en uno nuevo, usá joinOrganization con el nombre.",
  };
}

async function joinOrganizationStep({ organization }: { organization: string }, ctx: ToolCtx) {
  "use step";
  const actor = actorOf(ctx);
  if (actor?.role !== "paciente" || !actor.patientId) {
    return { ok: false, error: "Solo un paciente puede sumarse a un consultorio." };
  }
  const n = organization.trim().toLowerCase();
  const orgs = await listOrganizations();
  const org = orgs.find(
    (o) => o.name.toLowerCase().includes(n) || n.includes(o.name.toLowerCase()) || o.id === organization,
  );
  if (!org) {
    return {
      ok: false,
      error: `No encontré "${organization}". Opciones: ${orgs.map((o) => o.name).join(", ")}.`,
    };
  }
  if (await patientInOrg(actor.patientId, org.id)) {
    return { ok: true, message: `Ya estabas registrado en ${org.name}.` };
  }
  await joinPatientOrg(actor.patientId, org.id);
  return { ok: true, organizationId: org.id, message: `Listo, ahora también te atendés en ${org.name}.` };
}

// ---------------------------------------------------------------------------
// Clinic info / patients
// ---------------------------------------------------------------------------

async function clinicInfoStep({ organization }: { organization?: string }, ctx: ToolCtx) {
  "use step";
  const actor = actorOf(ctx);
  let orgId: string | undefined;
  if (actor?.role === "paciente") {
    const r = resolvePatientOrg(ctx, organization);
    if ("error" in r) {
      return {
        ok: false,
        error: r.error,
        tusConsultorios: (actor.orgs ?? []).map((o) => o.name),
      };
    }
    orgId = r.id;
  } else {
    orgId = staffOrgId(ctx);
  }
  if (!orgId) return { ok: false, error: "Sin organización." };
  const [org, providers] = await Promise.all([getOrganization(orgId), listProviders(orgId, { activeOnly: true })]);
  return {
    ok: true,
    name: org!.name,
    address: org!.address,
    hours: org!.hours,
    phone: org!.phone,
    providers: providers.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty })),
    prep: {
      laboratorio: "Ayuno de 8 horas. Se puede tomar agua.",
      resonancia: "Traer estudios previos. Avisar si tiene marcapasos o prótesis metálicas.",
      ecografiaAbdominal: "Ayuno de 6 horas.",
    },
  };
}

async function registerPatientStep(
  {
    fullName,
    dni,
    dateOfBirth,
    coverage,
    phone,
    email,
    reason,
  }: {
    fullName?: string;
    dni: string;
    dateOfBirth?: string;
    coverage?: string;
    phone?: string;
    email?: string;
    reason?: string;
  },
  ctx: ToolCtx,
) {
  "use step";
  const orgId = staffOrgId(ctx);
  if (!orgId) return { ok: false, error: "Sin organización activa." };
  const orgName = actorOf(ctx)?.activeOrg?.name ?? "este consultorio";
  if (!dni?.trim()) return { ok: false, error: "Indicá el DNI del paciente." };

  // Already in the system → DNI is enough, just link to this org.
  const existing = await getPatientByDni(dni);
  if (existing) {
    await joinPatientOrg(existing.id, orgId);
    await ensurePatientLogin({
      patientId: existing.id,
      name: existing.fullName,
      email: existing.email,
      dni: existing.dni,
      phone: existing.phone,
    });
    return {
      ok: true,
      patientId: existing.id,
      alreadyExisted: true,
      message: `${existing.fullName} (DNI ${existing.dni}) ya estaba en el sistema; lo/la sumé a ${orgName}.`,
    };
  }

  // New patient → full data required.
  const mail = (email ?? "").trim().toLowerCase();
  if (!fullName?.trim() || !dateOfBirth?.trim() || !coverage?.trim()) {
    return { ok: false, error: "Paciente nuevo: pedí nombre, fecha de nacimiento (AAAA-MM-DD) y cobertura." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return { ok: false, error: "Pedí un email válido: es lo que usa el paciente para recuperar su PIN." };
  }
  if ((phone ?? "").replace(/\D/g, "").length < 8) {
    return { ok: false, error: "Pedí un teléfono válido para el paciente." };
  }

  const patient = await createPatient({
    fullName,
    dni,
    dateOfBirth,
    coverage,
    phone,
    email: mail,
    notes: reason,
  });
  await joinPatientOrg(patient.id, orgId);
  await ensurePatientLogin({ patientId: patient.id, name: fullName, email: mail, dni, phone: phone! });
  return {
    ok: true,
    patientId: patient.id,
    fullName: patient.fullName,
    dni: patient.dni,
    message: `Paciente dado de alta en ${orgName}. Ya puede entrar: con su DNI o email y "Olvidé mi PIN" elige su PIN.`,
  };
}

async function registerProfessionalStep(
  {
    role,
    dni,
    fullName,
    email,
    phone,
    specialty,
    roomLabel,
  }: {
    role?: "medico" | "recepcion";
    dni: string;
    fullName?: string;
    email?: string;
    phone?: string;
    specialty?: string;
    roomLabel?: string;
  },
  ctx: ToolCtx,
) {
  "use step";
  if (!actorOf(ctx)?.activeOrg?.canAdmin) {
    return { ok: false, error: "Solo la secretaría administrativa (o quien fundó el consultorio) puede dar de alta al equipo." };
  }
  const orgId = staffOrgId(ctx);
  if (!orgId) return { ok: false, error: "Sin organización activa." };
  if (!dni?.trim()) return { ok: false, error: "Indicá el DNI de la persona." };
  const kind = role === "recepcion" ? "recepcion" : "medico";
  const existing = await getUserByDni(dni);

  if (kind === "recepcion") {
    if (existing) {
      await addMembership({ userId: existing.id, organizationId: orgId, role: "recepcion", canAdmin: true });
      return {
        ok: true,
        role: "recepcion",
        name: existing.name,
        message: `${existing.name} ya estaba en el sistema; ahora también es secretaría de este consultorio.`,
      };
    }
    const mail = (email ?? "").trim().toLowerCase();
    if (!fullName?.trim()) return { ok: false, error: "Persona nueva: pedí el nombre." };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return { ok: false, error: "Persona nueva: pedí un email válido (le sirve para recuperar el PIN)." };
    }
    if ((phone ?? "").replace(/\D/g, "").length < 8) {
      return { ok: false, error: "Persona nueva: pedí un teléfono válido." };
    }
    const userId = (
      await createUser({
        name: fullName,
        email: mail,
        role: "recepcion",
        pinHash: "",
        pinSalt: "",
        dni,
        phone,
      })
    ).id;
    await addMembership({ userId, organizationId: orgId, role: "recepcion", canAdmin: true });
    return {
      ok: true,
      role: "recepcion",
      name: fullName,
      message: `Secretaría dada de alta. Entra con su DNI o email y "Olvidé mi PIN" para elegir su PIN.`,
    };
  }

  // kind === "medico"
  if (existing) {
    const { provider } = await createProfessional({
      organizationId: orgId,
      name: existing.name,
      email: existing.email,
      dni: existing.dni || dni,
      phone: existing.phone,
      specialty: (specialty ?? "").trim() || "A confirmar",
      roomLabel: roomLabel?.trim() || "A confirmar",
    });
    return {
      ok: true,
      role: "medico",
      providerId: provider.id,
      name: provider.name,
      message: `${existing.name} ya estaba en el sistema; lo/la sumé a este consultorio con agenda propia.`,
    };
  }

  const mail = (email ?? "").trim().toLowerCase();
  if (!fullName?.trim()) return { ok: false, error: "Profesional nuevo: pedí el nombre." };
  if (!specialty?.trim()) {
    return { ok: false, error: "Indicá el tipo de profesional (especialidad / profesión)." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return { ok: false, error: "Profesional nuevo: pedí un email válido (le sirve para recuperar el PIN)." };
  }
  if ((phone ?? "").replace(/\D/g, "").length < 8) {
    return { ok: false, error: "Profesional nuevo: pedí un teléfono válido." };
  }
  if (await providerNameTakenInOrg(orgId, fullName)) {
    return { ok: false, error: `Ya hay un profesional llamado "${fullName}" en este consultorio.` };
  }
  const { provider } = await createProfessional({
    organizationId: orgId,
    name: fullName,
    email: mail,
    dni,
    phone,
    specialty: specialty.trim(),
    roomLabel: roomLabel?.trim() || "A confirmar",
  });
  return {
    ok: true,
    role: "medico",
    providerId: provider.id,
    name: provider.name,
    specialty: provider.specialty,
    roomLabel: provider.roomLabel,
    message: `Profesional dado de alta con agenda. Entra con su DNI o email y "Olvidé mi PIN" para elegir su PIN.`,
  };
}

async function findPatientStep({ query }: { query: string }, ctx: ToolCtx) {
  "use step";
  const orgId = staffOrgId(ctx);
  if (!orgId) return { ok: false, error: "Sin organización activa." };
  const matches = await searchPatients(orgId, query);
  const result = {
    count: matches.length,
    matches: matches.map((p) => ({
      patientId: p.id,
      fullName: p.fullName,
      dni: p.dni,
      dateOfBirth: p.dateOfBirth,
      coverage: p.coverage,
    })),
  };
  // Única coincidencia → el llamado siguiente iba a ser getPatientBriefing sí o
  // sí (instructions.md §1); lo adelantamos acá y nos ahorramos ese round-trip
  // completo al modelo. Con 0 o >1 coincidencias no hay paciente identificado
  // todavía (toca askHumanInput), así que no tiene sentido calcularlo.
  if (matches.length === 1) {
    return { ...result, briefing: await buildPatientBriefing(matches[0].id, orgId) };
  }
  return result;
}

async function patientBriefingStep({ patientId }: { patientId: string }, ctx: ToolCtx) {
  "use step";
  const actor = actorOf(ctx);
  const pid = scopePatientId(ctx, patientId);
  const orgId = actor?.role === "paciente" ? undefined : staffOrgId(ctx);
  if (actor?.role !== "paciente" && orgId && !(await patientInOrg(pid, orgId))) {
    return { found: false, summary: "Ese paciente no está registrado en este consultorio." };
  }
  return buildPatientBriefing(pid, orgId);
}

async function availableSlotsStep(
  { date, providerId, organization }: { date?: string; providerId?: string; organization?: string },
  ctx: ToolCtx,
) {
  "use step";
  const actor = actorOf(ctx);
  let orgId: string | undefined;
  if (actor?.role === "paciente") {
    const r = resolvePatientOrg(ctx, organization);
    if ("error" in r) return { ok: false, error: r.error };
    orgId = r.id;
  } else orgId = staffOrgId(ctx);
  if (!orgId) return { ok: false, error: "Sin organización." };

  const [slotsAll, org] = await Promise.all([listOpenSlots(orgId, { date, providerId }), getOrganization(orgId)]);
  const slots = slotsAll.slice(0, 20);
  const slotViews = await Promise.all(
    slots.map(async (s) => {
      const provider = await getProvider(s.providerId);
      return {
        slotId: s.id,
        start: s.start.replace("T", " "),
        durationMinutes: s.durationMinutes,
        provider: provider?.name ?? s.providerId,
        specialty: provider?.specialty,
      };
    }),
  );
  return {
    today: DEMO_TODAY,
    organization: org?.name,
    count: slots.length,
    slots: slotViews,
  };
}

async function myAgendaStep({ date }: { date?: string }, ctx: ToolCtx) {
  "use step";
  const orgId = staffOrgId(ctx);
  if (!orgId) return { ok: false, error: "Sin organización activa." };
  const providerId = staffProviderId(ctx);
  const [appts, prov] = await Promise.all([
    listAppointments(orgId, { providerId, date }),
    providerId ? getProvider(providerId) : Promise.resolve(undefined),
  ]);
  const appointments = await Promise.all(
    appts.map(async (a) => {
      const [patient, pendingLabsAll, invoicesAll, provider] = await Promise.all([
        getPatient(a.patientId),
        getLabResultsForPatient(a.patientId, orgId),
        getInvoicesForPatient(a.patientId, orgId),
        getProvider(a.providerId),
      ]);
      const pendingLabs = pendingLabsAll.filter((l) => l.status === "pending-review");
      const unpaid = invoicesAll.filter((i) => i.status === "unpaid");
      return {
        appointmentId: a.id,
        start: a.start.replace("T", " "),
        patient: patient?.fullName ?? a.patientId,
        patientDni: patient?.dni,
        reason: a.reason,
        provider: provider?.name,
        flags: [
          ...pendingLabs.map((l) => `Resultado pendiente: ${l.panel}`),
          ...unpaid.map((i) => `Factura impaga: ${i.concept} (${ars(i.amount)})`),
        ],
      };
    }),
  );
  return {
    today: DEMO_TODAY,
    tomorrow: DEMO_TOMORROW,
    organization: actorOf(ctx)?.activeOrg?.name,
    queriedDate: date ?? "todas las fechas",
    count: appts.length,
    scope: prov ? `${prov.name} · ${prov.specialty}` : "todo el consultorio",
    appointments,
  };
}

async function pendingApprovalsStep(_input: unknown, ctx: ToolCtx) {
  "use step";
  const items = await listPendingRequests(staffOrgId(ctx));
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

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

async function scheduleAppointmentStep(
  {
    patientId,
    slotId,
    reason,
    organization,
  }: { patientId: string; slotId: string; reason: string; organization?: string },
  ctx: ToolCtx,
) {
  "use step";
  const actor = actorOf(ctx);
  let orgId: string | undefined;
  if (actor?.role === "paciente") {
    const r = resolvePatientOrg(ctx, organization);
    if ("error" in r) return { ok: false, error: r.error };
    orgId = r.id;
  } else orgId = staffOrgId(ctx);
  if (!orgId) return { ok: false, error: "Sin organización." };

  const pid = scopePatientId(ctx, patientId);
  if (!(await getPatient(pid))) return { ok: false, error: `Paciente ${pid} no existe.` };
  if (!(await patientInOrg(pid, orgId))) {
    if (actor?.role === "paciente") await joinPatientOrg(pid, orgId);
    else return { ok: false, error: "Ese paciente no está registrado en este consultorio." };
  }
  const res = await bookAppointment({ organizationId: orgId, patientId: pid, slotId, reason });
  if (!res.ok) return res;
  const [org, provider] = await Promise.all([getOrganization(orgId), getProvider(res.appointment.providerId)]);
  return {
    ok: true,
    appointmentId: res.appointment.id,
    start: res.appointment.start.replace("T", " "),
    organization: org?.name,
    provider: provider?.name,
    reason: res.appointment.reason,
    price: res.price,
  };
}

async function cancelAppointmentStep({ appointmentId }: { appointmentId: string; reason: string }, ctx: ToolCtx) {
  "use step";
  const actor = actorOf(ctx);
  const existing = await getAppointment(appointmentId);
  if (!existing) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  if (actor?.role === "paciente" && actor.patientId && existing.patientId !== actor.patientId) {
    return { ok: false, error: "Ese turno no pertenece a tu ficha." };
  }
  if (actor?.role !== "paciente" && staffOrgId(ctx) !== existing.organizationId) {
    return { ok: false, error: "Ese turno es de otro consultorio." };
  }
  if (existing.status !== "scheduled")
    return { ok: false, error: `El turno ${appointmentId} está ${existing.status}.` };
  const res = await cancelAppointmentSvc(appointmentId);
  if (!res.ok) return res;
  return {
    ok: true,
    appointmentId: res.appointment.id,
    status: res.appointment.status,
    avisosEnviados: res.notices,
  };
}

async function rescheduleAppointmentStep(
  { appointmentId, newSlotId }: { appointmentId: string; newSlotId: string; reason: string },
  ctx: ToolCtx,
) {
  "use step";
  const actor = actorOf(ctx);
  const existing = await getAppointment(appointmentId);
  if (!existing) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  if (actor?.role === "paciente" && actor.patientId && existing.patientId !== actor.patientId) {
    return { ok: false, error: "Ese turno no pertenece a tu ficha." };
  }
  if (actor?.role !== "paciente" && staffOrgId(ctx) !== existing.organizationId) {
    return { ok: false, error: "Ese turno es de otro consultorio." };
  }
  const res = await rescheduleAppointmentSvc(appointmentId, newSlotId);
  if (!res.ok) return res;
  return {
    ok: true,
    previousAppointmentId: res.previousAppointmentId,
    appointmentId: res.appointment.id,
    start: res.appointment.start.replace("T", " "),
    avisosEnviados: res.notices,
  };
}

async function prescriptionRenewalStep(
  {
    patientId,
    medication,
    approvedBy,
    note,
  }: { patientId: string; medication: string; approvedBy: string; note?: string },
  ctx: ToolCtx,
) {
  "use step";
  const orgId = staffOrgId(ctx);
  if (!orgId) return { ok: false, error: "Sin organización activa." };
  if (!(await getPatient(patientId))) return { ok: false, error: `Paciente ${patientId} no existe.` };
  const req = await createPrescriptionRequest({
    organizationId: orgId,
    patientId,
    medication,
    decision: "approved",
    decidedBy: approvedBy,
    note,
  });
  return { ok: true, prescriptionRequestId: req.id, medication: req.medication, status: req.status };
}

async function sendPatientMessageStep(
  { patientId, message }: { patientId: string; message: string },
  ctx: ToolCtx,
) {
  "use step";
  const orgId = staffOrgId(ctx);
  if (!orgId) return { ok: false, error: "Sin organización activa." };
  if (!(await getPatient(patientId))) return { ok: false, error: `Paciente ${patientId} no existe.` };
  const msg = await recordPatientMessage(orgId, patientId, message);
  return { ok: true, messageId: msg.id, sentAt: msg.sentAt };
}

async function refundInvoiceStep(
  { invoiceId, approvedBy }: { invoiceId: string; reason: string; approvedBy: string },
  ctx: ToolCtx,
) {
  "use step";
  const inv = await getInvoice(invoiceId);
  if (!inv) return { ok: false, error: `La factura ${invoiceId} no existe.` };
  if (staffOrgId(ctx) !== inv.organizationId) {
    return { ok: false, error: "Esa factura es de otro consultorio." };
  }
  try {
    const done = await refundInvoiceInDb(invoiceId);
    return { ok: true, invoiceId: done.id, status: done.status, amount: done.amount, approvedBy };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Pricing & daily reports
// ---------------------------------------------------------------------------

async function listPricesStep({ provider }: { provider?: string }, ctx: ToolCtx) {
  "use step";
  const pid = await resolveProviderId(ctx, provider);
  if (typeof pid !== "string") return { ok: false, error: pid.error };
  const [p, prices] = await Promise.all([getProvider(pid), listProviderPrices(pid)]);
  return {
    ok: true,
    providerId: pid,
    professional: p!.name,
    specialty: p!.specialty,
    consultaEstandar: p!.defaultFee,
    practicas: prices.map((i) => ({ label: i.label, amount: i.amount })),
  };
}

async function setConsultationFeeStep({ provider, amount }: { provider?: string; amount: number }, ctx: ToolCtx) {
  "use step";
  const pid = await resolveProviderId(ctx, provider);
  if (typeof pid !== "string") return { ok: false, error: pid.error };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Importe inválido." };
  await setProviderFee(pid, amount);
  const p = await getProvider(pid);
  return { ok: true, professional: p!.name, consultaEstandar: Math.round(amount) };
}

async function addPriceItemStep(
  { provider, label, amount }: { provider?: string; label: string; amount: number },
  ctx: ToolCtx,
) {
  "use step";
  const pid = await resolveProviderId(ctx, provider);
  if (typeof pid !== "string") return { ok: false, error: pid.error };
  if (!label?.trim()) return { ok: false, error: "Falta el nombre de la práctica." };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Importe inválido." };
  const p = await getProvider(pid);
  const item = await addProviderPrice(p!.organizationId, pid, label, amount);
  return { ok: true, professional: p!.name, added: item };
}

async function markAttendedStep({ appointmentId }: { appointmentId: string }, ctx: ToolCtx) {
  "use step";
  const apt = await getAppointment(appointmentId);
  if (!apt) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  const actor = actorOf(ctx);
  if (actor?.role !== "paciente" && staffOrgId(ctx) !== apt.organizationId) {
    return { ok: false, error: "Ese turno es de otro consultorio." };
  }
  if (actor?.role === "medico" && staffProviderId(ctx) && apt.providerId !== staffProviderId(ctx)) {
    return { ok: false, error: "Ese turno no es de tu agenda." };
  }
  if (apt.status === "cancelled") return { ok: false, error: "El turno está cancelado." };
  await setAppointmentStatus(appointmentId, "completed");
  const price = apt.price || (await priceForReason(apt.providerId, apt.reason));
  if (!apt.price) await setAppointmentPrice(appointmentId, price);
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
  const orgId = staffOrgId(ctx);
  if (!orgId) return { ok: false, error: "Sin organización activa." };
  const day = date?.trim() || DEMO_TODAY;
  const actor = actorOf(ctx);
  let providerId: string | undefined;
  if (actor?.role === "medico") providerId = staffProviderId(ctx);
  else if (provider) {
    const r = await resolveProviderId(ctx, provider);
    if (typeof r !== "string") return { ok: false, error: r.error };
    providerId = r;
  }
  const [report, saved] = await Promise.all([
    buildDayReport(orgId, day, providerId),
    getSavedDailyReport(orgId, day, providerId ?? ""),
  ]);
  return {
    ok: true,
    organization: actor?.activeOrg?.name,
    ...reportSummary(report),
    cierreOficial: saved ? `hecho por ${saved.generatedBy} el ${saved.generatedAt}` : "todavía no se cerró el día",
  };
}

async function closeDayStep({ date }: { date?: string }, ctx: ToolCtx) {
  "use step";
  if (actorOf(ctx)?.role !== "recepcion") {
    return { ok: false, error: "El cierre del día lo hace recepción." };
  }
  const orgId = staffOrgId(ctx);
  if (!orgId) return { ok: false, error: "Sin organización activa." };
  const day = date?.trim() || DEMO_TODAY;
  const by = actorOf(ctx)?.name ?? "Recepción";
  const orgName = actorOf(ctx)?.activeOrg?.name ?? "el consultorio";
  const clinic = await buildDayReport(orgId, day);

  await saveDailyReport(orgId, day, "", by, clinic);
  for (const p of clinic.providers) {
    await saveDailyReport(orgId, day, p.providerId, by, await buildDayReport(orgId, day, p.providerId));
  }

  const lines = [
    `*Cierre del día ${day} — ${orgName}*`,
    `Atendidos: ${clinic.totalAttended} · Recaudado: ${ars(clinic.clinicRevenue)}`,
    "",
    ...clinic.providers
      .filter((p) => p.attendedCount + p.cancelledCount > 0)
      .map(
        (p) => `• ${p.providerName} (${p.specialty}): ${p.attendedCount} atendidos, ${p.cancelledCount} cancelados — ${ars(p.revenue)}`,
      ),
  ];
  const slackPosted = await postSlackText(lines.join("\n"));
  return { ok: true, ...reportSummary(clinic), slackPosted };
}

// ---------------------------------------------------------------------------
// Live agenda
// ---------------------------------------------------------------------------

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function agendaSummary(a: Awaited<ReturnType<typeof providerAgenda>>) {
  return {
    reloj: a.clock,
    marcha: a.running,
    desfasajeMin: a.offsetMinutes,
    atendidosHoy: a.attendedToday,
    enEspera: [...(a.next ? [a.next] : []), ...a.upcoming].map(
      (e) => `${e.scheduled}→~${e.estimated} ${e.patientName} (${e.reason})`,
    ),
  };
}

async function warnDelayStep(
  { extraMinutes, reason }: { extraMinutes?: number; reason?: string },
  ctx: ToolCtx,
) {
  "use step";
  const orgId = staffOrgId(ctx);
  const providerId = staffProviderId(ctx);
  if (!orgId || !providerId) {
    return { ok: false, error: "Esta herramienta es para el profesional (se demora en su consulta)." };
  }
  const extra = Math.max(5, Math.round(extraMinutes ?? 15));
  const agenda = await providerAgenda(providerId, DEMO_TODAY);
  const waiting = [...(agenda.next ? [agenda.next] : []), ...agenda.upcoming];
  if (waiting.length === 0) {
    return { ok: true, message: "No hay pacientes esperando a los que avisar.", avisosEnviados: [] };
  }
  const because = reason?.trim() ? ` (${reason.trim()})` : "";
  const out: { patient: string; message: string }[] = [];
  for (const e of waiting) {
    const est = fromMin(toMin(e.estimated) + extra);
    const msg =
      `El/la profesional se está demorando${because}. Tu turno de las ${e.scheduled} ` +
      `podría correrse ~${extra} min (estimado ~${est}). Te confirmamos apenas se libere; ` +
      `si preferís, podés venir más tarde.`;
    await replacePatientNotice(orgId, e.appointmentId, e.patientId, DEMO_TODAY, msg);
    out.push({ patient: e.patientName, message: msg });
  }
  return { ok: true, extraMinutes: extra, avisosEnviados: out };
}

async function nextPatientStep(_input: unknown, ctx: ToolCtx) {
  "use step";
  const orgId = staffOrgId(ctx);
  const providerId = staffProviderId(ctx);
  if (!orgId || !providerId) return { ok: false, error: "Esta herramienta es para el profesional." };

  const agenda = await providerAgenda(providerId, DEMO_TODAY);
  const target = agenda.inAttention ?? agenda.next;
  if (!target) {
    return { ok: true, message: "No quedan pacientes en la agenda de hoy.", agenda: agendaSummary(agenda) };
  }
  const briefing = await buildPatientBriefing(target.patientId, orgId);
  return {
    ok: true,
    estado: agenda.inAttention ? "en atención" : "próximo",
    turno: {
      appointmentId: target.appointmentId,
      paciente: target.patientName,
      motivo: target.reason,
      programado: target.scheduled,
      estimado: target.estimated,
      cumpleAniosHoy: target.isBirthday,
    },
    resumenPaciente: briefing.summary,
    agenda: agendaSummary(agenda),
  };
}

async function startAttentionStep({ appointmentId }: { appointmentId?: string }, ctx: ToolCtx) {
  "use step";
  const provId = staffProviderId(ctx);
  const a = appointmentId
    ? await getAppointment(appointmentId)
    : provId
      ? await nextScheduledAppointment(provId, DEMO_TODAY)
      : undefined;
  if (!a) return { ok: false, error: "No encontré el turno a iniciar." };
  if (provId && a.providerId !== provId) return { ok: false, error: "Ese turno no es de tu agenda." };
  try {
    const started = await startAttention(a.id);
    const notified = await refreshWaitingNotices(a.organizationId, a.providerId);
    const [patient, agenda] = await Promise.all([
      getPatient(started.patientId),
      providerAgenda(a.providerId, DEMO_TODAY),
    ]);
    return {
      ok: true,
      enAtencion: patient?.fullName,
      agenda: agendaSummary(agenda),
      avisosEnviados: notified,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function finishAttentionStep(
  { appointmentId, actualMinutes }: { appointmentId?: string; actualMinutes?: number; note?: string },
  ctx: ToolCtx,
) {
  "use step";
  const provId = staffProviderId(ctx);
  const a = appointmentId
    ? await getAppointment(appointmentId)
    : provId
      ? await inProgressAppointment(provId, DEMO_TODAY)
      : undefined;
  if (!a) return { ok: false, error: "No hay ninguna atención en curso para cerrar." };
  if (provId && a.providerId !== provId) return { ok: false, error: "Ese turno no es de tu agenda." };
  try {
    await finishAttention(a.id, actualMinutes);
    const notified = await refreshWaitingNotices(a.organizationId, a.providerId);
    const [agenda, patient] = await Promise.all([
      providerAgenda(a.providerId, DEMO_TODAY),
      getPatient(a.patientId),
    ]);
    return {
      ok: true,
      cerrado: patient?.fullName,
      duracionMin: actualMinutes ?? a.durationMinutes,
      agenda: agendaSummary(agenda),
      proximo: agenda.next
        ? `${agenda.next.patientName} — programado ${agenda.next.scheduled}, estimado ~${agenda.next.estimated}`
        : "no quedan turnos",
      avisosEnviados: notified,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function myVisitStatusStep(_input: unknown, ctx: ToolCtx) {
  "use step";
  const actor = actorOf(ctx);
  if (actor?.role !== "paciente" || !actor.patientId) {
    return { ok: false, error: "Esta herramienta es para el paciente." };
  }
  const appt = await patientNextAppointment(actor.patientId, DEMO_TODAY, patientOrgIds(ctx));
  const noticesRaw = await listPatientNotices(actor.patientId, DEMO_TODAY);
  const notices = noticesRaw.map((n) => n.message);
  if (!appt) return { ok: true, tenesTurnoHoy: false, avisos: notices };

  const agenda = await providerAgenda(appt.providerId, DEMO_TODAY);
  const entry =
    [agenda.inAttention, agenda.next, ...agenda.upcoming].find((e) => e?.appointmentId === appt.id) ?? null;
  const [earlier, org] = await Promise.all([
    entry ? earlierOpeningToday(appt.providerId, DEMO_TODAY, entry.estimated) : Promise.resolve(undefined),
    getOrganization(appt.organizationId),
  ]);
  return {
    ok: true,
    tenesTurnoHoy: true,
    consultorio: org?.name,
    profesional: agenda.providerName,
    motivo: appt.reason,
    programado: entry?.scheduled,
    estimadoAhora: entry?.estimated,
    demoraMin: entry?.delayMinutes ?? 0,
    marchaAgenda: agenda.running,
    hayLugarAntes: earlier ? earlier.time : null,
    avisos: notices,
  };
}

async function changeMyVisitTimeStep({ direction }: { direction: "later" | "earlier" }, ctx: ToolCtx) {
  "use step";
  const actor = actorOf(ctx);
  if (actor?.role !== "paciente" || !actor.patientId) {
    return { ok: false, error: "Esta herramienta es para el paciente." };
  }
  const appt = await patientNextAppointment(actor.patientId, DEMO_TODAY, patientOrgIds(ctx));
  if (!appt) return { ok: false, error: "No tenés un turno hoy." };
  const agenda = await providerAgenda(appt.providerId, DEMO_TODAY);
  const entry = [agenda.next, ...agenda.upcoming].find((e) => e?.appointmentId === appt.id) ?? null;

  if (direction === "later") {
    const notices = await listPatientNotices(actor.patientId, DEMO_TODAY);
    for (const n of notices) await resolvePatientNotice(n.id);
    return {
      ok: true,
      accion: "confirmado-mas-tarde",
      mensaje: `Perfecto. Vení tranquilo/a, te esperamos alrededor de las ${entry?.estimated ?? entry?.scheduled}.`,
    };
  }

  const opening = await earlierOpeningToday(
    appt.providerId,
    DEMO_TODAY,
    entry?.estimated ?? entry?.scheduled ?? "23:59",
  );
  if (!opening) return { ok: true, accion: "sin-lugar-antes", mensaje: "Por ahora no hay lugar para adelantarte." };
  await cancelAppointmentById(appt.id);
  const moved = await bookSlot({
    organizationId: appt.organizationId,
    patientId: appt.patientId,
    slotId: opening.slotId,
    reason: appt.reason,
  });
  await setAppointmentPrice(moved.id, appt.price || (await priceForReason(moved.providerId, appt.reason)));
  const notices = await listPatientNotices(actor.patientId, DEMO_TODAY);
  for (const n of notices) await resolvePatientNotice(n.id);
  return {
    ok: true,
    accion: "adelantado",
    nuevoHorario: opening.time,
    appointmentId: moved.id,
    mensaje: `Listo, te adelantamos a las ${opening.time}.`,
  };
}

// ---------------------------------------------------------------------------
// Tool set
// ---------------------------------------------------------------------------

export const secretaryTools = {
  listOrganizations: {
    description:
      "Para el PACIENTE: lista los consultorios donde puede atenderse. Para sumarse a uno nuevo, usá joinOrganization.",
    inputSchema: z.object({}),
    execute: listOrganizationsStep,
  },
  joinOrganization: {
    description: "Para el PACIENTE: se suma a un consultorio (por nombre) para poder pedir turnos ahí.",
    inputSchema: z.object({ organization: z.string() }),
    execute: joinOrganizationStep,
  },

  getClinicInfo: {
    description:
      "Datos del consultorio (dirección, horarios, profesionales, preparación de estudios). El paciente puede indicar cuál con `organization` si está en varios.",
    inputSchema: z.object({ organization: z.string().optional() }),
    execute: clinicInfoStep,
  },

  findPatient: {
    description:
      "Busca pacientes de ESTE consultorio por nombre, DNI, email o id. Si hay 0 o más de 1 coincidencia, no adivines: usá askHumanInput. Si hay una sola, la respuesta ya incluye su `briefing` (no llames getPatientBriefing de nuevo para ese paciente).",
    inputSchema: z.object({ query: z.string().describe("Nombre, DNI, email o id") }),
    execute: findPatientStep,
  },

  registerPatient: {
    description:
      "Da de alta un paciente en ESTE consultorio (médico/a o recepción). Si el paciente YA está en el sistema, con el DNI alcanza: se lo suma a este consultorio sin pedir nada más. Si es NUEVO, pedí además: nombre y apellido, fecha de nacimiento (AAAA-MM-DD), cobertura, email y teléfono (el email y el teléfono son obligatorios para el paciente nuevo: le sirven para recuperar el PIN y entrar). En ambos casos el paciente queda habilitado a entrar con su DNI o email y 'Olvidé mi PIN'.",
    inputSchema: z.object({
      dni: z.string().describe("DNI del paciente (obligatorio siempre)"),
      fullName: z.string().optional().describe("Solo si es paciente nuevo"),
      dateOfBirth: z.string().optional().describe("AAAA-MM-DD, solo si es paciente nuevo"),
      coverage: z.string().optional().describe("Obra social o prepaga, solo si es paciente nuevo"),
      phone: z.string().optional().describe("Teléfono, obligatorio si es paciente nuevo"),
      email: z.string().optional().describe("Email, obligatorio si es paciente nuevo"),
      reason: z.string().optional(),
    }),
    execute: registerPatientStep,
  },

  registerProfessional: {
    description:
      "Da de alta a alguien del equipo en ESTE consultorio (secretaría administrativa, o el/la fundador/a). Elegí `role`: 'medico' (default) para un/a profesional o 'recepcion' para secretaría administrativa. Si la persona YA está en el sistema, con el DNI alcanza: se la suma acá (el profesional con agenda propia). Si es NUEVA, pedí además: nombre, email y teléfono (y la especialidad si es 'medico'). La persona entra con su DNI o email y 'Olvidé mi PIN' para elegir su PIN — no se asignan PINs a mano.",
    inputSchema: z.object({
      role: z.enum(["medico", "recepcion"]).optional().describe("'medico' (default) o 'recepcion'"),
      dni: z.string().describe("DNI de la persona (obligatorio siempre)"),
      fullName: z.string().optional().describe("Nombre con título si es profesional; solo si es persona nueva"),
      email: z.string().optional().describe("Email para ingresar / recuperar PIN; obligatorio si es persona nueva"),
      phone: z.string().optional().describe("Teléfono; obligatorio si es persona nueva"),
      specialty: z.string().optional().describe("Tipo de profesional (solo role='medico', persona nueva)"),
      roomLabel: z.string().optional(),
    }),
    execute: registerProfessionalStep,
  },

  getPatientBriefing: {
    description:
      "Resumen del paciente para este consultorio (antecedentes, alergias, medicación, próximos turnos, pendientes). Llamalo SIEMPRE apenas identifiques al paciente.",
    inputSchema: z.object({ patientId: z.string() }),
    execute: patientBriefingStep,
  },

  listMyAgenda: {
    description:
      "Agenda de turnos de ESTE consultorio. Para el rol médico/a viene filtrada a su agenda. Incluye alertas por paciente. Filtro opcional por fecha YYYY-MM-DD.",
    inputSchema: z.object({ date: z.string().optional() }),
    execute: myAgendaStep,
  },

  listPendingApprovals: {
    description: "Bandeja de pedidos human-in-the-loop en espera de ESTE consultorio. Solo lectura.",
    inputSchema: z.object({}),
    execute: pendingApprovalsStep,
  },

  listAvailableSlots: {
    description:
      "Horarios de turno disponibles. El paciente puede indicar el consultorio con `organization`. Filtros: date (YYYY-MM-DD), providerId.",
    inputSchema: z.object({
      date: z.string().optional(),
      providerId: z.string().optional(),
      organization: z.string().optional(),
    }),
    execute: availableSlotsStep,
  },

  scheduleAppointment: {
    description:
      "Agenda un turno en un horario libre. El paciente puede indicar `organization` si está en varios. Sobreturno / urgencia / fuera de horario: pedí antes requestHumanApproval.",
    inputSchema: z.object({
      patientId: z.string(),
      slotId: z.string(),
      reason: z.string(),
      organization: z.string().optional(),
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
    description: "Reprograma un turno a un nuevo horario. Mismas reglas de aprobación que cancelAppointment.",
    inputSchema: z.object({ appointmentId: z.string(), newSlotId: z.string(), reason: z.string() }),
    execute: rescheduleAppointmentStep,
  },

  createPrescriptionRenewal: {
    description:
      "Registra una renovación de receta YA APROBADA. Recepción/paciente: obtené primero la aprobación. Médico/a: directo para sus pacientes. Pasá en approvedBy quién la aprobó.",
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
      "Envía un mensaje al paciente. Recordatorios/avisos: directo. Si incluye resultados o datos clínicos: pedí antes requestHumanApproval.",
    inputSchema: z.object({ patientId: z.string(), message: z.string() }),
    execute: sendPatientMessageStep,
  },

  refundInvoice: {
    description:
      "Marca una factura como reembolsada. Recepción: requiere requestHumanApproval previo si el monto es ≥ $50.000 o el motivo no es claro. Médico/a: directo. Pasá en approvedBy quién lo aprobó.",
    inputSchema: z.object({ invoiceId: z.string(), reason: z.string(), approvedBy: z.string() }),
    execute: refundInvoiceStep,
  },

  listPrices: {
    description:
      "Precios de un profesional de ESTE consultorio: consulta estándar + prácticas. El profesional ve el suyo; recepción indica de quién.",
    inputSchema: z.object({ provider: z.string().optional() }),
    execute: listPricesStep,
  },

  setConsultationFee: {
    description:
      "Define el precio de la consulta estándar de un profesional de ESTE consultorio. Recepción (indicando quién) o el propio profesional. Sin aprobación.",
    inputSchema: z.object({ provider: z.string().optional(), amount: z.number() }),
    execute: setConsultationFeeStep,
  },

  addPriceItem: {
    description:
      "Agrega una práctica con su precio a un profesional de ESTE consultorio (ej. 'Crioterapia' $30000). Sin aprobación.",
    inputSchema: z.object({ provider: z.string().optional(), label: z.string(), amount: z.number() }),
    execute: addPriceItemStep,
  },

  markAttended: {
    description:
      "Marca un turno como atendido (status 'completed') → suma a la recaudación del día. Recepción, o el profesional dueño del turno.",
    inputSchema: z.object({ appointmentId: z.string() }),
    execute: markAttendedStep,
  },

  getDailyReport: {
    description:
      "Resumen del día de ESTE consultorio: atendidos, cancelados, pendientes y recaudado. El profesional ve el suyo; recepción todo (o filtra por profesional). Fecha opcional.",
    inputSchema: z.object({ date: z.string().optional(), provider: z.string().optional() }),
    execute: dailyReportStep,
  },

  closeDay: {
    description:
      "Cierre del día de ESTE consultorio (SOLO recepción): calcula, guarda y publica en Slack el resumen del consultorio y de cada profesional.",
    inputSchema: z.object({ date: z.string().optional() }),
    execute: closeDayStep,
  },

  getNextPatient: {
    description:
      "Para el PROFESIONAL: el paciente en atención o el próximo, con su resumen para hoy (incluye si cumple años), horario programado vs. estimado, y cómo viene la agenda.",
    inputSchema: z.object({}),
    execute: nextPatientStep,
  },

  startAttention: {
    description:
      "Para el PROFESIONAL: registra que EMPEZÓ a atender (su 'ok'). Sin appointmentId toma el próximo. Fija la hora real y avisa a los pacientes que siguen si hay atraso/adelanto.",
    inputSchema: z.object({ appointmentId: z.string().optional() }),
    execute: startAttentionStep,
  },

  finishAttention: {
    description:
      "Para el PROFESIONAL: registra que TERMINÓ. Sin appointmentId cierra la atención en curso. Pasá `actualMinutes` si duró distinto. Recalcula la demora y reavisa; deja listo el resumen del siguiente.",
    inputSchema: z.object({
      appointmentId: z.string().optional(),
      actualMinutes: z.number().optional(),
      note: z.string().optional(),
    }),
    execute: finishAttentionStep,
  },

  warnDelay: {
    description:
      "Para el PROFESIONAL: mientras todavía atiende, avisa a los que siguen que PUEDE haber demora (tentativo). `extraMinutes` opcional (default 15), `reason` opcional.",
    inputSchema: z.object({ extraMinutes: z.number().optional(), reason: z.string().optional() }),
    execute: warnDelayStep,
  },

  getMyVisitStatus: {
    description:
      "Para el PACIENTE: estado de su próximo turno de hoy (en cualquiera de sus consultorios) — programado, estimado, demora, si hay lugar antes, y los avisos del consultorio.",
    inputSchema: z.object({}),
    execute: myVisitStatusStep,
  },

  changeMyVisitTime: {
    description:
      "Para el PACIENTE: 'later' = confirma que viene más tarde por la demora (no reagenda). 'earlier' = si hay un hueco antes con el mismo profesional hoy, adelanta el turno.",
    inputSchema: z.object({ direction: z.enum(["later", "earlier"]) }),
    execute: changeMyVisitTimeStep,
  },

  requestHumanApproval: {
    description:
      "Pausa el flujo y pide APROBACIÓN a una persona (Slack y/o panel). Devuelve { approved, note, respondedBy, timedOut }.",
    inputSchema: z.object({
      action: z.string(),
      summary: z.string(),
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
      const orgId = staffOrgId(ctx) ?? actorOf(ctx)?.orgs[0]?.id ?? "";
      const res = await requestHuman({
        token: ctx?.toolCallId ?? `approval_${Date.now()}`,
        organizationId: orgId,
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
      "Pausa el flujo y pide ACLARACIÓN a una persona (identidad ambigua, dato faltante, intención poco clara). Devuelve { answer, respondedBy, timedOut }.",
    inputSchema: z.object({
      question: z.string(),
      context: z.string(),
      patientName: z.string().optional(),
    }),
    execute: async (input: { question: string; context: string; patientName?: string }, ctx: ToolCtx) => {
      const orgId = staffOrgId(ctx) ?? actorOf(ctx)?.orgs[0]?.id ?? "";
      const res = await requestHuman({
        token: ctx?.toolCallId ?? `input_${Date.now()}`,
        organizationId: orgId,
        kind: "input",
        action: "Aclaración",
        summary: `${input.question}\n\n_Contexto:_ ${input.context}`,
        question: input.question,
        patientName: input.patientName,
        requestedBy: actorOf(ctx)?.name,
      });
      return { answer: res.answer ?? "", respondedBy: res.respondedBy, timedOut: res.timedOut ?? false };
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
  "requestHumanApproval",
  "askHumanInput",
] as const;

export const TOOLS_BY_ROLE: Record<Role, (keyof typeof secretaryTools)[]> = {
  medico: [
    ...COMMON,
    "findPatient",
    "registerPatient",
    "listMyAgenda",
    "listPendingApprovals",
    "getNextPatient",
    "startAttention",
    "finishAttention",
    "warnDelay",
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
    "registerPatient",
    "registerProfessional",
    "listMyAgenda",
    "getNextPatient",
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
    "listOrganizations",
    "joinOrganization",
    "getMyVisitStatus",
    "changeMyVisitTime",
    "scheduleAppointment",
    "cancelAppointment",
    "rescheduleAppointment",
  ],
};
