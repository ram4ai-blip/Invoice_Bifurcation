// ============================================================
//  INVOICE BIFURCATION SCRIPT — Google Apps Script
//  Company : Truestate (truestate.in)
//  Version : 3.2  (One API call per email)
// ============================================================
//
//  CHANGES FROM v3.1:
//  - ONE OpenRouter API call per email (not per PDF)
//  - Multiple PDFs from same email → separate rows in Sheet
//  
//
//  SETUP CHECKLIST (do this before first run):
//  1. Open script.google.com → New Project → paste this file
//  2. Get your FREE OpenRouter API key: openrouter.ai → "Get API key"
//  3. Paste the key in OPENROUTER_API_KEY below
//  4. Run setupScript() ONCE — creates Gmail labels + Google Sheet
//  5. Run processInvoiceEmails() manually each time (3 PDFs per run)
//     Run it again when you want the next batch of 3
//
//  BATCHING LOGIC:
//  - Each manual run processes exactly PDF_BATCH_SIZE (3) PDFs
//  - Progress is saved in Script Properties (acts as a bookmark)
//  - Run again to process the next 3, and so on
//  - Run resetBatchProgress() to start fresh from the beginning
//
// ============================================================


// ╔══════════════════════════════════════════════════════════╗
// ║                  C O N F I G                            ║
// ╚══════════════════════════════════════════════════════════╝

const CONFIG = {

  // ── OpenRouter API ────────────────────────────────────────
  OPENROUTER_API_KEY : '',   // ← PASTE YOUR KEY HERE
  OPENROUTER_MODEL   : 'google/gemini-3.1-flash-lite',

  // ── Alerting ──────────────────────────────────────────────
  ALERT_EMAIL          : '', // Enter your email to get alerts
  CONFIDENCE_THRESHOLD : 75,

  // ── Google Drive folder names ─────────────────────────────
  PURCHASE_ROOT : 'Purchase Invoices',
  SALES_ROOT    : 'Sales Invoices',
  IGNORED_ROOT  : 'Ignored Documents',

  // ── Google Sheet ──────────────────────────────────────────
  SHEET_NAME : 'Truestate Invoice Register',

  // ── Gmail labels ──────────────────────────────────────────
  LABEL_PROCESSED : 'Invoice-Processed',
  LABEL_LOW_CONF  : 'Invoice-LowConfidence',
  LABEL_IGNORED   : 'Invoice-Ignored',
  LABEL_ERROR     : 'Invoice-Error',

  // ── Company domain ────────────────────────────────────────
  COMPANY_DOMAIN : 'truestate.in',

  // ── Batching ──────────────────────────────────────────────
  PDF_BATCH_SIZE : 15,
  API_DELAY_MS   : 2000,
  BATCH_SIZE     : 50,
};


// ╔══════════════════════════════════════════════════════════╗
// ║   L A Y E R  0 — I G N O R E   B L O C K L I S T      ║
// ╚══════════════════════════════════════════════════════════╝

const IGNORE_FILENAME_PATTERNS = [
  'gstr1', 'gstr-1', 'gstr2', 'gstr-2', 'gstr3b', 'gstr-3b',
  'gstr9', 'gstr-3', 'gstr_',
  'bank_statement', 'bank-statement', 'account_statement',
  'salary_slip', 'payslip', 'pay_slip',
  'form_16', 'form16',
  'tds_certificate', 'tds_cert',
];

const IGNORE_BODY_SIGNALS = {
  HARD: [
    'form gstr-1', 'form gstr1', '[see rule 59(1)]',
    'details of outward supplies of goods or services',
    'details of inward supplies', 'arn date', 'b2b - regular',
    'b2b reverse charge', 'b2cl (large)', '6a - exports',
    'sezwp/sezwop', 'account statement', 'closing balance',
    'opening balance', 'bank statement', 'salary slip',
    'pay slip', 'payroll summary', 'form 16',
  ],
};


// ╔══════════════════════════════════════════════════════════╗
// ║          K E Y W O R D   S I G N A L S                 ║
// ║  (Fallback when PDF text extraction fails)              ║
// ║  HIGH = 3 pts | MEDIUM = 2 pts | LOW = 1 pt            ║
// ╚══════════════════════════════════════════════════════════╝

const PURCHASE_SIGNALS = {
  HIGH: [
    'please find the attached invoice', 'please find the payment invoice attached',
    'pfa the invoice', 'pfa invoice', 'vendor invoice for payment', 'vendor invoice',
    'tds to be deducted', 'tds deduction', 'gst is to be paid on reverse charge',
    'reverse charge basis', 'invoice for payment', 'paid invoices for google are attached',
    'paid invoices', 'invoice and receipt for claude', 'google cloud bill',
    'ac service @ truestate', 'ac repair and service', 'camps executed',
    'camps payment invoice', 'nobroker camps', 'for the period',
    'attached below for your reference', 'payment for the period', 'bill of',
    'invoice for the camps', 'invoice for video editing services',
    'payment invoice - video editing', 'invoice for video editing',
    'services provided by our freelancer', 'invoice provided by our freelancer',
    'freelancer invoice', 'please find the payment invoice',
    'find attached the invoice for', 'also find the account details below',
    'bank transfer', 'account holder:', 'sbin', 'ifsc:', 'ifsc code',
    'account number:', 'short-form content', 'content creation invoice',
    'design invoice', 'marketing invoice',
  ],
  MEDIUM: [
    'invoice', 'bill', 'receipt', 'tds', 'subscription', 'service charge',
    'service invoice', 'due date', 'amount due', 'amount payable', 'please pay',
    'please find attached', 'find attached', 'pfa', 'attached herewith', 'supplier',
    'payment due', 'google cloud', 'google workspace', 'claude ai', 'anthropic',
    'truestate office', 'office maintenance', 'umang jhanwar', 'vault',
    'total amount: rs', 'total amount: inr', 'rs.', 'inr',
  ],
  LOW: [
    'attached', 'charges', 'fee', 'amount', 'tax', 'deduction', 'office',
    'service', 'repair', 'maintenance', 'payment', 'camp', 'freelancer',
    'video editing', 'content',
  ],
};

