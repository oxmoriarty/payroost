# Payroost — AG Grid React Integration Specification

## 1. Purpose in Payroost

AG Grid React powers the **Payment Operations** workspace. It is not a decorative dashboard widget. It gives a freelancer/admin a structured, interactive view of payment records associated with projects and milestones.

The initial grid is a read-only operational table. Financial operations remain in separate server-authorized workflows.

## 2. Required MVP experience

Create a Payment Operations page with:

- Summary counts/amounts calculated from the authorized payment records returned by the server. Label totals with their currency; do not combine unlike currencies into one total.
- A responsive AG Grid transaction table.
- Columns for project, milestone, seller/payee display name, payment provider, currency, gross amount, payment state, provider reference (safely truncated), created time and last updated time where those fields exist in the application data.
- Sorting and column filters for relevant fields.
- Pagination.
- Currency and date formatting through value formatters that do not change stored values.
- A custom status cell renderer with accessible text; do not communicate status by colour alone.
- Row selection or row click to open a read-only payment detail panel/page. Use the documented current row-selection API if selection is implemented.
- Loading, empty, error and no-results states.
- Responsive behaviour for narrower screens; allow horizontal scrolling where necessary rather than hiding financially important columns without an alternative.

Use real persisted payment records once the payment workflow exists. Seed records may be used during UI development, but must be clearly identified as demo data and must not be represented as real provider transactions.

## 3. Edition and licensing boundary

The required implementation uses **AG Grid Community**. AG Grid's official React documentation lists sorting, filtering, pagination, custom cell rendering, themes/styling, accessibility support and virtualization among Community features. Community is available for production use without a licence.

Do not use Enterprise-only features for the required MVP. AG Grid's current documentation identifies the Server-Side Row Model, advanced grouping/aggregation, pivoting and Excel export as Enterprise features. Integrated Charts have additional module and licensing distinctions in AG Grid's chart documentation; they are not part of this MVP. Do not add `ag-grid-enterprise`, Enterprise modules or Enterprise licence configuration unless the project owner explicitly supplies a valid production licence and approves the scope change.

The current implementation should use the Client-Side Row Model and a bounded, authorized dataset fetched by the application. Do not introduce Enterprise server-side row model features to solve pagination. If the dataset later exceeds the appropriate client-side limit, propose and verify a Community-compatible alternative or obtain approval for an Enterprise licence before changing the architecture.

## 4. React installation and module registration

Follow the current official AG Grid React installation page. It currently documents installing `ag-grid-react`, which also installs `ag-grid-community`, and providing `AllCommunityModule` through `AgGridProvider` to enable Community features.

Use matching AG Grid package versions. Do not pin a version in this specification; Codex must follow the live official installation documentation at implementation time.

Example pattern from the current docs (verify against the installed package version before use):

```tsx
import { AllCommunityModule } from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';

const modules = [AllCommunityModule];

export function PaymentGrid() {
  return (
    <AgGridProvider modules={modules}>
      <AgGridReact rowData={rows} columnDefs={columnDefs} />
    </AgGridProvider>
  );
}
```

This is an integration pattern, not a complete component. The implementation must add typed row/column definitions, the current documented theme setup, error/loading/empty states and responsive container sizing.

## 5. Data access and security

- Fetch rows from an authenticated server endpoint or server component that enforces the user's project/payment access.
- Apply tenant/owner authorization before returning records. RLS is additional protection, not a substitute for server authorization.
- Return only fields required by the table and detail view.
- Never expose access tokens, client secrets, webhook signature material, full webhook bodies, payment instrument details or unnecessary seller/client personal data.
- Use stable payment-record IDs as row IDs.
- The grid must not be the source of truth for payment state. It renders persisted server state.
- Do not enable inline editing for amount, currency, seller/payee, provider reference, capture state, ledger values or payout state.
- Do not add buttons that directly mark payments paid, refund them or change ledger entries.
- A future refund action, if implemented, must be a separate permission-checked server operation with confirmation and provider response handling.

## 6. Data and performance approach

For the hackathon MVP, use the Client-Side Row Model with an application-bounded result set. Fetch only records the current user is authorized to view. Apply grid sorting, filtering and pagination to that fetched set. Do not imply the grid is querying all database records if the endpoint returns only a subset.

AG Grid documentation describes other row models for different loading strategies. The Server-Side Row Model is Enterprise, so it is outside this required Community implementation.

## 7. Acceptance criteria

- AG Grid React is installed and registered according to the current official React docs.
- Only Community modules/features are used in the required build.
- Payment Operations displays real authorized records from the application's payment tables.
- Sorting, filtering and pagination work.
- Amount/date/status cells are formatted accessibly.
- Selecting/opening a row shows the corresponding read-only payment details.
- No financial mutation is possible from the grid.
- Loading, empty, error and no-results states work.
- Responsive and keyboard-accessible interaction is tested.
- No Enterprise watermark, licence warning or Enterprise dependency is present in the required build.

## 8. Official AG Grid references

- React installation: https://www.ag-grid.com/react-data-grid/installation/
- React quick start: https://www.ag-grid.com/react-data-grid/getting-started/
- Community vs Enterprise: https://www.ag-grid.com/react-data-grid/community-vs-enterprise/
- Modules: https://www.ag-grid.com/react-data-grid/modules/
- Basic React grid: https://www.ag-grid.com/react-data-grid/deep-dive/
- Row models: https://www.ag-grid.com/react-data-grid/row-models/
