# EHR `additionalFields` Schema-Gap Recommendations

Consolidated from per-category analyses of discovered `additionalFields` across the
`patient`, `provider`, `encounter`, `order`, and `other` buckets. Sources:
`summary-{patient,provider,encounter,order,other}.json` in this directory.

The single highest-leverage theme across every category is **synonym fragmentation**:
a handful of real concepts are splintered across dozens of vendor-specific label variants.
Canonicalization (Section 3) plus promoting the merged concepts (Section 1) recovers most
of the value; freeform value normalization (Section 2) is the second big win.

---

## 1. Promote to top-level schema

Prioritized by merged cross-cutting frequency. Frequencies are approximate merged counts
across all synonym labels within a category.

### Clear wins (high frequency, universal, structurable)

| Field | Absorbs labels (examples) | Approx freq | Proposed type |
|---|---|---|---|
| `provider` (rendering / treating) | Provider, Physician, Doctor, Rendering Provider, Encounter/Visit Provider, Seen By, Clinician | ~260 | `object{displayName, lastName?, firstName?, credential?, npi?, specialty?, facility?, isUnassigned?}` |
| `insurance` (patient) | Insurance, Primary/Secondary Insurance, Payer, Plan, Insurer, Coverage Plan | ~170 | `list<object{rank(primary\|secondary\|tertiary), payerName, planName?, memberId?, groupNumber?, policyNumber?, relationship?}>` |
| `allergies` | Allergies, Allergy, Drug Allergies, Adverse Drug Reactions, NKDA sentinels | ~160 | `object{noKnownAllergies:bool, entries:list<object{substance, reaction?, severity?, status?}>}` |
| `loggedInUser` (NOT a clinician) | User, Welcome, Logged-in User, Current User, Dashboard for | ~120 | `object{name, role?}` |
| `chiefComplaint` | Chief Complaint, CC, Reason (for Visit), Complaint, HPI/Indication | ~110 | `string` (optional separate `historyOfPresentIllness`) |
| `encounterLocation` | Location, Facility, Clinic, Room, Bed, Ward, Unit, POS | ~215 | `object{facility?, clinicOrDepartment?, room?, bed?, unitOrWard?, placeOfServiceCode?, raw?}` |
| `appointmentInfo` | Last Visit, Next Appointment, Appt Time/Type, Duration | ~120 | `object{appointmentTime?, appointmentType?, lastVisit?, nextAppointment?, duration?}` |
| `email` (patient) | Email, Email address, Patient Email, e-mail | ~75 | `string` — clear schema miss; phone/address exist but no email |
| `phones[]` (patient, typed) | Cell/Home/Work Phone, Mobile | (multiple) | `list<object{type(home\|cell\|work\|other), number, raw}>` — schema has only single `phone` |
| `primaryCareProvider` | PCP, Primary Care (Provider), Usual/Preferred/My Doctor | ~75 | `object{name, npi?, specialty?}` |
| `referringProvider` | Referring Physician/Provider, Referral PCP, Referred by/to | ~80 | `object{name, direction(referredFrom\|referredTo)?, npi?}` |
| Vitals: `weight`, `height`, `bmi`, `bloodPressure` | Weight/Wt, Height/Ht, BMI, BP/Blood Pressure | ~120 combined | per-vital `object{raw, value:number, unit, canonicalSI}` (kg/cm); BP `{systolic, diastolic, arm?, position?, raw}` |
| `encounterDiagnoses` / patient `problems` | Diagnosis, Dx, Assessment, Impression, Problem (List) | ~70 (enc) / ~45 (pt) | `list<object{code?, codeSystem(ICD-9\|ICD-10\|SNOMED)?, description, rank?}>` |
| `identifiers[]` (MRN/account/etc.) | MRN, Chart #, Account #, External ID, Patient ID | ~45 | `list<object{type(mrn\|chart\|account\|external\|other), value}>` |
| `ssn` | SSN, Soc Sec #, Social Security Number (often masked) | ~50 | `string` (mask-aware) |
| `facilityName` (org / care site) | Practice, Facility, Clinic, Hospital, Organization, Center | ~45 | `object{name, type(practice\|clinic\|hospital\|office\|organization\|program)}` |
| `patientBalance` / `accountBalances` | Patient Balance, Balance Due, Copay, Insurance Balance, Credit | ~40–70 | `object{patientBalance?, insuranceBalance?, totalBalance?, copay?, credit?, currency, raw}` |
| `orderedItemName` + `orderCategory` | Drug/Medication/Rx, Test, Study, Lab Ordered | ~25 | `string` + enum `medication\|lab\|imaging\|procedure\|referral\|vaccine\|supply\|other` |
| `careTeam[]` | Nurse, Tech, Anesthesiologist, Endoscopist, Surgeon, Therapist, Case Manager | ~60 | `list<object{name, role}>` |