const SALES_SIGNALS = {
  HIGH: [
    'closure update for invoicing', 'proceed further to raise the invoice',
    'can i proceed further to raise the invoice', 'raise the invoice',
    'invoice raised for', 'cp commission', 'cp comission',
    'channel partner commission', 'brokerage commission', 'incremental invoice',
    'consolidated invoice', 'agreement is executed', 'agreement value',
    'property value', 'unit no', 'unit number', 'billing to', 'cgst+sgst',
    'cgst + sgst', 'incremental %', 'cp comission @', 'cp commission @', 'closures',
    'invoice to', 'invoiced to', 'we have raised an invoice', 'invoice sent to client',
    'invoice sent to customer', 'payment received from', 'payment confirmed from',
    'thank you for your payment', 'sale invoice', 'sales invoice',
    'billed to client', 'dear client, please find', 'dear customer, please find',
  ],
  MEDIUM: [
    'payment received', 'booking confirmed', 'amount credited',
    'invoice for your records', 'your invoice is attached', 'property sale',
    'brokerage invoice', 'commission invoice', 'prestige marigold', 'greenshore',
    'ace realty ventures', 'project name', 'client name', 'account name',
  ],
  LOW: [
    'client', 'customer', 'buyer', 'sale', 'sold', 'brokerage', 'commission',
    'booking', 'token amount', 'site visit', 'flat no', 'unit', 'developer', 'builder',
  ],
};

const VENDOR_SENDER_DOMAINS = [
  'billing@', 'invoices@', 'payments@', 'accounts@', 'noreply@', 'no-reply@',
  'cloud-billing@google', 'billing.anthropic.com', 'canvas-homes.com', 'nobroker', 'gmail.com',
];

const SALES_PARTNER_DOMAINS = [
  'acnonline.in',
];


// ╔══════════════════════════════════════════════════════════╗
// ║              M A I N   E N T R Y   P O I N T           ║
// ╚══════════════════════════════════════════════════════════╝

function processInvoiceEmails() {
  Logger.log('══════════════════════════════════════════');
  Logger.log('   INVOICE BIFURCATION v3.2 — Run started');
  Logger.log(`   Time: ${new Date()}`);
  Logger.log(`   PDF batch size: ${CONFIG.PDF_BATCH_SIZE}`);
  Logger.log('══════════════════════════════════════════');

  validateConfig();
  ensureLabelsExist();
  const sheet = getOrCreateSheet();

  const props           = PropertiesService.getScriptProperties();
  const processedIds    = JSON.parse(props.getProperty('PROCESSED_MSG_IDS') || '[]');
  const processedIdsSet = new Set(processedIds);

  Logger.log(`  Resuming: ${processedIdsSet.size} message(s) already done in prior runs`);

  const query   = `has:attachment filename:pdf -label:"${CONFIG.LABEL_PROCESSED}" -label:"${CONFIG.LABEL_IGNORED}" -label:"${CONFIG.LABEL_ERROR}"`;
  const threads = GmailApp.search(query, 0, CONFIG.BATCH_SIZE);

  Logger.log(`  Found ${threads.length} unprocessed Gmail thread(s) to scan`);

  const stats = { processed: 0, purchase: 0, sales: 0, ignored: 0, lowConf: 0, skipped: 0, errors: 0 };

  const threadLabelMap = new Map();

  let pdfCount = 0;
  let done     = false;

  outerLoop:
  for (const thread of threads) {
    const threadId = thread.getId();
    if (!threadLabelMap.has(threadId)) {
      threadLabelMap.set(threadId, { thread, hadPdf: false, ignored: false, hadError: false });
    }
    const threadState = threadLabelMap.get(threadId);

    for (const message of thread.getMessages()) {
      const msgId = message.getId();

      if (processedIdsSet.has(msgId)) {
        Logger.log(`  ⏩ Already processed: "${message.getSubject()}" — skipping`);
        threadState.hadPdf = true;
        continue;
      }

      try {
        const { results, pdfsUsed } = processOneMessageBatched(
          message, sheet, CONFIG.PDF_BATCH_SIZE - pdfCount
        );

        pdfCount += pdfsUsed;

        if (results === 'NO_PDF') {
          stats.skipped++;
          processedIdsSet.add(msgId);
          continue;
        }

        if (results === 'IGNORED') {
          stats.ignored++;
          threadState.ignored = true;
          threadState.hadPdf  = true;
          processedIdsSet.add(msgId);
          continue;
        }

        if (results === 'PARTIAL') {
          Logger.log(`  ⏸ Batch limit (${CONFIG.PDF_BATCH_SIZE}) reached mid-message — saving progress`);
          done = true;
          break outerLoop;
        }

        threadState.hadPdf = true;
        processedIdsSet.add(msgId);

        for (const result of results) {
          stats.processed++;
          if (result.type === 'PURCHASE') stats.purchase++;
          else stats.sales++;
          if (result.lowConf) stats.lowConf++;
        }

        if (pdfCount >= CONFIG.PDF_BATCH_SIZE) {
          Logger.log(`  ✅ Batch limit (${CONFIG.PDF_BATCH_SIZE}) reached — saving progress`);
          done = true;
          break outerLoop;
        }

      } catch (err) {
        Logger.log(`  ✗ ERROR on "${message.getSubject()}": ${err.message}`);
        threadState.hadError = true;
        stats.errors++;
      }
    }
  }

  // Apply Gmail labels
  for (const [, state] of threadLabelMap) {
    if (!state.hadPdf) continue;
    if (state.hadError)      applyLabel(state.thread, CONFIG.LABEL_ERROR);
    else if (state.ignored)  applyLabel(state.thread, CONFIG.LABEL_IGNORED);
    else                     applyLabel(state.thread, CONFIG.LABEL_PROCESSED);
  }

  // Save progress
  const updatedIds = [...processedIdsSet].slice(-500);
  props.setProperty('PROCESSED_MSG_IDS', JSON.stringify(updatedIds));

  Logger.log('──────────────────────────────────────────');
  Logger.log(`📄 PDFs this run  : ${pdfCount} / ${CONFIG.PDF_BATCH_SIZE}`);
  Logger.log(`✅ Processed      : ${stats.processed}`);
  Logger.log(`📥 Purchase       : ${stats.purchase}`);
  Logger.log(`📤 Sales          : ${stats.sales}`);
  Logger.log(`🚫 Ignored        : ${stats.ignored}`);
  Logger.log(`⚠️  Low conf.      : ${stats.lowConf}`);
  Logger.log(`⏭️  Skipped        : ${stats.skipped}`);
  Logger.log(`❌ Errors         : ${stats.errors}`);

  if (done) {
    Logger.log('▶ More PDFs remaining — run processInvoiceEmails() again for next batch');
  } else {
    Logger.log('🎉 All pending PDFs processed — nothing left in queue');
  }
  Logger.log('══════════════════════════════════════════');

  if (stats.processed + stats.ignored > 0) sendSummaryEmail(stats, done);
}

function resetBatchProgress() {
  PropertiesService.getScriptProperties().deleteProperty('PROCESSED_MSG_IDS');
  Logger.log('✅ Batch progress reset — next run will start from the beginning');
}


