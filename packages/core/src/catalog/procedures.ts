/**
 * Catalogue of common operative procedures.
 *
 * Choosing a procedure from the catalogue (rather than typing free text)
 * keeps names consistent for analysis and prevents patient details from
 * leaking into the procedure name. De-identification replaces a session's
 * free-text `procedure.name` with the catalogue name when `catalogId` resolves.
 *
 * Ids are stable kebab-case keys that are persisted in sessions: never rename
 * or reuse one; add new entries instead.
 */
import type { SurgicalApproach } from '../types';

/** One catalogue entry. */
export interface ProcedureCatalogEntry {
  /** Stable kebab-case id, stored as `ProcedureInfo.catalogId`. */
  readonly id: string;
  /** Display name (British/Australian clinical spelling). */
  readonly name: string;
  /** One of {@link PROCEDURE_SPECIALTIES}. */
  readonly specialty: string;
  /** Typical approach, used to pre-fill the session form. */
  readonly defaultApproach?: SurgicalApproach;
}

/** Specialty names used in {@link PROCEDURE_CATALOG}, in display order. */
export const PROCEDURE_SPECIALTIES: readonly string[] = Object.freeze([
  'General surgery',
  'Colorectal surgery',
  'Upper GI & HPB surgery',
  'Urology',
  'Gynaecology',
  'Orthopaedics',
  'Vascular surgery',
  'Cardiothoracic surgery',
  'Neurosurgery',
  'ENT',
  'Plastic surgery',
  'Paediatric surgery',
]);

type Row = readonly [id: string, name: string, specialty: string, approach?: SurgicalApproach];

const GEN = 'General surgery';
const CR = 'Colorectal surgery';
const UGI = 'Upper GI & HPB surgery';
const URO = 'Urology';
const GYN = 'Gynaecology';
const ORTHO = 'Orthopaedics';
const VASC = 'Vascular surgery';
const CT = 'Cardiothoracic surgery';
const NEURO = 'Neurosurgery';
const ENT = 'ENT';
const PLAS = 'Plastic surgery';
const PAED = 'Paediatric surgery';