### Solid mid-tier

| Field | Absorbs | Approx freq | Proposed type |
|---|---|---|---|
| `medications[]` (patient) | Medications, Current/Active Meds | ~30 | `list<object{name, dose?, route?, frequency?}>` |
| `medicationSig` (order) | Sig, Dispense, Refills, Qty, NDC | ~11 | `object{sig, dispenseQuantity, refills:int, ndc}` |
| `emergencyContact[]` | Emergency Contact, Next of Kin, Person to Notify, Guardian, Proxy | ~30 | `list<object{name, relationship?, phone?, email?, role}>` |
| `attendingProvider` | Attending, Admitting, Supervising | ~42 | `object{name, role(attending\|admitting\|supervising)?, credential?}` |
| `encounterStatus` | Status, Visit/Schedule Status, Check-In, Arrived | ~75 | `object{rawStatus, normalizedStatus(enum)?, checkInTime?}` |
| `encounterId` family | Encounter/Visit #, CSN, FIN, Case, Episode | ~65 | `object{visitId?, encounterId?, caseId?, episodeId?}` |
| `insuranceCoverage` (encounter) | Payer, Plan, Financial Class, Self Pay | ~45 | `object{primaryPayer?, secondaryPayer?, planName?, financialClass?, selfPay?}` |
| `preferredPharmacy` | Pharmacy, Preferred/Selected Pharmacy, PBM | ~25 | `object{name, address?, pbm?}` |
| `smokingStatus` | Smoking Status, Smoke, Tobacco | ~15 | `object{statusText, normalized(never\|former\|current\|unknown)?, snomedCode?}` |
| `codeStatus` | Code Status, DNR, Resuscitation, Adv Dir | ~18 | `object{normalized(fullCode\|DNR\|DNI\|comfortCare\|other), raw}` |
| `orderId` | Order#, Requisition/Accession/Lab #, Case/Consult # | ~18 | `string` (+ `idType`) |
| `orderingDiagnosis` (+ `procedureCode`) | Dx/Reason, CPT Code, Pri. Proc | ~7 | `object{code, codeSystem, text}` |

### Marginal (promote only if cheap; otherwise leave nested/specialty)

| Field | Note |
|---|---|
| `lastVisitDate` / visit-timeline (patient) | Overlaps `appointmentInfo`; fold into it rather than duplicating. |
| `patientStatus` | Overloaded (record vs portal vs census) — only promote as typed `{statusText, type}`. |
| `worklistCounts` | ~25 UI badge counters; promote as a single generic `dashboardMetrics: list<{kind, count}>`, not per-metric fields. These are UI artifacts, not patient data. |
| `riskScore` (RAF, CMS-HCC, ESI) | ~6; typed `{type, value, maxValue}` only if score capture is in scope. |
| `providerFacility` | Distinct from `systemName`; can collapse into `facilityName`. |
| `pregnancy G/P`, oncology staging, ophthalmology, endoscopy | Specialty-only — keep as optional nested objects, see Section 4. |

**Schema misses to call out explicitly:** patient `email` and typed patient `phones[]` are
high-frequency and have no home in the current schema. The provider bucket currently
**conflates three orthogonal concepts** — encounter clinician vs. longitudinal providers
(PCP/referring/attending) vs. the authenticated **app user** (`User`/`Welcome` with values
like `SysAdmin`, `SYSDBA SYSDBA`, `Administrator`). Mislabeling the logged-in operator as the
treating physician is the highest-risk current error.

---

## 2. Fields needing structure / taxonomy

Concrete normalization and enum proposals for freeform values.

