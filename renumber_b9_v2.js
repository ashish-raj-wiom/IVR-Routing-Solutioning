// B9 transformations:
//   1. DROP: old UAT_19 and old DEV_06 (entire blocks)
//   2. MOVE from UAT → Dev: old UAT_13, UAT_14, UAT_16
//   3. EDIT: old DEV_05 — remove the "IVR doesn't talk to CT directly" clause
//   4. EDIT: old UAT_01 + UAT_02 — remove the Table 1 SELECT verify lines
//                                  (Table 1 lives in Redis, not SQL)
//   5. RENUMBER: 24 UAT + 21 Dev = 45 cases total
//
// Mapping (old → new). Drops produce null in the right-hand column.

const fs = require('fs');
const path = 'C:/Users/ashis/ivr-fix/csp-ivr-service-product-spec.html';
let html = fs.readFileSync(path, 'utf8');

// old → new mapping
const renameMap = {
  // UAT 01..12 stay
  UAT_01: 'UAT_01', UAT_02: 'UAT_02', UAT_03: 'UAT_03', UAT_04: 'UAT_04',
  UAT_05: 'UAT_05', UAT_06: 'UAT_06', UAT_07: 'UAT_07', UAT_08: 'UAT_08',
  UAT_09: 'UAT_09', UAT_10: 'UAT_10', UAT_11: 'UAT_11', UAT_12: 'UAT_12',
  // Moved to Dev
  UAT_13: 'DEV_09',
  UAT_14: 'DEV_12',
  UAT_16: 'DEV_21',
  // Stays in UAT, renumbered
  UAT_15: 'UAT_13',
  UAT_17: 'UAT_14',
  UAT_18: 'UAT_15',
  // Dropped
  UAT_19: null,
  // Stays in UAT, renumbered
  UAT_20: 'UAT_16',
  UAT_21: 'UAT_17', UAT_22: 'UAT_18', UAT_23: 'UAT_19', UAT_24: 'UAT_20',
  UAT_25: 'UAT_21', UAT_26: 'UAT_22', UAT_27: 'UAT_23', UAT_28: 'UAT_24',
  // Dev 01..05 stay
  DEV_01: 'DEV_01', DEV_02: 'DEV_02', DEV_03: 'DEV_03', DEV_04: 'DEV_04', DEV_05: 'DEV_05',
  // Dropped
  DEV_06: null,
  // Renumbered (shift -1 for 07..09; insert at slot 9 from UAT_13)
  DEV_07: 'DEV_06', DEV_08: 'DEV_07', DEV_09: 'DEV_08',
  // (slot 9 taken by old UAT_13 → DEV_09)
  DEV_10: 'DEV_10', DEV_11: 'DEV_11',
  // (slot 12 taken by old UAT_14 → DEV_12)
  DEV_12: 'DEV_13', DEV_13: 'DEV_14', DEV_14: 'DEV_15', DEV_15: 'DEV_16',
  DEV_16: 'DEV_17', DEV_17: 'DEV_18', DEV_18: 'DEV_19', DEV_19: 'DEV_20',
  // (slot 21 taken by old UAT_16 → DEV_21)
};

// Final ordering of new IDs (drives the layout). Drops are omitted.
const uatOrder = ['UAT_01','UAT_02','UAT_03','UAT_04','UAT_05','UAT_06','UAT_07','UAT_08',
                  'UAT_09','UAT_10','UAT_11','UAT_12','UAT_13','UAT_14','UAT_15','UAT_16',
                  'UAT_17','UAT_18','UAT_19','UAT_20','UAT_21','UAT_22','UAT_23','UAT_24'];
const devOrder = ['DEV_01','DEV_02','DEV_03','DEV_04','DEV_05','DEV_06','DEV_07','DEV_08',
                  'DEV_09','DEV_10','DEV_11','DEV_12','DEV_13','DEV_14','DEV_15','DEV_16',
                  'DEV_17','DEV_18','DEV_19','DEV_20','DEV_21'];

// Locate B9 bounds
const b9Marker = '<h2><span class="num">B9.</span>';
const b9Start = html.indexOf(b9Marker);
const b9End = html.indexOf('</section>', b9Start);
const sectEndHrIdx = html.lastIndexOf('<hr class="sect-end">', b9End);

// Find first gherkin block (might be preceded by the B9.1 header)
// We need to locate where the gherkin region starts so we can preserve
// the header and intro text. We'll regenerate the headers/preamble below.
const b9Header = html.slice(b9Start, html.indexOf('<h3>B9.1', b9Start));
const tail = html.slice(sectEndHrIdx, b9End);

// Extract every gherkin block in B9
function extractBlocks(region) {
  const blocks = [];
  let i = 0;
  const OPEN = '<div class="gherkin">';
  while (true) {
    const start = region.indexOf(OPEN, i);
    if (start < 0) break;
    let depth = 0;
    let cursor = start;
    while (cursor < region.length) {
      const nextOpen = region.indexOf('<div', cursor);
      const nextClose = region.indexOf('</div>', cursor);
      if (nextClose < 0) throw new Error('Unbalanced div');
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth++;
        cursor = nextOpen + 4;
      } else {
        depth--;
        cursor = nextClose + 6;
        if (depth === 0) break;
      }
    }
    blocks.push({ start, end: cursor, html: region.slice(start, cursor) });
    i = cursor;
  }
  return blocks;
}
const blocks = extractBlocks(html.slice(b9Start, b9End));
console.log(`Extracted ${blocks.length} gherkin blocks`);

// Identify each block's old ID
const idRe = /<strong>(UAT_\d+|DEV_\d+)\b/;
const labeled = blocks.map(b => {
  const m = b.html.match(idRe);
  if (!m) throw new Error('No ID found');
  return { ...b, oldId: m[1] };
});