// Arthroscopic and thoracoscopic (VATS) procedures use 'endoscopic': the
// SurgicalApproach union groups all scope-based, non-abdominal minimally
// invasive access under that value.
const ROWS: readonly Row[] = [
  // General surgery (incl. breast & endocrine)
  ['laparoscopic-cholecystectomy', 'Laparoscopic cholecystectomy', GEN, 'laparoscopic'],
  ['laparoscopic-appendicectomy', 'Laparoscopic appendicectomy', GEN, 'laparoscopic'],
  ['open-inguinal-hernia-repair', 'Open inguinal hernia repair', GEN, 'open'],
  ['laparoscopic-inguinal-hernia-repair', 'Laparoscopic inguinal hernia repair (TEP/TAPP)', GEN, 'laparoscopic'],
  ['umbilical-hernia-repair', 'Umbilical hernia repair', GEN, 'open'],
  ['incisional-hernia-repair', 'Incisional hernia repair', GEN, 'open'],
  ['exploratory-laparotomy', 'Exploratory laparotomy', GEN, 'open'],
  ['total-thyroidectomy', 'Total thyroidectomy', GEN, 'open'],
  ['parathyroidectomy', 'Parathyroidectomy', GEN, 'open'],
  ['mastectomy', 'Mastectomy', GEN, 'open'],
  ['breast-wide-local-excision', 'Wide local excision of breast', GEN, 'open'],
  ['sentinel-lymph-node-biopsy', 'Sentinel lymph node biopsy', GEN, 'open'],
  // Colorectal
  ['laparoscopic-right-hemicolectomy', 'Laparoscopic right hemicolectomy', CR, 'laparoscopic'],
  ['laparoscopic-anterior-resection', 'Laparoscopic anterior resection', CR, 'laparoscopic'],
  ['robotic-anterior-resection', 'Robotic anterior resection', CR, 'robotic'],
  ['hartmanns-procedure', "Hartmann's procedure", CR, 'open'],
  ['abdominoperineal-resection', 'Abdominoperineal resection', CR, 'open'],
  ['reversal-of-ileostomy', 'Reversal of loop ileostomy', CR, 'open'],
  ['haemorrhoidectomy', 'Haemorrhoidectomy', CR, 'open'],
  // Upper GI & HPB
  ['laparoscopic-fundoplication', 'Laparoscopic fundoplication', UGI, 'laparoscopic'],
  ['laparoscopic-sleeve-gastrectomy', 'Laparoscopic sleeve gastrectomy', UGI, 'laparoscopic'],
  ['roux-en-y-gastric-bypass', 'Roux-en-Y gastric bypass', UGI, 'laparoscopic'],
  ['oesophagectomy', 'Oesophagectomy', UGI, 'open'],
  ['pancreaticoduodenectomy', 'Pancreaticoduodenectomy (Whipple)', UGI, 'open'],
  ['distal-pancreatectomy', 'Distal pancreatectomy', UGI, 'laparoscopic'],
  ['liver-resection', 'Liver resection (hepatectomy)', UGI, 'open'],
  // Urology
  ['transurethral-resection-of-prostate', 'Transurethral resection of prostate (TURP)', URO, 'endoscopic'],
  ['transurethral-resection-of-bladder-tumour', 'Transurethral resection of bladder tumour (TURBT)', URO, 'endoscopic'],
  ['robotic-radical-prostatectomy', 'Robot-assisted radical prostatectomy', URO, 'robotic'],
  ['laparoscopic-nephrectomy', 'Laparoscopic nephrectomy', URO, 'laparoscopic'],
  ['ureteroscopy-laser-lithotripsy', 'Ureteroscopy and laser lithotripsy', URO, 'endoscopic'],
  ['percutaneous-nephrolithotomy', 'Percutaneous nephrolithotomy (PCNL)', URO, 'percutaneous'],
  // Gynaecology
  ['caesarean-section', 'Caesarean section', GYN, 'open'],
  ['total-laparoscopic-hysterectomy', 'Total laparoscopic hysterectomy', GYN, 'laparoscopic'],
  ['total-abdominal-hysterectomy', 'Total abdominal hysterectomy', GYN, 'open'],
  ['laparoscopic-ovarian-cystectomy', 'Laparoscopic ovarian cystectomy', GYN, 'laparoscopic'],
  ['operative-hysteroscopy', 'Operative hysteroscopy', GYN, 'endoscopic'],
  // Orthopaedics
  ['total-hip-arthroplasty', 'Total hip arthroplasty', ORTHO, 'open'],
  ['total-knee-arthroplasty', 'Total knee arthroplasty', ORTHO, 'open'],
  ['hip-hemiarthroplasty', 'Hip hemiarthroplasty', ORTHO, 'open'],
  ['dynamic-hip-screw', 'Dynamic hip screw fixation', ORTHO, 'open'],
  ['ankle-orif', 'Open reduction and internal fixation of ankle', ORTHO, 'open'],
  ['arthroscopic-acl-reconstruction', 'Arthroscopic ACL reconstruction', ORTHO, 'endoscopic'],
  ['lumbar-spinal-fusion', 'Lumbar spinal fusion', ORTHO, 'open'],
  // Vascular
  ['carotid-endarterectomy', 'Carotid endarterectomy', VASC, 'open'],
  ['open-aaa-repair', 'Open abdominal aortic aneurysm repair', VASC, 'open'],
  ['evar', 'Endovascular aneurysm repair (EVAR)', VASC, 'percutaneous'],
  ['femoropopliteal-bypass', 'Femoropopliteal bypass', VASC, 'open'],
  ['arteriovenous-fistula-creation', 'Arteriovenous fistula creation', VASC, 'open'],
  ['endovenous-ablation', 'Endovenous ablation of varicose veins', VASC, 'percutaneous'],
  // Cardiothoracic
  ['cabg', 'Coronary artery bypass grafting (CABG)', CT, 'open'],
  ['aortic-valve-replacement', 'Aortic valve replacement', CT, 'open'],
  ['mitral-valve-repair', 'Mitral valve repair', CT, 'open'],
  ['tavi', 'Transcatheter aortic valve implantation (TAVI)', CT, 'percutaneous'],
  ['vats-lobectomy', 'VATS lobectomy', CT, 'endoscopic'],
  // Neurosurgery
  ['craniotomy-tumour-resection', 'Craniotomy for tumour resection', NEURO, 'microsurgical'],
  ['burr-hole-subdural-evacuation', 'Burr-hole evacuation of chronic subdural haematoma', NEURO, 'open'],
  ['lumbar-microdiscectomy', 'Lumbar microdiscectomy', NEURO, 'microsurgical'],
  ['acdf', 'Anterior cervical discectomy and fusion (ACDF)', NEURO, 'microsurgical'],
  ['ventriculoperitoneal-shunt', 'Ventriculoperitoneal shunt insertion', NEURO, 'open'],
  // ENT
  ['tonsillectomy', 'Tonsillectomy', ENT, 'open'],
  ['functional-endoscopic-sinus-surgery', 'Functional endoscopic sinus surgery (FESS)', ENT, 'endoscopic'],
  ['septoplasty', 'Septoplasty', ENT, 'open'],
  ['tympanoplasty', 'Tympanoplasty', ENT, 'microsurgical'],
  ['parotidectomy', 'Parotidectomy', ENT, 'open'],
  ['surgical-tracheostomy', 'Surgical tracheostomy', ENT, 'open'],
  // Plastic surgery
  ['carpal-tunnel-release', 'Carpal tunnel release', PLAS, 'open'],
  ['diep-flap-breast-reconstruction', 'DIEP free-flap breast reconstruction', PLAS, 'microsurgical'],
  ['skin-lesion-excision-local-flap', 'Excision of skin lesion with local flap', PLAS, 'open'],
  ['split-skin-graft', 'Split-thickness skin graft', PLAS, 'open'],
  ['flexor-tendon-repair', 'Flexor tendon repair', PLAS, 'open'],
  // Paediatric surgery
  ['paediatric-inguinal-herniotomy', 'Paediatric inguinal herniotomy', PAED, 'open'],
  ['pyloromyotomy', 'Pyloromyotomy', PAED, 'laparoscopic'],
  ['orchidopexy', 'Orchidopexy', PAED, 'open'],
  ['paediatric-laparoscopic-appendicectomy', 'Paediatric laparoscopic appendicectomy', PAED, 'laparoscopic'],
  ['cleft-lip-repair', 'Cleft lip repair', PAED, 'open'],
];

/**
 * Common procedures across general, colorectal, upper GI/HPB, urology,
 * gynaecology, orthopaedics, vascular, cardiothoracic, neurosurgery, ENT,
 * plastics and paediatrics (SPEC.md › catalog/procedures.ts). Deeply frozen.
 */
export const PROCEDURE_CATALOG: readonly ProcedureCatalogEntry[] = Object.freeze(
  ROWS.map(([id, name, specialty, defaultApproach]) =>
    Object.freeze(
      defaultApproach === undefined ? { id, name, specialty } : { id, name, specialty, defaultApproach },
    ),
  ),
);

const BY_ID: ReadonlyMap<string, ProcedureCatalogEntry> = new Map(PROCEDURE_CATALOG.map((p) => [p.id, p]));

/**
 * Look up a catalogue entry by its id (exact, case-sensitive match).
 * Returns `undefined` for unknown ids.
 */
export function findProcedure(id: string): ProcedureCatalogEntry | undefined {
  return BY_ID.get(id);
}
