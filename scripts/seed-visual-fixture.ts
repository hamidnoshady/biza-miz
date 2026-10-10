/**
 * Deterministic fixture for the visual-regression baselines.
 *
 * `npm run db:seed` deliberately seeds only enough to log in: a business, a
 * location and two users. That is right for development, but it is *wrong* for
 * a visual baseline — every table photographs as its empty state, so a baseline
 * recorded against it cannot catch a regression in how a row, an amount or a
 * status badge renders. Which is most of what the design system does.
 *
 * So this adds a small, fixed cast of rows on top of the ordinary seed:
 * a chart of accounts with a posted journal entry, three warehouse items with
 * stock, three parties and three CRM deals.
 *
 * Every value here is **hard-coded on purpose**. No `Math.random`, no
 * `new Date()`, no faker: a fixture that varies produces a baseline that
 * disagrees with itself on the next run, the check gets marked flaky, and a
 * flaky check is not a check. Dates are fixed Gregorian instants chosen to land
 * on unremarkable Jalali days, and money is in integer Rial, which is how the
 * app stores it — the UI converts to the business's selected display unit.
 *
 * Idempotent: it keys every row on a stable natural key and skips what exists,
 * so re-running it before a re-record does not double the data.
 *
 * Usage: npm run db:seed:visual   (run `npm run db:seed` first)
 */
import "dotenv/config";
import { Client } from "pg";