// Targeted edits
function applyContentEdits(oldId, blockHtml) {
  let out = blockHtml;

  // EDIT 1: old DEV_05 — remove "IVR doesn't talk to CT directly" clause
  if (oldId === 'DEV_05') {
    out = out.replace(
      / The IVR is NOT allowed to call CleverTap \/ FCM \/ Gupshup directly — that's <code>csp-notification-service<\/code>'s job\./g,
      ''
    );
    out = out.replace(
      / IVR doesn't talk to CleverTap directly/gi,
      ''
    );
    // Also strip the title suffix if present
    out = out.replace(
      /; IVR doesn't talk to CleverTap directly/gi,
      ''
    );
  }

  // EDIT 2: old UAT_01 — remove the Table 1 SQL SELECT verify step
  if (oldId === 'UAT_01') {
    out = out.replace(
      /[\t ]*<li><strong>DB<\/strong> — <code>SELECT \* FROM table_1 WHERE from_mobile = Priya AND ttl_expires_at &gt; now\(\)<\/code> → one row, TO = Ramesh's mobile<\/li>\n?/g,
      ''
    );
  }

  // EDIT 3: old UAT_02 — remove Table 1 SELECT but keep Table 2 SELECT
  if (oldId === 'UAT_02') {
    out = out.replace(
      /<code>SELECT \* FROM table_1 WHERE from_mobile = Ramesh<\/code> → 0 rows\. /g,
      ''
    );
    // Also adjust the "DB (pre-call)" label since only Table 2 is left
    out = out.replace(
      /<strong>DB \(pre-call\)<\/strong> — /g,
      '<strong>DB (pre-call, Table 2 only — Table 1 lives in Redis)</strong> — '
    );
  }

  return out;
}

// Apply renumbering to ALL strong IDs and cross-references within a block.
// Replaces every occurrence of an old UAT_NN / DEV_NN with the new value
// from renameMap. Drops mean we leave the block to be discarded separately.
function renumberRefs(text) {
  return text.replace(/(UAT|DEV)_(\d{2})/g, (match) => {
    if (renameMap[match] === undefined) return match;       // not in our map
    if (renameMap[match] === null) return match + '_DROPPED'; // sentinel
    return renameMap[match];
  });
}

const transformed = labeled.map(b => {
  const dest = renameMap[b.oldId];
  if (dest === null) {
    return { ...b, dropped: true };
  }
  const edited = applyContentEdits(b.oldId, b.html);
  const renumbered = renumberRefs(edited);
  return { ...b, dropped: false, newId: dest, html: renumbered };
});

// Drop the dropped blocks
const keep = transformed.filter(b => !b.dropped);

// If any cross-reference to a dropped block remains (we marked them with
// _DROPPED), surface a warning so they can be cleaned up manually
const droppedRefs = keep.filter(b => /_DROPPED/.test(b.html));
if (droppedRefs.length) {
  console.warn(`\nWARNING: ${droppedRefs.length} block(s) reference a dropped criterion:`);
  droppedRefs.forEach(b => {
    const matches = b.html.match(/(UAT|DEV)_\d+_DROPPED/g) || [];
    console.warn(`  ${b.newId}: ${[...new Set(matches)].join(', ')}`);
  });
  console.warn('  → these stale references must be removed manually after the renumber.');
}

// Sort by destination order
function key(newId) {
  const [bucket, n] = newId.split('_');
  return (bucket === 'UAT' ? 0 : 1) * 100 + parseInt(n, 10);
}
keep.sort((a, b) => key(a.newId) - key(b.newId));

// Verify final order matches the target sequences exactly
const finalUat = keep.filter(b => b.newId.startsWith('UAT_')).map(b => b.newId);
const finalDev = keep.filter(b => b.newId.startsWith('DEV_')).map(b => b.newId);
console.log(`\nFinal UAT (${finalUat.length}): ${finalUat.join(', ')}`);
console.log(`Final DEV (${finalDev.length}): ${finalDev.join(', ')}`);

if (finalUat.join(',') !== uatOrder.join(',')) {
  throw new Error('UAT order mismatch');
}
if (finalDev.join(',') !== devOrder.join(',')) {
  throw new Error('DEV order mismatch');
}

// Build B9 body
const uatBlocks = keep.filter(b => b.newId.startsWith('UAT_'));
const devBlocks = keep.filter(b => b.newId.startsWith('DEV_'));

const uatHeader = `
  <h3>B9.1 UAT test Cases</h3>
  <p style="font-size:13px;color:var(--muted);">User-Acceptance Tests — observable from the apps and physical phones. These are what PM (or PM-coordinated testers) validate by sitting with a phone and stepping through the scenarios. ${uatBlocks.length} cases.</p>

`;
const devHeader = `
  <h3>B9.2 Internal Dev Test Cases</h3>
  <p style="font-size:13px;color:var(--muted);">Tests that primarily require dev / QA tooling — DB inspection, code review, simulation, log greps, chaos / brute-force runners. ${devBlocks.length} cases.</p>

`;

const newBody =
  b9Header +
  uatHeader +
  uatBlocks.map(b => b.html).join('\n\n  ') +
  '\n\n  ' +
  devHeader +
  devBlocks.map(b => b.html).join('\n\n  ') +
  '\n\n  ';

const newHtml = html.slice(0, b9Start) + newBody + tail + html.slice(b9End);
fs.writeFileSync(path, newHtml, 'utf8');
console.log(`\nWrote updated B9. Total cases: ${keep.length} (was 47, dropped 2).`);
