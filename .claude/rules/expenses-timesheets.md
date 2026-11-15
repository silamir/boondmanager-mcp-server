---
paths:
  - "src/schemas/**/*.ts"
  - "src/tools/expenses.ts"
  - "src/tools/timesheets.ts"
  - "src/tools/absences.ts"
  - "src/prompts/**/*.ts"
---

# Expenses and timesheets: monthly-container write model, state on write schemas

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

**Expenses / notes de frais** (`src/tools/expenses.ts`, issue #179): the write
model here was **not** derivable from the documentation. The RAML for
`/expenses-reports` says `post: description: Create an expenses` and nothing
else — no body, no required set — and while `/application/dictionary` publishes
the attribute *names* (`models.expensesreport`, `models.expense`), it publishes
neither which of them are required nor which are accepted-then-ignored. Every
statement below was verified field by field against the live API, so change it
against the API, not against intuition.

The entity is a **monthly container per resource** (`term` + `resource`) whose
lines live in the `actualExpenses` array. There is no standalone expense-line
endpoint. The shape the tools before #179 sent — `amount`, `expenseDate`,
`typeOf`, `note` at report level — was line vocabulary in a report slot and had
never created anything; `boond_expenses_create` returned 422 on every call.

Traps, each with a test:

- **`exchangeRateAgency` is required on create** (`1002` otherwise), hence its
  `.default(1)`. `data.type` on the other hand is *ignored*, so the historical
  `"expense"` type string was never the bug.
- **`state` is accepted and silently ignored, on POST *and* PUT.** The state is
  moved by BoondManager's validation workflow; a create always lands in
  `savedAndNoValidation`. It is therefore absent from both schemas — exposing it
  advertised a transition the endpoint does not perform.
- **A line's required set is larger than it looks**: besides `startDate`,
  `activityType`, `project`, `delivery` and the amount, the API also demands
  `batch`, `isKilometricExpense`, `reinvoiced`, `currency` and `exchangeRate`. It
  reports them in *waves* — one 422 per group — so discovering them by trial and
  error costs five round-trips. They are `.default()`ed on their overwhelmingly
  common values rather than left to the model.
- **`batch` must be present with a `null` id** when the line has no batch.
  `{ id: "0" }` and `{ id: 0 }` are both rejected (`1002`) and an absent key is
  `1017`. It is the one field that must survive `buildJsonApiBody`'s
  undefined-stripping, which is why `buildExpenseLine` writes it
  unconditionally. Same for `expenseType`, which must be present holding `null`
  on a kilometric line.
- **`actualExpenses` on PUT replaces the whole array.** PUT is otherwise a
  partial update (sending only `informationComments` keeps the lines), so this
  one field breaking the pattern is what silently deletes a month of expenses.
  Said in the schema description and in the prompt runbook.
- **The API does not deduplicate.** Two reports can coexist on the same
  (resource, term) — a blind create silently doubles the month, which is why the
  runbook searches before writing.
- **HT/VAT are derived, not stored.** `amountIncludingTax` (TTC) and `tax` — a
  **rate** in %, not an amount — are what persist. `amountExcludingTax` and
  `taxAmount` are accepted on write and recomputed, never echoed back. So there
  is nothing to add for them and nothing lost by omitting them.

**Timesheets / CRA** (`src/tools/timesheets.ts`, issue #249): the same
monthly-container model as expenses, established **from reads only** — this
tenant is production, so unlike #179 the POST/PUT were *not* exercised; the
first write against a test tenant should confirm the points marked *unverified*
below and fix this section.

- **Verified (read, 2026-09-25)**: `GET /times-reports/{id}` returns `term`,
  `informationComments`, `closed`, `state` (a workflow *string*: `validated`,
  `waitingForValidation`…), `regularTimes[]`, `exceptionalTimes[]`,
  `plannedTimes[]`, `absencesTimes[]`; a line is `{ startDate, duration, row,
  workUnitType: { reference, activityType, name }, project, delivery, batch }`
  with `project` / `delivery` / `batch` **`null`** on an absence line
  (`models.time` in the dictionary lists the same attributes). `GET
  /times-reports/default?resource=&term=` (422 without both) returns the
  container skeleton, the chargeable projects with their `deliveries` /
  `batches`, the `plannedTimes` derived from the deliveries' planning, and —
  on the **included resource**, `workUnitTypesAllowed` — the work-unit-type
  codes (`1` Normale/production, `4` RTT, `5` Maladie, `9` Intervention…),
  which `/application/dictionary` and `/agencies/{id}` do not publish. This is
  why `boond_timesheets_default` exists and renders that resource attribute.
- **Unverified (write)**: whether an absent `project` / `delivery` / `batch`
  must be `null` (what the API echoes — what `buildTimeLine` sends) or
  `{ id: null }` (what `/expenses-reports` demanded for `batch`); whether
  `agency` is required on POST; the 422 "waves" of required fields. `state` is
  kept out of both schemas on the strength of the expenses finding (same
  validation workflow — `boond_validations_search` covers `timesReport`), and
  `regularTimes` / `exceptionalTimes` on PUT are documented as replacing the
  whole array by analogy with `actualExpenses`.
- The previous `boond_timesheets_create` sent `totalDays`, `totalHours`,
  `state`, `note` at report level — line vocabulary in a report slot, none of
  it in `models.timesreport`; it had never created anything.
**`state` on write schemas** (issue #250) is a truth table, pinned in
`src/schemas/state-writability.test.ts` with the verification behind each
row: absent on the three validation-workflow documents (`expensesReport` —
verified on write in #179; `absencesReport` and `timesReport` — verified on
read: their `state` is a workflow *string* such as `waitingForValidation`,
so an integer could never be what the API stores), exposed as a dictionary id
(`stateField`, `boond://dictionary/states/*`) on `invoice`, `order` and
`positioning` (the positionings RAML documents `won` on POST attaching a
project; the invoice / order write path is not verified). Don't add a bare
`z.number()` `state` to a write schema: use `stateField` where it persists,
nothing where the workflow owns it. On invoices, send `performedPaymentDate` in the
same PUT as the move to "paid", otherwise Boond dates the payment with today (write
path unverified; fallback = a second update carrying the date alone).

**`boond_expenses_default`** exists because the expense-type codes are published
nowhere else. `GET /expenses-reports/default?resource=&term=` is the only route
that returns the agency's `expenseTypes` (`reference` + label + `taxRate`) and
`ratePerKilometerTypes`: `/application/dictionary` has no expense-type table at
all (`setting.state` has no `expensesreport` key either) and `/agencies/{id}`
returns only a name. It also yields the `agencyId`, the currency/exchange-rate
pair, and the (project, delivery) couples chargeable for that resource+term —
the two ids a line cannot omit and that the API refuses if not chargeable. The
tool renders those down rather than dumping the response, which inlines the
resource's entire `timesreport` (every daily row of the month) — data no expense
payload references, and enough of it to eat the character budget.