/** A fixed instant, so "last changed" columns never drift. */
const T0 = "2026-03-15T08:30:00.000Z";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    // Fixtures span the tenant boundary the same way seeding does.
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    const business = await client.query("SELECT id FROM businesses ORDER BY created_at LIMIT 1");
    if (!business.rowCount) {
      throw new Error("No business found. Run `npm run db:seed` first.");
    }
    const businessId = business.rows[0].id as string;

    const location = await client.query(
      "SELECT id FROM locations WHERE business_id = $1 ORDER BY created_at LIMIT 1",
      [businessId],
    );
    if (!location.rowCount) throw new Error("No location found. Run `npm run db:seed` first.");
    const locationId = location.rows[0].id as string;

    // ---- Chart of accounts -------------------------------------------------
    // Four accounts, enough for the trial balance to show a real hierarchy and
    // a balanced pair of totals rather than «هنوز سندی ثبت نشده است».
    // `normal_balance` is a generated column derived from `type`, so it is not
    // written here — the database decides debit/credit from the account type.
    const ACCOUNTS: Array<{ code: string; name: string; type: string }> = [
      { code: "1010", name: "صندوق", type: "asset" },
      { code: "1020", name: "بانک ملت", type: "asset" },
      { code: "4010", name: "فروش کافه", type: "revenue" },
      { code: "5010", name: "خرید مواد اولیه", type: "expense" },
      // 1200 is WELL_KNOWN_CODES.accountsReceivable — the A/R screens read
      // balances from journal lines posted to exactly this code, so without it
      // «حساب‌های دریافتنی» photographs as an empty state.
      { code: "1200", name: "حساب‌های دریافتنی", type: "asset" },
      { code: "5020", name: "اجاره محل", type: "expense" },
    ];
    const accountIds = new Map<string, string>();
    for (const account of ACCOUNTS) {
      const existing = await client.query(
        "SELECT id FROM accounts WHERE business_id = $1 AND code = $2",
        [businessId, account.code],
      );
      if (existing.rowCount) {
        accountIds.set(account.code, existing.rows[0].id);
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO accounts (business_id, code, name, type, level)
         VALUES ($1, $2, $3, $4::account_type, 'moein'::account_level) RETURNING id`,
        [businessId, account.code, account.name, account.type],
      );
      accountIds.set(account.code, inserted.rows[0].id);
    }

    // ---- A posted journal entry -------------------------------------------
    // Balanced by construction: a cash sale of 4,500,000 Rial and the purchase
    // that supplied it. Two entries so the trial balance has more than one row
    // per side and its totals are worth reading.
    const ENTRIES: Array<{
      memo: string;
      date: string;
      lines: Array<{ code: string; debit: number; credit: number }>;
    }> = [
      {
        memo: "فروش نقدی روز",
        date: "2026-03-10",
        lines: [
          { code: "1010", debit: 45_000_000, credit: 0 },
          { code: "4010", debit: 0, credit: 45_000_000 },
        ],
      },
      {
        memo: "خرید دانه قهوه",
        date: "2026-03-12",
        lines: [
          { code: "5010", debit: 18_000_000, credit: 0 },
          { code: "1020", debit: 0, credit: 18_000_000 },
        ],
      },
    ];
    for (const entry of ENTRIES) {
      const existing = await client.query(
        "SELECT id FROM journal_entries WHERE business_id = $1 AND memo = $2",
        [businessId, entry.memo],
      );
      if (existing.rowCount) continue;
      const created = await client.query(
        `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, posted_at)
         VALUES ($1, $2, $3, $4, 'fixture', $5) RETURNING id`,
        [businessId, locationId, entry.date, entry.memo, T0],
      );
      const entryId = created.rows[0].id as string;
      for (const line of entry.lines) {
        await client.query(
          "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)",
          [entryId, accountIds.get(line.code), line.debit, line.credit],
        );
      }
    }

    // ---- Inventory ---------------------------------------------------------
    // Three items with stock, so the warehouse table shows counts, a money
    // column and a low-stock badge instead of one empty branch row.
    const ITEMS: Array<{ name: string; sku: string; unit: string; qty: number; cost: number; reorder: number }> = [
      { name: "دانه قهوه عربیکا", sku: "CF-ARB-1", unit: "کیلوگرم", qty: 24, cost: 1_850_000, reorder: 10 },
      { name: "شیر پرچرب", sku: "MK-FULL-1", unit: "لیتر", qty: 6, cost: 420_000, reorder: 20 },
      { name: "شکر سفید", sku: "SG-WHT-1", unit: "کیلوگرم", qty: 40, cost: 310_000, reorder: 15 },
    ];
    for (const item of ITEMS) {
      const existing = await client.query(
        "SELECT id FROM inventory_items WHERE location_id = $1 AND sku = $2",
        [locationId, item.sku],
      );
      const itemId = existing.rowCount
        ? (existing.rows[0].id as string)
        : ((
            await client.query(
              `INSERT INTO inventory_items (location_id, name, sku, unit, reorder_level, avg_cost, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
              [locationId, item.name, item.sku, item.unit, item.reorder, item.cost, T0],
            )
          ).rows[0].id as string);

      // Stock is derived from `stock_movements`, not stored as a level — the
      // warehouse list sums movements per item. (`item_stock` is the *retail*
      // `items` table's companion and is a different subsystem.) So the
      // fixture records an opening purchase, which is also how the real app
      // would have got this stock there.
      const opening = await client.query(
        "SELECT 1 FROM stock_movements WHERE inventory_item_id = $1 AND source_type = 'fixture'",
        [itemId],
      );
      if (!opening.rowCount) {
        await client.query(
          `INSERT INTO stock_movements
             (location_id, inventory_item_id, type, quantity, unit_cost, source_type, note, occurred_at, cost_value_rial)
           VALUES ($1, $2, 'purchase'::stock_movement_type, $3, $4, 'fixture', 'موجودی اولیه', $5, $6)`,
          [locationId, itemId, item.qty, item.cost, T0, Math.round(item.qty * item.cost)],
        );
      }
    }

    // ---- Parties and CRM ---------------------------------------------------
    const PARTIES: Array<{ name: string; phone: string; role: string }> = [
      { name: "سارا محمدی", phone: "09121110001", role: "customer" },
      { name: "رضا کریمی", phone: "09121110002", role: "customer" },
      { name: "پخش مواد غذایی آریا", phone: "02144440003", role: "supplier" },
    ];
    const partyIds = new Map<string, string>();
    for (const party of PARTIES) {
      const existing = await client.query(
        "SELECT id FROM parties WHERE business_id = $1 AND name = $2",
        [businessId, party.name],
      );
      if (existing.rowCount) {
        partyIds.set(party.name, existing.rows[0].id);
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO parties (business_id, location_id, name, phone, role, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
        [businessId, locationId, party.name, party.phone, party.role, T0],
      );
      partyIds.set(party.name, inserted.rows[0].id);
    }

    const DEALS: Array<{ title: string; stage: string; value: number; customer: string }> = [
      { title: "قرارداد پذیرایی هفتگی", stage: "qualified", value: 120_000_000, customer: "سارا محمدی" },
      { title: "سفارش عمده دانه قهوه", stage: "proposal", value: 85_000_000, customer: "رضا کریمی" },
      { title: "تأمین ماهانه شیر", stage: "won", value: 46_000_000, customer: "سارا محمدی" },
    ];
    for (const deal of DEALS) {
      const existing = await client.query(
        "SELECT id FROM crm_deals WHERE business_id = $1 AND title = $2",
        [businessId, deal.title],
      );
      if (existing.rowCount) continue;
      await client.query(
        `INSERT INTO crm_deals (business_id, customer_id, title, stage, value_rial, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [businessId, partyIds.get(deal.customer), deal.title, deal.stage, deal.value, T0],
      );
    }

    // ---- Expenses ----------------------------------------------------------
    // The «هزینه‌ها» register reads the `expenses` table directly, so the
    // journal entries above do not populate it. Three rows: two categories,
    // two payment accounts, one with a vendor and one without, which is what
    // makes the "طرف حساب" column's «—» fallback visible in the baseline.
    const EXPENSES: Array<{
      memo: string;
      date: string;
      amount: number;
      account: string;
      paymentAccount: string;
      vendor: string | null;
    }> = [
      { memo: "اجاره اسفند", date: "2026-03-05", amount: 240_000_000, account: "5020", paymentAccount: "1020", vendor: "املاک مرکزی" },
      { memo: "خرید دانه قهوه", date: "2026-03-12", amount: 18_000_000, account: "5010", paymentAccount: "1010", vendor: "پخش مواد غذایی آریا" },
      { memo: "هزینه حمل", date: "2026-03-14", amount: 3_500_000, account: "5010", paymentAccount: "1010", vendor: null },
    ];
    for (const expense of EXPENSES) {
      const existing = await client.query(
        "SELECT id FROM expenses WHERE business_id = $1 AND memo = $2",
        [businessId, expense.memo],
      );
      if (existing.rowCount) continue;
      await client.query(
        `INSERT INTO expenses (business_id, location_id, account_id, payment_account_id, amount, expense_date, vendor, memo, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          businessId,
          locationId,
          accountIds.get(expense.account),
          accountIds.get(expense.paymentAccount),
          expense.amount,
          expense.date,
          expense.vendor,
          expense.memo,
          T0,
        ],
      );
    }

    // ---- Accounts receivable -----------------------------------------------
    // A/R balances are derived, not stored: `listCustomerBalances` sums journal
    // lines on account 1200 and attributes each to a party through the order,
    // receipt or cheque the entry came from. A cheque is the cheapest of the
    // three to seed, so each customer gets one receivable-raising entry.
    const RECEIVABLES: Array<{ customer: string; amount: number; serial: string; due: string }> = [
      { customer: "سارا محمدی", amount: 32_000_000, serial: "۸۸۱۲۳۴", due: "2026-04-20" },
      { customer: "رضا کریمی", amount: 14_500_000, serial: "۸۸۱۲۳۵", due: "2026-05-02" },
    ];
    for (const receivable of RECEIVABLES) {
      const existing = await client.query(
        "SELECT id FROM cheques WHERE business_id = $1 AND serial_number = $2",
        [businessId, receivable.serial],
      );
      if (existing.rowCount) continue;
      const cheque = await client.query(
        `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, bank_name,
                              amount, issue_date, due_date, counterparty_name, customer_id, created_at, updated_at)
         VALUES ($1, $2, 'receivable', 'on_hand', $3, 'بانک ملت', $4, '2026-03-08', $5, $6, $7, $8, $8)
         RETURNING id`,
        [
          businessId,
          locationId,
          receivable.serial,
          receivable.amount,
          receivable.due,
          receivable.customer,
          partyIds.get(receivable.customer),
          T0,
        ],
      );
      const entry = await client.query(
        `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id, posted_at)
         VALUES ($1, $2, '2026-03-08', $3, 'cheque', $4, $5) RETURNING id`,
        [businessId, locationId, `چک دریافتی ${receivable.customer}`, cheque.rows[0].id, T0],
      );
      // Debit A/R, credit sales — the customer owes this amount.
      for (const line of [
        { code: "1200", debit: receivable.amount, credit: 0 },
        { code: "4010", debit: 0, credit: receivable.amount },
      ]) {
        await client.query(
          "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)",
          [entry.rows[0].id, accountIds.get(line.code), line.debit, line.credit],
        );
      }
    }

    // ---- Cheques -----------------------------------------------------------
    /*
     * The cheque register photographs its *lifecycle*, so the fixture has to
     * contain one of each state the screen renders differently: the two
     * on-hand receivables above, plus a cheque in collection, one endorsed to
     * a supplier (the contingent-liability category), one returned, one
     * returned-and-resolved together with the replacement issued against it,
     * one cleared, and a payable the business issued.
     *
     * Everything sits in the seeded branch. A second location would be
     * visible to any screen that lists branches — the expenses register is
     * one — and a fixture for one screen must not redraw another.
     *
     * Deliberately **no journal entries**: these rows exist to exercise the
     * register's own rendering, and posting them would move accounts 1200 and
     * 1241, which the trial-balance and receivables baselines photograph. A
     * fixture for one screen must not silently redraw another.
     */
    // The supplier *alias* an endorsement points at, linked to the canonical
    // party so the detail view's supplier link resolves the way it does in
    // production.
    const SUPPLIER_NAME = "پخش مواد غذایی آریا";
    const existingSupplier = await client.query(
      "SELECT id FROM suppliers WHERE location_id = $1 AND name = $2",
      [locationId, SUPPLIER_NAME],
    );
    const supplierId: string = existingSupplier.rowCount
      ? existingSupplier.rows[0].id
      : (
          await client.query(
            `INSERT INTO suppliers (location_id, name, phone, party_id, is_active)
             VALUES ($1, $2, '02144440003', $3, true) RETURNING id`,
            [locationId, SUPPLIER_NAME, partyIds.get(SUPPLIER_NAME)],
          )
        ).rows[0].id;

    interface ChequeFixture {
      serial: string;
      direction: "receivable" | "payable";
      status: string;
      amount: number;
      due: string;
      counterparty: string;
      customer?: string;
      supplier?: boolean;
      replaces?: string;
      memo?: string;
      /** `event`/`occurredOn` pairs, in order — the detail timeline. */
      events: Array<[string, string]>;
    }

    const CHEQUES: ChequeFixture[] = [
      {
        serial: "۸۸۱۲۳۶",
        direction: "receivable",
        status: "in_collection",
        amount: 21_000_000,
        due: "2026-04-05",
        counterparty: "سارا محمدی",
        customer: "سارا محمدی",
        events: [["received", "2026-03-08"], ["deposited", "2026-03-16"]],
      },
      {
        serial: "۸۸۱۲۳۷",
        direction: "receivable",
        status: "endorsed",
        amount: 9_800_000,
        due: "2026-04-12",
        counterparty: "رضا کریمی",
        customer: "رضا کریمی",
        supplier: true,
        memo: "بابت تسویه فاکتور ۱۱۸",
        events: [["received", "2026-03-09"], ["endorsed", "2026-03-17"]],
      },
      {
        serial: "۸۸۱۲۳۸",
        direction: "receivable",
        status: "bounced",
        amount: 6_400_000,
        due: "2026-03-14",
        counterparty: "رضا کریمی",
        customer: "رضا کریمی",
        events: [["received", "2026-03-06"], ["deposited", "2026-03-12"], ["bounced", "2026-03-14"]],
      },
      {
        serial: "۸۸۱۲۳۹",
        direction: "receivable",
        status: "resolved",
        amount: 12_000_000,
        due: "2026-03-10",
        counterparty: "سارا محمدی",
        customer: "سارا محمدی",
        events: [
          ["received", "2026-03-02"],
          ["bounced", "2026-03-10"],
          ["restored", "2026-03-11"],
        ],
      },
      {
        serial: "۸۸۱۲۴۰",
        direction: "receivable",
        status: "on_hand",
        amount: 12_000_000,
        due: "2026-05-18",
        counterparty: "سارا محمدی",
        customer: "سارا محمدی",
        replaces: "۸۸۱۲۳۹",
        events: [["received", "2026-03-12"]],
      },
      {
        serial: "۸۸۱۲۴۲",
        direction: "receivable",
        status: "cleared",
        amount: 4_300_000,
        due: "2026-03-05",
        counterparty: "سارا محمدی",
        customer: "سارا محمدی",
        events: [["received", "2026-02-20"], ["deposited", "2026-03-01"], ["cleared", "2026-03-05"]],
      },
      {
        serial: "۹۹۰۰۰۱",
        direction: "payable",
        status: "issued",
        amount: 55_000_000,
        due: "2026-04-28",
        counterparty: SUPPLIER_NAME,
        supplier: true,
        events: [["issued", "2026-03-13"]],
      },
    ];

    const chequeIds = new Map<string, string>();
    for (const fixture of CHEQUES) {
      const existing = await client.query(
        "SELECT id FROM cheques WHERE business_id = $1 AND serial_number = $2",
        [businessId, fixture.serial],
      );
      if (existing.rowCount) {
        chequeIds.set(fixture.serial, existing.rows[0].id);
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, bank_name,
                              amount, issue_date, due_date, counterparty_name, customer_id, supplier_id,
                              memo, replaces_cheque_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'بانک ملت', $6, '2026-03-01', $7, $8, $9, $10, $11, $12, $13, $13)
         RETURNING id`,
        [
          businessId,
          locationId,
          fixture.direction,
          fixture.status,
          fixture.serial,
          fixture.amount,
          fixture.due,
          fixture.counterparty,
          fixture.customer ? partyIds.get(fixture.customer) : null,
          fixture.supplier ? supplierId : null,
          fixture.memo ?? null,
          fixture.replaces ? chequeIds.get(fixture.replaces) : null,
          T0,
        ],
      );
      chequeIds.set(fixture.serial, inserted.rows[0].id);

      for (const [event, occurredOn] of fixture.events) {
        await client.query(
          `INSERT INTO cheque_events (business_id, cheque_id, event, occurred_on,
                                      endorsed_to_supplier_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            businessId,
            inserted.rows[0].id,
            event,
            occurredOn,
            event === "endorsed" ? supplierId : null,
            T0,
          ],
        );
      }
    }

    await client.query("COMMIT");
    console.log(
      "Visual fixture ready: 6 accounts, 4 journal entries, 3 inventory items, 3 parties, 3 deals, " +
        "3 expenses, 2 receivables, 7 cheques across the lifecycle.",
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