### Date / datetime normalization (touches every category)
Values span `Feb 02, 2011`, `11/18/2014`, `04/25/19`, `1950-01-16`,
`Wed, Aug 03, 2011 at 10:00 am`, `0320 28 Apr 2016`, relative (`Today`, `2 months ago`).
**Proposal:** normalize all date-valued fields to ISO 8601 (`YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`,
timezone when present), preserve original in a `raw` subfield, resolve 2-digit years and
relative dates against capture/encounter date, flag unresolved.

### Money / currency normalization (billing across categories)
Values: `$0.00`, `$1,242.00`, `US$0.00`, `0.00`, `$171.6100`, `$ 540.00`, `$(100.00)`, `DUE`.
**Proposal:** parse to `{amount:number, currency:'USD', raw}`; strip symbol/commas/spaces;
treat parentheses as negative (credit); route non-numeric tokens (`DUE`, `Self Pay`) to a
status field; keep patient vs insurance balance distinct. Note one `Fee (CAD)`.

### Diagnosis / problem codes vs text
`ICD10 R10.32 Left lower quadrant pain`, `401.1`, `J44.9 - Chronic...`, `Abdominal pain [789.0]`,
`H10.33 (372.00)`, `I4820, Chronic atrial fibrillation`.
**Proposal:** split into `{code, codeSystem, description}`. Infer system: `^[A-Z]\d` → ICD-10,
`^\d{3}` or bracketed `[789.0]` → ICD-9, 5-digit numeric → CPT. Carry `rank` from the source label.

### Provider name + embedded credential / NPI / specialty
Formats: `LAST, First`, `First Last`, `First Last, MD`, `Dr. First Last`, ALL CAPS,
login-prefixed `JDB - John Banks MD`, `02 - FRANKLIN JACKSON MD`; suffixes `[Pediatrics]`,
`| Garlic Creek FC`, `: Mental Health`, `(NPI: 1245319599)`.
**Proposal:** shared parse to `{displayName(verbatim), lastName, firstName, credential, npi, specialty, facility}`.
Strip leading `/^[A-Z0-9]{1,5}\s*-+\s*/`. Credential enum with punctuation normalization
(`M.D.`→`MD`, `O.D.`→`OD`, `PA-C`→`PA`); flag OCR-suspect tokens (`MMD`). Extract `NPI:?\s*(\d{10})`, DEA, provider IDs.

### Null / unassigned sentinels (provider, and generally)
`N/A`, `(None)`, `None`, `Not Selected`, `No Referring Physician`, `Primary Care Team Unassigned`,
`No consultor asignado`, `-ALL-`. **Proposal:** normalize to null with `isUnassigned=true`
(case-insensitive sentinel set).

### Multi-person values
`Maryann McLaughlin / Paula Moran-Lally`, `Lauren Powell + 2 others`, `Contact Abas Tay, M.D.`.
**Proposal:** model as arrays; split on `/`, ` + `, ` and `, name-safe `,`; capture overflow
(`+ 2 others`) as `additionalCount`.

### Vitals units + combined fields
`95.254kg`, `200 lbs`, `150 lb 0 oz (68.04 kg)`, `49.9kg/110lb`; height `5' 6.0"`, `1.65m`,
`63in`, `165.1cm/65in`; bundled `Ht/Wt/BSA` = `72 in / 130 lb / 1.73 m2`; BP `120/80 (Left Arm)`.
**Proposal:** per vital `{raw, value, unit, canonicalSI}`; split combined labels into components;
split BP into systolic/diastolic + arm + position.

### Allergy entries + "none" sentinels
`PENICILLINS (rash, nausea)`, `Amoxicillin: PENICILLINS`; none-states `None`, `No Known Allergies`,
`NKDA`, `Allergy information has not been entered`.
**Proposal:** `list<object{substance, reaction?, severity(mild\|moderate\|severe)?, status?}>`
plus a single `noKnownAllergies:bool` collapsing all negative sentinels.

### Status / lifecycle enums
- **Encounter status:** `scheduled, confirmed, arrived, checkedIn, roomed, inProgress\|beingSeen, completed, signed, unsigned, cancelled, noShow`; keep `rawStatus`; extract embedded time to `checkInTime`.
- **Smoking:** `never, former, current, currentSomeDay, currentEveryDay, unknown` + raw + optional snomedCode/frequency.
- **Code status:** `fullCode, DNR, DNI, comfortCare, other`; map `Full Code*`/`CPR`→`fullCode`.
- **Order/report status:** `draft, pending, active, inProgress, completed, final, cancelled, discontinued, preliminary, corrected`.
- **Encounter mode:** `inPerson, telehealth, phone, walkIn, scheduled` (derive telehealth from POS 02/10).
- **Fasting:** `fasting \| nonFasting \| unknown`.

