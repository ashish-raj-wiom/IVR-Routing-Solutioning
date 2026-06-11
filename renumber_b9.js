// Reorder and renumber B9 CRITERIA blocks.
//   - 28 cases become UAT_01 .. UAT_28
//   - 19 cases become DEV_01 .. DEV_19
//   - UAT block lands first under <h3>B9.1 UAT test Cases</h3>
//   - DEV block lands second under <h3>B9.2 Internal Dev Test Cases</h3>
//   - Cross-references (CRITERIA_NN inside other blocks) are remapped too
//
// Does NOT alter content of any block other than renaming the CRITERIA_NN
// labels and references.

const fs = require('fs');
const path = 'C:/Users/ashis/ivr-fix/csp-ivr-service-product-spec.html';
let html = fs.readFileSync(path, 'utf8');

// Mapping: old number → new prefixed ID
const mapping = {
  // UAT bucket
  1: 'UAT_01', 2: 'UAT_02', 3: 'UAT_03', 4: 'UAT_04',
  5: 'UAT_05', 6: 'UAT_06', 7: 'UAT_07', 8: 'UAT_08',
  9: 'UAT_09', 10: 'UAT_10', 11: 'UAT_11', 12: 'UAT_12',
  13: 'UAT_13', 16: 'UAT_14', 17: 'UAT_15', 21: 'UAT_16',
  32: 'UAT_17', 33: 'UAT_18', 34: 'UAT_19', 39: 'UAT_20',
  40: 'UAT_21', 41: 'UAT_22', 42: 'UAT_23', 43: 'UAT_24',
  44: 'UAT_25', 45: 'UAT_26', 46: 'UAT_27', 47: 'UAT_28',
  // DEV bucket
  14: 'DEV_01', 15: 'DEV_02', 18: 'DEV_03', 19: 'DEV_04',
  20: 'DEV_05', 22: 'DEV_06', 23: 'DEV_07', 24: 'DEV_08',
  25: 'DEV_09', 26: 'DEV_10', 27: 'DEV_11', 28: 'DEV_12',
  29: 'DEV_13', 30: 'DEV_14', 31: 'DEV_15', 35: 'DEV_16',
  36: 'DEV_17', 37: 'DEV_18', 38: 'DEV_19',
};

// Locate B9 section bounds
const b9Marker = '<h2><span class="num">B9.</span>';
const b9Start = html.indexOf(b9Marker);
if (b9Start < 0) throw new Error('B9 section not found');

// B9 ends at its </section> closer — find next </section> after b9Start
const b9End = html.indexOf('</section>', b9Start);
if (b9End < 0) throw new Error('B9 section close not found');

// Find the first <div class="gherkin"> after the B9 header
const firstBlockStart = html.indexOf('<div class="gherkin">', b9Start);
// Find the last </div> of the last gherkin block within B9. The marker
// pattern is the <hr class="sect-end"> right before </section>.
const sectEnd = html.lastIndexOf('<hr class="sect-end">', b9End);
if (firstBlockStart < 0 || sectEnd < 0) throw new Error('Block bounds not found');

// Extract everything between (the preamble before blocks) and (after blocks)
const preamble = html.slice(b9Start, firstBlockStart);
const criteriaRegion = html.slice(firstBlockStart, sectEnd);
const tail = html.slice(sectEnd, b9End);

// Parse all <div class="gherkin"> ... </div> blocks (top-level only — no
// nested gherkin divs exist in this spec)
function extractBlocks(region) {
  const blocks = [];
  let i = 0;
  const OPEN = '<div class="gherkin">';
  while (true) {
    const start = region.indexOf(OPEN, i);
    if (start < 0) break;
    // Match balanced <div>...</div> from start
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

const blocks = extractBlocks(criteriaRegion);
console.log(`Found ${blocks.length} gherkin blocks in B9`);

// For each block, identify the CRITERIA number it owns (the bolded header)
const idRe = /<strong>CRITERIA_(\d+)/;
const blocksWithIds = blocks.map(b => {
  const m = b.html.match(idRe);
  if (!m) throw new Error(`Block has no CRITERIA id: ${b.html.slice(0, 120)}`);
  return { ...b, oldNum: parseInt(m[1], 10) };
});

// Verify we have exactly 47, contiguous 1..47
const oldNums = blocksWithIds.map(b => b.oldNum).sort((a, b) => a - b);
const missing = [];
for (let n = 1; n <= 47; n++) if (!oldNums.includes(n)) missing.push(n);
if (missing.length) console.warn('Missing IDs:', missing);
console.log(`Old IDs span: ${Math.min(...oldNums)} .. ${Math.max(...oldNums)}`);

// Apply the mapping: rewrite every CRITERIA_NN reference (both the title and
// any cross-references) in each block's HTML to the new prefixed ID
function renumberBlock(blockHtml) {
  return blockHtml.replace(/CRITERIA_(\d+)/g, (match, num) => {
    const n = parseInt(num, 10);
    const newId = mapping[n];
    if (!newId) {
      console.warn(`No mapping for CRITERIA_${num}, leaving as-is`);
      return match;
    }
    return newId;
  });
}

// Build the UAT and DEV blocks lists in target order
function newIdSortKey(newId) {
  const [bucket, n] = newId.split('_');
  return (bucket === 'UAT' ? 0 : 1) * 100 + parseInt(n, 10);
}

const renumbered = blocksWithIds.map(b => {
  const newId = mapping[b.oldNum];
  return {
    ...b,
    newId,
    htmlRenumbered: renumberBlock(b.html),
    sortKey: newIdSortKey(newId),
  };
}).sort((a, b) => a.sortKey - b.sortKey);

// Split UAT vs DEV
const uatBlocks = renumbered.filter(b => b.newId.startsWith('UAT_'));
const devBlocks = renumbered.filter(b => b.newId.startsWith('DEV_'));
console.log(`UAT blocks: ${uatBlocks.length}`);
console.log(`DEV blocks: ${devBlocks.length}`);

// Assemble new criteria region with B9.1 / B9.2 sub-headers
const uatHeader = `
  <h3>B9.1 UAT test Cases</h3>
  <p style="font-size:13px;color:var(--muted);">User-Acceptance Tests — observable from the apps and physical phones. These are what PM (or PM-coordinated testers) validate by sitting with a phone and stepping through the scenarios. ${uatBlocks.length} cases.</p>

`;
const devHeader = `
  <h3>B9.2 Internal Dev Test Cases</h3>
  <p style="font-size:13px;color:var(--muted);">Tests that primarily require dev / QA tooling — DB inspection, code review, simulation, log greps, chaos / brute-force runners. ${devBlocks.length} cases.</p>

`;

const newCriteriaRegion =
  uatHeader +
  uatBlocks.map(b => b.htmlRenumbered).join('\n\n  ') +
  '\n\n  ' +
  devHeader +
  devBlocks.map(b => b.htmlRenumbered).join('\n\n  ') +
  '\n\n  ';

// Splice it back into the HTML
const newB9 = preamble + newCriteriaRegion + tail;
const newHtml = html.slice(0, b9Start) + newB9 + html.slice(b9End);

fs.writeFileSync(path, newHtml, 'utf8');
console.log('\nWrote renumbered B9 to', path);
console.log('\nFinal UAT order:');
uatBlocks.forEach(b => console.log(`  ${b.newId}  (was CRITERIA_${String(b.oldNum).padStart(2,'0')})`));
console.log('\nFinal DEV order:');
devBlocks.forEach(b => console.log(`  ${b.newId}  (was CRITERIA_${String(b.oldNum).padStart(2,'0')})`));