// ╔══════════════════════════════════════════════════════════╗
// ║         P R O C E S S   O N E   M E S S A G E          ║
// ║                                                          ║
// ║  v3.2: Extracts ALL PDF texts first, then makes         ║
// ║  exactly ONE API call for the entire email.             ║
// ║  Each PDF still gets its own row in the Sheet.          ║
// ╚══════════════════════════════════════════════════════════╝

function processOneMessageBatched(message, sheet, pdfBudget) {
  const subject        = message.getSubject()   || '';
  const body           = message.getPlainBody() || '';
  const sender         = message.getFrom()      || '';
  const emailDate      = message.getDate();
  const allAttachments = message.getAttachments();

  const pdfs = allAttachments.filter(a =>
    a.getContentType() === 'application/pdf' ||
    a.getName().toLowerCase().endsWith('.pdf')
  );

  if (pdfs.length === 0) return { results: 'NO_PDF', pdfsUsed: 0 };

  Logger.log(`\n► "${subject}"`);
  Logger.log(`  From: ${sender} | PDFs: ${pdfs.length} | Budget: ${pdfBudget}`);

  // ── LAYER 0: IGNORE check ─────────────────────────────────
  const ignoreReason = shouldIgnore(subject, body, pdfs);
  if (ignoreReason) {
    Logger.log(`  🚫 IGNORED: ${ignoreReason}`);
    for (const pdf of pdfs) uploadToDrive(pdf, 'IGNORED', emailDate, subject);
    return { results: 'IGNORED', pdfsUsed: 0 };
  }

  const originalSender  = extractForwardedSender(body);
  if (originalSender) Logger.log(`  Forwarded from: ${originalSender}`);
  const effectiveSender = originalSender || sender;

  // Honour PDF budget
  const pdfsToProcess = pdfs.slice(0, pdfBudget);
  if (pdfsToProcess.length < pdfs.length) {
    Logger.log(`  ⏸ Budget: processing ${pdfsToProcess.length} of ${pdfs.length} PDFs this run`);
  }

  // ── STEP 1: Extract text from ALL PDFs first ──────────────
  Logger.log(`  📄 Extracting text from ${pdfsToProcess.length} PDF(s)...`);
  const pdfTexts = pdfsToProcess.map((pdf, i) => {
    Logger.log(`  📄 PDF ${i + 1}/${pdfsToProcess.length}: ${pdf.getName()}`);
    const text = extractTextFromPdf(pdf);
    Logger.log(`  Extracted: ${text.length} chars`);
    return text;
  });

  // ── STEP 2: ONE API call for ALL PDFs in this email ───────
  let classificationResults;
  const anyTextFound = pdfTexts.some(t => t.length > 100);

  if (anyTextFound) {
    Logger.log(`  → ONE OpenRouter API call for all ${pdfsToProcess.length} PDF(s)`);
    classificationResults = classifyAllPdfsWithOpenRouter(subject, body, sender, pdfTexts);
  } else {
    Logger.log('  → Rules fallback (no PDF text extracted for any PDF)');
    const ruleResult = computeRuleScore(subject, body, sender, effectiveSender);
    ruleResult.source      = 'RULES_FALLBACK';
    ruleResult.invoiceDate = null;
    classificationResults  = pdfsToProcess.map(() => ({ ...ruleResult }));
  }

  // ── STEP 3: One row per PDF, all from the single API call ─
  const results = [];

  for (let i = 0; i < pdfsToProcess.length; i++) {
    const pdf = pdfsToProcess[i];
    const cr  = classificationResults[i] || classificationResults[0];

    Logger.log(`  [PDF ${i + 1}] → ${cr.type} (${cr.confidence}%) [${cr.source || 'OPENROUTER_AI'}]`);
    Logger.log(`  Amount: ${cr.invoiceAmount || '—'} | GST: ${cr.gstAmount || '—'} | Vendor: ${cr.vendorClient || '—'}`);

    const invoiceDate = cr.invoiceDate
      || extractInvoiceDate(subject, body, pdfTexts[i])
      || emailDate;
    Logger.log(`  Date → ${Utilities.formatDate(invoiceDate, Session.getScriptTimeZone(), 'dd MMM yyyy')}`);

    const driveLink = uploadToDrive(pdf, cr.type, invoiceDate, subject);

    writeToSheet(sheet, {
      emailDate,
      invoiceDate,
      sender,
      subject,
      pdfName      : pdf.getName(),
      type         : cr.type,
      confidence   : cr.confidence,
      source       : cr.source || 'OPENROUTER_AI',
      invoiceNumber: cr.invoiceNumber || '',
      invoiceAmount: cr.invoiceAmount || '',
      gstAmount    : cr.gstAmount     || '',
      vendorClient : cr.vendorClient  || '',
      driveLink    : driveLink        || '',
    });

    const isLowConf = cr.confidence < CONFIG.CONFIDENCE_THRESHOLD;
    if (isLowConf) {
      sendLowConfidenceAlert({
        subject, sender, body,
        type      : cr.type,
        confidence: cr.confidence,
        driveLinks: driveLink ? [driveLink] : [],
        invoiceDate,
      });
    }

    results.push({ type: cr.type, lowConf: isLowConf });
  }

  if (pdfsToProcess.length < pdfs.length) {
    return { results: 'PARTIAL', pdfsUsed: pdfsToProcess.length };
  }

  return { results, pdfsUsed: pdfsToProcess.length };
}


// ╔══════════════════════════════════════════════════════════╗
// ║       P D F   T E X T   E X T R A C T I O N           ║
// ╚══════════════════════════════════════════════════════════╝