### Order quantities / refills
`30 Tablet`, `90`, `2 2` (ordered,selected), `10 total Rx`; refills `Six` vs `2`.
**Proposal:** `{quantity:number, unit:string}`; `{orderedUnits, selectedUnits}` for tuples;
refills → non-negative integer (`Six`→6).

### Name components & emergency-contact parsing (patient)
`Patient Name` is often `Last, First M`; nickname/known-as/goes-by are one `preferredName`.
EC values embed name+relationship+phone+email (`Emily Gale Phone Number: (555)... Email: ...`,
`Combs, Evan (Brother) 513-555-1234`). **Proposal:** extend `name` with `middleName, suffix,
preferredName, legalName`; parse EC into `{name, relationship, phone, email, role}`.

### Document-author / audit values (provider)
`TAAdmin SupportAccount 5/26/2020 6:39 pm`, `John House MD on 9/4/2018 ... - Unsigned`.
**Proposal:** `documentAuthor{name, timestamp(ISO), status(signed\|unsigned\|cosigned)}` — not the encounter provider.

### Range / compound fields
`Last: 08/16/19 Next: __/__/__`, `28 - 03/01/2014 - 04/29/2014`, `Last PMT Date & AMT` = `05/21/2014 | $4.13`.
**Proposal:** split into `{start, end}` or separate date/amount fields; drop placeholders (`__/__/__`) to null.

---

## 3. Labeling guidance (canonical ↔ synonyms)

So the model labels the same concept consistently.

**Patient**
- `allergies` ← Allergies, Allergy, Drug Allergies, Adverse Drug Reactions, Active/Act. Allergies, Allergen, Screened/Client/Prior Allergies, Allg
- `insurance.primary` ← Primary Insurance, Primary Ins(.), Primary Plan, Pri, Insurance 1
- `insurance.secondary` ← Secondary Insurance, Secondary/Second Ins, Sec, Insurance 2
- `insurance` ← Insurance, Health insurance, Insurance Plan/Provider/Carrier, Insurer, Payer, Plan, Ins, Coverage Plan, Pt. Insurance
- `email` ← Email, Email address, Patient Email, e-mail, E-Mail Address, Contact E-mail
- `ssn` ← SSN, Soc Sec #, Social, Social Security Number (SSN), SSNum, External SSN, SSN (LAST FOUR DIGITS)
- `mrn` ← MRN, External MRN, Chart #, Chart Number; `accountNumber` ← Account Number/#, Acct #, ACCT(#), Account (ID)
- `weight` ← Weight, Wt, W, Patient/Last/Current/Initial/Most Recent Weight, Weight (lbs), Wt (lb)
- `height` ← Height, Ht, Last Height, Height/Length, Height (Inches), Ht (in)
- `bloodPressure` ← BP, Blood Pressure
- `smokingStatus` ← Smoking Status, Smoke, Tobacco, Tobacco Status
- `codeStatus` ← Code Status, DNR Status, Resuscitation Status
- `preferredPharmacy` ← Pharmacy, Preferred Pharmacy, Pharmacy1, Pref. Pharm., Pharm, Primary Pharm
- `emergencyContact` ← Emergency Contact, Emergency, Next of Kin, Person to Notify, Primary Next of Kin Name
- `problems` ← Problem(s), Problem List, Active/Act. Problems, Medical Problems/Conditions, Diagnosis(es), Dx, Pt Diagnoses, Primary Diagnosis
- `medications` ← Medications, Medication, Current/Active Meds, Current Medication(s), Act. Meds
- `patientBalance` ← Patient Balance, Balance, Account Balance, Balance Due, Current/Total Balance, Patient/Pt. Due, Owes
- `cellPhone` ← Cell Phone, Cell, Cell #, Mobile, Mobile Phone; `homePhone` ← Home Phone, Phone Home; `workPhone` ← Work Phone
- `preferredName` ← Nickname, Nick Name, Preferred Name, Known As, Goes By
- `preferredLanguage` ← Language, Preferred Language, Language at Home/Spoken At Home
- `patientAlert` ← Alert(s), Patient Alert, EMR/Medical Alerts, Flag, Warnings
- address: `city` ← City, Town; `state` ← State, State/Prov; `zip` ← Zip, Zip Code, State ZIP

