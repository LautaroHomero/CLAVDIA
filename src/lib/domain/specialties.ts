/**
 * Curated list of health-professional types offered in the "add professional"
 * flows. It's a suggestion list, not a constraint — the forms also accept a
 * free-text "Otra" value, and `provider.specialty` stays a plain string.
 */
export const SPECIALTIES = [
  "Clínica Médica",
  "Cardiología",
  "Dermatología",
  "Endocrinología",
  "Gastroenterología",
  "Ginecología",
  "Kinesiología",
  "Medicina del Deporte",
  "Neurología",
  "Nutrición",
  "Obstetricia",
  "Odontología",
  "Oftalmología",
  "Otorrinolaringología",
  "Pediatría",
  "Psicología",
  "Psiquiatría",
  "Traumatología",
  "Urología",
] as const;

export type Specialty = (typeof SPECIALTIES)[number];