function extractTextFromPdf(pdfAttachment) {
  let tempFileId = null;
  let tempDocId  = null;

  try {
    const blob     = pdfAttachment.copyBlob();
    const tempFile = DriveApp.createFile(blob);
    tempFileId     = tempFile.getId();

    try {
      const resource  = { title: 'TMP_OCR_' + tempFileId, mimeType: MimeType.GOOGLE_DOCS };
      const converted = Drive.Files.copy(resource, tempFileId, { convert: true });
      tempDocId       = converted.id;
    } catch (driveApiErr) {
      Logger.log(`  Drive API service not enabled, using REST fallback: ${driveApiErr.message}`);
      const token    = ScriptApp.getOAuthToken();
      const copyUrl  = `https://www.googleapis.com/drive/v2/files/${tempFileId}/copy?convert=true`;
      const copyResp = UrlFetchApp.fetch(copyUrl, {
        method            : 'POST',
        headers           : { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        payload           : JSON.stringify({ title: 'TMP_OCR_' + tempFileId, mimeType: MimeType.GOOGLE_DOCS }),
        muteHttpExceptions: true,
      });
      if (copyResp.getResponseCode() !== 200) {
        Logger.log(`  REST copy failed (${copyResp.getResponseCode()}): ${copyResp.getContentText().substring(0, 200)}`);
        return '';
      }
      tempDocId = JSON.parse(copyResp.getContentText()).id;
    }

    const doc  = DocumentApp.openById(tempDocId);
    const text = doc.getBody().getText() || '';
    Logger.log(`  PDF→Doc conversion OK: ${text.length} chars`);

    if (text.length > 0) {
      Logger.log('  === PDF TEXT SAMPLE (first 600 chars) ===');
      Logger.log(text.substring(0, 600));
      Logger.log('  =========================================');
    }

    return text;

  } catch (err) {
    Logger.log(`  ⚠ PDF text extraction error: ${err.message}`);
    return '';

  } finally {
    try { if (tempFileId) DriveApp.getFileById(tempFileId).setTrashed(true); } catch(e) {}
    try { if (tempDocId)  DriveApp.getFileById(tempDocId).setTrashed(true);  } catch(e) {}
  }
}


// ╔══════════════════════════════════════════════════════════╗
// ║   O P E N R O U T E R   C L A S S I F I E R           ║
// ║                                                          ║
// ║  v3.2: ONE call per email. Accepts an array of PDF      ║
// ║  texts. Returns an array of results (one per PDF).      ║
// ╚══════════════════════════════════════════════════════════╝

function classifyAllPdfsWithOpenRouter(subject, body, sender, pdfTexts) {
  const makeFallback = () => ({
    type         : 'PURCHASE',
    confidence   : 50,
    source       : 'OPENROUTER_FALLBACK',
    invoiceNumber: '',
    invoiceAmount: '',
    gstAmount    : '',
    vendorClient : '',
    invoiceDate  : null,
  });

  if (!CONFIG.OPENROUTER_API_KEY || CONFIG.OPENROUTER_API_KEY === 'YOUR_OPENROUTER_API_KEY_HERE') {
    Logger.log('  ⚠ OpenRouter key not set — using rules fallback');
    return pdfTexts.map(() => makeFallback());
  }

  try {
    // Build one clearly labelled section per PDF
    const pdfSections = pdfTexts.map((text, i) =>
      `--- PDF ${i + 1} of ${pdfTexts.length} ---\n${
        text.length > 100
          ? text.substring(0, 2000)
          : '[No text extracted — classify using email context only]'
      }`
    ).join('\n\n');

    const prompt = `You are an invoice classifier and data extractor for Truestate, an Indian real estate company (domain: truestate.in).

═══════════════════════════════════════════════════
CLASSIFICATION RULES
═══════════════════════════════════════════════════

PURCHASE = Truestate is PAYING someone (money going OUT):
  - Vendor/supplier bills: Google Cloud, Claude AI, NoBroker, Anthropic, etc.
  - Freelancer invoices: video editing, content creation, design, marketing
    → PDF contains bank account details, IFSC code, account holder name
  - Office maintenance, service, repair invoices
  - Subscription renewals
  - Truestate appears as "Bill To" / "Client" on the invoice

SALES = Truestate has EARNED money (money coming IN):
  - Channel partner commission invoices for property sales
  - Contains: CP Commission %, Agreement Value, Property Value, Unit Number
  - Truestate is the service provider / biller

═══════════════════════════════════════════════════
EMAIL CONTEXT (shared across all PDFs below)
═══════════════════════════════════════════════════
Subject : ${subject}
Sender  : ${sender}
Body    : ${body.substring(0, 300)}

═══════════════════════════════════════════════════
PDF DOCUMENTS — ${pdfTexts.length} PDF(s) — classify each independently
═══════════════════════════════════════════════════
${pdfSections}

═══════════════════════════════════════════════════
EXTRACTION INSTRUCTIONS — apply to EACH PDF
═══════════════════════════════════════════════════

1. vendor_client_name — WHO ISSUED this invoice:
   - Look at the TOP of the PDF: letterhead, company name, "From:", "Issued by:",
     "Service Provider:", "Account Holder:", "Vendor:", "Freelancer:"
   - For freelancer invoices: name is usually in bank details
     e.g. "Account Holder: Manav Nayak" → extract "Manav Nayak"
   - NEVER return "Truestate" — Truestate is always the recipient

2. invoice_date — Date this invoice was issued:
   - Look for: "Invoice Date:", "Date:", "Bill Date:", "Issued On:"
   - Indian formats: "27 April 2026", "27/04/2026", "05-05-2026", "Apr 2026"
   - Return as DD/MM/YYYY e.g. "27/04/2026"
   - If only month/year: "01/MM/YYYY"
   - If not found: ""

3. invoice_amount — FINAL payable amount (after all taxes):
   - Look for: "Total", "Grand Total", "Total Amount", "Net Amount",
     "Amount Payable", "Net Payable", "Invoice Total", "Amount Due",
     "Total Due", "Balance Due", "Total Payable"
   - Indian formats: "Rs. 3,24,000" or "INR 1,76,13,399.50" or "Rs 5,600"
   - Return NUMERIC ONLY — no currency symbol, no commas
     e.g. "324000" or "17613399.50" or "5600"
   - Use the BOTTOM-RIGHT value in a table — that is the grand total
   - Do NOT return subtotal or pre-tax amount

4. gst_amount — GST portion only:
   - Look for: "GST", "CGST + SGST", "IGST", "Tax Amount"
   - Return numeric only or ""

5. invoice_number:
   - Look for: "Invoice No.", "Invoice #", "Bill No.", "Ref No."
   - Return as-is e.g. "INV-2026-042"

═══════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════
Return ONLY a valid JSON array — one object per PDF, in the same order as above.
No markdown. No explanation. No code fences. Nothing outside the array.

[
  {
    "pdf_index": 0,
    "type": "PURCHASE",
    "confidence": 90,
    "reason": "one line max 12 words",
    "invoice_number": "INV-2026-042 or empty",
    "invoice_date": "DD/MM/YYYY or empty",
    "invoice_amount": "numeric only or empty",
    "gst_amount": "numeric only or empty",
    "vendor_client_name": "name of issuer or empty"
  }
]`;

    const payload = {
      model      : CONFIG.OPENROUTER_MODEL,
      messages   : [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens : 400 * pdfTexts.length,  // scale with number of PDFs
    };

    const response = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', {
      method            : 'post',
      headers           : {
        'Authorization' : 'Bearer ' + CONFIG.OPENROUTER_API_KEY,
        'Content-Type'  : 'application/json',
        'HTTP-Referer'  : 'https://script.google.com',
        'X-Title'       : 'Truestate Invoice Bifurcation',
      },
      payload           : JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    const httpCode = response.getResponseCode();
    if (httpCode !== 200) {
      Logger.log(`  OpenRouter HTTP ${httpCode}: ${response.getContentText().substring(0, 300)}`);
      return pdfTexts.map(() => makeFallback());
    }

    const data  = JSON.parse(response.getContentText());
    const raw   = data?.choices?.[0]?.message?.content || '';
    Logger.log(`  OpenRouter raw response: ${raw.substring(0, 400)}`);

    const cleaned = raw.replace(/```json|```/g, '').trim();
    const match   = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array found in OpenRouter response: ' + raw);

    const parsedArray = JSON.parse(match[0]);

    // Map each parsed result, applying fallback helpers for missing fields
    return parsedArray.map((parsed, i) => {
      // Amount cleanup
      let invoiceAmount = cleanAmount(parsed.invoice_amount);
      let gstAmount     = cleanAmount(parsed.gst_amount);

      // Regex fallback if AI left amounts blank
      if (!invoiceAmount) {
        invoiceAmount = extractAmountByRegex(pdfTexts[i] || '', 'total');
        if (invoiceAmount) Logger.log(`  ℹ [PDF ${i+1}] Amount via regex fallback: ${invoiceAmount}`);
      }
      if (!gstAmount) {
        gstAmount = extractAmountByRegex(pdfTexts[i] || '', 'gst');
        if (gstAmount) Logger.log(`  ℹ [PDF ${i+1}] GST via regex fallback: ${gstAmount}`);
      }

      // Date parsing: AI returns DD/MM/YYYY → convert to Date object
      let aiInvoiceDate = null;
      const aiDateStr   = (parsed.invoice_date || '').trim();
      if (aiDateStr.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) {
        const parts = aiDateStr.split('/');
        aiInvoiceDate = new Date(+parts[2], +parts[1] - 1, +parts[0]);
        if (aiInvoiceDate.getFullYear() < 2020 || aiInvoiceDate.getFullYear() > 2035) {
          aiInvoiceDate = null;
        }
      }

      // Vendor name regex fallback if AI left it blank
      let vendorClient = (parsed.vendor_client_name || '').toString().trim();
      if (!vendorClient) {
        vendorClient = extractVendorByRegex(pdfTexts[i] || '');
        if (vendorClient) Logger.log(`  ℹ [PDF ${i+1}] Vendor via regex fallback: ${vendorClient}`);
      }

      return {
        type         : parsed.type === 'SALES' ? 'SALES' : 'PURCHASE',
        confidence   : Math.min(100, Math.max(0, parseInt(parsed.confidence) || 50)),
        source       : 'OPENROUTER_AI',
        invoiceNumber: (parsed.invoice_number || '').toString().trim(),
        invoiceDate  : aiInvoiceDate,
        invoiceAmount: invoiceAmount,
        gstAmount    : gstAmount,
        vendorClient : vendorClient,
        reason       : (parsed.reason || '').toString().trim(),
      };
    });

  } catch (err) {
    Logger.log(`  OpenRouter error: ${err.message}`);
    return pdfTexts.map(() => makeFallback());
  }
}


// ╔══════════════════════════════════════════════════════════╗
// ║      A M O U N T   H E L P E R S                       ║
// ╚══════════════════════════════════════════════════════════╝

function cleanAmount(raw) {
  if (!raw) return '';
  const cleaned = raw.toString()
    .replace(/₹|Rs\.?|INR/gi, '')
    .replace(/,/g, '')
    .trim();
  return isNaN(parseFloat(cleaned)) ? '' : cleaned;
}

function extractAmountByRegex(text, mode) {
  if (!text) return '';

  let patterns;

  if (mode === 'gst') {
    patterns = [
      /cgst\s*\+?\s*sgst[^:\d]*[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
      /igst[^:\d]*[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
      /gst[^:\d]*[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
      /tax[^:\d]*[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
    ];
  } else {
    patterns = [
      /grand\s*total[^:\d]*[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
      /total\s*amount[^:\d]*[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
      /net\s*(?:amount|payable|total)[^:\d]*[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
      /amount\s*(?:payable|due)[^:\d]*[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
      /balance\s*due[^:\d]*[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
      /total\s*due[^:\d]*[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
      /total[^:\d\n]{0,20}[:\s][\s]*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)/i,
      /(?:Rs\.?\s*|INR\s*|₹\s*)([\d,]+(?:\.\d{1,2})?)/i,
    ];
  }

  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const cleaned = m[1].replace(/,/g, '');
      if (!isNaN(parseFloat(cleaned)) && parseFloat(cleaned) > 0) return cleaned;
    }
  }

  return '';
}

function extractVendorByRegex(text) {
  if (!text) return '';

  const patterns = [
    /account\s*holder\s*[:\-]\s*([A-Z][A-Za-z\s\.]{2,40})/i,
    /^from\s*[:\-]\s*([A-Z][A-Za-z\s\.&,]{2,50})/im,
    /issued\s*by\s*[:\-]\s*([A-Z][A-Za-z\s\.&,]{2,50})/i,
    /service\s*provider\s*[:\-]\s*([A-Z][A-Za-z\s\.&,]{2,50})/i,
    /vendor\s*[:\-]\s*([A-Z][A-Za-z\s\.&,]{2,50})/i,
    /freelancer\s*(?:name)?\s*[:\-]\s*([A-Z][A-Za-z\s\.]{2,40})/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const name = m[1].trim();
      if (!name.toLowerCase().includes('truestate')) return name;
    }
  }

  return '';
}

function computeRuleScore(subject, body, sender, effectiveSender) {
  const text        = (subject + ' ' + body + ' ' + sender).toLowerCase();
  const senderLower = (effectiveSender || sender).toLowerCase();

  let pScore = 0, sScore = 0;

  for (const phrase of PURCHASE_SIGNALS.HIGH)   { if (text.includes(phrase)) pScore += 3; }
  for (const phrase of PURCHASE_SIGNALS.MEDIUM) { if (text.includes(phrase)) pScore += 2; }
  for (const phrase of PURCHASE_SIGNALS.LOW)    { if (text.includes(phrase)) pScore += 1; }

  for (const phrase of SALES_SIGNALS.HIGH)   { if (text.includes(phrase)) sScore += 3; }
  for (const phrase of SALES_SIGNALS.MEDIUM) { if (text.includes(phrase)) sScore += 2; }
  for (const phrase of SALES_SIGNALS.LOW)    { if (text.includes(phrase)) sScore += 1; }

  for (const domain of VENDOR_SENDER_DOMAINS) { if (senderLower.includes(domain)) { pScore += 5; break; } }
  for (const domain of SALES_PARTNER_DOMAINS) { if (senderLower.includes(domain)) { sScore += 5; break; } }

  const total = pScore + sScore;
  if (total === 0) {
    return {
      type: 'PURCHASE', confidence: 40, pScore: 0, sScore: 0,
      invoiceNumber: '', invoiceAmount: '', gstAmount: '', vendorClient: '',
    };
  }

  const type       = pScore >= sScore ? 'PURCHASE' : 'SALES';
  const dominant   = Math.max(pScore, sScore);
  const confidence = Math.min(95, Math.round((dominant / total) * 100));

  return {
    type, confidence, pScore, sScore,
    invoiceNumber: '', invoiceAmount: '', gstAmount: '', vendorClient: '',
  };
}


// ╔══════════════════════════════════════════════════════════╗
// ║   L A Y E R  0 — I G N O R E   C H E C K              ║
// ╚══════════════════════════════════════════════════════════╝

function shouldIgnore(subject, body, pdfAttachments) {
  const combined = (subject + ' ' + body).toLowerCase();

  for (const attachment of pdfAttachments) {
    const fname = attachment.getName().toLowerCase();
    for (const pattern of IGNORE_FILENAME_PATTERNS) {
      if (fname.includes(pattern)) return `Filename match: "${pattern}" in "${attachment.getName()}"`;
    }
  }

  for (const phrase of IGNORE_BODY_SIGNALS.HARD) {
    if (combined.includes(phrase)) return `Body signal: "${phrase}"`;
  }

  return null;
}


// ╔══════════════════════════════════════════════════════════╗
// ║   F O R W A R D E D   S E N D E R   E X T R A C T O R ║
// ╚══════════════════════════════════════════════════════════╝

function extractForwardedSender(body) {
  const forwardMatch = body.match(
    /[-]{5,}\s*forwarded message\s*[-]{5,}[\s\S]{0,200}?from:\s*.*?<([^>]+)>/i
  );
  if (forwardMatch) return forwardMatch[1].trim().toLowerCase();

  const simpleMatch = body.match(/^from:\s*.*?<([^>]+)>/im);
  if (simpleMatch) return simpleMatch[1].trim().toLowerCase();

  return null;
}


// ╔══════════════════════════════════════════════════════════╗
// ║         D A T E   E X T R A C T I O N                  ║
// ╚══════════════════════════════════════════════════════════╝

function extractInvoiceDate(subject, body, pdfText) {
  const text = (pdfText || '') + ' ' + subject + ' ' + body;

  const MONTHS = {
    january:0, february:1, march:2, april:3, may:4, june:5,
    july:6, august:7, september:8, october:9, november:10, december:11,
    jan:0, feb:1, mar:2, apr:3, jun:5, jul:6,
    aug:7, sep:8, oct:9, nov:10, dec:11,
  };

  const patterns = [
    {
      re   : /(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december),?\s+(\d{4})/i,
      parse: m => new Date(+m[3], MONTHS[m[2].toLowerCase()], +m[1]),
    },
    {
      re   : /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i,
      parse: m => new Date(+m[2], MONTHS[m[1].toLowerCase()], 1),
    },
    {
      re   : /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[-–]\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})/i,
      parse: m => new Date(+m[2], MONTHS[m[1].toLowerCase().substring(0,3)], 1),
    },
    {
      re   : /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
      parse: m => new Date(+m[3], +m[2]-1, +m[1]),
    },
    {
      re   : /(\d{1,2})[\/\-](\d{4})/,
      parse: m => new Date(+m[2], +m[1]-1, 1),
    },
  ];

  for (const { re, parse } of patterns) {
    const match = text.match(re);
    if (match) {
      try {
        const d = parse(match);
        if (d.getFullYear() >= 2020 && d.getFullYear() <= 2035) return d;
      } catch (e) { /* try next */ }
    }
  }

  return null;
}


// ╔══════════════════════════════════════════════════════════╗
// ║     G O O G L E   D R I V E   U P L O A D              ║
// ╚══════════════════════════════════════════════════════════╝

function uploadToDrive(attachment, type, invoiceDate, subject) {
  let rootName, prefix;

  if (type === 'IGNORED')       { rootName = CONFIG.IGNORED_ROOT;  prefix = '[IGNORED]';  }
  else if (type === 'PURCHASE') { rootName = CONFIG.PURCHASE_ROOT; prefix = '[PURCHASE]'; }
  else                          { rootName = CONFIG.SALES_ROOT;    prefix = '[SALES]';    }

  const year      = invoiceDate.getFullYear().toString();
  const monthName = Utilities.formatDate(invoiceDate, Session.getScriptTimeZone(), 'MMMM');
  const folder    = getOrCreateFolderPath([rootName, year, monthName]);

  const origName  = attachment.getName().replace(/\.pdf$/i, '');
  const newName   = `${prefix} ${origName}.pdf`;

  const existing  = folder.getFilesByName(newName);
  if (existing.hasNext()) {
    Logger.log(`  ⏩ Duplicate skipped: ${newName}`);
    return existing.next().getUrl();
  }

  const blob = attachment.copyBlob().setName(newName);
  const file = folder.createFile(blob);
  Logger.log(`  ✔ Uploaded → ${rootName}/${year}/${monthName}/${newName}`);
  return file.getUrl();
}

function getOrCreateFolderPath(parts) {
  let current = DriveApp.getRootFolder();
  for (const name of parts) {
    const iter = current.getFoldersByName(name);
    current = iter.hasNext() ? iter.next() : current.createFolder(name);
  }
  return current;
}


// ╔══════════════════════════════════════════════════════════╗
// ║         G O O G L E   S H E E T S                      ║
// ║                                                          ║
// ║  v3.2: AI Summary column removed. 14 columns total.     ║
// ╚══════════════════════════════════════════════════════════╝

function getOrCreateSheet() {
  const props      = PropertiesService.getScriptProperties();
  const existingId = props.getProperty('SHEET_ID');

  let ss;

  if (existingId) {
    try {
      ss = SpreadsheetApp.openById(existingId);
      Logger.log(`  📊 Using existing sheet: ${ss.getUrl()}`);
      return ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];
    } catch(e) {
      Logger.log('  Saved sheet ID no longer valid — creating new sheet');
    }
  }

  ss = SpreadsheetApp.create(CONFIG.SHEET_NAME);
  props.setProperty('SHEET_ID', ss.getId());
  Logger.log(`  📊 Created new sheet: ${ss.getUrl()}`);

  const sheet = ss.getSheets()[0];
  sheet.setName(CONFIG.SHEET_NAME);

  // 14 columns — AI Summary removed
  const headers = [
    'Email Date',             // A
    'Invoice Date',           // B
    'Sender',                 // C
    'Email Subject',          // D
    'PDF Filename',           // E
    'Invoice Type',           // F  ← colour coded
    'Confidence %',           // G
    'Classification Source',  // H
    'Invoice Number',         // I
    'Invoice Amount (₹)',     // J
    'GST Amount (₹)',         // K
    'Vendor / Client Name',   // L
    'Drive Link',             // M
    'Processed At',           // N
  ];

  sheet.appendRow(headers);

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange
    .setBackground('#1a73e8')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(10);

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(3,  200);  // Sender
  sheet.setColumnWidth(4,  280);  // Subject
  sheet.setColumnWidth(5,  200);  // PDF Filename
  sheet.setColumnWidth(12, 200);  // Vendor / Client Name
  sheet.setColumnWidth(13, 60);   // Drive Link

  return sheet;
}

function writeToSheet(sheet, data) {
  const tz          = Session.getScriptTimeZone();
  const fmtDate     = d => d ? Utilities.formatDate(d, tz, 'dd MMM yyyy') : '';
  const fmtDateTime = d => d ? Utilities.formatDate(d, tz, 'dd MMM yyyy HH:mm') : '';

  // 14 columns — no AI Summary
  const row = [
    fmtDate(data.emailDate),    // A
    fmtDate(data.invoiceDate),  // B
    data.sender,                // C
    data.subject,               // D
    data.pdfName,               // E
    data.type,                  // F
    data.confidence,            // G
    data.source,                // H
    data.invoiceNumber,         // I
    data.invoiceAmount,         // J
    data.gstAmount,             // K
    data.vendorClient,          // L
    data.driveLink,             // M
    fmtDateTime(new Date()),    // N
  ];

  sheet.appendRow(row);

  const lastRow  = sheet.getLastRow();
  const typeCell = sheet.getRange(lastRow, 6); // Column F = Invoice Type

  if (data.type === 'PURCHASE') {
    typeCell.setBackground('#e8f5e9').setFontColor('#2e7d32');  // green
  } else {
    typeCell.setBackground('#e3f2fd').setFontColor('#1565c0');  // blue
  }

  // Highlight low confidence rows in orange
  if (data.confidence < CONFIG.CONFIDENCE_THRESHOLD) {
    sheet.getRange(lastRow, 1, 1, 14).setBackground('#fff3e0');
  }

  Logger.log(`  📝 Sheet row written (row ${lastRow})`);
}


// ╔══════════════════════════════════════════════════════════╗
// ║         G M A I L   L A B E L   U T I L S              ║
// ╚══════════════════════════════════════════════════════════╝

function ensureLabelsExist() {
  [CONFIG.LABEL_PROCESSED, CONFIG.LABEL_LOW_CONF,
   CONFIG.LABEL_IGNORED,   CONFIG.LABEL_ERROR].forEach(name => {
    if (!GmailApp.getUserLabelByName(name)) {
      GmailApp.createLabel(name);
      Logger.log(`Created Gmail label: "${name}"`);
    }
  });
}

function applyLabel(thread, labelName) {
  const label = GmailApp.getUserLabelByName(labelName);
  if (label) label.addToThread(thread);
}


// ╔══════════════════════════════════════════════════════════╗
// ║      A L E R T   &   S U M M A R Y   E M A I L S      ║
// ╚══════════════════════════════════════════════════════════╝

function sendLowConfidenceAlert(ctx) {
  const { subject, sender, body, type, confidence, driveLinks, invoiceDate } = ctx;
  const tz = Session.getScriptTimeZone();

  GmailApp.sendEmail(
    CONFIG.ALERT_EMAIL,
    `⚠️ Low Confidence Invoice Alert (${confidence}%): ${subject}`,
    `⚠️  LOW CONFIDENCE INVOICE ALERT
──────────────────────────────────────────────────────

📧  Email Subject  : ${subject}
👤  Sender         : ${sender}
📅  Invoice Date   : ${Utilities.formatDate(invoiceDate, tz, 'dd MMM yyyy')}
🏷️  Classified As  : ${type}
📊  Confidence     : ${confidence}%  (threshold: ${CONFIG.CONFIDENCE_THRESHOLD}%)

── Email Snippet ──────────────────────────────────────
${body.substring(0, 400)}...

── Uploaded To ────────────────────────────────────────
${driveLinks.length > 0 ? driveLinks.join('\n') : 'Upload failed — check errors'}

── What To Do ─────────────────────────────────────────
1. Check the "${CONFIG.SHEET_NAME}" Google Sheet — low confidence rows are highlighted orange
2. If misclassified → move the file in Google Drive manually
3. Add distinguishing phrases to PURCHASE_SIGNALS or SALES_SIGNALS in the script

──────────────────────────────────────────────────────
Invoice Bifurcation Bot v3.2 | Truestate`.trim()
  );
  Logger.log(`  📨 Alert sent → ${CONFIG.ALERT_EMAIL}`);
}

function sendSummaryEmail(stats, moreRemaining) {
  const props    = PropertiesService.getScriptProperties();
  const sheetId  = props.getProperty('SHEET_ID');
  const sheetUrl = sheetId
    ? `https://docs.google.com/spreadsheets/d/${sheetId}`
    : 'Run setupScript() to create the sheet';

  const remainingNote = moreRemaining
    ? `\n▶  MORE PDFs REMAINING — run processInvoiceEmails() again for the next ${CONFIG.PDF_BATCH_SIZE}`
    : '\n🎉  All pending PDFs fully processed';

  GmailApp.sendEmail(
    CONFIG.ALERT_EMAIL,
    `📊 Invoice Batch Done (${stats.processed} PDFs) — ${new Date().toDateString()}`,
    `📊  INVOICE PROCESSING SUMMARY  (v3.2)
──────────────────────────────────────────────────────
${remainingNote}

✅  PDFs Classified    : ${stats.processed}
📥  Purchase Invoices  : ${stats.purchase}
📤  Sales Invoices     : ${stats.sales}
🚫  Ignored (non-inv)  : ${stats.ignored}  → Ignored Documents folder
⚠️  Low Confidence     : ${stats.lowConf}  (alerts sent separately)
⏭️  Skipped (no PDF)  : ${stats.skipped}
❌  Errors             : ${stats.errors}

📊  Google Sheet (all records):
${sheetUrl}

📁  Google Drive structure:
  Purchase Invoices → [year] → [month]
  Sales Invoices    → [year] → [month]
  Ignored Documents → [year] → [month]

Gmail labels applied:
  "${CONFIG.LABEL_PROCESSED}"  — fully processed
  "${CONFIG.LABEL_IGNORED}"    — non-invoice PDFs
  "${CONFIG.LABEL_LOW_CONF}"   — review needed (orange rows in sheet)
  "${CONFIG.LABEL_ERROR}"      — script error, retry manually

──────────────────────────────────────────────────────
Invoice Bifurcation Bot v3.2 | Truestate`.trim()
  );
}


// ╔══════════════════════════════════════════════════════════╗
// ║      S E T U P   &   V A L I D A T I O N               ║
// ╚══════════════════════════════════════════════════════════╝

function setupScript() {
  ensureLabelsExist();
  const sheet = getOrCreateSheet();
  const ss    = sheet.getParent();
  Logger.log('✅ Setup complete! (v3.2)');
  Logger.log(`📊 Google Sheet: ${ss.getUrl()}`);
  Logger.log(`ℹ  Each run processes ${CONFIG.PDF_BATCH_SIZE} PDFs — run again for next batch`);
  Logger.log('Next: Run processInvoiceEmails()');
}

function validateConfig() {
  if (!CONFIG.ALERT_EMAIL) throw new Error('ALERT_EMAIL is not set in CONFIG');
  if (!CONFIG.OPENROUTER_API_KEY || CONFIG.OPENROUTER_API_KEY === 'YOUR_OPENROUTER_API_KEY_HERE') {
    Logger.log('⚠ WARNING: OpenRouter API key not set. Classification will be rule-based only.');
  }
}


// ╔══════════════════════════════════════════════════════════╗
// ║    T E S T   F U N C T I O N S   (Dev use only)        ║
// ╚══════════════════════════════════════════════════════════╝

function testClassifier() {
  const tests = [
    {
      expected: 'PURCHASE',
      subject : 'Google cloud bill of April month',
      body    : '',
      sender  : 'samarth@truestate.in',
    },
    {
      expected: 'PURCHASE',
      subject : 'Invoice and Receipt for Claude AI | Apr - May 2026',
      body    : 'PFA the Invoice and Receipt for Claude AI payment for the period 27 April 2026 - 27 May 2026. GST is to be paid on reverse charge basis.',
      sender  : 'anubhav@truestate.in',
    },
    {
      expected: 'PURCHASE',
      subject : 'Fwd: Payment INVOICE - Video Editing Services, April2026',
      body    : '---------- Forwarded message ----------\nFrom: Manav Nayak <manav.nayak2004@gmail.com>\n\nPlease find the payment invoice attached.\nAlso find the account details below.\nAccount Holder: Manav Nayak\nAccount Number: 32804694055\nIFSC: SBIN0003286\nBANK TRANSFER',
      sender  : 'rasika@truestate.in',
    },
    {
      expected: 'SALES',
      subject : 'Clossure Update for invoicing. IQOL TECHNOLOGIES PRIVATE LIMITED',
      body    : 'Please update if i can proceed further to raise the invoice.\nBilling TO: ACE REALTY VENTURES\nAgreement Value: 1,23,75,000\nCp Comission @2%: 2,47,500\nCGST+SGST@18%: 44,550',
      sender  : 'imran@acnonline.in',
    },
    {
      expected: 'SALES',
      subject : 'Re: Incremental Invoice Format and Figures-Greenshore',
      body    : 'The consolidated invoice is attached below.\nProject: Greenshore\nUnit Number: T07-1202\nProperty Value: INR1,76,13,399.50\nIncremental: 1.25%',
      sender  : 'imran@acnonline.in',
    },
    {
      expected: 'IGNORE',
      subject : 'GSTR1 Filing - December 2025',
      body    : 'FORM GSTR-1\nDetails of outward supplies of goods or services',
      sender  : 'samarth@truestate.in',
      pdfName : 'GSTR1_29AAHCI3411P1Z7_122025.pdf',
    },
  ];

  Logger.log('══════════════════════════════════════════════════');
  Logger.log('   CLASSIFIER TEST RESULTS  (v3.2 — Rule layer)');
  Logger.log('══════════════════════════════════════════════════');

  let pass = 0, fail = 0;

  for (const t of tests) {
    const fakePdfs     = t.pdfName ? [{ getName: () => t.pdfName }] : [];
    const ignoreReason = shouldIgnore(t.subject, t.body, fakePdfs);

    if (t.expected === 'IGNORE') {
      const ok = ignoreReason !== null;
      Logger.log(`[${ok ? 'PASS ✓' : 'FAIL ✗'}] IGNORE — "${t.subject}"`);
      ok ? pass++ : fail++;
      continue;
    }

    if (ignoreReason) {
      Logger.log(`[FAIL ✗] ${t.expected} — "${t.subject}" wrongly IGNORED: ${ignoreReason}`);
      fail++;
      continue;
    }

    const origSender = extractForwardedSender(t.body);
    const effective  = origSender || t.sender;
    const result     = computeRuleScore(t.subject, t.body, t.sender, effective);
    const ok         = result.type === t.expected;

    Logger.log(
      `[${ok ? 'PASS ✓' : 'FAIL ✗'}] ${t.expected} → got ${result.type} ` +
      `(${result.confidence}%) | P:${result.pScore} S:${result.sScore} | ` +
      `OrigSender: ${origSender || 'none'}`
    );
    ok ? pass++ : fail++;
  }

  Logger.log('──────────────────────────────────────────────────');
  Logger.log(`   ${pass}/${pass + fail} tests passed`);
  Logger.log('══════════════════════════════════════════════════');
}

// ╔══════════════════════════════════════════════════════════╗
// ║         T R I G G E R   M A N A G E M E N T            ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Run this ONCE to set up the automatic every-5-min trigger.
 * After this, processInvoiceEmails() runs automatically.
 */
function createAutoTrigger() {
  // Delete any existing triggers first (avoid duplicates)
  deleteAutoTrigger();

  ScriptApp.newTrigger('processInvoiceEmails')
    .timeBased()
    .everyMinutes(15)   // ← change to 15 or 30 if you want less frequent
    .create();

  Logger.log('✅ Auto trigger created — processInvoiceEmails() will run every 15 minutes');
}

/**
 * Run this to stop the automatic trigger.
 */
function deleteAutoTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'processInvoiceEmails') {
      ScriptApp.deleteTrigger(trigger);
      Logger.log('🗑 Existing trigger deleted');
    }
  }
}

/**
 * Check if trigger is currently active.
 */
function checkTriggerStatus() {
  const triggers = ScriptApp.getProjectTriggers();
  const active = triggers.find(t => t.getHandlerFunction() === 'processInvoiceEmails');
  Logger.log(active
    ? `✅ Trigger is ACTIVE — runs every 5 minutes`
    : `❌ No trigger found — run createAutoTrigger() to enable`
  );
}