**Provider**
- `renderingProvider` ← Provider, Physician, Doctor, Rendering (Provider/Physician), Encounter/Visit Provider, Performing Provider, Seen By, Prov(.), Phys, Clinician, Practitioner, Care Provider
- `primaryCareProvider` ← PCP (Name), Primary Care (Provider), Primary Provider/Physician/Doctor/Clinician, PCM, Usual (Provider), My/Preferred Doctor/Provider, GP
- `referringProvider` ← Referring (Physician/Provider/Dr), Referral (From/Physician/PCP/Source), Referred by/to, Ref(.), Ref Dr/Phy/Provider, Requesting/Requested Provider
- `loggedInUser` ← User, Logged-in/Logged in User, Logged in as, Current User/Provider, Welcome (User/Provider), Login, Dashboard for, Chart Room for
- `attendingProvider` ← Attending (Provider/Physician/MD/Doc/Prov/Phy), Attend, Admitting (MD), Supervising Provider/Doctor/Nurse
- `billingProvider` ← Billing Provider/Physician (Name), Credited/Submitting Provider
- `prescriber` ← Prescriber, Prescribing MD, Ordering Prov, Ordered by, Order practitioner
- `careTeam` roles: `nurse` ← Nurse(s)/Nurse1/RN; `endoscopist` ← Endoscopist(s)/Endoscopist1; `technologist` ← Tech/Technologist
- `providerFacility` ← Facility/Facilities, Clinic, Practice (Name), GP Practice, Office, Location, Corporation, Organization Provider, Agency

