# EHR Identity-Banner Abstraction — Prompt & Schema (v3)

> **Runtime source of truth:** `scripts/abstract-screenshot.ts` (the Gemini
> `responseSchema` + `systemInstruction` + run config). This doc is the
> human-readable intent; if they ever disagree, the script wins.

## Role & scope

A medical-data abstraction assistant that reads a screenshot of an EHR/EMR
interface and extracts the **patient-identity banner** as structured JSON.

**In scope** — the header/strip that says *who the patient is* and the immediate
visit/provider context: identifiers, demographics, contact, light insurance, the
provider(s) of record, and the active encounter.

**Out of scope** — clinical body content in the work area (problem lists,
diagnoses/ICD codes, medications, allergies, vital signs, orders, results, notes),
*even when visible*. (In `--debug`, such items may be noted in `additionalFields`
for schema-gap discovery, but they are never promoted to the core schema.)

## Instructions (summary)

1. **System context** — `systemName` (vendor/platform), `clinicalSpecialty`,
   `activeFunction` (active screen/module), `uiSection`; `isEhrScreen` (bool);
   `patientScope` (`single`|`multiple`|`none`); `singlePatientConfidence` (0–1).
2. **Logged-in user** — `loggedInUser`: the operator ("Welcome X" / "User: X").
   **Never** a patient provider — it goes here, not in `providers`.
3. **Patient identity** —
   - `identifiers[]`: capture **every** banner ID, typed
     (`mrn|chartNumber|accountNumber|ssn|memberId|external|other`), keep masking;
     `primaryId` = the most prominent one.
   - `fullName`/`firstName`/`lastName`, `dateOfBirth` (YYYY-MM-DD), `age`, `sex`.
   - `phone`, `email`, `address`.
   - `insurance` (light, banner only): `primaryPayer`, `secondaryPayer`, `memberId`, `groupNumber`.
4. **Providers of record** — `providers[]` named in the patient/visit banner:
   `{ name, role (attending|rendering|referring|primaryCare|resident|nurse|consulting|other), credential }`.
   Banner providers only — never the logged-in operator.
5. **Encounter** — `encounterDate` (YYYY-MM-DD), `encounterType`, `location`
   (facility/clinic/unit/room), `visitId` (CSN/FIN/Visit #).
6. **Bounding boxes** — every value-bearing field is `{ value, box }`, and every
   array entry (`identifiers[]`, `providers[]`) carries its own `box`: a tight
   rectangle, integers normalized to a **0–1000** grid, origin top-left (the
   standard Gemini convention). Null value → null box. The runtime converts each
   box to pixel-space `boxPx{x,y,width,height}`.

Constraints: only what is explicitly visible (no extrapolation/hallucination);
null when unsure; output only valid JSON matching the schema.

## Output shape

```jsonc
{
  "systemMetadata": {
    "systemName": { "value": string|null, "box": {ymin,xmin,ymax,xmax}|null },
    "clinicalSpecialty": Field, "activeFunction": Field, "uiSection": Field,
    "isEhrScreen": boolean,
    "patientScope": "single" | "multiple" | "none",
    "singlePatientConfidence": number            // 0.0–1.0
  },
  "loggedInUser": Field,                          // operator, NOT a provider
  "patient": {
    "identifiers": [ { "type": "mrn|chartNumber|accountNumber|ssn|memberId|external|other",
                       "value": string, "label": string|null, "masked": boolean, "box": Box|null } ],
    "primaryId": { "type": string|null, "value": string|null },
    "fullName": Field, "firstName": Field, "lastName": Field,
    "dateOfBirth": Field, "age": Field, "sex": Field,
    "phone": Field, "email": Field, "address": Field,
    "insurance": { "primaryPayer": Field, "secondaryPayer": Field,
                   "memberId": Field, "groupNumber": Field }
  },
  "providers": [ { "name": string, "role": "attending|rendering|referring|primaryCare|resident|nurse|consulting|other",
                   "credential": string|null, "box": Box|null } ],
  "encounterContext": { "encounterDate": Field, "encounterType": Field,
                        "location": Field, "visitId": Field },

  // --debug only:
  "additionalFields": [ { "category": "patient|provider|encounter|order|other",
                          "label": string, "value": string, "box": Box|null } ]
}
// Field = { "value": string|null, "box": Box|null };  Box = { ymin, xmin, ymax, xmax }  (0–1000)
// The runtime adds "boxPx": { x, y, width, height } next to every populated box.
```

## Model & config

`gemini-3.5-flash`, structured output (`responseSchema` + `responseMimeType:
"application/json"`). Default run: `thinkingBudget: 0` + a `maxOutputTokens` cap;
on a parse failure (rare think=0 runaway) it retries once **with thinking on**.
`--debug` runs with thinking on and requests `additionalFields`.
