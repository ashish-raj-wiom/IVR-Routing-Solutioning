// Parse all CRITERIA blocks from the IVR product spec and emit CSV.
// Each row: ID, Category, Title, Scenario, Manually-testable?, Line
//
// Manually-testable column is my best-judgement classification:
//   Manual    = PM can validate by making a call / using the app / observing a phone
//   Mixed     = needs phone test + DB / log inspection together
//   Internal  = primarily dev / QA verification (DB, code review, log greps only)

const fs = require('fs');

const html = fs.readFileSync('C:/Users/ashis/ivr-fix/csp-ivr-service-product-spec.html', 'utf8');
const lines = html.split('\n');

// Find every <strong>CRITERIA_NN (cat · cat2 · ...):</strong> Title<br>
const titleRe = /<strong>CRITERIA_(\d+)(?:\s*\(([^)]+)\))?:\s*<\/strong>\s*(.+?)<br>/;
const scenarioRe = /<span class="scenario">Scenario:\s*(.+?)<\/span>/;

// Strip inline HTML tags + decode common entities for CSV friendliness
function clean(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Manual-testability classifier (deterministic, my judgement encoded)
function classify(id, cat, title) {
  const catL = (cat || '').toLowerCase();
  const t = title.toLowerCase();
  // UAT block (40-47) — pure manual
  if (catL.includes('uat')) return 'Manual';
  // API contract / code-review oriented
  if (catL.includes('api · contract')) return 'Internal';
  // Lifecycle / idempotency / pin generation — needs DB
  if (catL.includes('lifecycle')) return 'Internal';
  // Resilience / chaos — needs simulation
  if (catL.includes('resilience')) return 'Internal';
  // Security PIN injection / brute force — needs attack tooling
  if (catL.includes('security · p0')) return 'Internal';
  // Computation (90-day cooldown, structural caps) — needs time travel / DB
  if (catL.includes('computation')) return 'Internal';
  // Invariants — usually mixed (observe + verify DB)
  if (catL.includes('invariant')) return 'Mixed';
  // Edge / BEC — usually needs simulation + DB
  if (catL.includes('edge')) return 'Internal';
  // Failure modes (FM-NN) — usually needs simulation
  if (catL.includes('failure')) return 'Internal';
  // Regression — latency or branch coverage; usually mixed
  if (catL.includes('regression')) return 'Mixed';
  // Negative paths — usually observable on a call (manual)
  if (catL.includes('negative')) return 'Manual';
  // Happy paths (CRITERIA_01–08) — manual via real calls
  if (catL.includes('happy')) return 'Manual';
  // sim_inventory — needs SIM swap + observation
  if (catL.includes('sim_inventory')) return 'Mixed';
  // identity conflict
  if (catL.includes('identity')) return 'Mixed';
  // Default
  return 'Internal';
}

// CSV-escape a single field
function csvField(s) {
  if (s == null) return '';
  const needsQuote = /[",\n\r]/.test(s);
  const out = s.replace(/"/g, '""');
  return needsQuote ? `"${out}"` : out;
}

const rows = [];
rows.push(['ID', 'Category', 'Title', 'Scenario', 'Manually-testable', 'Line']);

let scanning = null; // current criterion waiting for its scenario line

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const m = line.match(titleRe);
  if (m) {
    const id = `CRITERIA_${m[1].padStart(2, '0')}`;
    const cat = clean(m[2] || '');
    const title = clean(m[3] || '');
    scanning = { id, cat, title, line: i + 1, scenario: '' };
    // Try to find the scenario on the next few lines
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const sm = lines[j].match(scenarioRe);
      if (sm) {
        scanning.scenario = clean(sm[1]);
        break;
      }
    }
    const verdict = classify(scanning.id, scanning.cat, scanning.title);
    rows.push([
      scanning.id,
      scanning.cat,
      scanning.title,
      scanning.scenario,
      verdict,
      String(scanning.line),
    ]);
    scanning = null;
  }
}

const csv = rows.map(r => r.map(csvField).join(',')).join('\n');
const outPath = 'C:/Users/ashis/Downloads/ivr_criteria_for_uat_review.csv';
fs.writeFileSync(outPath, csv, 'utf8');

console.log(`Wrote ${rows.length - 1} rows to ${outPath}`);

// Also print a Manual-only quick view to console
const manualOnly = rows.slice(1).filter(r => r[4] === 'Manual');
const mixed = rows.slice(1).filter(r => r[4] === 'Mixed');
const internal = rows.slice(1).filter(r => r[4] === 'Internal');
console.log(`\nSummary by manual-testability:`);
console.log(`  Manual:   ${manualOnly.length}`);
console.log(`  Mixed:    ${mixed.length}`);
console.log(`  Internal: ${internal.length}`);