**Encounter**
- `chiefComplaint` ← Chief Complaint(s), CC, Complaint, Pt Complaint, Reason (for Visit/encounter), Subjective Complaint, Queja Principal
- `historyOfPresentIllness` ← HPI, History of Present Illness/Illness, Indication
- `encounterLocation` ← Location, Loc, Encounter/Visit/Service/Clinic/Tx Location, Location Name
- `facility` ← Facility, Billing Facility, Office (Location); `clinicOrDepartment` ← Clinic, Program, Site, Department
- `room` ← Room (#/Number/Name), Exam/Proc Room, Resource; `bed` ← Bed, Room Bed, RM/BED, UNIT/BED, Unit - Room; `unitOrWard` ← Ward, Unit, Facility/Unit
- `placeOfService` ← Place of Service, POS, TOS
- `encounterStatus` ← Status, Encounter/Visit/Schedule/Patient Status, Workflow Stage, Intake status
- `encounterId` ← Encounter (ID/#), Enc#; `visitId` ← Visit (#/ID/Number), CSN, FIN, VN; `caseId` ← Case (#/ID/Number); `episodeId` ← Episode (#), External Episode
- `lastVisit` ← Last Visit/Appointment/Appt/Office Visit/Service/Seen/Exam Date; `nextAppointment` ← Next Appointment/Appt/Visit, Recall Date
- `appointmentType` ← Appt(.) Type, Appointment type/Reason, Visit Type, NOV; `appointmentTime` ← Appointment/Appt Time, Time, Start (time), Arrival Time
- `primaryDiagnosis` ← Primary/Provisional/Admitting Diagnosis, Pri. Dx, Admit Dx, Diagnosis 1
- `diagnosis` ← Diagnosis(es), Diagnosis Code/Description, Assessment, Impression, Problem (List), Reason (ICD), ICD
- `insurancePayer` ← Insurance, Payer (Name), Payor, Plan, Health Plan, Coverage, Bill (Primary), Ins; `copay` ← Copay, Co-Pay, Amount Copay
- `admitDate` ← Admit/Admission Date, Admitted; `checkInTime` ← Check In, Check-In Time, Arrived, Registered, Time In

**Order**
- `orderedItemName` ← Drug (Name), Medication (1/2), Rx, Selected Drug, Pending/Ordered Medication, Lab Ordered, Test, Study (Description), Pharmaceuticals
- `orderId` ← Order#, Requisition No., Lab Req#, Accession (No.), Case Number, Consult #, Lab#; `billingId` ← Claim #/ID, Invoice ID
- `pharmacy` ← Pharmacy; `performingLab` ← Lab Co.
- `orderingDiagnosis` ← Dx, Diagnosis, Diag., Reason; `procedureCode` ← Code, CPT Code, Pri. Proc
- `dispenseQuantity` ← Dispense, Qty; `sig` ← Sig; `refills` ← Refills; `ndc` ← Drug NDC
- `startDate` ← Start Date; `orderDate` ← Order date; `reportStatus` ← Report Status

**Other / cross-cutting**
- `facilityName` ← Practice, Facility (Name), Clinic (Location), Office, Organization/Organisation, Center (Name), Medical Center, Selected/Select Hospital/Location, POS Facility
- `patientBalance` ← Patient Balance, Patient Due($), Self-pay Balance, Current Balance, Balance; `insuranceBalance` ← Insurance Balance; `accountBalance` ← Account Balance, Total (balance/Due), Amount Due
- `insurancePayer` ← Insurance, Primary Insurance, Insurance Name, Payer, Vision/Medical
- `pharmacy` ← Pharmacy, Selected Pharmacy; `pbm` ← PBM
- `user` ← User, Username; `lastLogin` ← Last Login, Last Logon
- messaging: `messageSender` ← From, Inbox Message From; `messageRecipient` ← Inbox Message To; `messageSubject` ← Subject; `messageBody` ← Message; `messageDate` ← Message Date, Date
- `bodyLocation` ← Body Location, Location Detail (distinct from facility `Location`)

---

## 4. Leave as freeform (`additionalFields`)

Genuinely long-tail or specialty-specific; not worth schema bloat. Prefer optional nested
specialty objects or a generic `specialtyFields: list<{label, value, normalizedDate?}>` passthrough.

- **Specialty blocks** (recur only within a specialty):
  - Oncology: Stage/Stage group/TNM, ER/PR/HER2 status, Histology, Disease Status, CYCLE NUMBER, Line of therapy, Treatment Intent → optional `oncology{stage, tnm, receptors{er,pr,her2 enum positive\|negative\|equivocal\|unknown}, histology, diseaseStatus}`.
  - Ophthalmology: Preferred Eye, Last Dilation, Pachy OD/OS, VA Method, Rx Worn.
  - OB: G/P (gravida/para), EDD, GA → optional `obstetrics{gravida, para{term,preterm,abortions,living}, raw}`.
  - Endoscopy: Scope In/Out, Cecum Intubation.
  - Behavioral health: Self Destructive Act, Lethality, Court Ordered Counseling.
  - Radiation oncology / optical / blood bank order fields: Energy, Dose Rate, Treatment Orientation, Plan Id, Instrument(s); Manufacturer/Brand/Model/Color; Product `*RC`, XM, Units(ordered,selected).
- **Idiosyncratic singletons:** CCD Zip File Password, Medisolv Identifier, Favorite Color, Machine `D_Varian31EX`, WMSI, Phase.
- **UI / search artifacts to FILTER (do not model):** Client/Search Result, Similar/Duplicate Patient *, Hover/Tablet/Form/Scheduled Patient Name, Patient 1/2/3 Name, Active Banner Patient, Images Found.
- **Extraction noise to drop in post-process:** `other` bucket's top two labels are `F` (57) and `T` (28), plus a `null` label (value `T`) — mis-captured checkbox/toggle states where `label==value` (~27% of that bucket). Drop fields where `label ∈ {F, T, null}` or `label===value`; represent real toggles as `{label, state(on\|off\|yes\|no)}`.
- **Count/badge chips** (`Allergies Count`, `Conditions Count`, `Medications Count`, worklist counters): derive from the underlying lists or collapse into one `dashboardMetrics` list; do not store per-metric.
- **Misclassified into wrong bucket** (reclassify, don't model in patient): encounter operational fields (Room, Bed, ESI, Day of stay, Level of Care, Service, Schedule Status) → encounter; provider/staff/audit fields (Case Mgr, Last reviewed by, Historian, Referred By, Create User-*) → provider.
- **Localization / test noise:** non-English labels (`Queja Principal`, `Registro F/H`); test values (`Lorem Ipsum`, `Testing Please ignore`, demo names like `Marcus Welby`, `Harry Potter`, `House MD`) — fine for design, must not drive enum values.
