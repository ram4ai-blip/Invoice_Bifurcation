# Invoice_Bifurcation
Automated invoice classification using App Script

# Invoice Bifurcation Script — v3.2
**Company:** Truestate (truestate.in)  
**Platform**:Google Apps Script  
**Last Updated:** May 2026

---

## What It Does

Reads PDF invoices from Gmail, classifies them as **PURCHASE** or **SALES** using AI, files them into Google Drive, and logs key data into a Google Sheet — automatically.

---

## How It Works

```
Gmail (PDF attachments)
        ↓
  Ignore Check         ← GSTR, bank statements, salary slips → Ignored Documents folder
        ↓
  Drive OCR            ← Extracts text from all PDFs in the email
        ↓
  ONE API Call         ← OpenRouter (all PDFs sent together, one call per email)
        ↓
  ┌─────────────┐      ┌──────────────────────────────┐
  │ Google Drive │      │ Google Sheet (one row per PDF) │
  │  PURCHASE /  │      │  Date, Vendor, Amount, GST,   │
  │  SALES /     │      │  Invoice No., Drive Link, etc. │
  │  IGNORED     │      └──────────────────────────────┘
  └─────────────┘
```

---

## Classification Logic

| Type | When |
|------|------|
| **PURCHASE** | Truestate is paying — vendor bills, freelancer invoices, subscriptions, office expenses |
| **SALES** | Truestate has earned — channel partner commissions, property brokerage invoices |
| **IGNORED** | Not an invoice — GSTR returns, bank statements, salary slips, Form 16 |

If AI confidence is below **75%**, an alert email is sent and the row is highlighted **orange** in the Sheet.

If PDF text extraction fails, the script falls back to **keyword-based rules** (no API call).

---

## Google Drive Structure

```
My Drive/
├── Purchase Invoices/
│   └── 2026/
│       └── May/
│           └── [PURCHASE] filename.pdf
├── Sales Invoices/
│   └── 2026/
│       └── May/
│           └── [SALES] filename.pdf
└── Ignored Documents/
    └── 2026/
        └── May/
            └── [IGNORED] filename.pdf
```

---

## Google Sheet Columns

| Col | Field | Description |
|-----|-------|-------------|
| A | Email Date | Date the email was received |
| B | Invoice Date | Date extracted from the PDF |
| C | Sender | Email address of sender |
| D | Email Subject | Subject line of the email |
| E | PDF Filename | Name of the PDF file |
| F | Invoice Type | `PURCHASE` (green) or `SALES` (blue) |
| G | Confidence % | AI confidence score (0–100) |
| H | Classification Source | `OPENROUTER_AI` or `RULES_FALLBACK` |
| I | Invoice Number | Invoice / Bill / Ref number |
| J | Invoice Amount (₹) | Final payable amount (numeric) |
| K | GST Amount (₹) | GST portion (numeric) |
| L | Vendor / Client Name | Who issued the invoice |
| M | Drive Link | Direct link to the filed PDF |
| N | Processed At | Timestamp of processing |

> Low confidence rows (< 75%) are highlighted **orange** across all columns.

---

## Gmail Labels

| Label | Meaning |
|-------|---------|
| `Invoice-Processed` | Successfully classified and filed |
| `Invoice-Ignored` | Non-invoice PDF (GSTR, bank stmt, etc.) |
| `Invoice-LowConfidence` | Classified but needs manual review |
| `Invoice-Error` | Script error — retry manually |

---

## CONFIG Reference

| Key | Default | Description |
|-----|---------|-------------|
| `OPENROUTER_API_KEY` | _(empty)_ | Your OpenRouter API key |
| `OPENROUTER_MODEL` | `google/gemini-3.1-flash-lite` | Model used for classification |
| `ALERT_EMAIL` | `ramprabhu4ai@gmail.com` | Where alerts and summaries are sent |
| `CONFIDENCE_THRESHOLD` | `75` | Below this % → alert + orange row |
| `PDF_BATCH_SIZE` | `3` | PDFs processed per manual run |
| `API_DELAY_MS` | `2000` | Delay between runs (ms) |
| `BATCH_SIZE` | `50` | Gmail threads fetched per run |

---

## Functions

| Function | Purpose |
|----------|---------|
| `setupScript()` | **Run once.** Creates Gmail labels and Google Sheet |
| `processInvoiceEmails()` | **Main function.** Run this to process the next batch |
| `resetBatchProgress()` | Clears saved progress — next run starts from the beginning |
| `testClassifier()` | Tests rule-based classification without touching Gmail or Drive |

---

## First-Time Setup

1. Go to [script.google.com](https://script.google.com) → New Project → paste the script
2. Go to **Services** → Add **Google Drive API (v2)**
3. Get a free API key from [openrouter.ai](https://openrouter.ai)
4. Paste the key into `OPENROUTER_API_KEY` in CONFIG
5. Run `setupScript()` once
6. Run `processInvoiceEmails()` to process your first batch

---

## Batching

Each run processes **3 PDFs** (set by `PDF_BATCH_SIZE`).  
Progress is saved automatically — run again to continue where it left off.  
Run `resetBatchProgress()` to start over from the beginning.

---

## Fallback Behaviour

| Scenario | What happens |
|----------|-------------|
| PDF has no extractable text | Keyword rules used instead of API |
| API key not set | Keyword rules used for all emails |
| OpenRouter returns error | Falls back to `PURCHASE` at 50% confidence |
| Duplicate PDF filename | Skipped — not re-uploaded |
| Confidence < 75% | Filed normally + alert email sent + row highlighted orange |

---

## Ignore Rules

Emails are skipped (not classified) if:
- **PDF filename** contains: `gstr`, `bank_statement`, `salary_slip`, `form_16`, `tds_cert`, etc.
- **Email body** contains: `form gstr-1`, `account statement`, `bank statement`, `salary slip`, `closing balance`, etc.

Ignored PDFs are still uploaded to the **Ignored Documents** folder for audit.
